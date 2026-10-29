// Local re-embed: moves a store's vectors to the embedding model the stack is configured with.
//
// Why: every stored vector records its family in `embedding_model` (migration 118) and the store never holds two
// (lib/llm/embedding-family.ts). After the local embedder is switched, the write guard refuses every new vector and
// search filters the vector leg to the configured family, so old rows stay keyword-only until they are re-embedded.
// `membral local reembed` drives POST /api/internal/local/reembed, which calls reembedBatch once per request.
//
// One call handles ONE batch of ONE table, in REEMBED_TABLES order. A row is selected when its vector is missing
// (and it has not been retired as un-embeddable) or its `embedding_model` is not the configured family's value; rows
// of the configured family are never read or written. Keyset order by id plus a caller-held cursor (`after`) makes a
// run finish even when some rows keep failing; a fresh run starts again from the top and finds only what is left, so
// the whole thing is resumable and idempotent.
//
// Text embedded per table is what each table's own writer embeds:
//   session_memories    `text`                                   (lib/memory/embed.ts)
//   conversations       prepareTextForEmbedding(title, messages) (lib/conversation-embeddings.ts)
//   conversation_chunks `text`                                   (lib/conversation-chunks.ts)
//   session_raw_units   `text`, nomic: `search_document: ` prefix; model `<family>+doc-v1`, text_hash re-keyed
//                       (lib/memory/raw-units/embed.ts)
//
// A row is RETIRED (vector and model cleared, keyword-only, `embedding_failed_at` set where the table has that column)
// only when its own text is definitively un-embeddable: a per-text 4xx (400/413/422...), or a token overflow that
// MAX_HALVINGS halvings of the text cannot fix. Anything transient (5xx, timeout, connection reset, no status, an
// unusable vector) leaves the row UNTOUCHED, still carrying its old vector, and counts as `deferred`: the cursor moves
// past it and a re-run selects it again. Retirement is also refused unless something else in the batch embedded or a
// canary text does (a misconfigured model that 400s everything must not retire a whole store). If nothing embeds the
// provider is treated as down: no row is touched and the caller gets `embedder_unavailable`. A 429 aborts the call
// before any write and is handed to the caller with `retry_after_ms` (CLAUDE.md rule 4: the CLI owns the backoff).
// A model wider than the column (EmbeddingDimensionError) aborts the call before any write as `embedding_dimension`.
// One call is bounded by a time budget (REEMBED_BATCH_BUDGET_MS, well under the CLI's 10 minute abort): when it runs
// out the call stops, writes what it has and returns the cursor past the last text it tried.

import type { Db } from "@/lib/db/types";
import { prepareTextForEmbedding } from "@/lib/embeddings";
import {
  canonicalEmbeddingFamily,
  EMBEDDING_DIMENSIONS,
  EmbeddingDimensionError,
  embeddingModelField,
} from "@/lib/llm/embedding-client";
import { invalidateEmbeddingFamilyCache } from "@/lib/llm/embedding-family";
import { toVectorString } from "@/lib/llm/vector";
import { log } from "@/lib/log";
import {
  EMBED_BREAKER_FAILURES,
  embedInput,
  isUsableVector,
  SPLIT_RETRY_FACTOR,
  type UnitEmbedder,
  unitEmbeddingModel,
  unitTextHash,
} from "@/lib/memory/raw-units/embed";

export const REEMBED_TABLES = [
  "session_memories",
  "conversations",
  "conversation_chunks",
  "session_raw_units",
] as const;
export type ReembedTable = (typeof REEMBED_TABLES)[number];

export const DEFAULT_REEMBED_BATCH = 64;
export const MAX_REEMBED_BATCH = 256;
/** Row updates in flight at once while writing a batch. */
const WRITE_CONCURRENCY = 8;
/** One request stops embedding after this long (the CLI aborts a request at 10 minutes). */
export const REEMBED_BATCH_BUDGET_MS = 4 * 60_000;
/** Reactive halvings of one text on a token overflow (mirrors MAX_HALVINGS in lib/embeddings.ts, which does not export it). */
const MAX_HALVINGS = 3;
/** A halved text is never cut below this many characters. */
const MIN_HALVED_CHARS = 200;
/** Rows per request for tables whose rows are big (conversations select `messages`). */
const TABLE_BATCH_CAP: Partial<Record<ReembedTable, number>> = { conversations: 32 };

interface TableSpec {
  select: string;
  /** Has `embedding_failed_at` (session_memories does not). */
  hasFailedAt: boolean;
  /** Extra filter on the selection (chunks: empty text is a coverage sentinel, never embedded). */
  nonEmptyText: boolean;
  /** The text to embed for a row, or null when there is nothing to embed. */
  text(row: Record<string, unknown>): string | null;
  /** The `embedding_model` value rows of `family` carry in this table (null = the default family). */
  model(family: string): string | null;
  /** Columns written next to the vector (raw units re-key text_hash). */
  extra?(row: Record<string, unknown>, family: string): Record<string, unknown>;
  /** The exact string sent to the embedder. */
  input?(text: string, family: string): string;
}

const plainModel = (family: string): string | null => embeddingModelField(true, family).embedding_model ?? null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

const SPECS: Record<ReembedTable, TableSpec> = {
  session_memories: {
    select: "id, text, embedding_model",
    hasFailedAt: false,
    nonEmptyText: false,
    text: (r) => str(r.text),
    model: plainModel,
  },
  conversations: {
    select: "id, title, messages, embedding_model",
    hasFailedAt: true,
    nonEmptyText: false,
    text: (r) => {
      const messages = Array.isArray(r.messages) ? (r.messages as Array<{ role?: unknown; content?: unknown }>) : [];
      return prepareTextForEmbedding(
        typeof r.title === "string" ? r.title : "",
        messages.map((m) => ({
          role: typeof m.role === "string" ? m.role : "",
          content: typeof m.content === "string" ? m.content : "",
        })),
      );
    },
    model: plainModel,
  },
  conversation_chunks: {
    select: "id, text, embedding_model",
    hasFailedAt: true,
    nonEmptyText: true,
    text: (r) => str(r.text),
    model: plainModel,
  },
  session_raw_units: {
    select: "id, text, embedding_model",
    hasFailedAt: true,
    nonEmptyText: false,
    text: (r) => str(r.text),
    model: (family) => unitEmbeddingModel(family),
    extra: (r, family) => ({ text_hash: unitTextHash(String(r.text), family) }),
    input: (text, family) => embedInput(text, family),
  },
};

/**
 * PostgREST `or` filter for "rows that need a new vector" for rows whose configured model value is `target`.
 * Without `embedding_failed_at` (session_memories) a never-embedded row cannot be told from an unembeddable one, so
 * only foreign-family rows (vector present, model differs) are selected; never-embedded rows stay with the normal
 * write path.
 */
export function reembedFilter(target: string | null, hasFailedAt: boolean): string {
  const foreign =
    target === null
      ? "and(embedding.not.is.null,embedding_model.not.is.null)"
      : `and(embedding.not.is.null,or(embedding_model.is.null,embedding_model.neq.${JSON.stringify(target)}))`;
  return hasFailedAt ? `and(embedding.is.null,embedding_failed_at.is.null),${foreign}` : foreign;
}

export interface ReembedCursor {
  table: ReembedTable;
  /** Last id handled in `table`; the next call selects ids above it. */
  after: string | null;
}

export interface ReembedInput {
  family: string;
  /** null = no embedding provider is configured. */
  embedder: UnitEmbedder | null;
  batch?: number;
  dryRun?: boolean;
  cursor?: ReembedCursor | null;
  /** Time budget for the embedding phase of this call (default REEMBED_BATCH_BUDGET_MS). */
  budgetMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface TableCounts {
  /** Rows a run would (re-)embed now. */
  remaining: number;
  /** Rows without a vector (not retired). Informational for tables without `embedding_failed_at`: not in `remaining`. */
  missing: number;
  /** Rows holding a vector of another family, default-family (NULL model) vectors counted apart from named ones. */
  foreign_default: number;
  foreign_other: number;
}

export interface ReembedResult {
  ok: true;
  family: string;
  /** The table this call worked on (the last one examined when everything is done). */
  table: ReembedTable | null;
  /** Rows re-embedded and written by this call. */
  done: number;
  /** Rows retired by this call (their own text cannot be embedded: per-text 4xx or an overflow halving cannot fix). */
  failed: number;
  /** Rows left untouched after a transient failure (5xx, timeout, reset); they keep their old vector and a re-run picks them up. */
  deferred: number;
  /** Counted on the first call (no cursor), on a dry run and when finished; null on the calls in between. */
  remaining_by_table: Record<ReembedTable, number> | null;
  /** True when nothing is left to select past the cursor: the run is over. */
  finished: boolean;
  /** Pass back as the next call's cursor; null when finished. */
  next: ReembedCursor | null;
  /** Dry run only: counts per table. */
  counts?: Record<ReembedTable, TableCounts>;
  dry_run: boolean;
}

export type ReembedError =
  | { ok: false; code: "no_embedder"; message: string }
  | { ok: false; code: "rate_limited"; message: string; retryAfterMs: number | null }
  | { ok: false; code: "embedder_unavailable"; message: string }
  | { ok: false; code: "embedding_dimension"; message: string; dimensions: number }
  | { ok: false; code: "db"; message: string };

type Row = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: one PostgREST builder shape reused across four table shapes.
type PgQuery = any;

async function count(
  db: Db,
  table: ReembedTable,
  filter: string | null,
  extra?: (q: PgQuery) => PgQuery,
): Promise<number> {
  let q: PgQuery = db.from(table).select("id", { count: "exact", head: true });
  if (filter) q = q.or(filter);
  if (extra) q = extra(q);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: count failed: ${error.message}`);
  return n ?? 0;
}

async function remainingFor(db: Db, table: ReembedTable, family: string): Promise<number> {
  const spec = SPECS[table];
  return count(db, table, reembedFilter(spec.model(family), spec.hasFailedAt), (q) =>
    spec.nonEmptyText ? q.neq("text", "") : q,
  );
}

async function countsFor(db: Db, table: ReembedTable, family: string): Promise<TableCounts> {
  const spec = SPECS[table];
  const target = spec.model(family);
  const notText = (q: PgQuery) => (spec.nonEmptyText ? q.neq("text", "") : q);
  const missing = await count(db, table, null, (q) => {
    const m = notText(q).is("embedding", null);
    return spec.hasFailedAt ? m.is("embedding_failed_at", null) : m;
  });
  const foreignDefault =
    target === null
      ? 0
      : await count(db, table, null, (q) => notText(q).not("embedding", "is", null).is("embedding_model", null));
  const foreignAny = await count(db, table, null, (q) => {
    const base = notText(q).not("embedding", "is", null);
    return target === null
      ? base.not("embedding_model", "is", null)
      : base.or(`embedding_model.is.null,embedding_model.neq.${JSON.stringify(target)}`);
  });
  return {
    remaining: (spec.hasFailedAt ? missing : 0) + foreignAny,
    missing,
    foreign_default: foreignDefault,
    foreign_other: foreignAny - foreignDefault,
  };
}

function isRateLimit(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 429;
}

function retryAfter(err: unknown): number | null {
  const h = (err as { headers?: unknown } | null)?.headers as
    | { get?: (n: string) => string | null }
    | Record<string, unknown>
    | undefined;
  const raw =
    h && typeof (h as { get?: unknown }).get === "function"
      ? (h as { get: (n: string) => string | null }).get("retry-after")
      : (h as Record<string, unknown> | undefined)?.["retry-after"];
  const secs = Number(raw);
  return raw !== undefined && raw !== null && Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

/** What became of one text: embedded, definitively un-embeddable (retire the row), or failed transiently (leave it). */
type Outcome = { kind: "ok"; vector: number[] } | { kind: "retire" } | { kind: "defer" };
/** A condition that ends the whole call before any write. */
type Stop = { kind: "rate_limited"; retryAfterMs: number | null } | { kind: "dimension"; dimensions: number };

interface EmbedRun {
  /** Outcomes of the leading `outcomes.length` inputs; later inputs were not attempted (budget or breaker). */
  outcomes: Outcome[];
  stop: Stop | null;
}

/** Same gate as lib/embeddings.ts isTokenOverflowError (not exported there): a 400 / context_length_exceeded that says the input was too long. */
function isTokenOverflow(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; code?: string };
  if (e.status !== 400 && e.code !== "context_length_exceeded") return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("maximum context length") ||
    (msg.includes("token") && (msg.includes("exceed") || msg.includes("too long") || msg.includes("too many")))
  );
}

/**
 * A per-text rejection: the provider answered and refused THIS input. 401/403 (auth), 404 (model or route missing),
 * 408 (timeout) and 429 say nothing about the text, and a missing status or a 5xx is a transient fault.
 */
function isPermanentRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status);
}

const isTransient = (err: unknown): boolean => {
  const status = (err as { status?: unknown } | null)?.status;
  return status === undefined || (typeof status === "number" && status >= 500);
};

/** One text on its own, halving it on a token overflow (up to MAX_HALVINGS, drawing on the shared `pool`). */
async function embedOne(embedder: UnitEmbedder, text: string, pool: { halvings: number }): Promise<Outcome | Stop> {
  let attemptText = text;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await embedder.embedBatch([attemptText]);
      const v: unknown = Array.isArray(out) ? out[0] : undefined;
      if (isUsableVector(v)) return { kind: "ok", vector: v };
      if (Array.isArray(v) && v.length > EMBEDDING_DIMENSIONS) return { kind: "dimension", dimensions: v.length };
      return { kind: "defer" };
    } catch (err) {
      if (isRateLimit(err)) return { kind: "rate_limited", retryAfterMs: retryAfter(err) };
      if (err instanceof EmbeddingDimensionError) return { kind: "dimension", dimensions: err.dimensions };
      if (isTokenOverflow(err)) {
        const next = Math.max(MIN_HALVED_CHARS, Math.floor(attemptText.length / 2));
        if (attempt >= MAX_HALVINGS || next >= attemptText.length) return { kind: "retire" };
        if (pool.halvings <= 0) return { kind: "defer" }; // the halving pool ran out: not a fair verdict on this text
        pool.halvings--;
        attemptText = attemptText.slice(0, next);
        continue;
      }
      return { kind: isPermanentRejection(err) ? "retire" : "defer" };
    }
  }
}

/**
 * Embeds `inputs` (in order). One batch call first; if it fails, one text at a time with the embedUnitTexts breaker
 * (EMBED_BREAKER_FAILURES consecutive transient failures end the attempt), a shared cap on halving calls, and a time
 * budget checked before every text after the first. Texts not reached keep no outcome (the caller leaves them for the
 * next call). A 429 or a too-wide model ends the run with a Stop.
 */
async function embedAll(
  embedder: UnitEmbedder,
  inputs: string[],
  clock: { now: () => number; deadline: number },
): Promise<EmbedRun> {
  const outcomes: Outcome[] = [];
  let streak = 0;
  try {
    const got = await embedder.embedBatch(inputs);
    if (!Array.isArray(got) || got.length !== inputs.length) throw new Error("embedder returned a short batch");
    for (const v of got) {
      if (Array.isArray(v) && v.length > EMBEDDING_DIMENSIONS) {
        return { outcomes: [], stop: { kind: "dimension", dimensions: v.length } };
      }
      outcomes.push(isUsableVector(v) ? { kind: "ok", vector: v } : { kind: "defer" });
    }
    return { outcomes, stop: null };
  } catch (err) {
    if (isRateLimit(err)) return { outcomes: [], stop: { kind: "rate_limited", retryAfterMs: retryAfter(err) } };
    if (err instanceof EmbeddingDimensionError) {
      return { outcomes: [], stop: { kind: "dimension", dimensions: err.dimensions } };
    }
    log.warn("local_reembed: batch embed failed, retrying one text at a time", {
      size: inputs.length,
      err: err instanceof Error ? err.message : String(err),
    });
    streak = isTransient(err) ? 1 : 0;
  }
  const pool = { halvings: SPLIT_RETRY_FACTOR * Math.max(1, Math.ceil(inputs.length / 100)) };
  for (let i = 0; i < inputs.length; i++) {
    if (i > 0 && (clock.now() >= clock.deadline || streak >= EMBED_BREAKER_FAILURES)) break;
    const o = await embedOne(embedder, inputs[i], pool);
    if (o.kind === "rate_limited" || o.kind === "dimension") return { outcomes: [], stop: o };
    streak = o.kind === "defer" ? streak + 1 : 0;
    outcomes.push(o);
  }
  return { outcomes, stop: null };
}

async function inChunks<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/** Restricts an update to the row as it was selected: a row another writer refreshed since is not clobbered. */
function ifModelUnchanged(q: PgQuery, row: Row): PgQuery {
  const old = row.embedding_model;
  return typeof old === "string" ? q.eq("embedding_model", old) : q.is("embedding_model", null);
}

async function remainingByTable(db: Db, family: string): Promise<Record<ReembedTable, number>> {
  const remaining = {} as Record<ReembedTable, number>;
  for (const t of REEMBED_TABLES) remaining[t] = await remainingFor(db, t, family);
  return remaining;
}

/** Handles up to one batch of the first table (from the cursor) that has work. Never throws: errors come back as ReembedError. */
export async function reembedBatch(db: Db, input: ReembedInput): Promise<ReembedResult | ReembedError> {
  const family = canonicalEmbeddingFamily(input.family);
  const requested = Math.min(
    Math.max(Math.trunc(input.batch ?? DEFAULT_REEMBED_BATCH) || DEFAULT_REEMBED_BATCH, 1),
    MAX_REEMBED_BATCH,
  );
  const dryRun = input.dryRun === true;
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? REEMBED_BATCH_BUDGET_MS);
  try {
    if (dryRun) {
      const remaining = {} as Record<ReembedTable, number>;
      const counts = {} as Record<ReembedTable, TableCounts>;
      for (const t of REEMBED_TABLES) {
        counts[t] = await countsFor(db, t, family);
        remaining[t] = counts[t].remaining;
      }
      return {
        ok: true,
        family,
        table: null,
        done: 0,
        failed: 0,
        deferred: 0,
        remaining_by_table: remaining,
        finished: true,
        next: null,
        counts,
        dry_run: true,
      };
    }
    if (!input.embedder || input.embedder.family !== family) {
      return {
        ok: false,
        code: "no_embedder",
        message:
          "No embedding provider is configured for this stack. Set MEMBRAL_EMBEDDINGS_BASE_URL and MEMBRAL_EMBEDDING_MODEL (`membral local up --embeddings ollama`), or use the bundled model.",
      };
    }

    const startIdx = input.cursor ? REEMBED_TABLES.indexOf(input.cursor.table) : 0;
    let table: ReembedTable | null = null;
    let rows: Row[] = [];
    let after = input.cursor?.after ?? null;
    for (let i = Math.max(startIdx, 0); i < REEMBED_TABLES.length; i++) {
      const t = REEMBED_TABLES[i];
      const spec = SPECS[t];
      let q: PgQuery = db
        .from(t)
        .select(spec.select)
        .or(reembedFilter(spec.model(family), spec.hasFailedAt));
      if (spec.nonEmptyText) q = q.neq("text", "");
      if (after) q = q.gt("id", after);
      const { data, error } = await q
        .order("id", { ascending: true })
        .limit(Math.min(requested, TABLE_BATCH_CAP[t] ?? requested));
      if (error) return { ok: false, code: "db", message: `${t}: ${error.message}` };
      table = t;
      if (data && data.length > 0) {
        rows = data as Row[];
        break;
      }
      after = null; // exhausted: the next table starts from its top
    }

    let done = 0;
    let failed = 0;
    let deferred = 0;
    if (table && rows.length > 0) {
      const spec = SPECS[table];
      const jobs: Array<{ row: Row; input: string }> = [];
      const noText: Row[] = []; // nothing to embed: retired below
      for (const row of rows) {
        const text = spec.text(row);
        if (text === null) noText.push(row);
        else jobs.push({ row, input: spec.input ? spec.input(text, family) : text });
      }
      const run: EmbedRun = jobs.length
        ? await embedAll(
            input.embedder,
            jobs.map((j) => j.input),
            { now, deadline },
          )
        : { outcomes: [], stop: null };
      // Every exit before this point and these two returns has written nothing.
      if (run.stop?.kind === "rate_limited") {
        return {
          ok: false,
          code: "rate_limited",
          message: "The embedding provider answered 429.",
          retryAfterMs: run.stop.retryAfterMs,
        };
      }
      if (run.stop?.kind === "dimension") {
        return {
          ok: false,
          code: "embedding_dimension",
          message: `The embedding model "${family}" returns ${run.stop.dimensions}-dimension vectors; the store holds at most ${EMBEDDING_DIMENSIONS}. Nothing was changed. Use a model with ${EMBEDDING_DIMENSIONS} or fewer dimensions.`,
          dimensions: run.stop.dimensions,
        };
      }
      const outcomes = run.outcomes;
      if (jobs.length > 0 && !outcomes.some((o) => o.kind === "ok")) {
        // Nothing embedded. Unless a canary text still embeds (so the provider works and the texts themselves are
        // refused), treat the provider as down and touch nothing: a broken model must not retire the store.
        const canaryOk =
          outcomes.some((o) => o.kind === "retire") &&
          (await input.embedder
            .embedBatch([embedInput("membral reembed health check", family)])
            .then((v) => isUsableVector(v?.[0]))
            .catch(() => false));
        if (!canaryOk) {
          return {
            ok: false,
            code: "embedder_unavailable",
            message: `No text in this batch could be embedded with "${family}"; is the embedding server reachable and the model pulled? Nothing was changed.`,
          };
        }
      }
      const model = spec.model(family);
      const writes: Array<() => Promise<void>> = [];
      const retire: Row[] = [...noText];
      outcomes.forEach((o, i) => {
        const row = jobs[i].row;
        if (o.kind === "defer") deferred++;
        else if (o.kind === "retire") retire.push(row);
        else
          writes.push(async () => {
            if (o.vector.length !== EMBEDDING_DIMENSIONS) throw new Error("vector width");
            const { data, error } = await ifModelUnchanged(
              db
                .from(table as string)
                .update({
                  embedding: toVectorString(o.vector),
                  embedding_model: model,
                  ...(spec.hasFailedAt ? { embedding_failed_at: null } : {}),
                  ...(spec.extra ? spec.extra(row, family) : {}),
                })
                .eq("id", row.id as string),
              row,
            ).select("id");
            if (error) throw new Error(error.message);
            if (Array.isArray(data) && data.length > 0) done++;
            else log.warn("local_reembed: row changed since it was read; left as the other writer set it", { table });
          });
      });
      await inChunks(writes, WRITE_CONCURRENCY, async (w) => {
        try {
          await w();
        } catch (err) {
          // A failed write leaves the row as it was; it is selected again by the next run.
          log.warn("local_reembed: row update failed", {
            table,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      });
      await inChunks(retire, WRITE_CONCURRENCY, async (row) => {
        const { data, error } = await ifModelUnchanged(
          db
            .from(table as string)
            .update({
              embedding: null,
              embedding_model: null,
              ...(spec.hasFailedAt ? { embedding_failed_at: new Date().toISOString() } : {}),
            })
            .eq("id", row.id as string),
          row,
        ).select("id");
        if (error) log.warn("local_reembed: retire failed", { table, err: error.message });
        else if (Array.isArray(data) && data.length > 0) failed++;
      });
      // The cursor moves past the texts that were tried. A budget or breaker stop leaves the rest for the next call.
      const lastTried = outcomes.length < jobs.length ? jobs[outcomes.length - 1].row : rows[rows.length - 1];
      after = String(lastTried.id);
    }

    // Finished when this call found nothing past the cursor anywhere (rows seen above were all handled or retired).
    const finished = rows.length === 0;
    // Counting is four exact counts: only on the first call, and when the run is over.
    const remaining = finished || !input.cursor ? await remainingByTable(db, family) : null;
    invalidateEmbeddingFamilyCache();
    return {
      ok: true,
      family,
      table,
      done,
      failed,
      deferred,
      remaining_by_table: remaining,
      finished,
      next: finished || table === null ? null : { table, after },
      dry_run: false,
    };
  } catch (err) {
    return { ok: false, code: "db", message: err instanceof Error ? err.message : String(err) };
  }
}
