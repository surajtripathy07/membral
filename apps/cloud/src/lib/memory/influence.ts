// Recall influence reconciliation (#361, goal W2 item 2.1).
//
// WHAT "INFLUENCED" MEANS. A memory_recall_events row records which
// session_memories records were served into a coding session (by an MCP tool
// call, or by the SessionStart preamble). Once that session's turns are
// imported, this module marks the event:
//
//   influenced_quote — some assistant-role turn in the window (below)
//     contains a served record's `quote` verbatim. Comparison is
//     whitespace-normalised (runs of whitespace collapse to one space, ends
//     trimmed) and only quotes of at least MIN_QUOTE_CHARS characters count;
//     a paraphrase, a translation or a partial quote does NOT count. An
//     assistant that merely restates a served record (e.g. echoes the
//     preamble back) DOES count: this is co-occurrence, not proof of use.
//   influenced_edit — some turn in the window is an edit/write tool call
//     (EDIT_TOOL_NAMES) whose file_path equals a path listed on a served
//     record's `paths`, or ends with "/" then that path. Only record paths containing a
//     "/" are used (a bare file name like `index.ts` would match too much);
//     records that carry no such path never produce an edit hit.
//
// WINDOW. A preamble event counts every turn of the session: the preamble is
// injected at session start, before any turn, so a served_at cutoff would
// only lose turns to clock skew between the server and the client that
// stamps turn `ts`. An MCP event counts turns with ts >= served_at minus
// MCP_SKEW_TOLERANCE_MS. Turns with no parseable `ts` never count for MCP
// events. matched_turn_idx is the first turn that satisfied either rule.
//
// WHICH EVENTS. (1) Events of this user whose code_session_id is the session,
// or whose harness_session_id equals the session's source_session_id (the
// harness's own id: Claude Code's SessionStart `session_id`; the preamble
// fires before any code_sessions row exists). (2) MCP events of this user
// that echo the recall_token of a preamble event found in (1): the token is
// minted by that preamble, so the call happened in this session. Events tied
// to another code_session_id are skipped, and session_summary events are
// never reconciled (their code_session_id is the SUMMARISED session, not
// where the summary was served). (3) MCP events matched by the session's own
// tool-call turns: agents do not pass the optional recall_token argument
// (observed on prod 2026-10-02: memory_search events with a null token), so
// events (2) misses keep a null code_session_id and are never checked. A
// turn whose tool_name is a Membral memory tool (MEMBRAL_RECALL_TOOLS) with a
// parseable ts claims this user's surface='mcp' event for the same tool,
// bound to no other session, whose served_at - ts lies in the name's window.
// Claude Code names: the tool_result turn, [-5s, +2s]: on 21 historical prod
// calls served_at - tool_result.ts was always -1.6s..-0.6s (the event is
// logged just before the result returns), while served_at - tool_use.ts
// ranged -5.6s..+23.5s. opencode names: the parser emits no tool_result turn
// (the call is one tool_use row stamped with state.time.start), so the
// tool_use turn is used with the wider window [-5s, +25s]. Events carrying a
// recall_token that is not one of this session's preamble tokens belong to a
// different session and are never claimed. One query per session over the
// results' time range; assignment is greedy by smallest |served_at - ts|, so a
// turn claims at most one event and an event at most one turn. A claimed event
// has code_session_id set compare-and-set (only while still null).
//
// SAFETY. Every query is scoped by user_id. `.in()` lists are chunked at
// IN_CHUNK_SIZE (#277: PostgREST 414s past ~200 UUIDs). Turn reads page past
// the 1000-row cap. The caller (code-sessions/import.ts) treats any throw as
// a logged warning, never an import failure.
import type { Db } from "@/lib/db/types";
import { selectAllRows } from "@/lib/util/pagination";

/**
 * Edit/write tool names as the session parsers in packages/core emit them:
 * Claude Code (sessions/claude-code.ts FILE_PATH_TOOLS minus Read) and
 * opencode (sessions/opencode.ts FILE_PATH_TOOLS minus read).
 */
export const EDIT_TOOL_NAMES: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write"];

export const MCP_RESULT_MATCH_BEFORE_MS = 5_000;
export const MCP_RESULT_MATCH_AFTER_MS = 2_000;
export const MCP_START_MATCH_BEFORE_MS = 5_000;
export const MCP_START_MATCH_AFTER_MS = 25_000;

interface RecallToolRule {
  /** memory_recall_events.tool value. */
  tool: "memory_search" | "memory_recall";
  /** Which of the session's turns carries the call time. */
  turnKind: "tool_result" | "tool_use";
  /** Window for served_at - turn.ts: [-before, +after]. */
  before: number;
  after: number;
}

const CLAUDE_CODE_RULE = {
  turnKind: "tool_result",
  before: MCP_RESULT_MATCH_BEFORE_MS,
  after: MCP_RESULT_MATCH_AFTER_MS,
} as const;
const OPENCODE_RULE = {
  turnKind: "tool_use",
  before: MCP_START_MATCH_BEFORE_MS,
  after: MCP_START_MATCH_AFTER_MS,
} as const;

/**
 * Membral memory tool names as they appear in turns' tool_name, each with the
 * rule that ties its turn to a memory_recall_events row. session_summary is
 * deliberately absent.
 *  - Claude Code names MCP tools `mcp__<server>__<tool>` (claude-code.ts stores
 *    the raw name; migration 097 documents it) and emits a tool_result turn
 *    whose ts follows the event by 0.6-1.6s.
 *  - opencode names them `<server>_<tool>` (opencode.ts isLikelyMcpTool) and
 *    emits NO tool_result turn: the call is one tool_use row stamped with
 *    state.time.start, so the rule uses that turn and the wider tool_use
 *    spread observed on Claude Code (served_at - ts of -5.6s..+23.5s).
 */
export const MEMBRAL_RECALL_TOOLS: Readonly<Record<string, RecallToolRule>> = {
  mcp__membral__memory_search: { tool: "memory_search", ...CLAUDE_CODE_RULE },
  mcp__membral__memory_recall: { tool: "memory_recall", ...CLAUDE_CODE_RULE },
  membral_memory_search: { tool: "memory_search", ...OPENCODE_RULE },
  membral_memory_recall: { tool: "memory_recall", ...OPENCODE_RULE },
};

export const MIN_QUOTE_CHARS = 20;
export const MCP_SKEW_TOLERANCE_MS = 30_000;
const IN_CHUNK_SIZE = 100;
const MAX_EVENTS = 500;
const EVENT_COLUMNS = "id, tool, surface, recall_token, record_ids, served_at, code_session_id, harness_session_id";

type EventRow = {
  id: string;
  tool: string;
  surface: string | null;
  recall_token: string | null;
  record_ids: string[] | null;
  served_at: string;
  code_session_id: string | null;
  harness_session_id: string | null;
};
type RecordRow = { id: string; quote: string | null; paths: string[] | null };
type TurnRow = {
  idx: number;
  role: string;
  kind: string | null;
  text: string | null;
  tool_name: string | null;
  file_path: string | null;
  ts: string | null;
};

export interface ReconcileResult {
  checked: number;
  influencedQuote: number;
  influencedEdit: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/**
 * A turn's file_path matches a record path when the record path contains a
 * "/" and the turn path equals it or ends with "/" + it. One direction only:
 * a short turn path never matches a longer record path.
 */
export function pathMatches(turnPath: string, recordPath: string): boolean {
  const t = normalizePath(turnPath);
  const r = normalizePath(recordPath);
  if (!t || !r || !r.includes("/")) return false;
  return t === r || t.endsWith(`/${r}`);
}

export async function reconcileRecallInfluence(
  db: Db,
  userId: string,
  codeSessionId: string,
  knownTurns?: TurnRow[],
): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, influencedQuote: 0, influencedEdit: 0 };

  const { data: sessionRow, error: sessionErr } = await db
    .from("code_sessions")
    .select("id, source_session_id")
    .eq("user_id", userId)
    .eq("id", codeSessionId)
    .maybeSingle();
  if (sessionErr) throw new Error(`reconcileRecallInfluence: code_sessions lookup failed: ${sessionErr.message}`);
  if (!sessionRow) return result;
  const harnessId = (sessionRow as { source_session_id: string | null }).source_session_id;

  const belongsHere = (e: EventRow) =>
    e.tool !== "session_summary" && (e.code_session_id === null || e.code_session_id === codeSessionId);

  // (1) Events tied to this session by id or by harness id.
  const matchFilter = harnessId
    ? `code_session_id.eq.${codeSessionId},harness_session_id.eq.${JSON.stringify(harnessId)}`
    : `code_session_id.eq.${codeSessionId}`;
  const { data: eventData, error: eventErr } = await db
    .from("memory_recall_events")
    .select(EVENT_COLUMNS)
    .eq("user_id", userId)
    .or(matchFilter)
    .order("served_at", { ascending: true })
    .limit(MAX_EVENTS);
  if (eventErr) throw new Error(`reconcileRecallInfluence: events lookup failed: ${eventErr.message}`);
  const events = new Map<string, EventRow>();
  for (const e of (eventData ?? []) as EventRow[]) if (belongsHere(e)) events.set(e.id, e);

  // (2) MCP events echoing a recall_token this session's preamble minted.
  const tokens = [
    ...new Set(
      [...events.values()]
        .filter((e) => e.surface === "preamble" && e.recall_token)
        .map((e) => e.recall_token as string),
    ),
  ];
  for (const tokenChunk of chunk(tokens, IN_CHUNK_SIZE)) {
    const { data, error } = await db
      .from("memory_recall_events")
      .select(EVENT_COLUMNS)
      .eq("user_id", userId)
      .in("recall_token", tokenChunk)
      .limit(MAX_EVENTS);
    if (error) throw new Error(`reconcileRecallInfluence: token events lookup failed: ${error.message}`);
    for (const e of (data ?? []) as EventRow[]) if (belongsHere(e) && !events.has(e.id)) events.set(e.id, e);
  }
  // (3) MCP events matched by this session's own Membral call turns (the
  // kind per tool name is in MEMBRAL_RECALL_TOOLS). Caller-supplied turns (the
  // import already holds them) avoid a read; else a narrow select.
  type CallTurn = { kind?: string | null; tool_name: string | null; ts: string | null };
  const ruleOf = (t: CallTurn) =>
    t.tool_name && Object.hasOwn(MEMBRAL_RECALL_TOOLS, t.tool_name) ? MEMBRAL_RECALL_TOOLS[t.tool_name] : null;
  let candidateTurns: CallTurn[];
  if (knownTurns) {
    candidateTurns = knownTurns;
  } else {
    candidateTurns = await selectAllRows<CallTurn>((from, to) =>
      db
        .from("code_session_turns")
        .select("kind, tool_name, ts")
        .eq("user_id", userId)
        .eq("session_id", codeSessionId)
        .in("kind", ["tool_result", "tool_use"])
        .in("tool_name", Object.keys(MEMBRAL_RECALL_TOOLS))
        .order("idx", { ascending: true })
        .range(from, to),
    );
  }
  const callTurns = candidateTurns
    .map((t) => ({ rule: ruleOf(t), kind: t.kind, tsMs: t.ts ? Date.parse(t.ts) : Number.NaN }))
    .filter((t) => t.rule !== null && t.kind === t.rule.turnKind && Number.isFinite(t.tsMs))
    .map((t) => ({ rule: t.rule as RecallToolRule, tsMs: t.tsMs }));
  if (callTurns.length > 0) {
    // served_at - ts lies in [-before, +after], so served_at in [ts - before, ts + after].
    const minMs = Math.min(...callTurns.map((t) => t.tsMs - t.rule.before));
    const maxMs = Math.max(...callTurns.map((t) => t.tsMs + t.rule.after));
    const { data, error } = await db
      .from("memory_recall_events")
      .select(EVENT_COLUMNS)
      .eq("user_id", userId)
      .eq("surface", "mcp")
      .in("tool", [...new Set(callTurns.map((t) => t.rule.tool))])
      .or(`code_session_id.is.null,code_session_id.eq.${codeSessionId}`)
      .gte("served_at", new Date(minMs).toISOString())
      .lte("served_at", new Date(maxMs).toISOString())
      .order("served_at", { ascending: true })
      .limit(MAX_EVENTS);
    if (error) throw new Error(`reconcileRecallInfluence: turn-matched events lookup failed: ${error.message}`);
    const ownTokens = new Set(tokens);
    // A token that is not one of this session's preamble tokens marks another session's call.
    const candidates = ((data ?? []) as EventRow[]).filter(
      (e) => belongsHere(e) && !events.has(e.id) && (e.recall_token === null || ownTokens.has(e.recall_token)),
    );
    const pairs: { ti: number; ei: number; diff: number }[] = [];
    callTurns.forEach((t, ti) =>
      candidates.forEach((e, ei) => {
        const delta = Date.parse(e.served_at) - t.tsMs;
        if (e.tool === t.rule.tool && delta >= -t.rule.before && delta <= t.rule.after)
          pairs.push({ ti, ei, diff: Math.abs(delta) });
      }),
    );
    pairs.sort((a, b) => a.diff - b.diff || a.ti - b.ti || a.ei - b.ei);
    const usedTurns = new Set<number>();
    const usedEvents = new Set<number>();
    for (const p of pairs) {
      if (usedTurns.has(p.ti) || usedEvents.has(p.ei)) continue;
      usedTurns.add(p.ti);
      usedEvents.add(p.ei);
      const e = candidates[p.ei];
      events.set(e.id, e);
    }
  }
  if (events.size === 0) return result;

  const recordIds = [...new Set([...events.values()].flatMap((e) => e.record_ids ?? []))];
  const records = new Map<string, RecordRow>();
  for (const ids of chunk(recordIds, IN_CHUNK_SIZE)) {
    const { data, error } = await db
      .from("session_memories")
      .select("id, quote, paths")
      .eq("user_id", userId)
      .in("id", ids);
    if (error) throw new Error(`reconcileRecallInfluence: session_memories lookup failed: ${error.message}`);
    for (const r of (data ?? []) as RecordRow[]) records.set(r.id, r);
  }

  const turns =
    knownTurns ??
    (await selectAllRows<TurnRow>((from, to) =>
      db
        .from("code_session_turns")
        .select("idx, role, kind, text, tool_name, file_path, ts")
        .eq("user_id", userId)
        .eq("session_id", codeSessionId)
        .order("idx", { ascending: true })
        .range(from, to),
    ));
  const prepared = turns.map((t) => ({
    ...t,
    tsMs: t.ts ? Date.parse(t.ts) : Number.NaN,
    // Never a tool_use turn: it now carries the text it wrote (Write/Edit), which would match a served quote taken
    // from that file. Before, tool_use turns had no text, so this keeps influenced_quote comparable with older rows.
    normText: t.role === "assistant" && t.kind !== "tool_use" && t.text ? normalizeWhitespace(t.text) : null,
    isEdit: !!t.tool_name && EDIT_TOOL_NAMES.includes(t.tool_name) && !!t.file_path,
  }));

  const checkedAt = new Date().toISOString();
  for (const ev of events.values()) {
    const isPreamble = ev.surface === "preamble";
    const cutoffMs = Date.parse(ev.served_at) - MCP_SKEW_TOLERANCE_MS;
    const served = (ev.record_ids ?? []).map((id) => records.get(id)).filter((r): r is RecordRow => !!r);
    const quotes = served
      .map((r) => (r.quote ? normalizeWhitespace(r.quote) : ""))
      .filter((q) => q.length >= MIN_QUOTE_CHARS);
    const paths = served.flatMap((r) => r.paths ?? []).filter((p) => p.length > 0);

    let quoteHit = false;
    let editHit = false;
    let firstIdx: number | null = null;
    for (const t of prepared) {
      if (!isPreamble && !(t.tsMs >= cutoffMs)) continue; // NaN ts or before the window
      const q = !!t.normText && quotes.some((quote) => (t.normText as string).includes(quote));
      const e = t.isEdit && paths.some((p) => pathMatches(t.file_path as string, p));
      if ((q || e) && firstIdx === null) firstIdx = t.idx;
      quoteHit ||= q;
      editHit ||= e;
      if (quoteHit && editHit) break;
    }

    const update: Record<string, unknown> = {
      influenced_quote: quoteHit,
      influenced_edit: editHit,
      matched_turn_idx: firstIdx,
      influence_checked_at: checkedAt,
    };
    if (ev.code_session_id === null) update.code_session_id = codeSessionId;
    let upd = db.from("memory_recall_events").update(update).eq("user_id", userId).eq("id", ev.id);
    // Compare-and-set: only claim a row that is still unbound.
    if (ev.code_session_id === null) upd = upd.is("code_session_id", null);
    const { data: written, error } = await upd.select("id");
    if (error) throw new Error(`reconcileRecallInfluence: event update failed: ${error.message}`);
    // Lost the race (another session claimed the row first): it is not ours to count.
    if (ev.code_session_id === null && (written ?? []).length === 0) continue;
    result.checked++;
    if (quoteHit) result.influencedQuote++;
    if (editHit) result.influencedEdit++;
  }
  return result;
}
