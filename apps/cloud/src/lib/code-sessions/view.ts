// Pure, testable data-shaping helpers for the /code view (ADR 0021 Q6, P1d).
//
// Keeps the page.tsx server components thin: they fetch rows via Supabase
// (RLS-scoped, same server-component pattern as the rest of the dashboard —
// see lib/stats.ts / conversations/page.tsx) via lib/code-sessions/queries.ts,
// then hand the raw rows to these functions to shape into what the page
// renders. Nothing here touches the network or a Supabase client, so it's
// covered by plain vitest unit tests instead of an e2e harness (CLAUDE.md
// testing conventions: most dashboard logic tests live at lib level).
import { formatDateOnlyUtc } from "@/lib/format/dates";
import type { CodeProjectRollup, RollupStatus } from "./rollup";
import { readTurnObserved, type TurnAction } from "./turn-actions";

// ---- Count gate -----------------------------------------------------------

/**
 * The count gate (ADR Q6): the /code surface — and its nav entry — exist
 * only once a user has at least one code session. Zero or negative counts
 * (a fresh user, or a query that legitimately returns 0) both gate closed.
 */
export function hasCodeSessions(sessionCount: number): boolean {
  return sessionCount > 0;
}

// ---- Rollup props parsing ---------------------------------------------------

const EMPTY_ROLLUP: CodeProjectRollup = {
  summary: "",
  what_built: "",
  key_decisions: "",
  recurring_files_tools: [],
  people: [],
  open_threads: "",
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** parseCodeProjectRollup's return shape — the six CodeProjectRollup content
 * fields plus `status`, so the (redesigned) /code pages can render "Summary
 * not generated yet" / "could not be generated" honestly instead of
 * presenting a placeholder or stale content as if it were a real synthesis
 * (see rollup.ts's rollup_status doc). */
export interface ParsedCodeProjectRollup extends CodeProjectRollup {
  status: RollupStatus;
}

/**
 * `props.rollup_status` if present and well-formed; otherwise inferred from
 * whether a rollup blob exists at all — 'ok' for a legacy row written before
 * this field existed (it has real content, just no status marker), 'pending'
 * for a project that has never been rolled up.
 */
function parseRollupStatus(props: unknown): RollupStatus {
  if (!props || typeof props !== "object") return "pending";
  const status = (props as Record<string, unknown>).rollup_status;
  if (status === "pending" || status === "failed" || status === "ok") return status;
  const rollup = (props as Record<string, unknown>).rollup;
  return rollup && typeof rollup === "object" ? "ok" : "pending";
}

/**
 * Parse a code_projects.props JSON blob into its rollup dimensions (what was
 * built / key decisions / recurring files+tools / people / open threads —
 * ADR #6 non-negotiable) plus its status. Tolerates NULL props, a pre-rollup
 * props value (P1a/P1b rows before P1c's synthesis pass has run), or a
 * malformed/wrong-typed rollup: every field independently falls back to an
 * empty string/array rather than throwing or rendering "undefined" in the UI.
 */
export function parseCodeProjectRollup(props: unknown): ParsedCodeProjectRollup {
  const status = parseRollupStatus(props);
  if (!props || typeof props !== "object") return { ...EMPTY_ROLLUP, status };
  const rollup = (props as Record<string, unknown>).rollup;
  if (!rollup || typeof rollup !== "object") return { ...EMPTY_ROLLUP, status };
  const r = rollup as Record<string, unknown>;
  return {
    summary: typeof r.summary === "string" ? r.summary : "",
    what_built: typeof r.what_built === "string" ? r.what_built : "",
    key_decisions: typeof r.key_decisions === "string" ? r.key_decisions : "",
    recurring_files_tools: isStringArray(r.recurring_files_tools) ? r.recurring_files_tools : [],
    people: isStringArray(r.people) ? r.people : [],
    open_threads: typeof r.open_threads === "string" ? r.open_threads : "",
    status,
  };
}

// ---- Session display title ---------------------------------------------------

interface SessionTitleInput {
  /** Migration 110: the generated 3-8 word title, already validated at write time. Preferred over everything. */
  short_title?: string | null;
  title: string | null;
  summary: string | null;
  /** First real (non-harness-injected) user prose turn's text, when the caller already has it cheaply — the
   *  D (2026-09-25) "no more Untitled session" fallback, tried after title and summary. Harness-injected turns
   *  (hook context, system reminders, command caveats) are already excluded upstream — the parser never writes
   *  them as a `kind: "prose"` turn (packages/core/src/sessions/claude-code.ts's META_PREFIXES filter) — so any
   *  `role: "user", kind: "prose"` turn is already a real human prompt. */
  firstUserMessage?: string | null;
}

const MAX_SUMMARY_FALLBACK_CHARS = 120;
const MAX_TITLE_FALLBACK_CHARS = 80;

/**
 * UX W6 (review 3b): a session title is never pasted content. Claude Code
 * wraps a long paste inline as `<pasted_content id="…">…</pasted_content …>`
 * (packages/core/src/sessions/claude-code.ts `ownerTextOf`, cecfe8e); every
 * such span is removed here, and an unclosed opening tag drops the rest of
 * the text. What remains is the owner's own words ("" when the prompt was
 * only a paste). Callers that have the turn's stored `ownerText` pass it
 * instead — it is already the prompt with the spans removed.
 */
const PASTED_SPAN = /<pasted_content(?:\s+id="[^"]*")?\s*>[\s\S]*?<\/pasted_content(?:\s+id="[^"]*")?\s*>/g;
/** v4 item 4 — mirrors packages/core claude-code.ts `stripHarnessContext` for rows stored before it. */
// Review B3 (structural only): a whole block on its own lines, closing tag present. An unclosed tag,
// or a tag quoted inline in the owner's sentence, is the owner's text and stays.
const SYSTEM_REMINDER_SPAN = /(^|\n)[ \t]*<system-reminder>[\s\S]*?<\/system-reminder>[ \t]*(?=\n|$)/g;
const MEMBRAL_CARD_HEADING =
  /^\s*## (?:About this user|Relevant memory|Related conversations|Code projects|What Membral knows)\b/;
const MEMBRAL_CARD_HANDOVER = /^User's message:[ \t]*$/m;

/**
 * v4 item 4: a prompt with harness-injected context removed — `<system-reminder>`
 * blocks (whole, closed, on their own lines), and a leading Membral context card
 * up to its `User's message:` line (only when that handover line is there). Never a title, never
 * owner prose. Returns `text` itself when nothing was injected.
 */
export function stripHarnessContext(text: string): string {
  let out = text.includes("<system-reminder>") ? text.replace(SYSTEM_REMINDER_SPAN, "$1") : text;
  // Review B3: the card is stripped only when the injection's whole structure is there — its
  // opening section heading AND the `User's message:` handover. A heading alone is the owner's.
  if (MEMBRAL_CARD_HEADING.test(out)) {
    const m = MEMBRAL_CARD_HANDOVER.exec(out);
    if (m) out = out.slice(m.index + m[0].length).replace(/^\s+/, "");
  }
  return out === text ? text : out.trim() === "" ? "" : out;
}

export function titleSourceText(text: string, ownerText?: string | null): string {
  const source = stripHarnessContext(typeof ownerText === "string" ? ownerText : text);
  if (!source.includes("<pasted_content")) return source;
  const stripped = source.replace(PASTED_SPAN, " ");
  const open = stripped.indexOf("<pasted_content");
  return open === -1 ? stripped : stripped.slice(0, open);
}

/**
 * First line of a user message, trimmed to ~MAX_TITLE_FALLBACK_CHARS chars on a word boundary with an
 * ellipsis (D, 2026-09-25) — no model call, pure string slicing. Empty/whitespace-only input returns "".
 */
export function firstLineTitle(text: string): string {
  // A stripped paste leaves leading blank space: the owner's first line starts after it.
  const own = titleSourceText(text);
  const firstLine = (own === text ? text : own.trimStart()).split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= MAX_TITLE_FALLBACK_CHARS) return firstLine;
  const cut = firstLine.slice(0, MAX_TITLE_FALLBACK_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${trimmed}…`;
}

/**
 * e2e R-6: a stored summary written before paths were made repo-relative
 * ("Touched 2 files: /private/tmp/…/README.md") shows each absolute local
 * path as its file name. A URL (`https://…`) is not a local path.
 */
export function stripLocalPaths(text: string): string {
  return text.replace(/(^|[\s(])(?:~|[A-Za-z]:)?[\\/][^\s,;)]*[\\/]([^\s,;)\\/]+)/g, "$1$2");
}

/** Timeline entries use short_title-or-title-or-summary-or-first-message (ADR Q6 + D 2026-09-25, migration 110):
 *  the generated short title if set, else title, else a truncated summary, else the first line of the first real
 *  user message, else a neutral placeholder. */
export function sessionDisplayTitle(session: SessionTitleInput): string {
  const short = session.short_title ? stripLocalPaths(session.short_title).replace(/\s+/g, " ").trim() : "";
  if (short) return short;
  // v4 item 4: a title stored from harness-injected context (a Membral card, a system reminder) is no title.
  const storedTitle = session.title ? stripHarnessContext(session.title) : session.title;
  const title = storedTitle?.includes("<pasted_content") ? firstLineTitle(storedTitle) : storedTitle?.trim();
  if (title) return title;
  const summary = session.summary ? stripLocalPaths(session.summary).trim() : "";
  if (summary) {
    return summary.length > MAX_SUMMARY_FALLBACK_CHARS ? `${summary.slice(0, MAX_SUMMARY_FALLBACK_CHARS)}…` : summary;
  }
  const firstMessage = session.firstUserMessage?.trim();
  if (firstMessage) {
    const derived = firstLineTitle(firstMessage);
    if (derived) return derived;
  }
  return "Untitled session";
}

// W9 (2026-09-12 refocus goal, D9): the session PAGE's <h1> needs a
// different fallback than the timeline row's sessionDisplayTitle above.
// summarize.ts's heuristicSummary() writes "A short session with no
// recorded prose. Touched N files: /Users/.../abs/path, ..." into
// `session.summary` for a session with no user prose turn — sessionDisplayTitle
// (used by /pulse and the MCP session-title lookup, both frozen/out of
// scope here) happily renders that whole sentence, absolute path included,
// as a heading. A NEW, additive function rather than changing
// sessionDisplayTitle itself: that function's existing callers (the
// /pulse dashboard, the timeline row, lib/mcp/graph-tools.ts) keep their
// current behavior and their own locked tests untouched.
export interface SessionPageTitleInput {
  title: string | null;
  summary: string | null;
  gitBranch: string | null;
  turnCount: number;
  startedAt: string | null;
}

/** Matches summarize.ts's heuristicSummary() no-prose fallback sentence, or
 *  any summary that embeds an absolute filesystem path — never render either
 *  as a page heading. */
export function looksLikeGeneratedNoProseSummary(summary: string): boolean {
  return /^A short session with no recorded prose\.?/i.test(summary) || /\/[A-Za-z]:\\|\/(Users|home)\//.test(summary);
}

/**
 * Session-page <h1> fallback: the real title if set; else the summary,
 * UNLESS it looks like the machine-generated no-prose sentence (which can
 * carry an absolute path) — that case, and a session with neither title nor
 * summary at all, render `<branch> · <N> turns · <date>` instead. Never an
 * absolute path in a heading.
 */
export function sessionPageTitle(input: SessionPageTitleInput): string {
  const title = input.title?.includes("<pasted_content") ? firstLineTitle(input.title) : input.title?.trim();
  if (title) return title;

  const summary = input.summary?.trim();
  if (summary && !looksLikeGeneratedNoProseSummary(summary)) {
    return summary.length > MAX_SUMMARY_FALLBACK_CHARS ? `${summary.slice(0, MAX_SUMMARY_FALLBACK_CHARS)}…` : summary;
  }

  const branch = input.gitBranch?.trim() || null;
  const date = formatDateOnlyUtc(input.startedAt) || null;
  if (!branch && !date && input.turnCount === 0) return "Untitled session";
  const turns = `${input.turnCount} turn${input.turnCount === 1 ? "" : "s"}`;
  return [branch, turns, date].filter((p): p is string => !!p).join(" · ");
}

// ---- Turn grouping: the user spine ------------------------------------------

export interface TurnRow {
  idx: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  file_path: string | null;
  ts: string | null;
  /** The tool_use turn's own tool-use id (props.toolUseId — ADR 0026 D1), null for every other kind. Migration 089: a Task/Agent tool_use turn's toolUseId is the join key to that spawn's child code_sessions row (its props.subAgent.toolUseId). */
  toolUseId: string | null;
  /** tool_use turns only: the turn's observed forge/git actions (props.action(s), W3 / D-051) — fixed-shape, already redacted. */
  actions?: TurnAction[];
  /** tool_use turns only: the parser's redacted command digest (props.inputDigest, ADR 0026 D10), or null. */
  inputDigest?: string | null;
}

/** Raw select shape for a code_session_turns row before shapeTurnRow extracts toolUseId out of its jsonb `props` — callers select `props` alongside the other columns and pass the row straight through. */
export interface RawTurnRow {
  idx: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  file_path: string | null;
  ts: string | null;
  props?: Record<string, unknown> | null;
}

/** Pull `props.toolUseId` (buildTurnProps in import.ts, D1) out of a raw turn row into TurnRow's flat field. */
export function shapeTurnRow(raw: RawTurnRow): TurnRow {
  const toolUseId = raw.props && typeof raw.props.toolUseId === "string" ? raw.props.toolUseId : null;
  return {
    idx: raw.idx,
    role: raw.role,
    kind: raw.kind,
    text: raw.text,
    tool_name: raw.tool_name,
    file_path: raw.file_path,
    ts: raw.ts,
    toolUseId,
    ...(raw.kind === "tool_use" ? readTurnObserved(raw.props) : {}),
  };
}

export interface SpineGroup {
  /** The user prose turn that opens this group, or null for activity that precedes the first user turn (agent-initiated work — common in autonomous/backfilled sessions with no recorded human prompt). */
  anchor: TurnRow | null;
  /** Assistant prose/thinking + tool_use/tool_result, collapsed beneath the anchor, in order. */
  activity: TurnRow[];
}

/**
 * Group a session's turns into the user-spine narrative (ADR Q6, ADR
 * non-negotiable #5): every role=user/kind=prose turn is genuine human input
 * and opens a new group as its headline. Everything else — assistant
 * prose/thinking, tool_use, and tool_result markers (which are stored with
 * role="user" even though they're synthetic, not human prose) — collapses
 * into the most recently opened group's activity list. Turns are sorted by
 * idx first so callers can pass rows in any order.
 */
export function groupSessionTurns(turns: TurnRow[]): SpineGroup[] {
  const sorted = [...turns].sort((a, b) => a.idx - b.idx);
  const groups: SpineGroup[] = [];
  let current: SpineGroup | null = null;

  for (const turn of sorted) {
    const isUserProse = turn.role === "user" && turn.kind === "prose";
    if (isUserProse) {
      current = { anchor: turn, activity: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { anchor: null, activity: [] };
      groups.push(current);
    }
    current.activity.push(turn);
  }

  return groups;
}

// ---- Compact activity line rendering ------------------------------------------

/** Compact "toolName file_path" (or just toolName) label for a tool_use turn. */
export function toolActivityLabel(turn: TurnRow): string {
  if (turn.file_path) return `${turn.tool_name ?? "tool"} ${turn.file_path}`;
  return turn.tool_name ?? "tool";
}

export type ToolResultStatus = "ok" | "error" | "unknown";

/** Classify a tool_result turn's elided marker text ("[tool_result elided: ok]" / "...: error]") into a tiny status chip value. */
export function toolResultStatus(turn: TurnRow): ToolResultStatus {
  const text = turn.text ?? "";
  if (/error/i.test(text)) return "error";
  if (/ok/i.test(text)) return "ok";
  return "unknown";
}

// ---- Code-graph facts (GitHub issue #87) -----------------------------------
//
// Pure shaping of code_kg_nodes/code_kg_edges rows (queries.ts's
// getCodeProjectFacts/getCodeSessionFacts) into what the /code/[projectId]
// and /code/session/[sessionId] pages render. DELIBERATELY does NOT
// basename-dedupe or otherwise merge file keys: cwd fragmentation means the
// "same" file on disk can appear under several distinct paths, each with its
// own low session_count — collapsing them would paper over that
// fragmentation instead of surfacing it (locked by a negative test in
// project-facts.test.tsx).
//
// Structural (duck-typed) input shapes below, rather than importing
// CodeKgFactRow/CodeKgSessionEdgeRow from ./queries: queries.ts already
// imports TurnRow from this file, so importing back would make the two
// modules mutually dependent for no real benefit — TS only needs the shape.

export interface CodeFactNodeRow {
  node_type: string;
  key: string;
  label: string;
  session_count: number;
}

export interface ProjectFactItem {
  key: string;
  label: string;
  sessionCount: number;
}

export interface ProjectFactBucket {
  items: ProjectFactItem[];
  /** Count of additional qualifying items beyond the display cap — rendered as "+K more". */
  moreCount: number;
  /** Whether at least one item in this bucket actually recurs (session_count >= 2) — distinct from the top-N backfill, which can populate `items` with singletons even when this is false. Drives the section's title (F4 adversarial finding: don't call singletons "recurring"). */
  hasRecurring: boolean;
}

export interface ShapedProjectFacts {
  files: ProjectFactBucket;
  tools: ProjectFactBucket;
  subagents: ProjectFactBucket;
}

/** True count of a node_type's rows for a project — from a `count: "exact", head: true` query, NOT derived from a (possibly truncated) fetched row list. See getCodeProjectFacts's per-type queries (F3 adversarial finding). */
export interface FactTypeTrueCounts {
  total: number;
  qualifying: number;
}

// "Recurring" means session_count >= 2, but a corpus where every path is
// fragmented across sessions (different cwd prefixes for what's really the
// same file) can depress every single key to session_count 1 — so the
// candidate pool is always AT LEAST the display cap, backfilled by raw
// top-by-count, even when nothing technically clears the >=2 bar. Rows are
// assumed pre-sorted by session_count desc (the query orders this way); this
// function re-sorts anyway so it's correct standalone, independent of caller
// ordering.
export const RECURRING_MIN_SESSION_COUNT = 2;
const MAX_ITEMS_PER_LIST = 10;

/**
 * `trueCounts`, when given, is the type's TRUE total/qualifying counts from
 * exact head-count queries — used for `moreCount` and `hasRecurring` instead
 * of counts derived from `items`, which may be a fetch-limited subset (F3
 * adversarial finding: a shared/per-type row LIMIT under-reports "+K more"
 * once a project has more matching rows than the fetch cap). When omitted,
 * falls back to deriving both from `items` directly — correct as long as
 * the caller passed every row of the type (e.g. in pure unit tests).
 */
function bucketRecurring(items: ProjectFactItem[], trueCounts?: FactTypeTrueCounts): ProjectFactBucket {
  const sorted = [...items].sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));
  const qualifyingCount = trueCounts
    ? trueCounts.qualifying
    : sorted.filter((r) => r.sessionCount >= RECURRING_MIN_SESSION_COUNT).length;
  const totalCount = trueCounts ? trueCounts.total : sorted.length;
  const poolSize = Math.min(Math.max(qualifyingCount, MAX_ITEMS_PER_LIST), totalCount);
  const shown = sorted.slice(0, Math.min(poolSize, MAX_ITEMS_PER_LIST));
  return { items: shown, moreCount: Math.max(poolSize - shown.length, 0), hasRecurring: qualifyingCount > 0 };
}

function toFactItem(row: CodeFactNodeRow): ProjectFactItem {
  return { key: row.key, label: row.label, sessionCount: row.session_count };
}

/**
 * Split a project's file/tool/subagent facts (getCodeProjectFacts) by
 * node_type and bucket each into "recurring" (see bucketRecurring). Returns
 * null when there's nothing to show at all — the page renders no section
 * (not an empty skeleton) in that case.
 *
 * `trueCountsByType` (optional, keyed by node_type) supplies each type's TRUE
 * total/qualifying counts — pass getCodeProjectFacts's `trueCounts` here so
 * `moreCount` reflects the full corpus, not just the fetched page (F3).
 *
 * NOTE (judgment call, stated per task brief): decision/directive/task/
 * technology node types exist in the 031 schema but are P2b (semantic
 * graph) scope — getCodeProjectFacts deliberately only fetches
 * file/tool/subagent (P2a, zero LLM calls) today, so there is no data path
 * for those types yet. When P2b starts writing them, both the query's
 * `.in("node_type", ...)` allow-list AND this function need a matching new
 * bucket before a UI block for them would have anything to render.
 */
export function shapeProjectFacts(
  rows: CodeFactNodeRow[],
  trueCountsByType?: Partial<Record<string, FactTypeTrueCounts>>,
): ShapedProjectFacts | null {
  const files = bucketRecurring(rows.filter((r) => r.node_type === "file").map(toFactItem), trueCountsByType?.file);
  const tools = bucketRecurring(rows.filter((r) => r.node_type === "tool").map(toFactItem), trueCountsByType?.tool);
  const subagents = bucketRecurring(
    rows.filter((r) => r.node_type === "subagent").map(toFactItem),
    trueCountsByType?.subagent,
  );
  if (files.items.length === 0 && tools.items.length === 0 && subagents.items.length === 0) return null;
  return { files, tools, subagents };
}

// ---- Session facts (GitHub issue #87) --------------------------------------

export interface CodeFactEdgeRow {
  rel_type: string;
  weight: number;
  props: Record<string, unknown>;
  key: string;
  label: string;
}

export interface SessionToolFact {
  key: string;
  label: string;
  callCount: number;
}

export interface SessionFileFact {
  key: string;
  label: string;
  editCount: number;
  /** null when the underlying tool_use rows never carried a `create`/`update` result type (backfill rows from before that parser extension). */
  created: boolean | null;
}

export interface SessionFactBucket<T> {
  items: T[];
  /** Additional items beyond the display cap — rendered as "+K more" (same idiom as ProjectFactBucket). */
  moreCount: number;
}

export interface ShapedSessionFacts {
  models: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  } | null;
  tools: SessionFactBucket<SessionToolFact>;
  files: SessionFactBucket<SessionFileFact>;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// A real session can touch/use well over a hundred distinct files/tools
// (adversarial browser finding: 112 chips on one founder-1k session, ~1.5
// viewports, duplicating the header's own capped files_touched list) — cap
// each list the same way the project page's recurring buckets do.
const MAX_SESSION_CHIPS = 10;

function capChips<T>(items: T[]): SessionFactBucket<T> {
  return { items: items.slice(0, MAX_SESSION_CHIPS), moreCount: Math.max(items.length - MAX_SESSION_CHIPS, 0) };
}

/**
 * Shape one session's node props + outgoing touched/used edges
 * (getCodeSessionFacts) into the session page's facts strip. Returns null
 * when there is nothing to show — no session mirror node yet (pre-P2a
 * import, or the Stage-1 build hasn't run) and no edges at all.
 */
export function shapeSessionFacts(
  raw: { sessionProps: Record<string, unknown> | null; edges: CodeFactEdgeRow[] } | null,
): ShapedSessionFacts | null {
  if (!raw || raw.sessionProps === null) return null;
  const props = raw.sessionProps;

  const models = Array.isArray(props.models) ? props.models.filter((m): m is string => typeof m === "string") : [];

  const rawUsage = props.usage;
  let usage: ShapedSessionFacts["usage"] = null;
  if (rawUsage && typeof rawUsage === "object") {
    const u = rawUsage as Record<string, unknown>;
    if (
      isFiniteNumber(u.inputTokens) &&
      isFiniteNumber(u.outputTokens) &&
      isFiniteNumber(u.cacheReadInputTokens) &&
      isFiniteNumber(u.cacheCreationInputTokens)
    ) {
      usage = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadInputTokens: u.cacheReadInputTokens,
        cacheCreationInputTokens: u.cacheCreationInputTokens,
      };
    }
  }

  // UX W5 (cost-consistency.md #5, ADR 0032 §1.3 finding 4): the mirror
  // node's stored cost snapshot is never read here. A session's cost is
  // computed live (aggregateAgentStats, lib/agent-stats/aggregate.ts), the
  // same path as the session header.

  const tools = capChips(
    raw.edges
      .filter((e) => e.rel_type === "used")
      .map((e) => ({ key: e.key, label: e.label, callCount: e.weight }))
      .sort((a, b) => b.callCount - a.callCount),
  );

  const files = capChips(
    raw.edges
      .filter((e) => e.rel_type === "touched")
      .map((e) => ({
        key: e.key,
        label: e.label,
        editCount: isFiniteNumber(e.props.edit_count) ? (e.props.edit_count as number) : 0,
        created: typeof e.props.created === "boolean" ? (e.props.created as boolean) : null,
      }))
      .sort((a, b) => b.editCount - a.editCount),
  );

  if (models.length === 0 && !usage && tools.items.length === 0 && files.items.length === 0) {
    return null;
  }

  return { models, usage, tools, files };
}

// ---- Total token count (facts-strip display) -------------------------------

/** Sum of the four usage buckets — the single number the facts strip shows; per-bucket breakdown lives in the title attribute. */
export function totalTokens(usage: ShapedSessionFacts["usage"]): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

// ---- Pulse empty-state gate (adversarial finding F1) -----------------------
//
// Pulled out of pulse/page.tsx (formerly `recent.length === 0 &&
// (census?.conversations ?? "0") === "0"`, which silently ignored code
// sessions) so the predicate has direct unit coverage instead of only being
// exercised transitively through 1150 unrelated tests, none of which would
// fail if this logic regressed.
export function isPulseEmpty(input: {
  recentCount: number;
  codeCount: number;
  censusConversations: string | undefined;
}): boolean {
  return input.recentCount === 0 && input.codeCount === 0 && (input.censusConversations ?? "0") === "0";
}

// ---- Files-touched list (maintainer product-review feedback) --------------
//
// /code/session/[id]'s header used to dump every files_touched entry (up to
// 12, then a bare "+N more" with no way to see the rest) straight into the
// page, dominating it on any session that touched more than a handful of
// files. FilesTouchedList (files-touched-list.tsx) collapses to this default
// count with a client-side "Show all N ->" toggle; these two pieces are the
// pure logic behind it so the collapse math and left-truncation are unit
// tested without needing a DOM.

/** How many files show before the "Show all N ->" control appears. */
export const FILES_LIST_DEFAULT_SHOWN = 5;

/** Slice of `files` the list should render for a given expanded state. */
export function visibleFiles(files: string[], expanded: boolean, defaultCount = FILES_LIST_DEFAULT_SHOWN): string[] {
  return expanded ? files : files.slice(0, defaultCount);
}

// ---- Repo-relative path shortening (redesign: /code Activity details) -----
//
// Distinct from truncatePathLeft above (character-based, keeps the tail
// regardless of what the path IS) — this is segment-aware AND classifies a
// path as "source" vs "scratch/notes" (a coding-agent's memory dir and its
// scratchpad dir — both noise, not the repo) so the Activity details section
// can hide the scratch group behind a toggle by default instead of letting
// it crowd out real source files. Order matters: cwd-strip first (the common
// in-repo case), then the two known out-of-repo homes, then a generic
// last-N-segments fallback for everything else. `cwd` is optional — when the
// caller has none (e.g. a session-list row, which doesn't carry it), this
// still degrades gracefully: it just never takes the cwd-strip branch, and
// every path still gets the memory/scratchpad/fallback treatment.

export type PathGroup = "source" | "scratch";

export interface ShortenedPath {
  display: string;
  group: PathGroup;
}

const MEMORY_DIR_RE = /\.claude\/projects\/[^/]+\/memory\/(.+)$/;
const SCRATCHPAD_DIR_RE = /^\/private\/tmp\/claude-.*\/scratchpad\/(.+)$/;
const FALLBACK_SEGMENTS = 3;

/**
 * Shorten one file path for display. Rules, in order:
 *  1. Strip the project's `cwd` prefix when given and the path is inside it
 *     -> repo-relative, group "source" (the path itself is `cwd` -> ".").
 *  2. Collapse a Claude Code per-project memory-dir path
 *     (`~/.claude/projects/<slug>/memory/X`) -> `memory/X`, group "scratch".
 *  3. Collapse this harness's scratchpad path
 *     (`/private/tmp/claude-…/scratchpad/X`) -> `scratchpad/X`, group
 *     "scratch".
 *  4. Anything else: keep the last FALLBACK_SEGMENTS path segments prefixed
 *     with "…/", group "source" (an unrecognized absolute path is still
 *     someone's source tree, just not this project's cwd). A path already at
 *     or under that many segments passes through unchanged.
 */
// ---- Sub-agent sessions (migration 089) ------------------------------------
//
// A sub-agent transcript is its own code_sessions row (queries.ts's
// listChildSessions). Two ways they surface on the parent's page: INLINE, at
// the Task/Agent tool_use turn that spawned them (joined by toolUseId — the
// turn's own tool_use id, shapeTurnRow above, against the child's
// props.subAgent.toolUseId, ChildSessionForMatch.toolUseId below — or, for
// an opencode child, which carries none, the parent's own props.subAgents[]
// entry for its agentId); in a "hidden turns" group when that spawn turn is
// past the capped window; or, for whatever can't be joined at all (a nested
// spawn's spawning turn lives in ANOTHER sub-agent's own transcript, not the
// parent's), in an end-of-page "Sub-agents" section, nested by parentAgentId.

export interface ChildSessionForMatch {
  id: string;
  agentId: string | null;
  parentAgentId: string | null;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  turnCount: number;
}

export interface MatchedChildSessions {
  /** Turn idx -> the child session that turn spawned (rendered turns only). */
  byTurnIdx: Map<number, ChildSessionForMatch>;
  /** Children whose spawning tool_use turn exists in this session but lies outside the rendered window (the default 500-turn cap) — sorted by that turn's idx. */
  hidden: { child: ChildSessionForMatch; turnIdx: number }[];
  /** Every child not joined to ANY turn of this session (see header). */
  unmatched: ChildSessionForMatch[];
}

/** A tool_use turn's idx + tool-use id — the light, whole-session index (queries.ts's getSessionToolUseIndex) that lets matching see spawns in turns the capped page didn't load. */
export interface ToolUseTurnRef {
  idx: number;
  toolUseId: string;
}

export interface MatchChildSessionsOptions {
  /** Every tool_use turn of the session, not just the rendered ones; omit when `turns` is already the whole session. */
  allToolUses?: ToolUseTurnRef[];
  /** The parent's own props.subAgents[] agentId -> toolUseId (parseSubAgentSpawnIndex). opencode children carry no toolUseId of their own; the parent's entry does. */
  toolUseIdByAgentId?: Map<string, string>;
}

/**
 * Join each child to the Task/Agent tool_use turn that spawned it, by
 * toolUseId — the child's own props.subAgent.toolUseId, else (opencode) the
 * parent's props.subAgents[] entry for the child's agentId. A spawn turn
 * that's in the session but not in `turns` (the capped window) goes to
 * `hidden`; a child with no such turn at all (a nested spawn — its parent
 * turn lives in another sub-agent's own transcript) falls into `unmatched`
 * rather than being dropped.
 */
export function matchChildSessionsToTurns(
  turns: TurnRow[],
  children: ChildSessionForMatch[],
  options: MatchChildSessionsOptions = {},
): MatchedChildSessions {
  const renderedIdxByToolUseId = new Map<string, number>();
  for (const turn of turns) {
    if (turn.kind === "tool_use" && turn.toolUseId) renderedIdxByToolUseId.set(turn.toolUseId, turn.idx);
  }
  const anyIdxByToolUseId = new Map<string, number>();
  for (const ref of options.allToolUses ?? []) anyIdxByToolUseId.set(ref.toolUseId, ref.idx);

  const byTurnIdx = new Map<number, ChildSessionForMatch>();
  const hidden: { child: ChildSessionForMatch; turnIdx: number }[] = [];
  const unmatched: ChildSessionForMatch[] = [];
  for (const child of children) {
    const toolUseId =
      child.toolUseId ?? (child.agentId ? options.toolUseIdByAgentId?.get(child.agentId) : undefined) ?? null;
    const renderedIdx = toolUseId ? renderedIdxByToolUseId.get(toolUseId) : undefined;
    const anyIdx = toolUseId ? anyIdxByToolUseId.get(toolUseId) : undefined;
    if (renderedIdx !== undefined) byTurnIdx.set(renderedIdx, child);
    else if (anyIdx !== undefined) hidden.push({ child, turnIdx: anyIdx });
    else unmatched.push(child);
  }
  hidden.sort((a, b) => a.turnIdx - b.turnIdx);
  return { byTurnIdx, hidden, unmatched };
}

/** A parent session's props.subAgents[] (RawSubAgent: agentId + toolUseId of the spawning call) as agentId -> toolUseId. Tolerant of any malformed entry. */
export function parseSubAgentSpawnIndex(props: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!props || typeof props !== "object") return out;
  const subs = (props as Record<string, unknown>).subAgents;
  if (!Array.isArray(subs)) return out;
  for (const sub of subs) {
    if (!sub || typeof sub !== "object") continue;
    const { agentId, toolUseId } = sub as Record<string, unknown>;
    if (typeof agentId === "string" && agentId && typeof toolUseId === "string" && toolUseId) {
      out.set(agentId, toolUseId);
    }
  }
  return out;
}

export interface SubAgentTreeNode {
  child: ChildSessionForMatch;
  children: SubAgentTreeNode[];
}

/**
 * Nest a flat child list by parentAgentId (a nested spawn's meta.json
 * parentAgentId, ADR 0026) into a tree for the end-of-page "Sub-agents"
 * section. A child whose parentAgentId doesn't match any agentId in THIS
 * list (no parent, or the parent is elsewhere — e.g. already inline-linked)
 * is a root. Every child's own agentId is keyed by itself as a fallback when
 * absent (an opencode child, say), so it can never collide with another
 * child's real agentId and is never mistaken for someone's parent.
 *
 * A child whose parentAgentId names itself, or that sits in a longer
 * parentAgentId cycle (A -> B -> A, malformed meta.json), can never be
 * nested: attaching it under its claimed parent either makes the node its
 * own descendant (infinite recursion for anything that walks `children`) or,
 * for a multi-node cycle, leaves every member reachable only from inside the
 * cycle so none of them is ever found from `roots` (silently vanishing).
 * Every member of such a cycle is treated as a root instead; a non-cycle
 * child that legitimately points AT a cycle member still nests under it.
 */
export function buildSubAgentTree(children: ChildSessionForMatch[]): SubAgentTreeNode[] {
  const nodeByKey = new Map<string, SubAgentTreeNode>();
  for (const child of children) {
    nodeByKey.set(child.agentId ?? child.id, { child, children: [] });
  }

  const isCycleMember = (startKey: string): boolean => {
    let key = nodeByKey.get(startKey)?.child.parentAgentId ?? undefined;
    for (let steps = 0; key !== undefined && nodeByKey.has(key) && steps <= nodeByKey.size; steps++) {
      if (key === startKey) return true;
      key = nodeByKey.get(key)!.child.parentAgentId ?? undefined;
    }
    return false;
  };

  const roots: SubAgentTreeNode[] = [];
  for (const child of children) {
    const key = child.agentId ?? child.id;
    const node = nodeByKey.get(key)!;
    const parent = child.parentAgentId && !isCycleMember(key) ? nodeByKey.get(child.parentAgentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// ---- Sub-agent session metadata (child session page header) ---------------

/**
 * Child-page breadcrumb label for the parent session: title, else a
 * non-generated summary, else the parent's first prompt (a Claude Code
 * parent usually has neither title nor summary, and sessionPageTitle's
 * `<branch> · N turns` fallback read as "Sub-agent of main"), else that
 * fallback.
 */
export function parentBreadcrumbLabel(input: SessionPageTitleInput & { firstPrompt: string | null }): string {
  const title = input.title?.trim();
  const summary = input.summary?.trim();
  if (title || (summary && !looksLikeGeneratedNoProseSummary(summary))) return sessionPageTitle(input);
  const prompt = input.firstPrompt ? stripHtmlComments(input.firstPrompt).replace(/\s+/g, " ").trim() : "";
  if (prompt) {
    return prompt.length > MAX_SUMMARY_FALLBACK_CHARS ? `${prompt.slice(0, MAX_SUMMARY_FALLBACK_CHARS)}…` : prompt;
  }
  return sessionPageTitle(input);
}

/** Display-only: drop HTML comments (e.g. an opencode plugin's `<!-- OMO_INTERNAL_INITIATOR -->` marker) from prompt text; the stored text is unchanged. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Header turn-count line. A sub-agent session's one "user" prompt was written by the parent agent, not the person — never count it as "yours". */
export function turnCountsLabel(input: {
  turnCount: number;
  userTurnCount: number;
  toolCount: number;
  isSubAgent: boolean;
}): string {
  const who = input.isSubAgent
    ? `${input.userTurnCount} prompt${input.userTurnCount === 1 ? "" : "s"} from the parent agent`
    : `${input.userTurnCount} yours`;
  return `${input.turnCount} turns (${who}, ${input.toolCount} tool calls)`;
}

export interface SubAgentMeta {
  agentType: string | null;
  description: string | null;
  model: string | null;
}

/** Parse code_sessions.props.subAgent (set only on a child session's own row, import.ts) for the child page's header — agentType/description/model, each tolerant of a missing or wrong-typed field. */
export function parseSubAgentMeta(props: unknown): SubAgentMeta | null {
  if (!props || typeof props !== "object") return null;
  const sub = (props as Record<string, unknown>).subAgent;
  if (!sub || typeof sub !== "object") return null;
  const s = sub as Record<string, unknown>;
  return {
    agentType: typeof s.agentType === "string" ? s.agentType : null,
    description: typeof s.description === "string" ? s.description : null,
    model: typeof s.model === "string" ? s.model : null,
  };
}

export function shortenSessionPath(path: string, cwd?: string | null): ShortenedPath {
  if (!path) return { display: path, group: "source" };

  if (cwd) {
    if (path === cwd) return { display: ".", group: "source" };
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (path.startsWith(prefix)) return { display: path.slice(prefix.length), group: "source" };
  }

  const memoryMatch = path.match(MEMORY_DIR_RE);
  if (memoryMatch) return { display: `memory/${memoryMatch[1]}`, group: "scratch" };

  const scratchMatch = path.match(SCRATCHPAD_DIR_RE);
  if (scratchMatch) return { display: `scratchpad/${scratchMatch[1]}`, group: "scratch" };

  const segments = path.split("/").filter(Boolean);
  if (segments.length <= FALLBACK_SEGMENTS) return { display: path, group: "source" };
  return { display: `…/${segments.slice(-FALLBACK_SEGMENTS).join("/")}`, group: "source" };
}
