// Embedding step of the raw-unit write path (docs/design/i33-port.md D5, section 5 PR 2). It runs FIRST, outside any
// database transaction, and returns a map keyed by text_hash; the transaction (replace_session_raw_units, migration
// 130) only swaps finished rows in. A text whose hash a stored unit already has (same embedding model, vector
// present) reuses that vector, so a session that grew embeds only its new unit texts.
//
// D5: only the nomic family takes the task prefix (`search_document: ` on every stored text; the lab's I1 variant).
// The vector is recorded under a versioned model value, never the plain family id, so a nomic vector embedded
// with the prefix is never compared with an unprefixed one. text-embedding-3-small and any other family take no
// prefix and keep their canonical id (the default family stores NULL, as the other embedding tables do).
//
// Failures never throw and never produce a vector: a failed batch is retried one text at a time, and a text that
// still fails maps to null (the writer stores NULL + embedding_failed_at, never a zero vector, as write/insert.ts).

import { bundledEmbeddingsCreate } from "@/lib/llm/bundled-embedder";
import {
  callEmbeddingsCreate,
  canonicalEmbeddingFamily,
  EMBEDDING_DIMENSIONS,
  isBundledEmbeddingConfig,
  isDefaultEmbeddingFamily,
  resolveEmbeddingConfig,
} from "@/lib/llm/embedding-client";
import { backoffMultiplier, DECAY_FACTOR, INITIAL_DELAY_MS, MAX_DELAY_MS, retryAfterMs } from "@/lib/llm/retry";
import { log } from "@/lib/log";
import { sha256Hex } from "./units";

/** The nomic task prefix for stored text (lab variants/I1-nomic-prefixes/representation.mjs). */
export const NOMIC_DOCUMENT_PREFIX = "search_document: ";

/** The nomic task prefix for a search query (see queryEmbedInput). */
export const NOMIC_QUERY_PREFIX = "search_query: ";

/**
 * Version of the prefix scheme. D5 asked for a versioned `embedding_model`; the value is family + prefix version
 * (`nomic-embed-text+doc-v1`), not a fixed "nomic-v2", so switching to another nomic model, or changing the
 * prefix, reads as stale.
 */
export const NOMIC_PREFIX_VERSION = "doc-v1";

/** Texts per embeddings call, as memory/embed.ts. */
export const UNIT_EMBED_BATCH_SIZE = 100;

/** After this long a unit whose embedding failed is retried by the next import or sweep (compared inside Postgres). */
export const EMBED_RETRY_AFTER_SECONDS = 15 * 60;

/** Per request limits for the default embedder: a hung provider cannot stall an import. */
export const EMBED_REQUEST_TIMEOUT_MS = 30_000;

/** Extra (split) calls allowed per run, as a multiple of its batch count (isolating one bad text in a batch of 100 takes ~14 calls). */
export const SPLIT_RETRY_FACTOR = 16;

/** Consecutive failed calls (across all batches of one run) after which the rest of the run is not attempted. */
export const EMBED_BREAKER_FAILURES = 3;

/** One call: texts in, vectors out (aligned by position); throws on failure. Vectors must be EMBEDDING_DIMENSIONS wide. */
export type EmbedBatchFn = (texts: string[]) => Promise<number[][]>;

export interface UnitEmbedder {
  /** The embedding family this embedder produces (canonical id). */
  family: string;
  embedBatch: EmbedBatchFn;
}

export const isNomicFamily = (family: string): boolean => /nomic/i.test(canonicalEmbeddingFamily(family));

/** The exact string sent to the embedder for a unit text. */
export function embedInput(text: string, family: string): string {
  return isNomicFamily(family) ? `${NOMIC_DOCUMENT_PREFIX}${text}` : text;
}

/** The exact string to embed for a search QUERY against units of `family` (PR 3/4 import this, with unitEmbeddingModel). */
export function queryEmbedInput(text: string, family: string): string {
  return isNomicFamily(family) ? `${NOMIC_QUERY_PREFIX}${text}` : text;
}

/**
 * The `embedding_model` value units of `family` are stored under, and the value readers must pass as
 * `p_embedding_model` to the 129 RPCs. Note: a NULL p_embedding_model in 129 matches ANY model, and the default family
 * itself stores NULL, so a caller that wants "only this family" must pass this value for non-default families and
 * must not pass NULL while other families' units exist. (129 is left as is.) Null = the default family, as other
 * tables.
 */
export function unitEmbeddingModel(family: string): string | null {
  if (isNomicFamily(family)) return `${canonicalEmbeddingFamily(family)}+${NOMIC_PREFIX_VERSION}`;
  return isDefaultEmbeddingFamily(family) ? null : canonicalEmbeddingFamily(family);
}

/** text_hash: sha256 of the embedded string (prefix included for nomic), the key for vector reuse. */
export const unitTextHash = (text: string, family: string): string => sha256Hex(embedInput(text, family));

/** A usable vector: right width, finite, not all zero (a zero vector looks like a real embedding to cosine). */
export function isUsableVector(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === EMBEDDING_DIMENSIONS &&
    v.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    v.some((n) => n !== 0)
  );
}

/** The embedder for this process's configuration, or null when no embedding provider is configured. */
export function createDefaultUnitEmbedder(env: Record<string, string | undefined> = process.env): UnitEmbedder | null {
  const config = resolveEmbeddingConfig(env);
  if (!config.apiKey) return null;
  const family = canonicalEmbeddingFamily(config.model);
  return {
    family,
    embedBatch: async (texts) => {
      if (isBundledEmbeddingConfig(config)) {
        const res = await callEmbeddingsCreate((body) => bundledEmbeddingsCreate(body), config, texts);
        return res.data.map((d) => d.embedding);
      }
      // Imported lazily: lib/openai.ts builds the SDK client on first use.
      const { getOpenAI } = await import("@/lib/openai");
      const openai = getOpenAI();
      // maxRetries 0: the SDK's own immediate retries would hit a rate limit again; failures surface to the breaker.
      const res = await callEmbeddingsCreate(
        (body) => openai.embeddings.create(body, { timeout: EMBED_REQUEST_TIMEOUT_MS, maxRetries: 0 }),
        config,
        texts,
      );
      return res.data.map((d) => d.embedding);
    },
  };
}

/** A vector a stored unit already holds, offered for reuse (same text_hash and embedding model). */
export interface ReusableVector {
  text_hash: string;
  embedding_model: string | null;
  vector: number[];
}

export interface EmbedUnitsResult {
  /** text_hash -> vector, or null for a text that could not be embedded. */
  vectors: Map<string, number[] | null>;
  embedded: number;
  reused: number;
  failed: number;
}

/**
 * Embeds the distinct texts of `texts` (unit text, unprefixed) that `reuse` does not cover. Never throws.
 * `embedder === null` (no provider configured) maps every uncovered text to null.
 */
export async function embedUnitTexts(
  texts: string[],
  embedder: UnitEmbedder | null,
  family: string,
  reuse: ReusableVector[] = [],
  opts: { splitRetryFactor?: number } = {},
): Promise<EmbedUnitsResult> {
  const model = unitEmbeddingModel(family);
  const vectors = new Map<string, number[] | null>();
  const reusable = new Map<string, number[]>();
  for (const r of reuse)
    if (r.embedding_model === model && isUsableVector(r.vector)) reusable.set(r.text_hash, r.vector);

  const todo = new Map<string, string>(); // hash -> embedded string
  let reused = 0;
  for (const text of texts) {
    const hash = unitTextHash(text, family);
    if (vectors.has(hash) || todo.has(hash)) continue;
    const have = reusable.get(hash);
    if (have) {
      vectors.set(hash, have);
      reused++;
    } else todo.set(hash, embedInput(text, family));
  }

  let embedded = 0;
  let failed = 0;
  const entries = [...todo.entries()];
  if (!embedder || embedder.family !== canonicalEmbeddingFamily(family)) {
    for (const [hash] of entries) vectors.set(hash, null);
    return { vectors, embedded, reused, failed: entries.length };
  }
  // One breaker for the whole run (EMBED_BREAKER_FAILURES consecutive failed calls, a success resets it). A 429 is
  // handled by the process-wide backoff below (CLAUDE.md rule 4): every run waits out the pause, the batch is sent once
  // more, a second 429 trips this run's breaker, and a 429 batch is NEVER split. A transient non-429 failure (HTTP 5xx,
  // connection reset/EOF: Ollama's runner crashes about once per few hundred texts) splits the failed batch in halves
  // and retries them, down to single texts, within SPLIT_RETRY_FACTOR x the batch count of extra calls per run. A text
  // that still fails alone maps to null (stored with the failure marker, never a zero vector).
  let streak = 0;
  let wide = false;
  const batches = Math.ceil(entries.length / UNIT_EMBED_BATCH_SIZE);
  let retryBudget = (opts.splitRetryFactor ?? SPLIT_RETRY_FACTOR) * batches; // injectable so tests can make the cap bind
  const settle = (part: Array<[string, string]>, out: number[][]) => {
    part.forEach(([hash], i) => {
      const v = out[i];
      const ok = isUsableVector(v);
      if (!ok && Array.isArray(v) && (v as unknown[]).length > EMBEDDING_DIMENSIONS) wide = true;
      vectors.set(hash, ok ? v : null);
      if (ok) embedded++;
      else failed++;
    });
  };
  const giveUp = (part: Array<[string, string]>) => {
    for (const [hash] of part) vectors.set(hash, null);
    failed += part.length;
  };
  type Part = Array<[string, string]>;
  /** One call. Returns the part when it failed and may be split, else settles it (ok, or given up) and returns null. */
  const attempt = async (part: Part, isRetry: boolean): Promise<Part | null> => {
    if (streak >= EMBED_BREAKER_FAILURES) {
      giveUp(part);
      return null;
    }
    if (isRetry) retryBudget--;
    const done = await tryBatch(
      embedder,
      part.map(([, t]) => t),
    );
    if (done.out) {
      streak = 0;
      settle(part, done.out);
      return null;
    }
    streak = done.rateLimited ? EMBED_BREAKER_FAILURES : streak + 1;
    if (done.rateLimited || !done.transient || part.length < 2) {
      giveUp(part);
      return null;
    }
    return part;
  };
  // Breadth first: both halves of a failed part get one call before either is split further. A bad text then leaves a
  // success next to every failure (the breaker's streak resets), while a server that is down fails the part and both
  // halves, which is EMBED_BREAKER_FAILURES consecutive failures and trips the breaker.
  const expand = async (part: Part): Promise<void> => {
    if (retryBudget < 2) return giveUp(part);
    const mid = Math.ceil(part.length / 2);
    const halves = [part.slice(0, mid), part.slice(mid)];
    const failedHalves: Part[] = [];
    for (const h of halves) {
      const f = await attempt(h, true);
      if (f) failedHalves.push(f);
    }
    for (const h of failedHalves) await expand(h);
  };
  for (let start = 0; start < entries.length; start += UNIT_EMBED_BATCH_SIZE) {
    const failedPart = await attempt(entries.slice(start, start + UNIT_EMBED_BATCH_SIZE), false);
    if (failedPart) await expand(failedPart);
  }
  if (wide) {
    log.warn("raw units: embedder returned vectors wider than the column; those texts are stored without a vector", {
      expected: EMBEDDING_DIMENSIONS,
    });
  }
  return { vectors, embedded, reused, failed };
}

// ---------- process-wide 429 backoff (CLAUDE.md rule 4) ----------
// One state for every run in the process: a 429 pauses ALL of them. The delay grows by lib/llm/retry's proportional
// multiplier (bigger at a small delay, smaller as it grows), decays by 0.9x per success and never resets to the floor.

const backoff = { delayMs: INITIAL_DELAY_MS, pausedUntil: 0 };

export const embedBackoffDeps = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  random: (): number => Math.random(),
};

export function currentEmbedBackoffMs(): number {
  return backoff.delayMs;
}

/** Test hook. */
export function resetEmbedBackoff(): void {
  backoff.delayMs = INITIAL_DELAY_MS;
  backoff.pausedUntil = 0;
}

/** Waits out the shared pause. Returns false (without sleeping) when the pause is longer than MAX_DELAY_MS. */
async function waitOutPause(): Promise<boolean> {
  const wait = backoff.pausedUntil - embedBackoffDeps.now();
  if (wait > MAX_DELAY_MS) return false;
  if (wait > 0) await embedBackoffDeps.sleep(wait);
  return true;
}

/**
 * Records a 429. The delay grows once per pause window (a 429 that lands while the process is already paused, e.g. a
 * concurrent run's, only extends nothing and grows nothing), with 0-25% jitter. A Retry-After longer than the cap is
 * honoured in full (pausedUntil) instead of being clamped; runs then give up without sleeping it out.
 */
function noteRateLimit(err: unknown): void {
  const now = embedBackoffDeps.now();
  const asked = retryAfterMs(err, now);
  const inWindow = backoff.pausedUntil > now;
  const base = Math.max(INITIAL_DELAY_MS, asked ?? backoff.delayMs);
  const wait = asked !== null && asked > MAX_DELAY_MS ? asked : Math.min(MAX_DELAY_MS, base);
  const jittered = wait * (1 + 0.25 * embedBackoffDeps.random());
  if (!inWindow) backoff.delayMs = Math.min(MAX_DELAY_MS, backoff.delayMs * backoffMultiplier(backoff.delayMs));
  backoff.pausedUntil = Math.max(backoff.pausedUntil, now + jittered);
}

function noteSuccess(): void {
  backoff.delayMs = Math.max(INITIAL_DELAY_MS, backoff.delayMs * DECAY_FACTOR);
}

async function tryBatch(
  embedder: UnitEmbedder,
  inputs: string[],
): Promise<{ out: number[][] | null; rateLimited: boolean; transient: boolean }> {
  let rateLimited = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await waitOutPause())) return { out: null, rateLimited: true, transient: false };
    try {
      const out = await embedder.embedBatch(inputs);
      if (!Array.isArray(out) || out.length !== inputs.length) {
        throw new Error(`embedder returned ${Array.isArray(out) ? out.length : "no"} of ${inputs.length} vectors`);
      }
      noteSuccess();
      return { out, rateLimited: false, transient: false };
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      log.warn("raw units: embedding call failed", {
        batch: inputs.length,
        status,
        err: err instanceof Error ? err.message : String(err),
      });
      if (status !== 429) {
        // Transient: no status (connection reset/EOF), 5xx. Ollama also sheds load with 503, which lands here too and
        // is retried by splitting (smaller requests ease the load).
        const transient = status === undefined || (typeof status === "number" && status >= 500);
        return { out: null, rateLimited: false, transient };
      }
      rateLimited = true;
      noteRateLimit(err); // the next loop turn (and every other run) waits this out first
    }
  }
  return { out: null, rateLimited, transient: false };
}
