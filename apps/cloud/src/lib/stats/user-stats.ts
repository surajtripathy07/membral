// Nightly personal stats (goal 2026-09-26 P8) — the PURE half.
//
// deriveUserStats() turns one UTC day's rows from code_sessions,
// code_session_turns, code_session_issues and mcp_tool_calls into the
// user_stats rows (migration 104) the cron upserts. No Supabase, no fetch, no
// clock: the caller (lib/stats/derive-user-stats.ts) owns the queries and
// passes the day in. Rows come from unvalidated jsonb, so every props read is
// defensive and a malformed value counts as absent, never throws (B12).
//
// COST is the same estimate /code/stats shows: computeCost() over
// props.usage at the primary model, plus each non-fork props.subAgents[]
// entry at its own model — imported from lib/agent-stats/aggregate.ts, never
// re-implemented. It is labelled est. wherever it is shown (B11).
//
// A day with no top-level session for a user yields no row for that user,
// even when MCP calls exist: the row is "what you did in sessions"; a
// stray MCP call without a session is not a day of work.
import { asModelList, asRawUsage, asSubAgentList } from "@/lib/agent-stats/aggregate";
import { computeCost } from "@/lib/code-sessions/price-table";

// ---- Inputs (the columns the loader selects) --------------------------------

export interface UserStatsSessionRow {
  id: string;
  user_id: string;
  code_project_id: string | null;
  parent_source_session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  turn_count: number | null;
  user_turn_count: number | null;
  tool_count: number | null;
  model: string | null;
  props: unknown;
}

export interface UserStatsTurnRow {
  session_id: string;
  role: string;
  kind: string;
  tool_name: string | null;
  file_path: string | null;
  props: unknown;
}

export interface UserStatsIssueRow {
  session_id: string;
  ref: string;
  role: string;
}

export interface UserStatsMcpCallRow {
  user_id: string;
  tool: string;
  ok: boolean;
}

export interface UserStatsProjectRow {
  id: string;
  repo_identity: string;
  display_name: string | null;
}

export interface DeriveUserStatsInput {
  /** UTC day as YYYY-MM-DD; every session/MCP row passed in belongs to it. */
  day: string;
  sessions: UserStatsSessionRow[];
  turns: UserStatsTurnRow[];
  issues: UserStatsIssueRow[];
  mcpCalls: UserStatsMcpCallRow[];
  projects?: UserStatsProjectRow[];
  /** user_id -> the user's earliest session start (any day); copied onto the row. */
  firstSessionAt?: Record<string, string | null | undefined>;
}

// ---- Output (one user_stats row) --------------------------------------------

export interface UserStatsRow {
  user_id: string;
  day: string;
  sessions: number;
  sub_agent_sessions: number;
  turns: number;
  user_turns: number;
  tool_calls: number;
  /** Estimate (B11): price-table cost of the day's usage. */
  cost_usd: number;
  edits: number;
  reads: number;
  tests: number;
  commits: number;
  pushes: number;
  verb_counts: Record<string, number>;
  refs: number;
  ref_counts: Record<string, number>;
  tool_counts: Record<string, number>;
  mcp_calls: number;
  mcp_errors: number;
  mcp_tool_counts: Record<string, number>;
  longest_session_seconds: number | null;
  longest_session_id: string | null;
  busiest_repo: string | null;
  most_edited_file: string | null;
  start_hour: number | null;
  first_session_at: string | null;
}

// ---- Tool-name classes ------------------------------------------------------
// Claude Code and opencode tool names, lower-cased. Anything else is neither
// an edit nor a read and only lands in tool_counts.
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "str_replace_editor",
  "apply_patch",
  "patch",
]);
const READ_TOOLS = new Set(["read", "glob", "grep", "ls", "list", "view", "webfetch"]);

/** Bash digest shapes that count as a test run when no structured action says so (B14 rule). */
const TEST_DIGEST = /\b(npm|pnpm|yarn|npx|bun)\s+(run\s+)?test\b|\b(vitest|jest|pytest|go\s+test|cargo\s+test|mocha)\b/;
const COMMIT_DIGEST = /\bgit\s+commit\b/;
const PUSH_DIGEST = /\bgit\s+push\b/;

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function asObject(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function asInt(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** The action verb on a tool_use turn (`props.action.verb`, P1), or undefined. */
export function actionVerb(props: unknown): string | undefined {
  const action = asObject(asObject(props)?.action);
  // D-051 N3: an action whose repo is not observable is not counted, even as user-level activity —
  // the stats never count what the rest of the product refuses to attribute.
  if (action?.repoUnknown === true) return undefined;
  const verb = action?.verb;
  return typeof verb === "string" && verb.length > 0 && verb.length <= 40 ? verb : undefined;
}

function inputDigest(props: unknown): string {
  const d = asObject(props)?.inputDigest;
  return typeof d === "string" ? d : "";
}

/** Session cost in USD (estimate): main usage at the primary model + each non-fork sub-agent run. */
export function estimateSessionCost(session: Pick<UserStatsSessionRow, "model" | "props">): number {
  const props = asObject(session.props);
  let total = 0;
  const usage = asRawUsage(props?.usage);
  if (usage) {
    const primary = asModelList(props?.models)[0] ?? session.model ?? undefined;
    total += computeCost(usage, primary)?.amount ?? 0;
  }
  for (const sub of asSubAgentList(props?.subAgents)) {
    if (!sub.usage) continue;
    total += computeCost(sub.usage, sub.model)?.amount ?? 0;
  }
  return round6(total);
}

function sessionSeconds(s: UserStatsSessionRow): number | null {
  if (typeof s.duration_seconds === "number" && s.duration_seconds >= 0) return Math.floor(s.duration_seconds);
  if (s.started_at && s.ended_at) {
    const ms = Date.parse(s.ended_at) - Date.parse(s.started_at);
    if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms / 1000);
  }
  return null;
}

function utcHour(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).getUTCHours() : null;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Key with the highest count; ties break on first-seen order (Map insertion). */
function argmax(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

interface Acc {
  row: UserStatsRow;
  sessionIds: Set<string>;
  longest: number;
  hours: number[];
  repoCounts: Map<string, number>;
  fileCounts: Map<string, number>;
  refs: Set<string>;
}

function emptyRow(user_id: string, day: string): UserStatsRow {
  return {
    user_id,
    day,
    sessions: 0,
    sub_agent_sessions: 0,
    turns: 0,
    user_turns: 0,
    tool_calls: 0,
    cost_usd: 0,
    edits: 0,
    reads: 0,
    tests: 0,
    commits: 0,
    pushes: 0,
    verb_counts: {},
    refs: 0,
    ref_counts: {},
    tool_counts: {},
    mcp_calls: 0,
    mcp_errors: 0,
    mcp_tool_counts: {},
    longest_session_seconds: null,
    longest_session_id: null,
    busiest_repo: null,
    most_edited_file: null,
    start_hour: null,
    first_session_at: null,
  };
}

/**
 * One row per user who had at least one TOP-LEVEL session on `day`.
 * Sub-agent sessions and MCP calls only ever add to such a row.
 */
export function deriveUserStats(input: DeriveUserStatsInput): UserStatsRow[] {
  const projectName = new Map<string, string>();
  for (const p of input.projects ?? []) projectName.set(p.id, p.display_name?.trim() || p.repo_identity);

  const byUser = new Map<string, Acc>();
  const acc = (user_id: string): Acc => {
    let a = byUser.get(user_id);
    if (!a) {
      a = {
        row: emptyRow(user_id, input.day),
        sessionIds: new Set(),
        longest: -1,
        hours: [],
        repoCounts: new Map(),
        fileCounts: new Map(),
        refs: new Set(),
      };
      byUser.set(user_id, a);
    }
    return a;
  };

  // Sessions: top-level rows create the user's row; children fold into it.
  const sessionUser = new Map<string, string>();
  for (const s of input.sessions) {
    sessionUser.set(s.id, s.user_id);
    const a = acc(s.user_id);
    a.sessionIds.add(s.id);
    a.row.turns += asInt(s.turn_count);
    a.row.user_turns += asInt(s.user_turn_count);
    if (s.parent_source_session_id) {
      // A child is priced through its parent: estimateSessionCost(parent)
      // already adds each props.subAgents[].usage, so pricing the child row
      // too would count the same spend twice (migration 104's contract).
      a.row.sub_agent_sessions += 1;
      continue;
    }
    a.row.cost_usd = round6(a.row.cost_usd + estimateSessionCost(s));
    a.row.sessions += 1;
    const secs = sessionSeconds(s);
    if (secs !== null && secs > a.longest) {
      a.longest = secs;
      a.row.longest_session_id = s.id;
      a.row.longest_session_seconds = secs;
    }
    const hour = utcHour(s.started_at);
    if (hour !== null) a.hours.push(hour);
    if (s.code_project_id) {
      const name = projectName.get(s.code_project_id) ?? s.code_project_id;
      a.repoCounts.set(name, (a.repoCounts.get(name) ?? 0) + 1);
    }
  }

  // Turns: tool calls, edit/read classes, verbs, commit/push/test fallbacks.
  for (const t of input.turns) {
    const user_id = sessionUser.get(t.session_id);
    if (!user_id) continue;
    const a = acc(user_id);
    if (t.kind !== "tool_use") continue;
    a.row.tool_calls += 1;
    const tool = (t.tool_name ?? "").trim();
    if (tool) bump(a.row.tool_counts, tool);
    const lower = tool.toLowerCase();
    if (EDIT_TOOLS.has(lower)) {
      a.row.edits += 1;
      if (t.file_path) a.fileCounts.set(t.file_path, (a.fileCounts.get(t.file_path) ?? 0) + 1);
    } else if (READ_TOOLS.has(lower)) {
      a.row.reads += 1;
    }
    const verb = actionVerb(t.props);
    if (verb) {
      bump(a.row.verb_counts, verb);
      if (verb === "committed") a.row.commits += 1;
      else if (verb === "pushed") a.row.pushes += 1;
      else if (verb === "tested") a.row.tests += 1;
      continue;
    }
    // No structured action (pre-P1 import): read the redacted Bash digest.
    const digest = inputDigest(t.props);
    if (!digest) continue;
    if (COMMIT_DIGEST.test(digest)) a.row.commits += 1;
    else if (PUSH_DIGEST.test(digest)) a.row.pushes += 1;
    else if (TEST_DIGEST.test(digest)) a.row.tests += 1;
  }

  // Refs: per role, and distinct refs. One (session, ref) counts once, at its
  // strongest role — a legacy tail run could leave the same ref under two
  // roles (review F1), which must not count as two refs of the day.
  const ROLE_RANK: Record<string, number> = { worked_on: 3, discussed: 2, referenced: 1 };
  const strongest = new Map<string, { user_id: string; role: string; ref: string }>();
  for (const i of input.issues) {
    const user_id = sessionUser.get(i.session_id);
    if (!user_id) continue;
    const key = `${i.session_id}\u0000${i.ref}`;
    const prev = strongest.get(key);
    if (!prev || (ROLE_RANK[i.role] ?? 0) > (ROLE_RANK[prev.role] ?? 0))
      strongest.set(key, { user_id, role: i.role, ref: i.ref });
  }
  for (const { user_id, role, ref } of strongest.values()) {
    const a = acc(user_id);
    bump(a.row.ref_counts, role);
    a.refs.add(ref);
  }

  // MCP calls: only for users who already have a row (a session that day).
  for (const c of input.mcpCalls) {
    const a = byUser.get(c.user_id);
    if (!a) continue;
    a.row.mcp_calls += 1;
    if (!c.ok) a.row.mcp_errors += 1;
    bump(a.row.mcp_tool_counts, c.tool);
  }

  const out: UserStatsRow[] = [];
  for (const a of byUser.values()) {
    if (a.row.sessions === 0) continue;
    a.row.refs = a.refs.size;
    a.row.start_hour = median(a.hours);
    a.row.busiest_repo = argmax(a.repoCounts);
    a.row.most_edited_file = argmax(a.fileCounts);
    a.row.first_session_at = input.firstSessionAt?.[a.row.user_id] ?? null;
    out.push(a.row);
  }
  return out.sort((x, y) => (x.user_id < y.user_id ? -1 : x.user_id > y.user_id ? 1 : 0));
}

// ---- The one line on Today --------------------------------------------------

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function fmtCost(usd: number): string {
  return usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Every line this row can honestly say, in a fixed order. Cost is labelled
 * est. (B11). A field that is null/0 contributes no line, so an empty row
 * still yields its session count.
 */
export function statsLines(row: UserStatsRow): string[] {
  const lines: string[] = [];
  const day = row.day;
  const head = `${plural(row.sessions, "session")} on ${day}`;
  lines.push(row.cost_usd > 0 ? `${head} · ${fmtCost(row.cost_usd)} est.` : head);
  if (row.longest_session_seconds !== null && row.longest_session_seconds > 0) {
    lines.push(`Longest session on ${day}: ${fmtDuration(row.longest_session_seconds)}`);
  }
  if (row.busiest_repo) lines.push(`Busiest repo on ${day}: ${row.busiest_repo}`);
  if (row.most_edited_file) lines.push(`Most-edited file on ${day}: ${row.most_edited_file}`);
  if (row.commits > 0) lines.push(`${plural(row.commits, "commit")} seen on ${day}`);
  if (row.start_hour !== null) lines.push(`Started around ${String(row.start_hour).padStart(2, "0")}:00 UTC on ${day}`);
  if (row.mcp_calls > 0) lines.push(`${plural(row.mcp_calls, "Membral lookup")} on ${day}`);
  if (row.first_session_at) {
    const first = row.first_session_at.slice(0, 10);
    if (first < day) lines.push(`First session: ${first}`);
  }
  return lines;
}

/**
 * The single stats line Today shows for this row. Deterministic: `seed`
 * (default: the row's day number) picks one of statsLines(), so the line
 * rotates day to day and a re-render of the same day shows the same line.
 */
export function formatStatsLine(row: UserStatsRow, seed?: number): string {
  const lines = statsLines(row);
  const n = seed ?? Math.floor(Date.parse(`${row.day}T00:00:00Z`) / 86_400_000);
  const idx = Number.isFinite(n) ? Math.abs(Math.trunc(n)) % lines.length : 0;
  return lines[idx];
}
