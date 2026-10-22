// Write path of the raw units (docs/design/i33-port.md section 5 PR 2).
//
// ensureSessionRawUnits(turns): build the units, and when the session's stored units are stale, embed first (outside
// any transaction, vectors reused by text_hash) and swap the rows in with ONE rpc (migration 130,
// replace_session_raw_units: delete + insert under a per-session advisory lock). Stale means
// units.source_hash != computeSourceHash(turns, UNITS_VERSION), never content_hash (which holds a "" sentinel
// mid-import), plus two repair cases: a unit whose embedding failed more than EMBED_RETRY_AFTER_SECONDS ago (the
// comparison runs in Postgres, raw_units_retry_due, never against this process's clock), and a unit stored under another
// embedding model than the current one.
//
// Bounds. Rows are written in ONE rpc when their estimated payload (texts plus vectors) fits CHUNK_BYTES; a larger session
// is written in chunks of at most CHUNK_BYTES: each chunk is staged (stage_session_raw_units, a table readers never
// see) and ONE commit call (commit_session_raw_units) swaps the complete set in atomically, so search sees the old
// units until the commit and the new complete set after it. Nothing is truncated. A failure between chunks leaves the
// old units in place and only orphan staged rows, collected by the next write. When a write fails after the embeddings
// were paid for, the vectors are cached per session and source hash (VECTOR_CACHE) and the failure is remembered for
// EMBED_RETRY_AFTER_SECONDS, so a retry neither loses the vectors nor re-embeds on every import.
//
// Self-healing: a crash after the turns are stored and before the units are written leaves no units (or old ones) whose
// source_hash differs, so the next import (even a skipped, unchanged one) or sweepSessionRawUnits rewrites them.
//
// Never throws. Any failure (unit building, embedding, the rpc, a missing migration) is logged and returns
// status "failed"; the rpc is atomic, so the session's previous units stay in place.

import { randomUUID } from "node:crypto";

import type { Db } from "@/lib/db/types";
import { currentEmbeddingFamily } from "@/lib/llm/embedding-client";
import { isLocalRuntime } from "@/lib/llm/embedding-family";
import { parseVector, toVectorString } from "@/lib/llm/vector";
import { log } from "@/lib/log";
import {
  createDefaultUnitEmbedder,
  EMBED_RETRY_AFTER_SECONDS,
  embedUnitTexts,
  type ReusableVector,
  type UnitEmbedder,
  unitEmbeddingModel,
  unitTextHash,
} from "./embed";
import { buildRawUnits, computeSourceHash, type RawUnit, UNITS_VERSION, type UnitTurn } from "./units";

/** "superseded": the session's content changed under this writer (newer import won); nothing was written. */
export type EnsureStatus = "current" | "written" | "failed" | "superseded";

/**
 * Payload bound of one rpc (texts plus vectors as text). A session over it is written in chunks of this size, staged
 * and then committed in one transaction.
 */
export const CHUNK_BYTES = 8 * 1024 * 1024;
// pgvector text is "[0.0123456789,...]": up to ~24 chars per dimension, plus JSON escaping of the string.
const VECTOR_BYTES = 1536 * 24 + 512;
const ROW_OVERHEAD_BYTES = 512;

const RETRY_BACKOFF_MS = EMBED_RETRY_AFTER_SECONDS * 1000;
const VECTOR_CACHE_SESSIONS = 16;
/**
 * Vectors of a FAILED replace rpc, per session and source hash, so the retry does not re-embed. Filled only on
 * failure, cleared on success. Process-local, FIFO-bounded to a few sessions.
 */
const VECTOR_CACHE = new Map<string, { sourceHash: string; model: string | null; vectors: ReusableVector[] }>();
/** session -> source hash whose rpc failed, and until when it is not retried. Process-local. */
const RPC_BACKOFF = new Map<string, { sourceHash: string; until: number }>();

/** Test hook: forget the process-local caches. */
export function resetRawUnitsCaches(): void {
  VECTOR_CACHE.clear();
  RPC_BACKOFF.clear();
}

export interface EnsureResult {
  status: EnsureStatus;
  /** Units in the session's new set (status "written"/"current"). */
  units?: number;
  embedded?: number;
  reused?: number;
  /** Units stored without a vector (embedding failed or no provider). */
  unembedded?: number;
  error?: string;
  /** Number of staged chunks (0 = written with the single replace rpc). */
  chunks?: number;
}

type UnitRow = ReturnType<typeof unitRow>;

/** Estimated rpc bytes of one row: its texts, its vector as text and the row overhead. */
export function rowBytes(r: { text: string; full_text?: string | null; turn_text?: string | null }): number {
  // JSON-escaped size (quotes, backslashes, control characters and non-ASCII expand in the rpc body). full_text is the
  // whole turn and stays uncapped: capping it would change the lab-parity text.
  const json = (v: string | null | undefined) => (v ? Buffer.byteLength(JSON.stringify(v)) : 0);
  return json(r.text) + json(r.full_text) + json(r.turn_text) + VECTOR_BYTES + ROW_OVERHEAD_BYTES;
}

/** Splits rows into consecutive chunks of at most maxBytes (a single row over the bound gets a chunk of its own). */
export function chunkRows<T extends { text: string; full_text?: string | null; turn_text?: string | null }>(
  rows: T[],
  maxBytes = CHUNK_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const r of rows) {
    const sz = rowBytes(r);
    if (cur.length > 0 && used + sz > maxBytes) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(r);
    used += sz;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export interface RawUnitsOptions {
  /** code_sessions.content_hash the caller computed; the rpc refuses (-2) if the stored one differs. Null = no check. */
  contentHash?: string | null;
  /** The embedder; null = no provider (units stored without vectors); omitted = built from the environment. */
  embedder?: UnitEmbedder | null;
  /** The embedding family when there is no embedder; defaults to the environment's. */
  family?: string;
  now?: () => number;
}

/**
 * Whether the import hook writes units. Hosted serves cards only for now (design D6), so units are written on a local
 * run only (MEMBRAL_LOCAL=1 and not on Vercel). The repair sweep and the backfill call the functions below directly.
 */
export function rawUnitsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isLocalRuntime(env);
}

interface StoredUnitState {
  source_hash: string;
  units_version: number;
  embedding_model: string | null;
  embedding_failed_at: string | null;
}

const PAGE = 1000;

/** Reads every row of a query in pages (PostgREST caps a response at 1,000 rows). */
async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/**
 * True when the stored units no longer match what the turns (and the current embedding model) would produce. Failed
 * units are not judged here: whether their retry is due is asked of Postgres (raw_units_retry_due).
 */
export function unitsAreStale(
  stored: StoredUnitState[],
  expected: { sourceHash: string; unitsVersion: number; model: string | null; count: number },
): boolean {
  if (stored.length !== expected.count) return true;
  for (const u of stored) {
    if (u.source_hash !== expected.sourceHash || u.units_version !== expected.unitsVersion) return true;
    if (!u.embedding_failed_at && (u.embedding_model ?? null) !== expected.model) return true;
  }
  return false;
}

/**
 * Sends the finished rows: one replace rpc when they fit CHUNK_BYTES, else staged chunks plus one commit. Returns the
 * rpc's result (rows written, -1 current, -2 content changed) and throws on any error, including an incomplete commit
 * (-3), so the caller keeps the vectors and backs off; the old units are untouched in every failure case.
 */
async function sendRows(
  supabase: Db,
  userId: string,
  sessionId: string,
  rows: UnitRow[],
  sourceHash: string,
  contentHash: string | null,
): Promise<{ result: number; chunks: number }> {
  const parts = chunkRows(rows);
  if (parts.length <= 1) {
    const { data, error } = await supabase.rpc("replace_session_raw_units", {
      p_user_id: userId,
      p_code_session_id: sessionId,
      p_rows: rows,
      p_source_hash: sourceHash,
      p_units_version: UNITS_VERSION,
      p_content_hash: contentHash,
    });
    if (error || typeof data !== "number") {
      throw new Error(
        error
          ? `replace_session_raw_units failed: ${error.message}`
          : `replace_session_raw_units returned ${JSON.stringify(data)}`,
      );
    }
    return { result: data, chunks: 0 };
  }
  const runId = randomUUID();
  for (const part of parts) {
    const { data, error } = await supabase.rpc("stage_session_raw_units", {
      p_user_id: userId,
      p_code_session_id: sessionId,
      p_run_id: runId,
      p_rows: part,
    });
    if (error || data !== part.length) {
      throw new Error(
        error
          ? `stage_session_raw_units failed: ${error.message}`
          : `stage_session_raw_units staged ${JSON.stringify(data)} of ${part.length}`,
      );
    }
  }
  const { data, error } = await supabase.rpc("commit_session_raw_units", {
    p_user_id: userId,
    p_code_session_id: sessionId,
    p_run_id: runId,
    p_expected_count: rows.length,
    p_source_hash: sourceHash,
    p_units_version: UNITS_VERSION,
    p_content_hash: contentHash,
  });
  if (error || typeof data !== "number" || data === -3) {
    throw new Error(
      error
        ? `commit_session_raw_units failed: ${error.message}`
        : `commit_session_raw_units returned ${JSON.stringify(data)} (incomplete or superseded run)`,
    );
  }
  return { result: data, chunks: parts.length };
}

/** code_sessions.content_hash of the session ("" = an import is mid-flight). Throws when the session is missing. */
async function readContentHash(supabase: Db, userId: string, sessionId: string): Promise<string> {
  const sess = await supabase
    .from("code_sessions")
    .select("content_hash")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (sess.error) throw new Error(sess.error.message);
  const hash = (sess.data as { content_hash?: string } | null)?.content_hash;
  if (hash === undefined) throw new Error("session not found");
  return hash;
}

export async function ensureSessionRawUnits(
  supabase: Db,
  userId: string,
  sessionId: string,
  turns: UnitTurn[],
  opts: RawUnitsOptions = {},
): Promise<EnsureResult> {
  try {
    // A caller without a content hash (the PR 3 backfill) gets the stored one, so the rpc's -2 guard protects it too;
    // the "" sentinel (an import is mid-flight) means there is nothing to do yet. An explicit null opts out.
    if (opts.contentHash === undefined) {
      const stored = await readContentHash(supabase, userId, sessionId);
      if (stored === "") return { status: "superseded" };
      opts = { ...opts, contentHash: stored };
    }
    const now = (opts.now ?? Date.now)();
    turns = [...turns].sort((a, b) => a.idx - b.idx); // import and sweep must hash the same order
    const embedder = opts.embedder === undefined ? createDefaultUnitEmbedder() : opts.embedder;
    const family = embedder?.family ?? opts.family ?? currentEmbeddingFamily();
    const model = unitEmbeddingModel(family);

    const units = buildRawUnits(turns);
    const sourceHash = computeSourceHash(turns, UNITS_VERSION);

    const stored = await readAll<StoredUnitState>((from, to) =>
      supabase
        .from("session_raw_units")
        .select("source_hash, units_version, embedding_model, embedding_failed_at")
        .eq("user_id", userId)
        .eq("code_session_id", sessionId)
        .order("id")
        .range(from, to),
    );
    if (units.length === 0 && stored.length === 0) return { status: "current", units: 0 };
    if (
      units.length > 0 &&
      !unitsAreStale(stored, { sourceHash, unitsVersion: UNITS_VERSION, model, count: units.length })
    ) {
      const anyFailed = stored.some((u) => u.embedding_failed_at);
      if (!anyFailed || !(await retryDue(supabase, userId, sessionId)))
        return { status: "current", units: units.length };
    }
    const backoff = RPC_BACKOFF.get(sessionId);
    if (backoff && backoff.sourceHash === sourceHash && now < backoff.until) {
      return { status: "failed", error: "rpc failed recently for this content; waiting before retrying" };
    }

    // Vectors the session already holds, for the texts that did not change.
    let reuse: ReusableVector[] = [];
    if (units.length > 0 && stored.length > 0) {
      try {
        const old = await readAll<{ text_hash: string; embedding: unknown; embedding_model: string | null }>(
          (from, to) =>
            supabase
              .from("session_raw_units")
              .select("text_hash, embedding, embedding_model")
              .eq("user_id", userId)
              .eq("code_session_id", sessionId)
              .order("id")
              .range(from, to),
        );
        reuse = old.map((o) => ({
          text_hash: o.text_hash,
          embedding_model: o.embedding_model ?? null,
          vector: parseVector(o.embedding),
        }));
      } catch (err) {
        log.warn("raw units: could not read stored vectors for reuse", { session_id: sessionId, err: msg(err) });
      }
    }

    const cached = VECTOR_CACHE.get(sessionId);
    const cachedVectors = cached && cached.sourceHash === sourceHash && cached.model === model ? cached.vectors : [];
    const emb = await embedUnitTexts(
      units.map((u) => u.text),
      embedder,
      family,
      [...reuse, ...cachedVectors],
    );
    const rows = units.map((u) => unitRow(u, family, model, emb.vectors));
    const unembedded = rows.filter((r) => r.embedding_failed).length;

    let data: number;
    let chunks = 0;
    try {
      const sent = await sendRows(supabase, userId, sessionId, rows, sourceHash, opts.contentHash ?? null);
      data = sent.result;
      chunks = sent.chunks;
    } catch (err) {
      VECTOR_CACHE.delete(sessionId);
      VECTOR_CACHE.set(sessionId, {
        sourceHash,
        model,
        vectors: [...emb.vectors].flatMap(([text_hash, vector]) =>
          vector ? [{ text_hash, embedding_model: model, vector }] : [],
        ),
      });
      if (VECTOR_CACHE.size > VECTOR_CACHE_SESSIONS) VECTOR_CACHE.delete(VECTOR_CACHE.keys().next().value as string);
      RPC_BACKOFF.set(sessionId, { sourceHash, until: now + RETRY_BACKOFF_MS });
      throw err;
    }
    RPC_BACKOFF.delete(sessionId);
    VECTOR_CACHE.delete(sessionId);
    if (data === -2) {
      log.info("raw units: content changed under this writer, nothing written", { session_id: sessionId });
      return { status: "superseded" };
    }
    // -1: a concurrent writer already stored these exact rows.
    return {
      status: data === -1 ? "current" : "written",
      units: units.length,
      embedded: emb.embedded,
      reused: emb.reused,
      unembedded,
      chunks,
    };
  } catch (err) {
    log.warn("raw units: generation failed, existing units left in place", {
      user_id: userId,
      session_id: sessionId,
      err: msg(err),
    });
    return { status: "failed", error: msg(err) };
  }
}

/**
 * Repair entrypoint (the PR 3 backfill and any sweep): loads the session's stored turns and runs
 * ensureSessionRawUnits. Never throws.
 */
export async function sweepSessionRawUnits(
  supabase: Db,
  userId: string,
  sessionId: string,
  opts: RawUnitsOptions = {},
): Promise<EnsureResult> {
  try {
    // The content hash is read BEFORE the turns: a "" sentinel means an import is mid-flight (turns not final), so
    // there is nothing to do yet; otherwise the hash goes to the rpc, which refuses (-2) if the content moved on.
    const contentHash = await readContentHash(supabase, userId, sessionId);
    if (contentHash === "") return { status: "superseded" };
    opts = { ...opts, contentHash };
    const turns = await readAll<UnitTurn>((from, to) =>
      supabase
        .from("code_session_turns")
        .select("idx, role, kind, text")
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .order("idx")
        .range(from, to),
    );
    return await ensureSessionRawUnits(supabase, userId, sessionId, turns, opts);
  } catch (err) {
    log.warn("raw units: could not load turns for the sweep", { session_id: sessionId, err: msg(err) });
    return { status: "failed", error: msg(err) };
  }
}

/** Asks Postgres whether a failed embedding is old enough to retry. An error (e.g. function missing) means "not due". */
async function retryDue(supabase: Db, userId: string, sessionId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("raw_units_retry_due", {
      p_user_id: userId,
      p_code_session_id: sessionId,
      p_retry_seconds: EMBED_RETRY_AFTER_SECONDS,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

function unitRow(u: RawUnit, family: string, model: string | null, vectors: Map<string, number[] | null>) {
  const vec = vectors.get(unitTextHash(u.text, family)) ?? null;
  return {
    unit: u.unit,
    ord: u.ord,
    turn_idx: u.turn_idx,
    turn_from: u.turn_from,
    turn_to: u.turn_to,
    parts: u.unit === "turn" ? { turn_len: u.turn_len } : u.parts,
    win: u.win ? `[${u.win[0]},${u.win[1]})` : null,
    text: u.text,
    full_text: u.full_text,
    turn_text: u.turn_text,
    embedding: vec ? toVectorString(vec) : null,
    // Always the intended model: the rpc compares it to skip a rewrite, and nulls it for a unit without a vector.
    embedding_model: model,
    embedding_failed: vec === null,
    text_hash: unitTextHash(u.text, family),
  };
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
