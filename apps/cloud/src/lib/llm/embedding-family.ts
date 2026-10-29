// Embedding family invariant (D-072, W7 local embeddings; design
// docs/design/w7-one-command-local.md §9 and §15 findings 2-3).
//
// The store holds vectors of ONE family. Migration 118 records each vector's
// family in `embedding_model` (NULL = DEFAULT_EMBEDDING_FAMILY) on the three
// tables search reads: session_memories, conversations, conversation_chunks.
//
// - Default family on the hosted app (not MEMBRAL_LOCAL=1, or VERCEL set): no
//   check, no extra query. Every pre-118 vector is this family.
// - Default family on a local run: checks that no vector carries a non-null
//   embedding_model (a store a local model wrote into).
// - Any other family: checks that no vector is NULL-model (default) or another
//   model.
//   Either check runs before an embedding write and is cached per family for
//   FAMILY_CHECK_TTL_MS. A mismatch refuses the write with
//   EmbeddingFamilyMismatchError and the caller stores no vector
//   (keyword-only), exactly as if embeddings were disabled.
// - kg_* tables have no `embedding_model` column: their writers skip embedding
//   for a non-default family (kgEmbeddingsAllowed).
// - Cosine-threshold steps (in-batch dedupe, cross-session dedupe/recurrence,
//   supersede, blocker dismiss, content match, semantic dedup RPC, search floor) have thresholds tuned per family
//   (vectorThreshold): the default family keeps its historical values, a calibrated family its own, and any other
//   family gets null and the step is skipped, never run with a wrong threshold.

import type { Db } from "@/lib/db/types";
import {
  CALIBRATED_FAMILY_THRESHOLDS,
  DEFAULT_FAMILY_THRESHOLDS,
  LEXICAL_MIN_HITS,
  type VectorStep,
} from "@/lib/domain/similarity";
import { log } from "../log";
import {
  canonicalEmbeddingFamily,
  currentEmbeddingFamily,
  DEFAULT_EMBEDDING_FAMILY,
  isDefaultEmbeddingFamily,
} from "./embedding-client";

/** Tables whose `embedding` vectors carry an `embedding_model` (migration 118). */
export const FAMILY_TABLES = ["session_memories", "conversations", "conversation_chunks"] as const;

export class EmbeddingFamilyMismatchError extends Error {
  constructor(
    public readonly family: string,
    public readonly table: string,
  ) {
    super(
      `Embedding model "${family}" differs from vectors already stored in ${table}. Mixing models would make similarity meaningless, so no vector is written (keyword search still works). Re-embed the store with the new model (run \`membral local reembed\`) or switch MEMBRAL_EMBEDDING_MODEL back.`,
    );
    this.name = "EmbeddingFamilyMismatchError";
  }
}

/** Re-check after this long: a store re-embedded or cleared meanwhile is picked up without a restart. */
export const FAMILY_CHECK_TTL_MS = 5 * 60 * 1000;

/** family -> the in-flight or settled check and when it started. A refusal is cached for the TTL too. */
const checks = new Map<string, { check: Promise<void>; at: number }>();

/** True on a local run (MEMBRAL_LOCAL=1 and not on Vercel). Hosted runs never query for the family. */
export function isLocalRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.MEMBRAL_LOCAL?.trim() === "1" && !env.VERCEL;
}

async function checkStore(supabase: Db, family: string): Promise<void> {
  const isDefault = isDefaultEmbeddingFamily(family);
  for (const table of FAMILY_TABLES) {
    // Another family = a stored vector whose coalesce(embedding_model, default) <> family.
    //   default family:   any vector with a non-null embedding_model (writers omit the column for default).
    //   another family:   any vector whose model is NULL (= default) or differs.
    const base = supabase.from(table).select("id").not("embedding", "is", null);
    const filtered = isDefault
      ? base.not("embedding_model", "is", null)
      : base.or(embeddingFamilyMismatchFilter(family));
    const { data, error } = await filtered.limit(1);
    if (error) throw new Error(`embedding family check on ${table} failed: ${error.message}`);
    if ((data ?? []).length > 0) throw new EmbeddingFamilyMismatchError(family, table);
  }
}

/** The PostgREST `or` filter for "a vector of a family other than `family`" (non-default `family`); the value is double-quoted so `:` or `,` in a model id (e.g. `qwen3-embedding:0.6b`) stays one value. */
export function embeddingFamilyMismatchFilter(family: string): string {
  return `embedding_model.is.null,embedding_model.neq.${JSON.stringify(family)}`;
}

/**
 * Resolves when an embedding of `family` may be written; throws
 * EmbeddingFamilyMismatchError when the store already holds another family.
 * Hosted + default family returns at once without touching the database; a
 * local run checks the default family too (a store a local model wrote into).
 */
export async function assertEmbeddingFamilyWritable(
  supabase: Db,
  family: string = currentEmbeddingFamily(),
  opts: { env?: Record<string, string | undefined>; now?: number } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  if (isDefaultEmbeddingFamily(family) && !isLocalRuntime(env)) return;
  const now = opts.now ?? Date.now();
  const cached = checks.get(family);
  if (cached && now - cached.at < FAMILY_CHECK_TTL_MS) return cached.check;
  const check = checkStore(supabase, family);
  checks.set(family, { check, at: now });
  // A failed READ (not a mismatch) is not cached: the next write retries it.
  check.catch((err) => {
    if (!(err instanceof EmbeddingFamilyMismatchError)) checks.delete(family);
    else log.warn("embeddings: store holds another embedding model — vectors disabled", { family, err: err.message });
  });
  return check;
}

/** Forget cached family checks so the next write re-reads the store (a re-embed just changed its vectors). */
export function invalidateEmbeddingFamilyCache(): void {
  checks.clear();
}

/** Test seam: forget cached checks and one-time logs. */
export function resetEmbeddingFamilyCacheForTests(): void {
  checks.clear();
  logged.clear();
  rawWarned.clear();
}

const logged = new Set<string>();

function logOnce(step: string, family: string): void {
  if (logged.has(step)) return;
  logged.add(step);
  log.info("embeddings: no calibrated threshold for this embedding model — vector step skipped", {
    step,
    family,
    default_family: DEFAULT_EMBEDDING_FAMILY,
  });
}

/**
 * The cosine cut `step` uses for `family`, or null when the step must be skipped.
 * - default family (text-embedding-3-small): the value the step has always used;
 * - a calibrated family (CALIBRATED_FAMILY_THRESHOLDS): its own value, or null for a step it did not calibrate;
 * - any other family: null (logged once per step), never a threshold calibrated for another model.
 */
export function vectorThreshold(step: VectorStep, family: string = currentEmbeddingFamily()): number | null {
  if (isDefaultEmbeddingFamily(family)) return DEFAULT_FAMILY_THRESHOLDS[step];
  const value = CALIBRATED_FAMILY_THRESHOLDS[canonicalEmbeddingFamily(family)]?.[step] ?? null;
  if (value === null) logOnce(step, family);
  return value;
}

/**
 * I33 raw-unit floors (docs/design/i33-port.md D6; lab ranker.mjs:221-222): the cosine a raw chunk needs to be served
 * (p90 of unrelated query/chunk pairs) and the one above which chunks are served with no record at all (p99).
 * Calibrated for nomic only. Kept beside, not inside, `VectorStep`: that union also types the default family's table
 * (`DEFAULT_FAMILY_THRESHOLDS`), and the hosted default has no raw path to calibrate.
 */
export const RAW_UNIT_THRESHOLDS: Readonly<Record<string, { chunk_floor: number; chunk_abstain: number }>> = {
  "nomic-embed-text": { chunk_floor: 0.626, chunk_abstain: 0.689 },
};

/** Every cut the raw path reads for one family. `sql_cut` is the pool query's `p_min_similarity`. */
export interface RawUnitCuts {
  sem_floor: number;
  mixed_sem_floor: number;
  sql_cut: number;
  lex_min_hits: number;
  chunk_floor: number;
  chunk_abstain: number;
}

const rawWarned = new Set<string>();

/**
 * The raw-unit cuts for `family`, or null when the family has none: the raw path then serves nothing ("no raw", cards
 * and records only) and a warning is logged once per family. Nomic's numbers are never applied to another family.
 */
export function rawUnitCuts(family: string = currentEmbeddingFamily()): RawUnitCuts | null {
  const own = RAW_UNIT_THRESHOLDS[canonicalEmbeddingFamily(family)];
  const sem = own ? vectorThreshold("sem_floor", family) : null;
  const mixed = own ? vectorThreshold("mixed_sem_floor", family) : null;
  const sql = own ? vectorThreshold("sql_cut", family) : null;
  if (!own || sem === null || mixed === null || sql === null) {
    if (!rawWarned.has(family)) {
      rawWarned.add(family);
      log.warn("embeddings: no calibrated raw-unit floors for this embedding model — raw excerpts are not served", {
        family,
      });
    }
    return null;
  }
  return { sem_floor: sem, mixed_sem_floor: mixed, sql_cut: sql, lex_min_hits: lexicalMinHits(family), ...own };
}

/** L5: matched query lexemes needed to serve on lexical evidence alone; 0 = no minimum (default family, uncalibrated). */
export function lexicalMinHits(family: string = currentEmbeddingFamily()): number {
  if (isDefaultEmbeddingFamily(family)) return 0;
  return LEXICAL_MIN_HITS[canonicalEmbeddingFamily(family)] ?? 0;
}

/** kg_* tables have no embedding_model column: only the default family may write them. Logs once per writer. */
export function kgEmbeddingsAllowed(writer: string, family: string = currentEmbeddingFamily()): boolean {
  if (isDefaultEmbeddingFamily(family)) return true;
  logOnce(`kg:${writer}`, family);
  return false;
}

/**
 * Never-throwing form for batch writers: null when `family` may be written,
 * else the reason (a mismatch, or a failed check read). The caller then stores
 * no vector — the same degrade as embeddings disabled (keyword-only).
 */
export async function embeddingWriteBlockedReason(
  supabase: Db,
  family: string = currentEmbeddingFamily(),
): Promise<string | null> {
  try {
    await assertEmbeddingFamilyWritable(supabase, family);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
