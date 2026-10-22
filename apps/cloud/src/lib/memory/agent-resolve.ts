// memory_resolve (#436): an agent closes a blocker Membral showed it.
//
// RESOLVE. Only the key owner's own LIVE blocker (explicit user_id filter,
// kind = 'blocker', retired_at is null; a code-scoped key also its project)
// can be resolved. Anything else gets one generic error, so the tool never
// reveals whether another user's id exists. The blocker and its live
// recurrence chain are retired as Today's dismiss does (blocker-dismiss.ts
// retireBlockerChain), with retire_reason = 'agent_resolved',
// resolution_quote = the agent's quote, and resolved_by_harness_session_id
// (migration 119) = the calling harness session when known. The only way to
// know it today is the call's recall_token: the preamble event that minted
// that token (memory_recall_events, surface 'preamble', migration 113)
// carries the harness session id. resolved_by_session_id stays NULL until the
// quote is verified.
//
// DEFERRED VERIFICATION (verifyAgentResolutions, run by the transcript import
// after the turns are written: code-sessions/import.ts; never fails an import).
// It only ever ADDS a receipt; it never un-retires. An agent_resolved row stays
// retired whatever happens here: Today labels it "resolved by agent" and the
// owner's Undo restores it. Which calls the uploaded session made:
//   (a) linked: resolved_by_harness_session_id equals the session's
//       source_session_id (the call carried a recall_token);
//   (b) unlinked (no harness id): claimed by the session's own memory_resolve
//       tool-call turn by time (the #405 rule in influence.ts: the tool_result
//       turn with retired_at - ts in [-5s, +2s]; opencode's tool_use turn in
//       [-5s, +25s]) — only when exactly ONE resolve turn falls in the call's
//       window and exactly ONE unlinked call falls in that turn's window.
//       Anything ambiguous is left alone. The blocker id itself is not in the
//       turns: the parsers keep no input for MCP tools and elide tool_result text.
// A claimed call gets resolved_by_session_id and resolution_turn_idx only when
// its quote is found (whitespace folded, case-insensitive substring) in a turn
// at or before the call's turn. Otherwise nothing is written. CHOICE: a row no
// upload ever verifies stays retired with an unverified receipt.
import { z } from "zod/v4";
import type { Db } from "@/lib/db/types";
import { AGENT_RESOLVED_RETIRE_REASON } from "@/lib/domain/retire-reasons";
import { log } from "@/lib/log";
import { selectAllRows } from "@/lib/util/pagination";
import { retireBlockerChain } from "./blocker-dismiss";
import {
  MCP_RESULT_MATCH_AFTER_MS,
  MCP_RESULT_MATCH_BEFORE_MS,
  MCP_START_MATCH_AFTER_MS,
  MCP_START_MATCH_BEFORE_MS,
} from "./influence";
import { verifyRecallToken } from "./recall-token";

export const MAX_RESOLVE_QUOTE_CHARS = 500;
/** Shorter quotes are refused at call time: they would match almost any transcript. */
export const MIN_RESOLVE_QUOTE_CHARS = 12;

export const MemoryResolveArgsSchema = z.object({
  id: z.uuid(),
  quote: z.string().trim().min(MIN_RESOLVE_QUOTE_CHARS).max(MAX_RESOLVE_QUOTE_CHARS),
  recall_token: z.string().optional(),
});
export type MemoryResolveArgs = z.infer<typeof MemoryResolveArgsSchema>;

/** The one error for every id that is not the caller's live blocker. */
export const RESOLVE_NOT_FOUND = "No open blocker of yours with that id.";

export interface MemoryResolveResult {
  resolved: true;
  /** Every row retired: the blocker and its live recurrence chain. */
  ids: string[];
  /** True when the calling session is known, so the quote will be checked when its transcript uploads. */
  will_verify: boolean;
}

/** The harness session id behind a recall_token: the preamble event of this user that minted it. Null when unknown. */
export async function harnessSessionForToken(
  supabase: Db,
  userId: string,
  token: string | undefined,
): Promise<string | null> {
  const payload = verifyRecallToken(token);
  if (!payload || payload.userId !== userId || !token) return null;
  const { data, error } = await supabase
    .from("memory_recall_events")
    .select("harness_session_id")
    .eq("user_id", userId)
    .eq("surface", "preamble")
    .eq("recall_token", token)
    .not("harness_session_id", "is", null)
    .limit(1);
  if (error) {
    log.warn("memory_resolve: recall-token session lookup failed", { user_id: userId, error: error.message });
    return null;
  }
  return ((data ?? []) as { harness_session_id: string | null }[])[0]?.harness_session_id ?? null;
}

/** memory_resolve. Throws `RESOLVE_NOT_FOUND` for any id that is not the caller's live blocker. */
export async function resolveBlockerByAgent(
  supabase: Db,
  userId: string,
  codeScopeId: string | null,
  rawArgs: unknown,
): Promise<MemoryResolveResult> {
  const parsed = MemoryResolveArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(
      `memory_resolve: id (uuid) and quote (${MIN_RESOLVE_QUOTE_CHARS}-${MAX_RESOLVE_QUOTE_CHARS} chars, the turn text that shows the fix) are required`,
    );
  }
  const { id, quote, recall_token } = parsed.data;
  const harness = await harnessSessionForToken(supabase, userId, recall_token);
  const outcome = await retireBlockerChain(
    supabase,
    userId,
    id,
    { retire_reason: AGENT_RESOLVED_RETIRE_REASON, resolution_quote: quote, resolved_by_harness_session_id: harness },
    codeScopeId,
  );
  if (!outcome.ok) throw new Error(RESOLVE_NOT_FOUND);
  return { resolved: true, ids: outcome.ids, will_verify: harness !== null };
}

interface PendingRow {
  id: string;
  text: string;
  resolution_quote: string | null;
  retired_at: string;
}

interface VerifyTurn {
  idx: number;
  text: string | null;
  ts: string | null;
  kind?: string | null;
  tool_name?: string | null;
  props?: { mcpServer?: unknown } | null;
}

export interface AgentResolutionVerdicts {
  /** Rows that got a receipt (resolved_by_session_id, resolution_turn_idx). */
  verified: string[];
}

/**
 * memory_resolve as it appears in a turn's tool_name, with the turn and window
 * that time the call (see header). Claude Code stores
 * `mcp__membral__memory_resolve` with a tool_result turn; Codex stores that
 * form too, or (namespaced calls, codex.ts mcpParts) the bare `memory_resolve`
 * with props.mcpServer = "membral" on the tool_use turn only, so the bare name
 * counts only with that server and uses the tool_use window. opencode stores
 * `membral_memory_resolve` and no result turn. Gap: no Copilot CLI MCP
 * tool-call fixture exists, so its name shape is unknown and its calls are only
 * linked through a recall_token.
 */
export const RESOLVE_TOOL_RULES: Readonly<
  Record<string, { turnKind: string; before: number; after: number; mcpServer?: string }>
> = {
  mcp__membral__memory_resolve: {
    turnKind: "tool_result",
    before: MCP_RESULT_MATCH_BEFORE_MS,
    after: MCP_RESULT_MATCH_AFTER_MS,
  },
  memory_resolve: {
    turnKind: "tool_use",
    before: MCP_START_MATCH_BEFORE_MS,
    after: MCP_START_MATCH_AFTER_MS,
    mcpServer: "membral",
  },
  membral_memory_resolve: { turnKind: "tool_use", before: MCP_START_MATCH_BEFORE_MS, after: MCP_START_MATCH_AFTER_MS },
};

/** The tool names a resolve call can be stored under — the narrow turn read filters on them. */
const RESOLVE_TOOL_NAMES = Object.keys(RESOLVE_TOOL_RULES);

/** The rule a turn's resolve call is timed by, or null when the turn is not a resolve call. */
function resolveRuleOf(t: VerifyTurn): { before: number; after: number } | null {
  const rule = t.tool_name && Object.hasOwn(RESOLVE_TOOL_RULES, t.tool_name) ? RESOLVE_TOOL_RULES[t.tool_name] : null;
  if (!rule || t.kind !== rule.turnKind) return null;
  if (rule.mcpServer && t.props?.mcpServer !== rule.mcpServer) return null;
  return rule;
}

/** Whitespace-folded, lower-cased text for the quote check. */
function fold(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The newest turn at or before `maxIdx` whose text holds `quote` (normalised substring), or null. Pure. */
export function findQuoteTurn(quote: string | null, turns: readonly VerifyTurn[], maxIdx: number): number | null {
  const q = quote ? fold(quote) : "";
  if (q.length < MIN_RESOLVE_QUOTE_CHARS) return null;
  let found: number | null = null;
  for (const t of turns) {
    if (t.idx <= maxIdx && t.text && fold(t.text).includes(q) && (found === null || t.idx > found)) found = t.idx;
  }
  return found;
}

/** Groups rows into calls: one memory_resolve call retires its chain with one retired_at. */
function groupCalls(rows: readonly PendingRow[]): Map<string, PendingRow[]> {
  const calls = new Map<string, PendingRow[]>();
  for (const r of rows) calls.set(r.retired_at, [...(calls.get(r.retired_at) ?? []), r]);
  return calls;
}

interface CallTurn {
  idx: number;
  ms: number;
  rule: { before: number; after: number };
}

function resolveTurns(turns: readonly VerifyTurn[]): CallTurn[] {
  return turns.flatMap((t) => {
    const rule = resolveRuleOf(t);
    const ms = t.ts ? Date.parse(t.ts) : Number.NaN;
    return rule && Number.isFinite(ms) ? [{ idx: t.idx, ms, rule }] : [];
  });
}

const inWindow = (callMs: number, t: CallTurn) => callMs - t.ms >= -t.rule.before && callMs - t.ms <= t.rule.after;

/** A call this session made, with the turn index its quote must precede. */
export interface ClaimedCall {
  ids: string[];
  rows: PendingRow[];
  callTurnIdx: number;
}

/**
 * Pure: the calls this session made among `linked` (harness id matched) and
 * `unlinked` (no harness id) rows, each with its call turn. Unlinked calls are
 * claimed only one-to-one (see header); a linked call's turn is its unique
 * resolve turn in window, else the newest turn at or before the call.
 */
export function claimCalls(
  linked: readonly PendingRow[],
  unlinked: readonly PendingRow[],
  turns: readonly VerifyTurn[],
): ClaimedCall[] {
  const calls = resolveTurns(turns);
  const out: ClaimedCall[] = [];
  for (const [at, group] of groupCalls(linked)) {
    const callMs = Date.parse(at);
    const hits = calls.filter((t) => inWindow(callMs, t));
    let callTurnIdx = hits.length === 1 ? hits[0].idx : -1;
    if (callTurnIdx < 0) {
      for (const t of turns) {
        const ms = t.ts ? Date.parse(t.ts) : Number.NaN;
        if (Number.isFinite(ms) && ms <= callMs && t.idx > callTurnIdx) callTurnIdx = t.idx;
      }
    }
    if (callTurnIdx >= 0) out.push({ ids: group.map((r) => r.id), rows: group, callTurnIdx });
  }
  const unlinkedCalls = [...groupCalls(unlinked)];
  for (const [at, group] of unlinkedCalls) {
    const callMs = Date.parse(at);
    const hits = calls.filter((t) => inWindow(callMs, t));
    if (hits.length !== 1) continue;
    const rivals = unlinkedCalls.filter(([other]) => inWindow(Date.parse(other), hits[0]));
    if (rivals.length !== 1) continue;
    out.push({ ids: group.map((r) => r.id), rows: group, callTurnIdx: hits[0].idx });
  }
  return out;
}

/** Pure: the receipt turn of each claimed call whose quote is in a turn at or before its call turn; others are dropped. */
export function judgeAgentResolutions(
  claimed: readonly ClaimedCall[],
  turns: readonly VerifyTurn[],
): { ids: string[]; turnIdx: number }[] {
  const out: { ids: string[]; turnIdx: number }[] = [];
  for (const c of claimed) {
    let turnIdx: number | null = null;
    for (const r of c.rows) {
      turnIdx = findQuoteTurn(r.resolution_quote, turns, c.callTurnIdx);
      if (turnIdx !== null) break;
    }
    if (turnIdx !== null) out.push({ ids: c.ids, turnIdx });
  }
  return out;
}

const PENDING_COLUMNS = "id, text, resolution_quote, retired_at";

/** Deferred verification of memory_resolve calls made from this session (see the header). Never throws. */
export async function verifyAgentResolutions(
  supabase: Db,
  userId: string,
  sessionId: string,
): Promise<AgentResolutionVerdicts> {
  const verdicts: AgentResolutionVerdicts = { verified: [] };
  try {
    const sess = await supabase
      .from("code_sessions")
      .select("source_session_id")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (sess.error) throw new Error(sess.error.message);
    if (!sess.data) return verdicts;
    const harness = (sess.data as { source_session_id: string | null }).source_session_id;

    let linked: PendingRow[] = [];
    if (harness) {
      const res = await supabase
        .from("session_memories")
        .select(PENDING_COLUMNS)
        .eq("user_id", userId)
        .eq("retire_reason", AGENT_RESOLVED_RETIRE_REASON)
        .eq("resolved_by_harness_session_id", harness)
        .is("resolved_by_session_id", null);
      if (res.error) throw new Error(res.error.message);
      linked = (res.data ?? []) as PendingRow[];
    }

    // Narrow first: only this session's resolve-call turns (no text). Most
    // uploads have none and no linked rows, and stop here.
    const callTurns = (await selectAllRows((from, to) =>
      supabase
        .from("code_session_turns")
        .select("idx, ts, kind, tool_name, props")
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .in("tool_name", RESOLVE_TOOL_NAMES)
        .order("idx", { ascending: true })
        .range(from, to),
    )) as VerifyTurn[];

    // (b) only when this session has memory_resolve turns: one read from just before the first of them.
    let unlinked: PendingRow[] = [];
    const callMs = resolveTurns(callTurns).map((t) => t.ms);
    if (callMs.length > 0) {
      const slack = MCP_START_MATCH_AFTER_MS + MCP_START_MATCH_BEFORE_MS;
      const res = await supabase
        .from("session_memories")
        .select(PENDING_COLUMNS)
        .eq("user_id", userId)
        .eq("retire_reason", AGENT_RESOLVED_RETIRE_REASON)
        .is("resolved_by_harness_session_id", null)
        .is("resolved_by_session_id", null)
        // Lower bound only: claimCalls applies each turn's exact window.
        .gte("retired_at", new Date(Math.min(...callMs) - slack).toISOString())
        .order("retired_at", { ascending: false })
        .limit(500);
      if (res.error) throw new Error(res.error.message);
      unlinked = (res.data ?? []) as PendingRow[];
    }
    if (linked.length === 0 && unlinked.length === 0) return verdicts;

    // Only now the full turns, text included, for the quote check.
    const turns = (await selectAllRows((from, to) =>
      supabase
        .from("code_session_turns")
        .select("idx, text, ts, kind, tool_name, props")
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .order("idx", { ascending: true })
        .range(from, to),
    )) as VerifyTurn[];

    for (const call of judgeAgentResolutions(claimCalls(linked, unlinked, turns), turns)) {
      const { error } = await supabase
        .from("session_memories")
        .update({ resolved_by_session_id: sessionId, resolution_turn_idx: call.turnIdx })
        .eq("user_id", userId)
        .in("id", call.ids)
        .eq("retire_reason", AGENT_RESOLVED_RETIRE_REASON)
        .is("resolved_by_session_id", null);
      if (error) throw new Error(error.message);
      verdicts.verified.push(...call.ids);
    }
  } catch (err) {
    log.warn("memory_resolve: deferred verification failed — rows left retired without a receipt", {
      user_id: userId,
      session_id: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return verdicts;
}
