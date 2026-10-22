import { tryServiceClient } from "@/lib/db/clients";
import type { Db } from "@/lib/db/types";
import { SERVICE_ROLE_KEY_ENV } from "./env";
import { assertFeature } from "./feature-flags";
import { embedCostUsd } from "./llm/client";
import {
  callEmbeddingsCreate,
  EMBEDDING_DIMENSIONS,
  type EmbeddingRequestOptions,
  embedTimeoutMs,
  resolveEmbeddingConfig,
} from "./llm/embedding-client";
import { checkMonthlyCeiling, createSpendLedger, type SpendLedger } from "./llm/spend-ledger";
import { getOpenAI } from "./openai";

/**
 * Three of kg/types.ts's PassName members (conversation_embedding/
 * query_embedding added for issue #92; chunk_embedding added for goal
 * 2026-07-26 step 11 / #39) — declared locally here rather than imported so
 * lib/embeddings.ts doesn't take on a type-only dependency for what's
 * structurally just a string literal union; TS accepts an EmbeddingPass value
 * wherever a PassName is expected (e.g. createSpendLedger's
 * onSpend(CostRecord)) because it's a literal subset.
 */
export type EmbeddingPass = "conversation_embedding" | "query_embedding" | "chunk_embedding";

// Model id is resolved per-call via resolveEmbeddingConfig() (kg/embedding-client.ts)
// so a base-URL override (MEMBRAL_EMBEDDINGS_BASE_URL / MEMBRAL_MODEL_BASE_URL) and
// model override (MEMBRAL_EMBEDDING_MODEL) always take effect — see generateEmbedding.
// EMBEDDING_DIMENSIONS is imported from ./llm/embedding-client (the single source of
// truth for the pgvector column width) rather than kept as a local literal — it's
// safe to use even before resolveEmbeddingConfig runs (e.g. the empty-text early
// return below, which never calls the API at all).
const MAX_CHAR_BUDGET = 24000; // ~8000 tokens worth of characters, ASCII-assumption fast path
const MIN_CHAR_BUDGET = 1000; // never shrink below this — a near-empty embed is still better than none

// text-embedding-3-small's hard limit (issue #90). Kept a hair under 8192 so
// the proactive shrink has headroom before the reactive 400-halving ever needs
// to fire for a well-behaved script mix.
const TOKEN_ESTIMATE_LIMIT = 8000;

// Tiered chars-per-token heuristic (issue #90, adversarial review m1): a
// single "dense vs ascii" split over/under-shrinks scripts that sit between
// the two extremes — Cyrillic/Greek tokenize meaningfully denser than ASCII
// but far less densely than Devanagari or CJK in a BPE vocab trained
// predominantly on English/European text. This is a per-codepoint-CLASS
// range table, not a word-list — works for any script, not just Hindi.
const CHARS_PER_TOKEN_ASCII = 4; // Basic Latin .. combining diacritics (< U+0370)
const CHARS_PER_TOKEN_CYRILLIC_GREEK = 2.2; // Greek and Coptic (0370-03FF) + Cyrillic/Cyrillic Supplement (0400-052F)
const CHARS_PER_TOKEN_CJK = 1.5; // Hiragana/Katakana, CJK Unified+Ext A, Hangul syllables, CJK Compatibility Ideographs
const CHARS_PER_TOKEN_DENSE_OTHER = 1.0; // Devanagari + other Indic scripts, Arabic, Hebrew, Thai, etc. — conservative default for anything else non-ASCII

/** Max reactive halvings on a token-overflow 400 before giving up permanently (issue #90). */
const MAX_HALVINGS = 3;

/**
 * Thrown when the per-user monthly spend ceiling (checkMonthlyCeiling,
 * kg/spend-ledger.ts) has already been reached — issue #92. Deliberately NOT
 * a plain Error: callers must special-case this the same way KG callers
 * special-case CostCapExceededError (kg/llm.ts) — "stop, don't fail" for
 * ingest, "degrade gracefully" for query-time callers — never "this text
 * failed to embed."
 */
export class EmbeddingCeilingExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly ceilingUsd: number,
  ) {
    super(
      `Monthly embedding cost ceiling exceeded: spent $${spentUsd.toFixed(4)} >= ceiling $${ceilingUsd.toFixed(4)}`,
    );
    this.name = "EmbeddingCeilingExceededError";
  }
}

/**
 * Thrown when a piece of text still 400s as a token-overflow after
 * `MAX_HALVINGS` reactive halvings (issue #90). Distinct from a plain Error
 * so callers (conversation-embeddings.ts) can tell "permanently
 * un-embeddable, stop re-selecting this row" apart from a transient failure
 * that should simply be retried on the next sync.
 */
export class EmbeddingTokenOverflowError extends Error {
  constructor(public readonly lastMessage: string) {
    super(`Embedding permanently failed after ${MAX_HALVINGS} halving(s) (token overflow): ${lastMessage}`);
    this.name = "EmbeddingTokenOverflowError";
  }
}

/** Per-codepoint chars-per-token tier (issue #90 m1) — see the tier constants above for the reasoning behind each range/value. */
function charsPerTokenFor(codePoint: number): number {
  if (codePoint < 0x0370) return CHARS_PER_TOKEN_ASCII;
  if (codePoint <= 0x052f) return CHARS_PER_TOKEN_CYRILLIC_GREEK;
  const isCjk =
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // Hiragana + Katakana
    (codePoint >= 0x3400 && codePoint <= 0x9fff) || // CJK Ext A + Unified Ideographs
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff); // CJK Compatibility Ideographs
  if (isCjk) return CHARS_PER_TOKEN_CJK;
  return CHARS_PER_TOKEN_DENSE_OTHER;
}

function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += 1 / charsPerTokenFor(ch.codePointAt(0) ?? 0);
  }
  return tokens;
}

function buildTruncated(title: string, messages: Array<{ role: string; content: string }>, budget: number): string {
  const parts: string[] = [`Title: ${title}`];
  let charCount = parts[0].length;

  for (const msg of messages) {
    const line = `[${msg.role}]: ${msg.content}`;
    if (charCount + line.length + 1 > budget) {
      // Add what fits from the current message
      const remaining = budget - charCount - 1;
      if (remaining > 50) {
        parts.push(line.slice(0, remaining));
      }
      break;
    }
    parts.push(line);
    charCount += line.length + 1; // +1 for newline
  }

  return parts.join("\n");
}

/**
 * Concatenates title + messages into a single string suitable for embedding.
 * Truncates to stay within budget — a flat 24,000-character fast path for
 * ASCII-heavy conversations, shrunk proactively (issue #90) when the
 * resulting text's script mix estimates over `TOKEN_ESTIMATE_LIMIT` tokens
 * (Devanagari/CJK/etc. run far denser than ~4 chars/token, so the flat
 * character budget alone can still exceed the embedding model's 8192-token
 * hard limit). Two-pass: build against the flat budget first (cheap, bounded
 * by MAX_CHAR_BUDGET regardless of conversation size), measure THAT result's
 * density, then rebuild against a shrunk budget only if needed.
 */
export function prepareTextForEmbedding(title: string, messages: Array<{ role: string; content: string }>): string {
  const fastPath = buildTruncated(title, messages, MAX_CHAR_BUDGET);
  const estimated = estimateTokens(fastPath);
  if (estimated <= TOKEN_ESTIMATE_LIMIT) {
    return fastPath;
  }

  const scale = TOKEN_ESTIMATE_LIMIT / estimated;
  const shrunkBudget = Math.max(MIN_CHAR_BUDGET, Math.floor(MAX_CHAR_BUDGET * scale));
  return buildTruncated(title, messages, shrunkBudget);
}

/** Minimal structural surface of an OpenAI SDK error we depend on for classification — never assume every thrown value has these. */
interface StatusedError extends Error {
  status?: number;
  code?: string;
}

/**
 * True ONLY for an OpenAI 400 (or the SDK's `context_length_exceeded` error
 * code) whose message ALSO indicates the input overflowed the model's token
 * limit (issue #90 adversarial review M1). The status/code gate MUST come
 * first: a message-only heuristic false-positives on things like a 429
 * "exceeded token rate limit" — a transient rate-limit error, not an
 * overflow — which would otherwise get halved-and-retried (harmless but
 * wrong) and, worse, could exhaust MAX_HALVINGS and permanently retire a
 * perfectly healthy row.
 */
function isTokenOverflowError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as StatusedError;
  const isOverflowStatus = e.status === 400 || e.code === "context_length_exceeded";
  if (!isOverflowStatus) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("maximum context length") ||
    (msg.includes("token") && (msg.includes("exceed") || msg.includes("too long") || msg.includes("too many")))
  );
}

/**
 * Lazily mints a SEPARATE, service-role Supabase client for the cost-guard
 * ceiling check + spend ledger — issue #92 adversarial review B1. Mirrors
 * apps/cloud/src/app/api/portrait/route.ts's getServiceSupabase() (route.ts:57-64).
 *
 * WHY THIS MUST NOT BE THE CALLER'S CLIENT: `llm_spend` has RLS enabled with
 * NO policies (migration 035) and `llm_spend_sum` is service-role-only. Two
 * real call sites (lib/kg/search.ts, lib/kg/seeded-areas.ts) pass their
 * request-scoped, cookie-bound (RLS'd) client straight through — with that
 * client, the ledger insert silently writes ZERO rows (RLS blocks it) and
 * checkMonthlyCeiling's `llm_spend_sum` RPC call fails/returns nothing,
 * which `checkMonthlyCeiling` treats as "fail open" (spentUsd stays 0
 * forever) — the guard becomes a structural no-op for every caller that
 * isn't already holding a service-role client. Minting this INTERNALLY, not
 * accepting it as a parameter, means no caller can get this wrong again —
 * the whole point of "callers pass their own data client only for their own
 * data work," per the file header on spend-ledger.ts's createCostGuardedLlm.
 *
 * NOT memoized (unlike lib/openai.ts's getOpenAI): a supabase-js client is a
 * thin fetch wrapper, cheap to construct per call, and matches
 * getServiceSupabase's own convention — memoizing here would also make an
 * env-var change (e.g. between tests) silently reuse a stale client.
 *
 * DEGRADE-NOT-CRASH when service-role env is absent: returns null rather
 * than throwing, and every call site below treats null as "guard disabled —
 * proceed unguarded" (the pre-#92 behavior), logging once per call so a
 * misconfigured deployment is loud in the logs rather than silently
 * unlimited.
 */
function getGuardSupabase(): Db | null {
  const supabase = tryServiceClient();
  if (!supabase) {
    console.warn(
      `[embeddings] ${SERVICE_ROLE_KEY_ENV}/NEXT_PUBLIC_SUPABASE_URL not set — the #92 cost guard/ledger is DISABLED for this generateEmbedding call: it proceeds UNGUARDED (no ceiling check, no llm_spend row — the pre-#92 behavior). Set both env vars to restore the ceiling.`,
    );
    return null;
  }
  return supabase;
}

/**
 * A pre-built, shared guard/ledger for BATCH callers (issue #92 adversarial
 * review m-batching) — e.g. embedMissingConversations builds ONE via
 * createEmbeddingGuardContext() and passes it to every generateEmbedding call
 * in the batch, instead of each call minting its own service-role client +
 * ledger + immediate flush. `supabase: null` means the guard is disabled
 * (service-role env absent) — same "unguarded" degrade as the default
 * per-call path. `ledger: null` mirrors that (never non-null when supabase is
 * null).
 */
export interface EmbeddingGuardContext {
  supabase: Db | null;
  ledger: SpendLedger | null;
}

/**
 * Builds ONE {@link EmbeddingGuardContext} for a whole batch — issue #92
 * m-batching. Only sanctioned batch callers should use this (currently
 * conversation-embeddings.ts); everything else (search/query paths) keeps
 * the default per-call guard generateEmbedding mints internally, which stays
 * the safe default — B1 still holds: nothing here lets a caller substitute
 * an ARBITRARY client, only ever the one getGuardSupabase() itself would
 * have minted.
 */
export function createEmbeddingGuardContext(userId: string): EmbeddingGuardContext {
  const supabase = getGuardSupabase();
  if (!supabase) return { supabase: null, ledger: null };
  return { supabase, ledger: createSpendLedger(supabase, userId) };
}

export interface GenerateEmbeddingOpts {
  userId: string;
  /**
   * Query-time embeds: the call gets this abort signal, no SDK retries (maxRetries 0) and an explicit timeout
   * (`timeoutMs`, default MEMBRAL_EMBED_TIMEOUT_MS = 4000) instead of the SDK's retries and 10-minute default.
   * An aborted or timed-out call throws before the spend ledger is touched, so it is never recorded as a success.
   * Unset (batch writers, every other caller): the SDK defaults, unchanged.
   */
  signal?: AbortSignal;
  /** Query-time embeds: the call's timeout in ms; setting it (or `signal`) selects the no-retry request options. */
  timeoutMs?: number;
  /** Distinguishes ingest-time vs query-time spend in the llm_spend ledger (issue #92). */
  pass: EmbeddingPass;
  /**
   * Batch callers only (issue #92 m-batching) — see
   * {@link createEmbeddingGuardContext}'s doc comment. When provided:
   *   - the per-call ceiling preflight below is SKIPPED — the batch caller
   *     is responsible for its own preflight cadence;
   *   - a successful call's spend is recorded via the SHARED ledger's
   *     onSpend (buffered per createSpendLedger's own flushEvery) instead of
   *     a fresh ledger + immediate flush — the batch caller flushes
   *     explicitly (e.g. in a `finally`).
   * Single-shot callers (search.ts, mcp/graph-tools.ts, kg/search.ts, etc.)
   * omit this and keep the original per-call preflight + immediate flush.
   */
  guard?: EmbeddingGuardContext;
  /**
   * Skips ONLY the monthly-ceiling preflight (checkMonthlyCeiling) below —
   * `assertFeature("embeddings")` above still runs, and a successful call
   * still ledgers its spend exactly as any other call does (so the ceiling
   * check on the NEXT call still sees it). For query-time embeds only (a
   * user typing a search): one query embed costs ~$0.000003 (2,699 queries
   * over 30 days = $0.008 total, evidence in issue #92 follow-up) — refusing
   * it once the ceiling (meant to cap bulk ingest/extraction spend) is hit
   * degrades search to keyword-only for the price of nothing saved. Bulk
   * embed call sites (ingest, chunking, cross-links, seeded-area anchors)
   * must NOT set this — the ceiling exists to bound exactly their spend.
   */
  skipCeiling?: boolean;
  /**
   * W1 (memory_search latency): when set, the `llm_spend` row for this call
   * is NOT awaited before the embedding is returned -- the insert starts
   * immediately and the promise is handed to this callback (a request
   * caller passes next/server `after`, the same seam lib/mcp/telemetry.ts's
   * `waitUntil` uses) so the function stays alive until it lands. The
   * ledger's flush already logs and swallows insert failures, so nothing is
   * lost on the request path but one round trip. Single-shot callers only;
   * the ceiling/feature gates above still run first, unchanged.
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * Generates an embedding vector using the configured embedding model
 * (default OpenAI text-embedding-3-small; MEMBRAL_EMBEDDING_MODEL overrides —
 * see kg/embedding-client.ts's resolveEmbeddingConfig). Returns a float array
 * of 1536 dimensions.
 *
 * Routes through the same cost-guard rails every other LLM-spending entry
 * point uses (issue #92): preflights the per-user monthly ceiling
 * (checkMonthlyCeiling) BEFORE issuing the call — throws
 * EmbeddingCeilingExceededError rather than spending past it, UNLESS
 * `opts.skipCeiling` is set (see its doc comment) — and records an
 * `llm_spend` row (createSpendLedger) priced via the same `embedCostUsd`
 * table kg/llm.ts's LlmClient.embed() uses, tagged with `opts.pass` so
 * ingest- and query-time spend are distinguishable in the ledger. The guard's
 * Supabase client is minted internally (getGuardSupabase) — see its doc
 * comment for why callers must never be trusted to supply the right one —
 * UNLESS `opts.guard` is set (batch callers; see GenerateEmbeddingOpts).
 *
 * On a 400 whose message indicates the input overflowed the model's token
 * limit (issue #90), halves the text and retries, up to MAX_HALVINGS times;
 * if it still overflows after that, throws EmbeddingTokenOverflowError so the
 * caller can retire the row instead of re-attempting it forever.
 */
export async function generateEmbedding(text: string, opts: GenerateEmbeddingOpts): Promise<number[]> {
  if (!text.trim()) {
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  }

  // Issue #126 (ADR 0047); feature split issue #128 (ADR 0047 v2) — every
  // embedding call (ingest-time, query-time, batch or not) is gated on the
  // "embeddings" feature specifically, NOT "llm": embeddings are on-by-
  // default-with-a-budget for every account (see feature-flags.ts's
  // resolveDefaults), independent of whether the account's KG/portrait/
  // bridge "llm" feature has ever been granted. This is the single per-user
  // gate covering every one of this function's ~8 call sites (search/query
  // paths, ingest-time batch callers, mcp/graph-tools, code-sessions
  // cross-links) — checked BEFORE the cost-guard/ceiling preflight below, so
  // a flagged-off/exhausted user never reaches the provider regardless of
  // monthly-ceiling headroom. Applies in both batch and non-batch mode
  // (unlike the ceiling check, which batch callers preflight themselves at
  // their own cadence) — batch callers still get their own upfront
  // hasFeature short-circuit for a single clean log line, but this per-call
  // gate is what actually protects the other, non-batched call sites.
  // Throws FeatureDisabledError — callers already special-case thrown
  // errors from this function (EmbeddingCeilingExceededError is the
  // existing precedent) and degrade or surface a 403 accordingly.
  await assertFeature(opts.userId, "embeddings");

  const batched = opts.guard !== undefined;
  const guardSupabase = batched ? (opts.guard?.supabase ?? null) : getGuardSupabase();

  // In batch mode the caller already preflighted (at its own cadence) —
  // skipping the check here IS the hoist m-batching asked for. Outside batch
  // mode, this is the original per-call preflight — unless the caller opted
  // out via `skipCeiling` (query-time embeds; see its doc comment above).
  if (!batched && !opts.skipCeiling && guardSupabase) {
    const ceiling = await checkMonthlyCeiling(guardSupabase, opts.userId);
    if (!ceiling.allowed) {
      throw new EmbeddingCeilingExceededError(ceiling.spentUsd, ceiling.ceilingUsd as number);
    }
  }

  const openai = getOpenAI();
  const embeddingConfig = resolveEmbeddingConfig();
  let attemptText = text;
  let lastErr: unknown;
  const requestOptions: EmbeddingRequestOptions | undefined =
    opts.signal || opts.timeoutMs !== undefined
      ? { ...(opts.signal ? { signal: opts.signal } : {}), maxRetries: 0, timeout: opts.timeoutMs ?? embedTimeoutMs() }
      : undefined;

  for (let attempt = 0; attempt <= MAX_HALVINGS; attempt++) {
    try {
      const response = await callEmbeddingsCreate(
        (body, reqOpts) => (reqOpts ? openai.embeddings.create(body, reqOpts) : openai.embeddings.create(body)),
        embeddingConfig,
        attemptText,
        requestOptions,
      );

      if (guardSupabase) {
        const tokensIn = response.usage?.prompt_tokens ?? 0;
        // Priced/logged against the CANONICAL configured model id, never a
        // provider-prefixed fallback variant (e.g. "openai/..."), so
        // llm_spend rows stay meaningful and embedCostUsd's pricing table
        // (keyed by the bare id) always finds a match.
        // kg/llm.ts's embedCostUsd now returns null for an unpriced model
        // (step2d finding 5, issue #151) — out of this file's scope to
        // change its fail-open-to-0 behavior here; falls back to 0 exactly
        // as the old always-numeric embedCostUsd did for an unknown model.
        const costUsd = embedCostUsd(embeddingConfig.model, tokensIn) ?? 0;
        const spendRecord = {
          conversation_id: "embedding",
          pass: opts.pass,
          model: embeddingConfig.model,
          tokens_in: tokensIn,
          tokens_out: 0,
          cost_usd: costUsd,
          latency_ms: 0,
        };
        if (batched) {
          // Buffered into the SHARED ledger — the batch caller flushes
          // (immediately flushing per-call here would defeat the whole
          // point of hoisting/batching the ledger writes).
          opts.guard?.ledger?.onSpend(spendRecord);
        } else {
          const ledger = createSpendLedger(guardSupabase, opts.userId);
          ledger.onSpend(spendRecord);
          if (opts.waitUntil) opts.waitUntil(ledger.flush());
          else await ledger.flush();
        }
      }

      return response.data[0].embedding;
    } catch (err) {
      lastErr = err;
      if (!isTokenOverflowError(err)) {
        throw err;
      }
      if (attempt === MAX_HALVINGS) {
        console.warn(
          `[embeddings] token overflow persisted after ${MAX_HALVINGS} halving(s) (final length ${attemptText.length} chars) — giving up`,
        );
        throw new EmbeddingTokenOverflowError(err instanceof Error ? err.message : String(err));
      }
      const nextLength = Math.max(200, Math.floor(attemptText.length / 2));
      console.warn(
        `[embeddings] token-overflow 400 on attempt ${attempt + 1}/${MAX_HALVINGS + 1} — halving ${attemptText.length} -> ${nextLength} chars and retrying`,
      );
      attemptText = attemptText.slice(0, nextLength);
    }
  }

  // Unreachable — the loop above always either returns or throws.
  throw lastErr instanceof Error ? lastErr : new Error("generateEmbedding: exhausted attempts");
}
