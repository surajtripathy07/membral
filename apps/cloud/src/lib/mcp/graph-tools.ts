// Graph-projecting MCP tool logic (GitHub issue #41 / membral-ort.5).
//
// Cloud /api/mcp is the SINGLE MCP surface (ADR 0001 addendum 2026-06-30):
// these functions back the tools registered in server.ts, reading the
// public.kg_* graph through the migration-016 `mcp_*` RPCs (SECURITY
// INVOKER, service_role-only — see that migration's header for why). Every
// function takes a SupabaseClient (dependency-injected, like lib/kg/read.ts)
// and the server-verified userId — never a client-supplied one — and passes
// both straight through to `p_user_id` on every RPC call.
//
// SCOPING: `scope` (a LifeArea id or label) is resolved to a node id via
// resolveScopeId() BEFORE any data RPC runs, so scoping is enforced at the
// graph layer inside Postgres's `contains`-traversal CTEs, never as a
// text/JS post-filter here. An unresolvable scope throws UnknownScopeError,
// which server.ts turns into a clean tool-call error.

import { getFirstUserMessages } from "@/lib/code-sessions/queries";
import { sessionDisplayTitle } from "@/lib/code-sessions/view";
import type { Db } from "@/lib/db/types";
import { EmbeddingCeilingExceededError, generateEmbedding } from "@/lib/embeddings";
import { FeatureDisabledError } from "@/lib/feature-flags";
import {
  EMBEDDING_FAMILY_KEYWORD_ONLY_MESSAGE,
  EMBEDDINGS_NOT_CONFIGURED_MESSAGE,
  embeddingsConfigured,
} from "@/lib/llm/embedding-client";
import { chatVectorPlan } from "@/lib/llm/embedding-family";
import { log } from "@/lib/log";

export class UnknownScopeError extends Error {
  constructor(scope: string) {
    super(`Unknown scope: "${scope}" is not one of your life areas`);
    this.name = "UnknownScopeError";
  }
}

function clampLimit(limit: number | undefined, fallback: number, max = 50): number {
  return Math.min(Math.max(limit ?? fallback, 1), max);
}

/** Set on a tool result whenever a call site below degraded instead of failing (issue #92 adversarial review M3) — visible to both the model and the user, not just the server logs. */
const EMBEDDING_DEGRADED_MESSAGE =
  "SEARCH DEGRADED: results are keyword-only (no semantic ranking) — the monthly embedding budget is exceeded";

/** Same idea as {@link EMBEDDING_DEGRADED_MESSAGE}, for the OTHER reason embedQuery can come back empty (issue #126 verification finding 6; feature split issue #128): the account's `embeddings` feature flag is off/exhausted, not the monthly ceiling. */
const EMBEDDING_FEATURE_DISABLED_MESSAGE = "AI features are not enabled for this account — keyword/empty results only";

interface EmbedQueryResult {
  vector: string | null;
  /** Set (non-null) whenever `vector` is null — the exact string a call site should put in its own `degraded` field, distinguishing "ceiling exceeded" from "feature not enabled" for the caller, not just the server log. */
  degradedMessage: string | null;
  /** mcp_search_unified's family args for this query's vector (migration 139); empty for the default family and when `vector` is null. */
  familyArgs: { p_embedding_model?: string; p_min_similarity?: number };
}

/**
 * pgvector accepts a bracketed number-list string for a vector(1536) param —
 * same shape lib/search.ts already sends. Returns `vector: null` (with a
 * reason in `degradedMessage`) rather than throwing for either of the two
 * expected refusal reasons — the monthly spend ceiling (issue #92) OR the
 * `llm` feature flag being off (issue #126, ADR 0047; `generateEmbedding`
 * throws `FeatureDisabledError` before the ceiling preflight even runs) —
 * every call site below degrades instead of failing the whole tool call; see
 * each site for exactly how. Any OTHER error still rethrows and fails the
 * tool call — those are unexpected. Logs a warning here (adversarial review
 * M3 — this used to swallow the ceiling error with zero log line, an
 * #63-class silent degradation) so a caller doesn't need to re-derive "why
 * did this come back empty/unranked" from the response alone.
 */
async function embedQuery(userId: string, text: string): Promise<EmbedQueryResult> {
  // W7 D3: no embedding key at all (explicit config check, never a catch-all)
  // -> keyword-only, not a "Missing OPENAI_API_KEY" tool error.
  if (!embeddingsConfigured()) {
    return { vector: null, degradedMessage: EMBEDDINGS_NOT_CONFIGURED_MESSAGE, familyArgs: {} };
  }
  // D-072 / migration 139: the default family and a family with chat floors (CHAT_FAMILY_THRESHOLDS) send a
  // vector, the latter with its family filter and cut; any other family runs keyword-only (no embed call).
  const plan = chatVectorPlan();
  if (!plan.allowed) {
    return { vector: null, degradedMessage: EMBEDDING_FAMILY_KEYWORD_ONLY_MESSAGE, familyArgs: {} };
  }
  try {
    // Query-time embed: skip the monthly-ceiling preflight (skipCeiling — see
    // embeddings.ts's doc comment). A search query costs ~$0.000003 to embed;
    // blocking it once the ceiling (meant for bulk ingest spend) is hit
    // degrades this whole tool to keyword-only for nothing saved.
    const vec = await generateEmbedding(text, { userId, pass: "query_embedding", skipCeiling: true });
    return { vector: `[${vec.join(",")}]`, degradedMessage: null, familyArgs: plan.rpcArgs };
  } catch (err) {
    if (err instanceof EmbeddingCeilingExceededError) {
      log.warn("mcp embedQuery degraded: monthly embedding cost ceiling exceeded", {
        user_id: userId,
        spent_usd: err.spentUsd,
        ceiling_usd: err.ceilingUsd,
      });
      return { vector: null, degradedMessage: EMBEDDING_DEGRADED_MESSAGE, familyArgs: {} };
    }
    if (err instanceof FeatureDisabledError) {
      log.warn("mcp embedQuery degraded: embeddings feature not enabled/exhausted for this user", {
        user_id: userId,
        detail: err.reason,
      });
      return { vector: null, degradedMessage: EMBEDDING_FEATURE_DISABLED_MESSAGE, familyArgs: {} };
    }
    throw err;
  }
}

/**
 * Resolve a `scope` string to a LifeArea id. LifeAreas lived in the dropped kg_*
 * graph (migration 134), so no scope can resolve any more: a supplied scope
 * throws UnknownScopeError, and no scope returns null. No RPC is made.
 */
export async function resolveScopeId(
  _supabase: Db,
  _userId: string,
  scope: string | undefined,
): Promise<string | null> {
  if (!scope) return null;
  throw new UnknownScopeError(scope);
}

/**
 * Effective scope id for a request. `tokenScopeId` is the key's legacy
 * `api_key_scope_node_id` (null for an unscoped key): it is passed through to
 * the SQL functions, which now FAIL CLOSED for a non-null id (migration 134),
 * so a stale scoped key matches nothing. A client-supplied `scope` can never
 * resolve (see resolveScopeId). The token bound is never taken from the
 * request body; the route injects it from the validated key.
 */
export async function resolveEffectiveScopeId(
  supabase: Db,
  userId: string,
  clientScope: string | undefined,
  tokenScopeId: string | null,
): Promise<string | null> {
  if (!tokenScopeId) return resolveScopeId(supabase, userId, clientScope);
  if (!clientScope) return tokenScopeId;
  throw new UnknownScopeError(clientScope);
}

// ---------------- search_conversations (unified: chat + code, goal 2026-07-26 step 10/11, #87/#39) ----------------

/**
 * One hit from `mcp_search_unified` (migration 044, upgraded by 045) mapped
 * into a stable TS shape. `id` is deliberately the single "what would I fetch
 * next" handle — `conversation_id` for a chat hit (pass to `get_conversation`),
 * `session_id` for a code hit (pass to `get_code_session`) — so a caller that
 * doesn't care about the distinction can still do `results.map(r => r.id)`
 * exactly like the pre-unification shape allowed.
 */
export interface UnifiedSearchResult {
  source_type: "chat" | "code";
  id: string;
  title: string | null;
  /** Chat-only (conversation extracted_metadata summary); always null on a code hit. */
  summary: string | null;
  similarity: number | null;
  /** The cross-leg ranking score — see migration 044's header for what this is and why. */
  score: number;
  recency: string | null;
  snippet: string | null;
  /**
   * true when this hit resolves to a specific span — a chunk-level chat
   * excerpt (message_start_idx/message_end_idx populated) or ANY code-turn
   * hit (a turn is already the atomic unit, see migration 045's header);
   * false only for a whole-conversation fallback chat row (title/summary,
   * no message range) — goal step 11's coverage-aware "no cliff" fallback.
   */
  resolved: boolean;
  chunk_idx: number | null;
  message_start_idx: number | null;
  message_end_idx: number | null;
  session_id: string | null;
  turn_idx: number | null;
  code_project_id: string | null;
  project_name: string | null;
  /** Ids of other hits in this call whose snippet was identical to this one's (collapseIdenticalSnippets); absent when none. */
  also_in?: string[];
}

/**
 * Raw shape of one row returned by the `mcp_search_unified` RPC (migration
 * 044, upgraded by 045). On a CODE row, `title`/`summary` are now the
 * session's own `title`/`summary` columns (MINOR-3 fix, round-2 adversarial
 * re-verification, 2026-07-26 — see 045's `code_matches` CTE comment) so
 * toUnifiedResult below has what it needs to render a display title for a
 * session that was never given an explicit title.
 */
interface RawUnifiedRow {
  source_type: "chat" | "code";
  conversation_id: string | null;
  session_id: string | null;
  turn_idx: number | null;
  code_project_id: string | null;
  project_name: string | null;
  title: string | null;
  summary: string | null;
  similarity: number | null;
  score: number;
  recency: string | null;
  resolved: boolean;
  chunk_idx: number | null;
  message_start_idx: number | null;
  message_end_idx: number | null;
  snippet: string | null;
}

function toUnifiedResult(row: RawUnifiedRow): UnifiedSearchResult {
  const isCode = row.source_type === "code";
  return {
    source_type: row.source_type,
    id: row.source_type === "chat" ? (row.conversation_id as string) : (row.session_id as string),
    // MINOR-3 fix (round-2 adversarial re-verification, 2026-07-26): a code
    // hit's title used to be the bare, often-null session title — 65/68
    // sessions in the live corpus surfaced as `title: null`. Routed through
    // the SAME title-or-summary fallback code-sessions/view.ts's
    // sessionDisplayTitle() applies dashboard-side, using the session
    // summary the RPC now returns (see RawUnifiedRow's doc comment) rather
    // than a project-name/snippet stand-in (rejected — a snippet is a
    // search-relevance excerpt, not a stable title, and would render a
    // different "title" for the same session depending on which query
    // matched it). A chat row's title is untouched — it always has one
    // (conversations.title defaults to "Untitled" at sync time, see
    // /api/sync's row mapping), so this fallback never applies to it.
    title: isCode ? sessionDisplayTitle({ title: row.title, summary: row.summary }) : row.title,
    // `summary` keeps its pre-existing "chat-only, always null on a code
    // hit" contract (UnifiedSearchResult's own doc comment) — the session
    // summary above is consumed ONLY for the title fallback, not re-exposed
    // here, so no existing caller's assumption about this field changes.
    summary: isCode ? null : row.summary,
    similarity: row.similarity,
    score: row.score,
    recency: row.recency,
    snippet: row.snippet,
    resolved: row.resolved,
    chunk_idx: row.chunk_idx,
    message_start_idx: row.message_start_idx,
    message_end_idx: row.message_end_idx,
    session_id: row.session_id,
    turn_idx: row.turn_idx,
    code_project_id: row.code_project_id,
    project_name: row.project_name,
  };
}

/**
 * ADR 0039 (W6/D7 review round 2 — residual leak) — a mirrored code session
 * (source='claude-code') is a real row in `conversations`, so the chat leg
 * of `mcp_search_unified` (FTS/similarity over `conversations`) can return
 * it as a `source_type: 'chat'` hit — duplicating (in a lower-quality form:
 * no turn_idx/session_id) the genuine `source_type: 'code'` hit the code
 * leg already returns for the SAME underlying session. `mcp_search_unified`
 * has no lane awareness of its own (same reasoning as
 * the retired bridge's route-level `excludeCodeLaneIds` — a migration to
 * add a narrowing filter isn't warranted when it can be applied just as
 * well after the fact): this checks `conversations.source` for the
 * returned chat-leg ids in one batch and drops any that are code-lane,
 * regardless of `p_include_code` — a chat-type result must always mean
 * genuine chat-lane content; code-lane content only ever surfaces via a
 * `source_type: 'code'` hit. Fails OPEN (logs, keeps every chat hit
 * unfiltered) on a lookup error, same posture as every other degrade path
 * in this file — this is the user's own data either way.
 */
async function excludeCodeLaneChatHits(
  supabase: Db,
  userId: string,
  results: UnifiedSearchResult[],
): Promise<UnifiedSearchResult[]> {
  const chatIds = [...new Set(results.filter((r) => r.source_type === "chat").map((r) => r.id))];
  if (chatIds.length === 0) return results;
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, source")
      .eq("user_id", userId)
      .in("id", chatIds);
    if (error) throw new Error(error.message);
    const codeLaneIds = new Set(
      ((data ?? []) as { id: string; source: string | null }[])
        .filter((r) => r.source === "claude-code")
        .map((r) => r.id),
    );
    if (codeLaneIds.size === 0) return results;
    return results.filter((r) => !(r.source_type === "chat" && codeLaneIds.has(r.id)));
  } catch (err) {
    log.warn("mcp_search_unified: code-lane chat-hit lookup failed, leaving results unfiltered", {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return results;
  }
}

/** A hit below this share of its leg's top score in the same call is dropped (applyRelativeCutoff). */
export const RELATIVE_SCORE_CUTOFF = 0.05;

/**
 * Drops hits scoring below RELATIVE_SCORE_CUTOFF x the top score of their
 * own leg in this call. `score` is the RPC's per-leg score (migration 102):
 * code = ts_rank(..., 32) x tool/lookup weights, chat = GREATEST(ts_rank,
 * cosine) + title boost. ts_rank's proximity term collapses toward 0 when a
 * query's terms sit far apart (a word in a pasted table, the other pages
 * away), which is where 1e-9 scores come from. The two legs are different
 * formulas (a chat title hit scores > 1.0, a strong code turn ~0.1), so the
 * cutoff is relative per leg, never one constant and never across legs;
 * each leg's top hit always stays. The RRF `rrf` is not used: 1/(60+rank)
 * never falls to 5% of 1/61 within any limit, so a cutoff on it is a no-op.
 */
export function applyRelativeCutoff(results: UnifiedSearchResult[]): UnifiedSearchResult[] {
  const top = new Map<string, number>();
  for (const r of results) {
    const s = Number.isFinite(r.score) ? r.score : 0;
    top.set(r.source_type, Math.max(top.get(r.source_type) ?? 0, s));
  }
  return results.filter((r) => {
    const legTop = top.get(r.source_type) ?? 0;
    return legTop <= 0 || r.score >= legTop * RELATIVE_SCORE_CUTOFF;
  });
}

function snippetKey(snippet: string | null): string | null {
  const key = (snippet ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return key === "" ? null : key;
}

/**
 * Hits whose snippets are identical after lowercasing and collapsing
 * whitespace become one hit: the best-scoring one, in the first one's place,
 * with the others' ids in `also_in` (the same pasted output quoted in several
 * sessions). Exact match only: two snippets that differ by one word stay two
 * hits. Empty snippets never collapse.
 */
export function collapseIdenticalSnippets(results: UnifiedSearchResult[]): UnifiedSearchResult[] {
  const groups = new Map<string, UnifiedSearchResult[]>();
  const order: (string | UnifiedSearchResult)[] = [];
  for (const r of results) {
    const key = snippetKey(r.snippet);
    if (key === null) {
      order.push(r);
      continue;
    }
    const group = groups.get(key);
    if (group) group.push(r);
    else {
      groups.set(key, [r]);
      order.push(key);
    }
  }
  return order.map((entry) => {
    if (typeof entry !== "string") return entry;
    const group = groups.get(entry) as UnifiedSearchResult[];
    if (group.length === 1) return group[0];
    const best = group.reduce((a, b) => (b.score > a.score ? b : a));
    return { ...best, also_in: group.filter((r) => r !== best).map((r) => r.id) };
  });
}

/**
 * D (2026-09-25) "no more Untitled session", search leg: toUnifiedResult's
 * title/summary chain already renders "Untitled session" ONLY when a code
 * hit's title AND summary were both empty -- that literal is therefore a
 * reliable signal for which hits still need the first-user-message tier
 * (getFirstUserMessages, one batched query for however many of the FINAL
 * results need it -- called after the cutoff/collapse below, never before,
 * so a hit that gets dropped or collapsed away never pays for the query).
 * Cosmetic only: never touches score/snippet/resolved, so ranking, the
 * relative cutoff and snippet collapsing are unaffected.
 */
async function fillSearchHitTitleFallbacks(
  supabase: Db,
  userId: string,
  results: UnifiedSearchResult[],
): Promise<UnifiedSearchResult[]> {
  const needFallback = results.filter((r) => r.source_type === "code" && r.title === "Untitled session");
  if (needFallback.length === 0) return results;
  const firstMessages = await getFirstUserMessages(
    supabase,
    userId,
    needFallback.map((r) => r.id),
  );
  if (firstMessages.size === 0) return results;
  return results.map((r) =>
    r.source_type === "code" && r.title === "Untitled session"
      ? { ...r, title: sessionDisplayTitle({ title: null, summary: null, firstUserMessage: firstMessages.get(r.id) }) }
      : r,
  );
}

/**
 * CONTRACT NOTE: the wire shape is a bare array on a normal result and ONLY
 * becomes `{conversations, degraded}` under ceiling degradation (issue #92
 * adversarial review M3) — callers parsing the MCP response must handle both.
 * The `conversations` key name is kept from the pre-unification contract even
 * though the array can now contain code hits too (goal step 10 DoD: "the tool
 * contract keeps its name") — renaming it would be a breaking wire change for
 * zero behavioral benefit.
 */
export async function searchConversationsScoped(
  supabase: Db,
  userId: string,
  query: string,
  scope?: string,
  limit?: number,
  tokenScopeId: string | null = null,
  /**
   * Whether the code leg of the unified search runs (goal step 10 DoD: "a
   * code-related query returns a code-session hit through MCP"). Defaults
   * true (an unscoped caller, e.g. a direct library call or a test). The MCP
   * route (server.ts) passes `tokenScopeId === null` explicitly: an
   * AREA-scoped API key's bound is "one LifeArea of chat" with no code-project
   * membership concept to check against (see code-tools.ts's header on why an
   * area-scoped key gets zero code tools) — folding code hits into that key's
   * search would silently grant it unbounded code access the rest of the key
   * model explicitly denies it.
   */
  includeCode = true,
  /** Recency bound as an ISO timestamp (mcp/since.ts); null = no bound (migration 095). */
  since: string | null = null,
): Promise<UnifiedSearchResult[] | { conversations: UnifiedSearchResult[]; degraded: string }> {
  const scopeId = await resolveEffectiveScopeId(supabase, userId, scope, tokenScopeId);
  // Ceiling hit OR llm feature disabled (#92 / #126): embedQuery returns a
  // null vector, and the RPC's chat-leg WHERE clause is
  // `fts @@ ... OR similarity > 0.3` — a null p_query_embedding makes the
  // similarity half of that OR evaluate to null (never true), so the RPC
  // degrades to FTS-only on its own with no extra branching needed here (the
  // code leg was always FTS-only — unaffected).
  const { vector: embedding, degradedMessage, familyArgs } = await embedQuery(userId, query);
  const wanted = clampLimit(limit, 10);
  const { data, error } = await supabase.rpc("mcp_search_unified", {
    p_user_id: userId,
    p_query: query,
    p_query_embedding: embedding,
    // Over-fetch: the code-lane filter, the relative cutoff and the snippet
    // collapse below all drop rows; the extra fill the caller's limit.
    p_limit: Math.min(wanted * 2, 100),
    p_scope_id: scopeId,
    p_include_code: includeCode,
    p_since: since,
    ...familyArgs,
  });
  if (error) throw new Error(`mcp_search_unified failed: ${error.message}`);
  const mapped = ((data ?? []) as RawUnifiedRow[]).map(toUnifiedResult);
  const kept = await excludeCodeLaneChatHits(supabase, userId, mapped);
  const cut = collapseIdenticalSnippets(applyRelativeCutoff(kept)).slice(0, wanted);
  const results = await fillSearchHitTitleFallbacks(supabase, userId, cut);
  if (embedding === null) {
    // `degraded` makes the FTS-only fallback visible in the response itself
    // (adversarial review M3) even though real (unranked-by-similarity, still
    // ts_rank-ranked per migration 044/045) matches came back.
    return { conversations: results, degraded: degradedMessage ?? EMBEDDING_DEGRADED_MESSAGE };
  }
  return results;
}

// ---------------- list_recent_conversations (migration 094) ----------------

/** Code-session sources the ingest paths write (packages/core/src/sessions). */
export const CODE_SESSION_SOURCES = new Set(["claude-code", "opencode", "copilot-cli", "codex"]);

export type RecentKind = "chat" | "code" | "all";

export interface RecentChat {
  type: "chat";
  id: string;
  title: string | null;
  source: string;
  created_at: string | null;
  updated_at: string | null;
  message_count: number;
}

export interface RecentCodeSession {
  type: "code";
  /** code_sessions.id — what get_code_session takes. */
  id: string;
  project_name: string | null;
  git_branch: string | null;
  source: string;
  started_at: string | null;
  ended_at: string | null;
  turn_count: number | null;
  /** The session's own summary, cut to 200 chars in SQL; null if none. */
  summary: string | null;
  /**
   * D (2026-09-25) "no more Untitled session": sessionDisplayTitle's
   * summary/first-message fallback -- mcp_recent_conversations (migration
   * 094) never selects a raw code-session title column for a code row at
   * all, so this is ALWAYS a derived value, never empty and never a raw
   * `null` the caller has to special-case.
   */
  title: string;
}

export type RecentItem = RecentChat | RecentCodeSession;

export const RECENT_HINT =
  "Open a chat with get_conversation id=<id> and a coding session with get_code_session id=<id> (long ones come in parts).";

/** The caller asked for a kind this key may not read. */
export class RecentKindNotAllowedError extends Error {
  constructor(kind: "chat" | "code") {
    super(
      kind === "chat"
        ? "This API key is scoped to a code project; it cannot list chats. Use kind=code."
        : "This API key is scoped to a life area; it cannot list coding sessions. Use kind=chat.",
    );
    this.name = "RecentKindNotAllowedError";
  }
}

function pickRecent(row: RecentItem): RecentItem {
  if (row.type === "code") {
    return {
      type: "code",
      id: row.id,
      project_name: row.project_name,
      git_branch: row.git_branch,
      source: row.source,
      started_at: row.started_at,
      ended_at: row.ended_at,
      turn_count: row.turn_count,
      summary: row.summary,
      // Summary tier only here (no title column exists to check) -- the
      // first-message tier for any row still "Untitled session" is filled in
      // by fillRecentCodeTitleFallbacks below, which needs a DB call this
      // synchronous per-row mapper can't make.
      title: sessionDisplayTitle({ title: null, summary: row.summary }),
    };
  }
  return {
    type: "chat",
    id: row.id,
    title: row.title,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    message_count: row.message_count,
  };
}

/**
 * D (2026-09-25) "no more Untitled session", list_recent_conversations leg:
 * same pattern as fillSearchHitTitleFallbacks above -- pickRecent's
 * synchronous summary-tier fallback already renders "Untitled session" only
 * when a code row's summary was ALSO empty, so that literal is the reliable
 * signal for which rows still need one batched getFirstUserMessages call.
 */
async function fillRecentCodeTitleFallbacks(
  supabase: Db,
  userId: string,
  results: RecentItem[],
): Promise<RecentItem[]> {
  const needFallback = results.filter(
    (r): r is RecentCodeSession => r.type === "code" && r.title === "Untitled session",
  );
  if (needFallback.length === 0) return results;
  const firstMessages = await getFirstUserMessages(
    supabase,
    userId,
    needFallback.map((r) => r.id),
  );
  if (firstMessages.size === 0) return results;
  return results.map((r) =>
    r.type === "code" && r.title === "Untitled session"
      ? { ...r, title: sessionDisplayTitle({ title: null, summary: null, firstUserMessage: firstMessages.get(r.id) }) }
      : r,
  );
}

/**
 * The user's chats and main coding sessions, newest activity first, metadata
 * only. Key scoping mirrors the rest of the MCP surface:
 *   - chats: readable unless the key is code-project-scoped (server.ts gives
 *     such a key no chat tools); an area-scoped key sees only chats under its
 *     LifeArea (same SQL predicate as mcp_scoped_conversation).
 *   - code sessions: readable when the key is unscoped or code-project-scoped
 *     (the code-tools gate in server.ts); a code-project-scoped key sees only
 *     that project (same SQL predicate as code_session_detail).
 * The same bounds are passed to mcp_recent_conversations, which enforces them
 * again in SQL. `source` must already be validated by the caller.
 */
export async function listRecentConversations(
  supabase: Db,
  userId: string,
  opts: { since: string | null; source?: string | null; limit?: number; kind?: RecentKind },
  bounds: { tokenScopeId: string | null; codeScopeId: string | null } = { tokenScopeId: null, codeScopeId: null },
): Promise<{ hint: string; results: RecentItem[] }> {
  const kind = opts.kind ?? "all";
  const chatAllowed = bounds.codeScopeId === null;
  const codeAllowed = bounds.codeScopeId !== null || bounds.tokenScopeId === null;
  if (kind === "chat" && !chatAllowed) throw new RecentKindNotAllowedError("chat");
  if (kind === "code" && !codeAllowed) throw new RecentKindNotAllowedError("code");

  const { data, error } = await supabase.rpc("mcp_recent_conversations", {
    p_user_id: userId,
    p_since: opts.since,
    p_limit: clampLimit(opts.limit, 30, 100),
    p_source: opts.source ?? null,
    p_scope_id: bounds.tokenScopeId,
    p_scope_code_project_id: bounds.codeScopeId,
    p_include_chat: chatAllowed && kind !== "code",
    p_include_code: codeAllowed && kind !== "chat",
  });
  if (error) throw new Error(`mcp_recent_conversations failed: ${error.message}`);
  const results = await fillRecentCodeTitleFallbacks(supabase, userId, ((data ?? []) as RecentItem[]).map(pickRecent));
  return { hint: RECENT_HINT, results };
}

// ---------------- get_conversation (graph-scoped direct fetch) ----------------

export interface ScopedConversation {
  id: string;
  source: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  model: string | null;
  messages: unknown;
  metadata: unknown;
}

/**
 * Fetch one conversation by id under the token's area bound (issue #83).
 * Returns null when the conversation does not exist, is not the user's, OR is
 * not attached under the token scope's `contains` subtree — the tool layer
 * turns null into a plain "not found", so an out-of-scope (or orphan)
 * conversation is INVISIBLE (404-equivalent, never 403 — no existence leak).
 * tokenScopeId null preserves the pre-#83 behaviour (any of the user's convs).
 * The direct id NEVER escapes the bound: scoping is a SQL predicate in
 * mcp_scoped_conversation, not a post-filter here.
 */
export async function getScopedConversation(
  supabase: Db,
  userId: string,
  conversationId: string,
  tokenScopeId: string | null = null,
): Promise<ScopedConversation | null> {
  const { data, error } = await supabase.rpc("mcp_scoped_conversation", {
    p_user_id: userId,
    p_conversation_id: conversationId,
    p_scope_id: tokenScopeId,
  });
  if (error) throw new Error(`mcp_scoped_conversation failed: ${error.message}`);
  return (data ?? null) as ScopedConversation | null;
}
