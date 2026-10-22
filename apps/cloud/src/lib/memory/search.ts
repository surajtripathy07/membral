// `memory_search` (docs/design/memory-v1.md §4): the topic tool. Postgres
// FTS on `text` fused with cosine on `embedding`, one query embedding per
// call.
//
// FUSION LOCATION (documented per the brief's "if you must add SQL, it is
// migration 085 and you must say so"): the fusion runs INSIDE
// `memory_search_records` (migration 085), not as two queries fused here in
// TS. A migration is unavoidable for the cosine leg alone -- pgvector's
// `<=>` operator has no supabase-js equivalent, exactly like every other
// semantic-ranked read in this codebase (migration 044's
// `mcp_search_unified`, migration 030's `code_context_for`) already goes
// through an RPC for this reason. Given that SQL round trip is unavoidable
// regardless, running the FTS leg inside the SAME function (RRF, migration
// 044's established pattern) is simpler and more consistent with this
// codebase than adding a SECOND, TS-side supabase-js query that duplicates
// the same WHERE-clause filters a second time to merely re-fuse client-side
// -- see 085's header for the full reasoning. `resolveProjectId` and
// `recordRecallEvent` below stay ordinary TS/supabase-js, per the "prefer
// TS" default.
//
// The RPC returns a RELEVANCE-ranked *candidate* set only; final serving
// order is rank.ts's job, applied here after the batched receipt re-check
// (verify.ts, rule 3), with the RPC's fused score as the lead key after
// verified (migration 091: IDF-weighted lexical leg RRF-fused with cosine).
//
// W3: the RPC is `memory_search_scored` (migration 116) -- the same body plus
// the raw per-leg signals (cosine, lexeme hits), observed_at and a p_since
// filter. The relevance floor and the recency boost below use them.

import { after } from "next/server";
import { normalizeRepoArgument } from "@/lib/code-sessions/repo-identity";
import type { Db } from "@/lib/db/types";
import { isFreshBlocker } from "@/lib/domain/blockers";
import { EmbeddingCeilingExceededError, generateEmbedding } from "@/lib/embeddings";
import { FeatureDisabledError } from "@/lib/feature-flags";
import {
  currentEmbeddingFamily,
  EMBEDDINGS_NOT_CONFIGURED_MESSAGE,
  embeddingsConfigured,
  embedTimeoutMs,
  isDefaultEmbeddingFamily,
} from "@/lib/llm/embedding-client";
import { isLocalRuntime, lexicalMinHits, vectorThreshold } from "@/lib/llm/embedding-family";
import { log } from "@/lib/log";
import { compactServedRecord } from "@/lib/mcp/served-record-view";
import { resolveSince } from "@/lib/mcp/since";
import { type EmbedBreaker, promptRecallEmbedBreaker } from "./embed-breaker";
import { anchorHits, codeAnchorBoost, extractQueryAnchors } from "./query-anchors";
import { parseQueryDates, type QueryDateWindow } from "./query-dates";
import { queryEmbedInput } from "./raw-units/embed";
import { fuseCardsRaw, type ServedCard, type ServedLine, searchRawUnits } from "./raw-units/search";
import { fetchValidity, mergeOldest } from "./reconcile/validity";
import { MEMORY_KINDS, type MemoryKind } from "./schema";
import { currentOnly, markSuperseded } from "./serve-filter";
import { type MemoryRow, type RankAndServeTimings, rankAndServe, type ServedRecord } from "./verify";

/**
 * W1: a metrics write that must land but must not hold up the response.
 * The promise is already running; next/server `after()` (the seam
 * app/api/mcp/route.ts hands lib/mcp/telemetry.ts) keeps the serverless
 * function alive until it settles. Outside a request scope (scripts, tests)
 * `after()` throws -- the write still runs, nothing else to do.
 */
function offRequestPath(p: Promise<unknown>): void {
  const settled = p.catch((err: unknown) =>
    log.warn("memory_search: off-path write failed", { error: err instanceof Error ? err.message : String(err) }),
  );
  try {
    after(settled);
  } catch {
    // not in a request scope -- see above
  }
}

export interface MemorySearchArgs {
  query: string;
  kind?: string | string[];
  scope?: "project" | "global";
  project?: string;
  path?: string;
  recall_token?: string;
  limit?: number;
  /** Hard lower bound on the record's observed time: ISO date or datetime (lib/mcp/since.ts). Wins over days. */
  since?: string;
  /** Hard bound: only records observed in the last N days. */
  days?: number;
  /** L2: also serve records a newer record replaced (each says by which, and when). Default false: replaced records are hidden. */
  include_superseded?: boolean;
}

export interface MemorySearchResult {
  records: ServedRecord[];
  /**
   * I33: the lines to serve, records (compact JSON lines) and raw session excerpts fused by reciprocal rank and cut at the
   * limit. Raw excerpts exist on a local run only (isLocalRuntime); hosted, this is the records alone.
   */
  served: ServedLine[];
  /** Why no raw excerpt was served when the raw path could not run (no calibrated floors, embedding or RPC failure). */
  raw_reason?: string;
  /** Set when the semantic leg was skipped (ceiling/feature gate) -- FTS-only results, never a hard failure. */
  degraded?: string;
  /** Why `records` is empty: nothing cleared the relevance floor, or nothing was left to search for. */
  reason?: string;
  /** Machine form of `reason` (migration 126's memory_recall_events.empty_reason). */
  empty_reason?: RecallEmptyReason;
  /** The date phrase read from the query and the window it boosted toward (a reading, not a filter). */
  date_hint?: QueryDateWindow & { applied: "boost" };
  /** The explicit since/days bound applied as a filter, ISO UTC. */
  since?: string;
  /** #436: blocker records that matched but are older than BLOCKER_FRESH_DAYS, so were not served. Set only when > 0. */
  stale_blockers_hidden?: number;
}

// ---------------------------------------------------------------------------
// Relevance floor (W3). RRF (leg_score) is rank-based: the best of ten
// irrelevant records still scores like a hit. The floor reads the raw per-leg
// signals from memory_search_scored (migration 116) instead. A record is
// served when ANY of:
//   (a) cosine similarity >= SEM_FLOOR;
//   (b) it contains at least LEX_COVERAGE_FLOOR of the query's distinct
//       lexemes, and at least 2 of them when the query has 2 or more;
//   (c) it contains at least MIXED_COVERAGE_FLOOR of the lexemes AND its
//       cosine similarity >= MIXED_SEM_FLOOR.
// Calibrated 2026-10-03 on the local corpus (one user, ~9.8k records,
// text-embedding-3-small): 16 real logged memory_search queries vs 14
// off-topic ones (sourdough, VAT filing, SwiftUI, Kafka, Terraform...).
//   Off-topic: max cosine 0.105-0.466 (SwiftUI 0.466, Terraform 0.416), max
//     lexical coverage 0.17-0.25 with one lexeme hit -- the rule passes 0
//     records for all 14.
//   On-topic: 14/16 keep records (e.g. "always use pnpm" 8, "opencode
//     parser" 27, "Postgres wedged outage restart fix" 1 via (c)). The two
//     that return [] are "repository purpose overview" (max cos 0.416, cov
//     0.33) and "home loan prepayment" (0.372, 0.33 -- a personal topic in a
//     code-session store).
// SEM_FLOOR sits above the highest off-topic cosine; (c)'s coverage floor
// sits above the highest off-topic coverage.
// ---------------------------------------------------------------------------
export const SEM_FLOOR = 0.5;
export const LEX_COVERAGE_FLOOR = 0.5;
export const MIXED_COVERAGE_FLOOR = 0.33;
export const MIXED_SEM_FLOOR = 0.4;

/** The raw per-leg signals migration 116 adds to each row. */
export interface ScoredSignals {
  leg_score?: number | null;
  similarity?: number | null;
  lex_score?: number | null;
  lex_hits?: number | null;
  query_lexemes?: number | null;
  observed_at?: string | null;
}

/**
 * The semantic cut for memory_search_scored's `p_min_similarity` and the TS
 * floor, per embedding family (D-072). SEM_FLOOR and the SQL 0.3 cut are
 * calibrated on text-embedding-3-small only.
 *   default family: SQL gets MEMBRAL_EMBEDDING_MIN_SIMILARITY if set, else
 *     null (migration 116's 0.3); the TS floor is passesRelevanceFloor.
 *   another family: SQL and TS both use MEMBRAL_EMBEDDING_MIN_SIMILARITY if set;
 *     else, for a calibrated family (L8: vectorThreshold), the same three-rule floor with that family's
 *     SEM_FLOOR / MIXED_SEM_FLOOR and SQL cut; else the floor is off (SQL gets FLOOR_OFF, TS serves every
 *     candidate).
 */
export const FLOOR_OFF = 0;

export interface FamilyFloor {
  family: string;
  /** memory_search_scored's p_embedding_model. */
  pEmbeddingModel: string;
  /** memory_search_scored's p_min_similarity (null = 116's 0.3; <= 0 = off). */
  pMinSimilarity: number | null;
  /** The TS relevance filter; null = no TS floor. */
  floor: ((row: ScoredSignals) => boolean) | null;
}

/** MEMBRAL_EMBEDDING_MIN_SIMILARITY clamped to cosine's [-1, 1]; unset -> null; non-numeric -> null with a warn. */
export function envMinSimilarity(env: Record<string, string | undefined>): number | null {
  const raw = env.MEMBRAL_EMBEDDING_MIN_SIMILARITY?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    log.warn("memory_search: MEMBRAL_EMBEDDING_MIN_SIMILARITY is not a number — ignored", { value: raw });
    return null;
  }
  return Math.min(1, Math.max(-1, n));
}

/** The memory_search_scored keys familyFloor needs sent: none for the default family with no cut override. */
export function familyRpcArgs(ff: FamilyFloor): { p_embedding_model?: string; p_min_similarity?: number } {
  const args: { p_embedding_model?: string; p_min_similarity?: number } = {};
  if (!isDefaultEmbeddingFamily(ff.family)) args.p_embedding_model = ff.pEmbeddingModel;
  if (ff.pMinSimilarity !== null) args.p_min_similarity = ff.pMinSimilarity;
  return args;
}

export function familyFloor(env: Record<string, string | undefined> = process.env): FamilyFloor {
  const family = currentEmbeddingFamily(env);
  const min = envMinSimilarity(env);
  if (isDefaultEmbeddingFamily(family)) {
    // The env cut changes only the SQL semantic cut here; the TS floor
    // (passesRelevanceFloor: SEM_FLOOR / MIXED_SEM_FLOOR, calibrated on this
    // model) still applies unchanged on top of it.
    return { family, pEmbeddingModel: family, pMinSimilarity: min, floor: (row) => passesRelevanceFloor(row) };
  }
  if (min === null) {
    const sem = vectorThreshold("sem_floor", family);
    const mixed = vectorThreshold("mixed_sem_floor", family);
    const cut = vectorThreshold("sql_cut", family);
    if (sem === null || mixed === null || cut === null) {
      return { family, pEmbeddingModel: family, pMinSimilarity: FLOOR_OFF, floor: null };
    }
    return {
      family,
      pEmbeddingModel: family,
      pMinSimilarity: cut,
      floor: (row) => passesRelevanceFloor(row, { sem, mixed, lexMinHits: lexicalMinHits(family) }),
    };
  }
  return {
    family,
    pEmbeddingModel: family,
    pMinSimilarity: min,
    floor: (row) => {
      const sim = typeof row.similarity === "number" ? row.similarity : null;
      if (sim !== null && sim >= min) return true;
      return passesLexicalFloor(row);
    },
  };
}

/** Rule (b) alone: the lexical-coverage floor, model-independent. */
function passesLexicalFloor(row: ScoredSignals): boolean {
  const hits = row.lex_hits ?? 0;
  const lexemes = row.query_lexemes ?? 0;
  const coverage = lexemes > 0 ? hits / lexemes : 0;
  return hits >= Math.min(2, lexemes) && hits > 0 && coverage >= LEX_COVERAGE_FLOOR;
}

export function passesRelevanceFloor(
  row: ScoredSignals,
  cuts: { sem: number; mixed: number; lexMinHits?: number } = { sem: SEM_FLOOR, mixed: MIXED_SEM_FLOOR },
): boolean {
  const sim = typeof row.similarity === "number" ? row.similarity : null;
  const hits = row.lex_hits ?? 0;
  const lexemes = row.query_lexemes ?? 0;
  const coverage = lexemes > 0 ? hits / lexemes : 0;
  if (sim !== null && sim >= cuts.sem) return true;
  // L5: lexical evidence (rules b and c) also needs an absolute count of matched lexemes, per family (0 = none).
  // A query shorter than the minimum needs every one of its lexemes.
  if (hits < Math.min(cuts.lexMinHits ?? 0, lexemes)) return false;
  if (hits >= Math.min(2, lexemes) && hits > 0 && coverage >= LEX_COVERAGE_FLOOR) return true;
  if (sim !== null && sim >= cuts.mixed && coverage >= MIXED_COVERAGE_FLOOR) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Recency (W3). Multiplies the fused score, so it is bounded by construction:
//   date phrase in the query: x(1 + DATE_BOOST_MAX * proximity), proximity 1
//     inside the window, 1/(1 + days outside / max(window days, 3)) outside --
//     at most doubles a record's score; a strong older match can still win.
//   no date phrase: x(1 + RECENCY_BOOST_MAX * 0.5^(age days / 30)) -- at most
//     +5%, about the gap between adjacent top ranks in RRF (1/61 vs 1/62 is
//     1.6%), so newer records win near-ties without reordering clear wins.
//     30 days matches the extraction recency window.
// Recency uses observed_at (the code session's start; see migration 116).
// ---------------------------------------------------------------------------
export const DATE_BOOST_MAX = 1.0;
export const RECENCY_BOOST_MAX = 0.05;
export const RECENCY_HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

export function boostedRelevance(
  legScore: number,
  observedAt: string | null | undefined,
  window: { from: string; to: string } | null,
  now: Date,
): number {
  const t = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (Number.isNaN(t)) return legScore;
  if (window) {
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    const outside = t < from ? (from - t) / DAY_MS : t >= to ? (t - to) / DAY_MS : 0;
    const soft = Math.max((to - from) / DAY_MS, 3);
    return legScore * (1 + DATE_BOOST_MAX / (1 + outside / soft));
  }
  const ageDays = Math.max(0, (now.getTime() - t) / DAY_MS);
  return legScore * (1 + RECENCY_BOOST_MAX * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS));
}

/**
 * MEMBRAL_RECORD_QUERY_PREFIX=1 embeds the records query with the family's retrieval prefix (see memorySearch). Flip it
 * together with the record re-embed under `search_document: ` (design i33-port.md, PR 4 precondition): until then the
 * stored record vectors are unprefixed and a prefixed query would only lower their cosines. A flag, not a data marker:
 * the query is embedded before the records RPC runs, so reading the stored `embedding_model` would cost an extra
 * round-trip per search.
 */
export function recordQueryPrefixEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MEMBRAL_RECORD_QUERY_PREFIX?.trim() === "1";
}

/** Records that seed the raw-unit walk (cards, cover test, triggers): the lab's B0_CONFIG.limit, whatever `limit` serves. */
export const RAW_SEED_RECORDS = 10;

function clampLimit(limit: number | undefined, fallback = 10, max = 20): number {
  return Math.min(Math.max(Math.trunc(limit ?? fallback), 1), max);
}

function normalizeKinds(kind: string | string[] | undefined): MemoryKind[] | null {
  if (!kind) return null;
  const list = Array.isArray(kind) ? kind : [kind];
  const valid = list.filter((k): k is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(k));
  return valid.length ? valid : null;
}

/** One of the user's projects, as far as short-name matching needs it (G, 2026-09-25). */
export interface ProjectNameCandidate {
  id: string;
  display_name: string | null;
  repo_identity: string;
}

/**
 * G (2026-09-25): does `short` (e.g. "membral-personal", or "owner/repo" --
 * the form the session-start preamble's project hint shows) name exactly one
 * of `projects`? A project matches when `short` equals its display_name, its
 * full repo_identity, OR the last one or two `/`-separated segments of its
 * repo_identity (repo_identity is always `host/owner/repo`, so a one- or
 * two-segment suffix is "repo" or "owner/repo"). Case-insensitive, both
 * sides trimmed. Pure and exported for its own unit tests.
 */
export function matchProjectsByShortName(projects: ProjectNameCandidate[], short: string): ProjectNameCandidate[] {
  const needle = short.trim().toLowerCase();
  if (!needle) return [];
  return projects.filter((p) => {
    const identity = p.repo_identity.toLowerCase();
    const display = p.display_name?.trim().toLowerCase();
    return display === needle || identity === needle || identity.endsWith(`/${needle}`);
  });
}

/** More than one of the user's projects matches a short name -- server.ts's shared toolResult reports this the same way it reports any other Error (see UnknownScopeError's identical treatment). */
export class AmbiguousProjectError extends Error {
  constructor(short: string, candidates: ProjectNameCandidate[]) {
    super(
      `"${short}" matches more than one project: ${candidates
        .map((c) => c.display_name ?? c.repo_identity)
        .join(", ")}. Pass the full repo remote URL or path, or a more specific name, to disambiguate.`,
    );
    this.name = "AmbiguousProjectError";
  }
}

/**
 * Resolve a client-supplied repo string to a code_projects.id, honoring an
 * API key's project scope as the mandatory outer bound (never overridable
 * from the request). Tries, in order: (1) an exact repo_identity match on
 * the normalized remote URL/path (unchanged pre-G behavior); (2) G's short
 * name match (matchProjectsByShortName) against every one of the user's
 * projects -- one match resolves, more than one throws AmbiguousProjectError
 * naming the candidates, zero falls through to null. Returns null when
 * unresolvable/unspecified -- never throws for that case, matching the
 * code-tools.ts "unscoped = no filter" convention.
 */
export async function resolveProjectId(
  supabase: Db,
  userId: string,
  project: string | undefined,
  codeScopeId: string | null,
): Promise<string | null> {
  if (codeScopeId) return codeScopeId; // key's bound wins, always -- see code-tools.ts's scoping convention
  if (!project) return null;
  const identity = normalizeRepoArgument(project);
  const { data, error } = await supabase
    .from("code_projects")
    .select("id")
    .eq("user_id", userId)
    .eq("repo_identity", identity)
    .maybeSingle();
  if (error) throw new Error(`resolveProjectId: code_projects lookup failed: ${error.message}`);
  const exact = (data as { id: string } | null)?.id ?? null;
  if (exact) return exact;

  const allRes = await supabase.from("code_projects").select("id, display_name, repo_identity").eq("user_id", userId);
  if (allRes.error) throw new Error(`resolveProjectId: code_projects list failed: ${allRes.error.message}`);
  const candidates = matchProjectsByShortName((allRes.data ?? []) as ProjectNameCandidate[], project);
  if (candidates.length === 1) return candidates[0].id;
  if (candidates.length > 1) throw new AmbiguousProjectError(project, candidates);
  return null;
}

const DEGRADED_CEILING =
  "SEARCH DEGRADED: results are keyword-only (no semantic ranking) — the monthly embedding budget is exceeded";
const DEGRADED_FEATURE = "AI features are not enabled for this account — keyword-only results";

type QueryEmbedResult = { vector: number[] | null; degraded?: string };

async function embedQuery(
  userId: string,
  text: string,
  request?: { signal: AbortSignal; timeoutMs: number },
): Promise<QueryEmbedResult> {
  // W7 D3: no embedding key at all (explicit config check, never a catch-all)
  // -> keyword-only, not a "Missing OPENAI_API_KEY" tool error.
  if (!embeddingsConfigured()) return { vector: null, degraded: EMBEDDINGS_NOT_CONFIGURED_MESSAGE };
  try {
    // Query-time embed: skip the monthly-ceiling preflight (skipCeiling —
    // see embeddings.ts's doc comment). A search query costs ~$0.000003 to
    // embed; blocking it once the ceiling (meant for bulk ingest spend) is
    // hit degrades memory_search to keyword-only for nothing saved.
    // waitUntil: the llm_spend row is written off the request path (W1);
    // the feature gate inside generateEmbedding still runs first.
    return {
      vector: await generateEmbedding(text, {
        userId,
        pass: "query_embedding",
        skipCeiling: true,
        waitUntil: offRequestPath,
        // Only the cancellable prompt-recall embed gets a signal, no SDK retries and an explicit timeout; every other
        // caller (MCP memory_search, dashboard) keeps the SDK defaults.
        ...(request ? { signal: request.signal, timeoutMs: request.timeoutMs } : {}),
      }),
    };
  } catch (err) {
    if (err instanceof EmbeddingCeilingExceededError) {
      log.warn("memory_search: embedding ceiling exceeded, degrading to FTS-only", { user_id: userId });
      return { vector: null, degraded: DEGRADED_CEILING };
    }
    if (err instanceof FeatureDisabledError) {
      log.warn("memory_search: embeddings feature disabled, degrading to FTS-only", { user_id: userId });
      return { vector: null, degraded: DEGRADED_FEATURE };
    }
    throw err;
  }
}

/**
 * A query embedding started ahead of memorySearch (prompt recall starts it at the top of the request, before the
 * project lookup) so its latency overlaps the other work. `abort()` cancels the HTTP call; `breakerOpen` means the
 * embed breaker was open, so no call was made and `promise` is already a keyword-only (null vector) result.
 */
export interface QueryEmbedding {
  /** The exact string embedded; memorySearch reuses the handle only when its own query input equals this. */
  text: string;
  startedAt: number;
  promise: Promise<QueryEmbedResult>;
  breakerOpen: boolean;
  abort(): void;
}

export function startQueryEmbedding(
  userId: string,
  text: string,
  opts: { breaker?: EmbedBreaker } = {},
): QueryEmbedding {
  const startedAt = Date.now();
  if ((opts.breaker ?? promptRecallEmbedBreaker).isOpen()) {
    log.info("memory_search: embedding_breaker: open, dense leg skipped", { user_id: userId });
    return {
      text,
      startedAt,
      promise: Promise.resolve({ vector: null }),
      breakerOpen: true,
      abort: () => undefined,
    };
  }
  const controller = new AbortController();
  const promise = embedQuery(userId, text, { signal: controller.signal, timeoutMs: embedTimeoutMs() });
  promise.catch(() => undefined); // an abort after the deadline rejects this; nobody may be listening by then
  return { text, startedAt, promise, breakerOpen: false, abort: () => controller.abort() };
}

/**
 * #307 option B (docs/design/current-truth-recall.md section 6): the two stores stay separate, and an empty
 * answer from the records store says where the raw text lives and what that text is. D-074: a raw hit is
 * "true when said", never current truth, so the pointer says so.
 */
export const RAW_TEXT_POINTER =
  " Raw session text may still hold it: search_conversations searches what was said, not checked or versioned, so a hit there is true when said, not current.";

/** Why a memory_search served nothing (memory_recall_events.empty_reason, migration 126). */
export type RecallEmptyReason = "below_floor" | "no_match";

/** Where a recall event's records were served (migration 113); `prompt_hook` is the UserPromptSubmit push (lib/memory/prompt-recall.ts). */
export type RecallSurface = "mcp" | "preamble" | "prompt_hook";

/**
 * Writes one `memory_recall_events` row per call (§4/§7) -- shared by every
 * read tool, not just memory_search, and by the SessionStart preamble
 * (`surface: "preamble"`, #361). `harnessSessionId` is the harness's own
 * session id (Claude Code's `session_id`), matched against
 * code_sessions.source_session_id at import (lib/memory/influence.ts).
 */
export async function recordRecallEvent(
  supabase: Db,
  userId: string,
  tool: "memory_search" | "memory_recall" | "session_summary" | "preamble",
  opts: {
    query?: string;
    recordIds: string[];
    recallToken?: string | null;
    codeSessionId?: string | null;
    surface?: RecallSurface;
    harnessSessionId?: string | null;
    /** Migration 126: why an empty search served nothing. Only sent when set, so a pre-126 database is untouched. */
    emptyReason?: RecallEmptyReason | null;
  },
): Promise<void> {
  const { error } = await supabase.from("memory_recall_events").insert({
    user_id: userId,
    tool,
    query: opts.query ?? null,
    record_ids: opts.recordIds,
    recall_token: opts.recallToken ?? null,
    code_session_id: opts.codeSessionId ?? null,
    surface: opts.surface ?? "mcp",
    harness_session_id: opts.harnessSessionId ?? null,
    ...(opts.emptyReason ? { empty_reason: opts.emptyReason } : {}),
  });
  // A metrics-log write failure must never fail the read it's logging (§7's
  // event log is a day-one metric, not a correctness gate) -- log and move on.
  if (error) log.warn("memory recall event write failed", { user_id: userId, tool, error: error.message });
}

/** memorySearch's W3 behaviours. All default OFF, so callers that did not opt in (the
 * prompt-relevance preamble lines, the dashboard's memory search) behave exactly as
 * before W3; only the MCP memory_search tool turns them on. */
export interface MemorySearchOptions {
  /** Injectable clock for tests. */
  now?: Date;
  /** Drop records under the calibrated relevance floor (skipped when the query has no embedding). */
  floor?: boolean;
  /** Read date phrases in the query (strip + boost toward their window) and apply the mild no-date recency boost. */
  dateHints?: boolean;
  /** Default true. False when the caller trims the records further (memory-tools.ts's token budget) and logs what it actually returns via logSearchRecall. */
  logEvent?: boolean;
  /**
   * #436: default false — blocker records older than BLOCKER_FRESH_DAYS
   * (lib/domain/blockers.ts) are dropped and counted in `stale_blockers_hidden`.
   * True only for the /memories archive's search, which lists every live record.
   */
  includeStaleBlockers?: boolean;
  /** L2: collapse paraphrases by embedding too (one extra read). The MCP tool sets it; prompt recall does not (budget). */
  collapseByMeaning?: boolean;
  /** I33: also search the raw session excerpts (local runtime only). The MCP tool sets it; prompt recall does not (budget). */
  raw?: boolean;
  /** Optional stage clock (prompt recall's per-stage log): times the query embedding as `embed_query` and the RPC as `search_rpc`. */
  stages?: { run<T>(name: "embed_query" | "search_rpc", fn: () => Promise<T>): Promise<T> };
  /**
   * Prompt recall: an embedding started earlier (startQueryEmbedding). Used only when its text equals the string this
   * search would embed; otherwise ignored.
   */
  queryEmbedding?: QueryEmbedding;
  /**
   * Prompt recall: ms (from the embedding's start) the vector may take, capped at hop1BudgetMs minus verifyReserveMs. A keyword-only search runs from the start; if
   * the vector has not arrived by then, or rejects, the embedding is aborted and the keyword rows are served (floor:
   * lexical rule only). Unset: wait for the vector, as before.
   */
  embedDeadlineMs?: number;
  /** Deadline mode: the caller's overall cap for this search, ms from the embedding's start (prompt recall passes its hop-1 budget). Default 1500. */
  hop1BudgetMs?: number;
  /** Deadline mode: ms kept after the fused RPC for verify/serve; the fused RPC must land by hop1BudgetMs minus this, else the keyword rows are served. Default 500. */
  verifyReserveMs?: number;
  /** Breaker fed by deadline misses (default: the process-wide prompt-recall breaker). Injectable for tests. */
  embedBreaker?: EmbedBreaker;
  /** Called once with how the embedding went, for the caller's own log line. */
  onEmbedOutcome?: (o: { embedding_skipped: boolean; embedding_breaker?: "open"; embed_deadline_ms: number }) => void;
}

const DEFAULT_HOP1_BUDGET_MS = 1_500;
const DEFAULT_VERIFY_RESERVE_MS = 500;
const DEGRADED_KEYWORD_FLOOR = "No query embedding, so the relevance floor is off: every keyword match is served";
/** Log one memory_search recall event off the request path -- for callers that set `logEvent: false`. */
export function logSearchRecall(
  supabase: Db,
  userId: string,
  opts: { query: string; recordIds: string[]; recallToken?: string | null; emptyReason?: RecallEmptyReason | null },
): void {
  offRequestPath(
    recordRecallEvent(supabase, userId, "memory_search", {
      query: opts.query,
      recordIds: opts.recordIds,
      recallToken: opts.recallToken,
      ...(opts.recordIds.length === 0 && opts.emptyReason ? { emptyReason: opts.emptyReason } : {}),
    }),
  );
}

/** #436: splits rows into fresh ones (non-blockers and fresh blockers, lib/domain/blockers.ts) and a count of stale blockers. Pure. */
export function partitionStaleBlockers<T extends { kind: string; created_at: string }>(
  rows: readonly T[],
  now: number,
): { fresh: T[]; staleHidden: number } {
  const fresh = rows.filter((r) => isFreshBlocker(r, now));
  return { fresh, staleHidden: rows.length - fresh.length };
}

/**
 * The live replacement of each id (L2 history): live rows of this user whose `supersedes` is one of `ids`. When several
 * live rows replace one id the OLDEST wins: a date phrase asks "was it current then", and the first replacement is the
 * moment it stopped being current. A failed read THROWS: history serves replaced rows, and without this lookup they
 * would reach the answer unmarked, so the search fails closed instead.
 */
export async function fetchReplacements(
  supabase: Db,
  userId: string,
  ids: readonly string[],
): Promise<Map<string, { id: string; at: string }>> {
  const out = new Map<string, { id: string; at: string }>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("session_memories")
    .select("id, supersedes, created_at")
    .eq("user_id", userId)
    .is("retired_at", null)
    .in("supersedes", [...ids])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    log.warn("memory_search: replacement lookup failed, history search fails closed", { error: error.message });
    throw new Error(`memory_search: history needs the replacement lookup, which failed: ${error.message}`);
  }
  for (const r of (data ?? []) as Array<{ id: string; supersedes: string | null; created_at: string }>) {
    if (r.supersedes && !out.has(r.supersedes)) out.set(r.supersedes, { id: r.id, at: r.created_at });
  }
  return out;
}

export async function memorySearch(
  supabase: Db,
  userId: string,
  codeScopeId: string | null,
  args: MemorySearchArgs,
  opts: MemorySearchOptions = {},
): Promise<MemorySearchResult> {
  const query = args.query?.trim();
  if (!query) throw new Error("memory_search: query is required");
  const now = opts.now ?? new Date();

  const limit = clampLimit(args.limit);
  // Explicit since/days is a hard filter; a bad value throws a message the tool layer returns as isError.
  const sinceIso = resolveSince({ since: args.since, days: args.days }, now) ?? undefined;
  const projectId = await resolveProjectId(supabase, userId, args.project, codeScopeId);
  const kinds = normalizeKinds(args.kind);

  const { text: searchText, window } = opts.dateHints ? parseQueryDates(query, now) : { text: query, window: null };
  const date_hint = window ? { ...window, applied: "boost" as const } : undefined;
  // L2 history: an explicit include_superseded, or a date phrase whose window ended over a day ago (no word list:
  // "before" and "previously" occur in ordinary queries, design section 5 Q7). The date form keeps a replaced record
  // only if its replacement came after the window end, i.e. it was current then.
  const windowEnd = window ? Date.parse(window.to) : Number.NaN;
  const asOfMs = Number.isFinite(windowEnd) && windowEnd < now.getTime() - DAY_MS ? windowEnd : undefined;
  const includeSuperseded = args.include_superseded === true;
  const history = includeSuperseded || asOfMs !== undefined;
  const notes: string[] = [];
  // Exact anchors (query-anchors.ts): a record naming the query's file path or
  // ref (strong) ranks first and clears the floor; a bare file name or a
  // backticked identifier (weak) only boosts relevance a little. The RPC's fused order can put such a
  // record far down, so an anchored query reads the full candidate pool.
  const anchors = extractQueryAnchors(query);
  const hasStrongAnchor = anchors.some((a) => a.kind === "path" || a.kind === "ref");
  // A bare `#12` on a row of the searched project carries the query's `owner/repo#12`.
  const scopedRepo = projectId && args.project ? normalizeRepoArgument(args.project) : null;
  const hitsOf = (r: MemoryRow) =>
    anchorHits(scopedRepo && r.code_project_id === projectId ? { ...r, repo: scopedRepo } : r, anchors);
  const strongHitsOf = (r: MemoryRow) => hitsOf(r).strong;

  const started = Date.now();
  const ff = familyFloor();
  // One embedding per distinct string per request (the cache is keyed by the exact string sent to the embedder).
  const embeds = new Map<string, ReturnType<typeof embedQuery>>();
  const embedOnce = (text: string) => {
    let p = embeds.get(text);
    if (!p) {
      p = embedQuery(userId, text);
      embeds.set(text, p);
    }
    return p;
  };
  const rawWanted = opts.raw === true;
  const rawLocal = rawWanted && isLocalRuntime();
  // Records query prefix (I33, off by default): with MEMBRAL_RECORD_QUERY_PREFIX=1 on the local raw path the records
  // query is embedded exactly as the raw-unit query is, with the family's retrieval prefix (queryEmbedInput:
  // "search_query: " for nomic, the text unchanged for any other family), as the lab scores records; one embedding then
  // serves both searches. Off, the records query is embedded as written and the raw query gets its own prefixed
  // embedding, started now so it runs beside the records query's (a failure surfaces in searchRawUnits).
  const prefixRecordQuery = rawLocal && recordQueryPrefixEnabled();
  if (rawLocal && !prefixRecordQuery) embedOnce(queryEmbedInput(searchText, ff.family)).catch(() => undefined);
  const queryInput = prefixRecordQuery ? queryEmbedInput(searchText, ff.family) : searchText;
  // No deadline: an embedding the caller started earlier simply serves the matching query string instead of a second call.
  if (
    opts.embedDeadlineMs === undefined &&
    opts.queryEmbedding?.text === queryInput &&
    !opts.queryEmbedding.breakerOpen
  ) {
    embeds.set(queryInput, opts.queryEmbedding.promise);
  }
  const timed = <T>(name: "embed_query" | "search_rpc", fn: () => Promise<T>) =>
    opts.stages ? opts.stages.run(name, fn) : fn();
  const baseArgs = {
    p_user_id: userId,
    p_query: searchText,
    p_code_project_id: projectId,
    p_kinds: kinds,
    p_scope: args.scope ?? null,
    p_path: args.path ?? null,
    // History (include_superseded, or a date phrase in the past) reads replaced rows too; retired rows are dropped below.
    p_include_retired: history,
    // Candidate pool -- rank.ts (business rules) picks the final order/limit. A date
    // hint reorders by time, so it reads the full pool to find in-window records.
    p_limit: window || anchors.length > 0 ? 60 : Math.min(limit * 3, 60),
  };
  // Migration 118 (D-072): the family/cut keys are sent only when they change
  // the result, so a default-family call with no cut override sends none.
  const runRpc = (vec: number[] | null) =>
    supabase.rpc("memory_search_scored", {
      ...baseArgs,
      p_query_embedding: vec ? `[${vec.join(",")}]` : null,
      p_since: sinceIso ?? null,
      ...familyRpcArgs(ff),
    });

  let vector: number[] | null;
  let degraded: string | undefined;
  let embeddingSkipped = false;
  let breakerOpen = false;
  let rpcStarted = Date.now();
  let rpcCall: PromiseLike<Awaited<ReturnType<typeof runRpc>>>;
  const hop1BudgetMs = opts.hop1BudgetMs ?? DEFAULT_HOP1_BUDGET_MS;
  const verifyReserveMs = opts.verifyReserveMs ?? DEFAULT_VERIFY_RESERVE_MS;
  // The vector may take as long as the hop-1 cap allows less the time verify needs to serve the keyword rows: past that
  // point the keyword rows are the answer (an empty reply from the cap would be worse). Fused RPC shares the same cutoff.
  const deadlineMs =
    opts.embedDeadlineMs === undefined ? undefined : Math.min(opts.embedDeadlineMs, hop1BudgetMs - verifyReserveMs);
  if (deadlineMs === undefined) {
    ({ vector, degraded } = await timed("embed_query", () => embedOnce(queryInput)));
    rpcStarted = Date.now();
    rpcCall = runRpc(vector);
  } else {
    // Deadline mode (prompt recall): the embedding runs beside a keyword-only search (null vector, migration 121).
    const breaker = opts.embedBreaker ?? promptRecallEmbedBreaker;
    const handle =
      opts.queryEmbedding && opts.queryEmbedding.text === queryInput
        ? opts.queryEmbedding
        : startQueryEmbedding(userId, queryInput, { breaker });
    breakerOpen = handle.breakerOpen;
    embeds.set(queryInput, handle.promise);
    rpcStarted = Date.now();
    // The builder is lazy and every .then() sends a request: wrap it once in a real Promise and reuse that.
    const keywordCall = Promise.resolve(runRpc(null));
    keywordCall.catch(() => undefined);
    type Outcome = { kind: "vector"; r: QueryEmbedResult } | { kind: "late" } | { kind: "error"; err: unknown };
    const outcome = await timed("embed_query", async (): Promise<Outcome> => {
      if (handle.breakerOpen) return { kind: "late" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = Math.max(0, deadlineMs - (Date.now() - handle.startedAt));
      const late = new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "late" }), wait);
      });
      const arrived = handle.promise.then(
        (r): Outcome => ({ kind: "vector", r }),
        (err): Outcome => ({ kind: "error", err }),
      );
      try {
        return await Promise.race([arrived, late]);
      } finally {
        clearTimeout(timer);
      }
    });
    if (outcome.kind === "vector") {
      ({ vector, degraded } = outcome.r);
      if (vector === null) {
        // No key / feature off / ceiling hit: the keyword search already running is the same request.
        rpcCall = keywordCall;
      } else {
        rpcStarted = Date.now();
        if (!breakerOpen) breaker.recordSuccess();
        // The fused RPC must land early enough to leave room for verify/serve inside the caller's cap; otherwise
        // the keyword rows (already running or resolved) are served, as after a deadline skip.
        const fused = Promise.resolve(runRpc(vector));
        fused.catch(() => undefined); // a late result or rejection after the race is lost must not go unhandled
        const rpcBy = handle.startedAt + hop1BudgetMs - verifyReserveMs;
        let rpcTimer: ReturnType<typeof setTimeout> | undefined;
        const tooSlow = new Promise<"slow">((resolve) => {
          rpcTimer = setTimeout(() => resolve("slow"), Math.max(0, rpcBy - Date.now()));
        });
        try {
          const winner = await Promise.race([
            fused.then(
              () => "done" as const,
              () => "done" as const,
            ),
            tooSlow,
          ]);
          if (winner === "slow") {
            embeddingSkipped = true;
            vector = null;
            rpcCall = keywordCall;
            notes.push("SEARCH DEGRADED: semantic search ran out of time — keyword-only results");
          } else {
            rpcCall = fused;
          }
        } finally {
          clearTimeout(rpcTimer);
        }
      }
    } else {
      embeddingSkipped = true;
      vector = null;
      rpcCall = keywordCall;
      if (!breakerOpen) {
        handle.abort();
        // Only a deadline miss counts toward the breaker; an embedding that failed outright does not.
        if (outcome.kind === "late") breaker.recordSkip();
      }
      if (outcome.kind === "error") {
        log.warn("memory_search: query embedding failed, serving keyword-only", {
          user_id: userId,
          error: outcome.err instanceof Error ? outcome.err.message : String(outcome.err),
        });
      }
      notes.push(
        breakerOpen
          ? "SEARCH DEGRADED: embedding breaker open — keyword-only results"
          : "SEARCH DEGRADED: query embedding missed its deadline — keyword-only results",
      );
    }
    opts.onEmbedOutcome?.({
      embedding_skipped: embeddingSkipped,
      ...(breakerOpen ? { embedding_breaker: "open" as const } : {}),
      embed_deadline_ms: deadlineMs,
    });
  }
  if (degraded) notes.push(degraded);
  const embedMs = Date.now() - started;

  const { data, error } = await timed("search_rpc", async () => rpcCall);
  if (error) throw new Error(`memory_search failed: ${error.message}`);
  const rpcMs = Date.now() - rpcStarted;

  const candidates = (data ?? []) as unknown as Array<MemoryRow & ScoredSignals>;
  // The floor needs the cosine leg: keyword-only results keep the pre-W3 behaviour
  // (any lexical match is served) rather than flooring every one away.
  // A deadline skip is the exception: prompt recall serves into a prompt, so it keeps the lexical rule (b) (at least two
  // matched lexemes and half the query's lexemes, plus the family's minimum hits) instead of serving every match.
  const applyFloor = !!opts.floor && (vector !== null || embeddingSkipped);
  if (opts.floor && vector === null && !embeddingSkipped) notes.push(DEGRADED_KEYWORD_FLOOR);
  const floorFn = embeddingSkipped
    ? (row: ScoredSignals) =>
        passesRelevanceFloor(row, {
          sem: Number.POSITIVE_INFINITY,
          mixed: Number.POSITIVE_INFINITY,
          lexMinHits: lexicalMinHits(ff.family),
        })
    : ff.floor;
  const aboveFloor = applyFloor && floorFn ? candidates.filter((r) => floorFn(r) || strongHitsOf(r) > 0) : candidates;
  // #436: an old blocker is old on every surface — dropped here, in TS after
  // the RPC (migration 116's function is untouched), and counted.
  const { fresh: rows, staleHidden } = opts.includeStaleBlockers
    ? { fresh: aboveFloor, staleHidden: 0 }
    : partitionStaleBlockers(aboveFloor, now.getTime());
  // L2: a record is hidden only while the record that replaced it is live (serve-filter.ts currentOnly); in history
  // mode the pool is read with replaced rows and retired rows are dropped here.
  // History reads replaced rows, so every pool row's replacement is looked up OUTSIDE the pool (a user-scoped read of
  // live rows whose `supersedes` points at pool ids): a replaced record never reaches the answer unmarked.
  const pool = history ? rows.filter((r) => !r.retired_at) : rows;
  const replacements = history
    ? await fetchReplacements(
        supabase,
        userId,
        pool.map((r) => r.id),
      )
    : new Map();
  // L1 (migration 124): the projection of write-time links, read outside the RPC. No columns => nothing; a failed read
  // fails closed in history mode (replaced rows must carry their marker) and serves unfiltered otherwise.
  const validity = await fetchValidity(
    supabase,
    userId,
    pool.map((r) => r.id),
  );
  if (validity.failed && history) throw new Error("memory_search: history needs the validity lookup, which failed");
  const linkReplacements = new Map<string, { id: string; at: string }>();
  for (const [id, v] of validity.map) linkReplacements.set(id, { id: v.superseded_by, at: v.valid_to });
  const poolWithLinks = pool.map((r) => {
    const v = validity.map.get(r.id);
    return v ? { ...r, valid_to: v.valid_to, superseded_by: v.superseded_by, supersede_kind: v.supersede_kind } : r;
  });
  const marked = markSuperseded(poolWithLinks, mergeOldest(replacements, linkReplacements));
  const supersededBy = new Map<string, { id: string; at: string }>();
  for (const r of marked) if (r.supersededBy) supersededBy.set(r.id, r.supersededBy);
  const current = currentOnly(marked, { includeSuperseded, asOfMs });
  const boost = !!opts.dateHints;
  // Relevance leads (after verified): the RPC's fused lexical+semantic score
  // (migration 091) -- times the bounded recency boost above when dateHints is
  // on -- so records carrying the query's distinctive terms are served first;
  // rank.ts's §4 order only breaks ties.
  const timings: RankAndServeTimings = {};
  const ranked = await rankAndServe(supabase, userId, current as MemoryRow[], "tool", limit, {
    supersededBy: history ? supersededBy : undefined,
    collapseByMeaning: opts.collapseByMeaning,
    relevance: (r) => {
      const { leg_score: score, observed_at } = r as ScoredSignals;
      if (typeof score !== "number" || !Number.isFinite(score)) return undefined;
      const rel = boost ? boostedRelevance(score, observed_at ?? r.created_at, window, now) : score;
      return anchors.length > 0 ? codeAnchorBoost(rel, hitsOf(r).weak) : rel;
    },
    ...(hasStrongAnchor ? { anchorHits: strongHitsOf } : {}),
    timings,
  });

  // I33: the records as served lines (no card format exists in the product: compact JSON lines), then the raw excerpts.
  const recordLines: ServedLine[] = !rawWanted
    ? []
    : ranked.map((r) => ({
        type: "record",
        id8: r.session_id.slice(0, 8),
        span: [r.turn_idx, r.turn_idx],
        members: [r.id],
        text: JSON.stringify(compactServedRecord(r, undefined, undefined, now.getTime())),
      }));
  let rawLines: ServedLine[] = [];
  let rawReason: string | undefined;
  if (rawLocal) {
    const similarity = new Map(candidates.map((c) => [c.id, typeof c.similarity === "number" ? c.similarity : null]));
    // The raw walk is seeded with the top RAW_SEED_RECORDS records, as the lab seeds it (B0_CONFIG.limit); `ranked`
    // (up to `limit`, as many as served above) is unchanged.
    const seed = ranked.slice(0, RAW_SEED_RECORDS);
    const cards: ServedCard[] = seed.map((r, i) => ({
      text: recordLines[i].text,
      ref: r.ref,
      paths: r.paths ?? [],
      vec_ids: [r.id],
    }));
    const raw = await searchRawUnits(supabase, userId, {
      query: searchText,
      family: ff.family,
      limit,
      projectId,
      anchors,
      records: seed.map((r) => ({ id: r.id, similarity: similarity.get(r.id) ?? null })),
      cards,
      embed: async (text) => (await embedOnce(text)).vector,
    });
    rawLines = raw.lines;
    rawReason = raw.reason;
    if (raw.reason && raw.reason.startsWith("raw search failed")) notes.push("RAW SEARCH DEGRADED"); // detail stays in log.warn / raw_reason
  }

  // W1: the event row is a metrics log (a failed write never failed the
  // read, see recordRecallEvent) -- started now, not awaited, so the
  // caller's next step (memory-tools.ts's session_refs lookup) runs
  // alongside it instead of after it.
  const emptyReason: RecallEmptyReason | undefined =
    ranked.length === 0 && (opts.floor || opts.dateHints)
      ? candidates.length === 0
        ? "no_match"
        : "below_floor"
      : undefined;
  if (opts.logEvent !== false) {
    logSearchRecall(supabase, userId, {
      query,
      recordIds: ranked.map((r) => r.id),
      recallToken: args.recall_token,
      emptyReason,
    });
  }

  // Per-phase split for prod logs (W1): embed / rpc / verify / serve context.
  log.info("memory_search timings", {
    user_id: userId,
    embed_ms: embedMs,
    rpc_ms: rpcMs,
    embedding_skipped: embeddingSkipped,
    embed_deadline_ms: deadlineMs ?? null,
    ...(breakerOpen ? { embedding_breaker: "open" } : {}),
    ...timings,
    candidates: candidates.length,
    above_floor: aboveFloor.length,
    anchors: anchors.length,
    stale_blockers_hidden: staleHidden,
    served: ranked.length,
    total_ms: Date.now() - started,
  });

  const result: MemorySearchResult = { records: ranked, served: fuseCardsRaw(recordLines, rawLines).slice(0, limit) };
  if (rawReason) result.raw_reason = rawReason;
  if (date_hint) result.date_hint = date_hint;
  if (sinceIso) result.since = sinceIso;
  if (notes.length) result.degraded = notes.join("; ");
  if (staleHidden > 0) result.stale_blockers_hidden = staleHidden;
  if (emptyReason) {
    result.empty_reason = emptyReason;
    const scope = sinceIso ? ` since ${sinceIso.slice(0, 10)}` : "";
    result.reason =
      emptyReason === "no_match"
        ? `No memory records match "${searchText}"${scope}.${RAW_TEXT_POINTER}`
        : `Nothing relevant to "${searchText}"${scope}: ${candidates.length} weak matches fell below the relevance floor, so none are served.${RAW_TEXT_POINTER}`;
  }
  return result;
}
