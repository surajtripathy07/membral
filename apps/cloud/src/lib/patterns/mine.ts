// Goal 2026-09-26 P9 / W10 — the pure half of "propose a skill".
//
// A coding session is a sequence of tool calls. Reduced to a coarse step
// label per call (`npm test`, `Edit ts`, `git commit`, `glab mr view`,
// `Agent`), sequences that recur across MANY sessions of one project are a
// habit the developer could name as a skill. minePatterns() finds them
// with no LLM: it counts, per contiguous n-gram of steps, the number of
// DISTINCT sessions containing it, keeps those seen in >= minSessions, and
// returns the top few (bounded — at most `maxPatterns`, default 3).
//
// Everything here is deterministic and has no I/O; derive.ts does the
// queries and draft-skill.ts the (optional, Zod-guarded) LLM wording.

/** The subset of a `code_session_turns` row the miner reads. */
export interface PatternTurn {
  tool_name: string | null;
  file_path?: string | null;
  /** ISO timestamp of the turn — only used for `lastSeenAt`. */
  ts?: string | null;
  props?: { inputDigest?: unknown; [k: string]: unknown } | null;
}

export interface Pattern {
  /** Stable identity of the sequence: steps joined by " → ". */
  key: string;
  steps: string[];
  /** Distinct sessions the sequence appeared in. */
  sessionCount: number;
  /** Those sessions' ids, most recent first, capped at MAX_SESSION_IDS. */
  sessionIds: string[];
  /** Latest turn timestamp among the matching sessions, or null when none had one. */
  lastSeenAt: string | null;
}

export interface MinePatternsOptions {
  /** A sequence must appear in at least this many distinct sessions. */
  minSessions: number;
  /** Shortest sequence considered (default 3 steps). */
  minLength?: number;
  /** Longest sequence considered (default 5 steps). */
  maxLength?: number;
  /** Patterns returned per call (default MAX_PATTERNS_PER_PROJECT). */
  maxPatterns?: number;
}

export const MAX_PATTERNS_PER_PROJECT = 3;
export const MAX_SESSION_IDS = 20;
const DEFAULT_MIN_LENGTH = 3;
const DEFAULT_MAX_LENGTH = 5;
export const STEP_SEPARATOR = " → ";

/** Navigation / bookkeeping tools carry no habit worth a skill and would swamp every n-gram. */
const IGNORED_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "TodoWrite",
  "TodoRead",
  "ToolSearch",
  "Monitor",
  "ExitPlanMode",
  "EnterPlanMode",
  "AskUserQuestion",
]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write", "patch"]);
/** Commands whose first two words are the verb: `git commit`, `npm test`, `cargo test`. */
const TWO_WORD_COMMANDS = new Set([
  "git",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "cargo",
  "go",
  "make",
  "docker",
  "kubectl",
  "bun",
]);
/** `NAME=value` — a shell env assignment, never a step label. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Forge CLIs use resource + action: `gh pr view`, `glab mr create`. */
const THREE_WORD_COMMANDS = new Set(["gh", "glab"]);

/**
 * Collapse a shell digest to its verb prefix: `cd x && npm test -- --run` →
 * `npm test`; `glab mr view 17 --web` → `glab mr view`; `pytest -q` → `pytest`.
 * Flags are dropped; `&&`/`|`/`;` end the command; only the first command of
 * a chain names the step (the chain's later verbs are their own turn rarely,
 * and W3's `actions` already records them).
 */
export function digestPrefix(digest: string): string | null {
  let cmd = digest.trim().replace(/^cd\s+\S+\s*&&\s*/, "");
  const cut = cmd.search(/\s(?:&&|\|\||\||;)\s|\n/);
  if (cut >= 0) cmd = cmd.slice(0, cut);
  const words = cmd.split(/\s+/).filter((t) => t.length > 0);
  // Leading env assignments (`PGPASSWORD=x psql …`, `env A=1 npm test`) are
  // not the verb, and their values must never become a stored, shown or
  // LLM-bound label (review F15).
  while (words.length > 0 && (ENV_ASSIGNMENT_RE.test(words[0]) || words[0] === "env")) words.shift();
  const tokens = words
    .filter((t) => !t.startsWith("-") && !ENV_ASSIGNMENT_RE.test(t))
    .map((t) => t.replace(/^['"`]+|['"`]+$/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const head = tokens[0];
  const width = THREE_WORD_COMMANDS.has(head) ? 3 : TWO_WORD_COMMANDS.has(head) ? 2 : 1;
  return tokens
    .slice(0, width)
    .map((t) => t.slice(0, 32))
    .join(" ");
}

function fileExtension(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base
    .slice(dot + 1)
    .toLowerCase()
    .slice(0, 12);
}

/**
 * One turn → one step label, or null when the turn is not a tool call worth
 * a step (assistant text, navigation tools). Edits collapse to `Edit <ext>`
 * so `Edit src/a.ts` and `Edit src/b.ts` are the same habit.
 */
export function stepLabel(turn: PatternTurn): string | null {
  const tool = turn.tool_name?.trim();
  if (!tool) return null;
  if (IGNORED_TOOLS.has(tool)) return null;
  if (EDIT_TOOLS.has(tool)) {
    const ext = fileExtension(turn.file_path);
    return ext ? `Edit ${ext}` : "Edit";
  }
  const digest = turn.props?.inputDigest;
  if ((tool === "Bash" || tool === "bash") && typeof digest === "string") {
    const prefix = digestPrefix(digest);
    return prefix ?? "Bash";
  }
  return tool;
}

/** A session's step sequence with consecutive duplicates collapsed (`Edit ts, Edit ts` → `Edit ts`). */
export function sessionSteps(turns: PatternTurn[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    const label = stepLabel(turn);
    if (!label) continue;
    if (out[out.length - 1] === label) continue;
    out.push(label);
  }
  return out;
}

function isContiguousSubsequence(shorter: string[], longer: string[]): boolean {
  if (shorter.length > longer.length) return false;
  outer: for (let i = 0; i + shorter.length <= longer.length; i++) {
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] !== shorter[j]) continue outer;
    }
    return true;
  }
  return false;
}

function latestTs(turns: PatternTurn[]): string | null {
  let best: string | null = null;
  for (const t of turns) {
    if (typeof t.ts === "string" && t.ts && (best === null || t.ts > best)) best = t.ts;
  }
  return best;
}

/**
 * Sequences of steps repeated across >= minSessions distinct sessions,
 * ranked by session count then length, de-duplicated so a sub-sequence
 * whose support is exactly the sessions of a longer kept pattern is not
 * listed twice. Bounded to `maxPatterns` (default 3).
 */
export function minePatterns(turnsBySession: Record<string, PatternTurn[]>, opts: MinePatternsOptions): Pattern[] {
  const minSessions = Math.max(1, Math.floor(opts.minSessions));
  const minLength = Math.max(2, opts.minLength ?? DEFAULT_MIN_LENGTH);
  const maxLength = Math.max(minLength, opts.maxLength ?? DEFAULT_MAX_LENGTH);
  const maxPatterns = Math.max(0, opts.maxPatterns ?? MAX_PATTERNS_PER_PROJECT);
  if (maxPatterns === 0) return [];

  const support = new Map<string, { steps: string[]; sessions: Set<string> }>();
  const sessionLastSeen = new Map<string, string | null>();

  for (const [sessionId, turns] of Object.entries(turnsBySession)) {
    const steps = sessionSteps(turns);
    sessionLastSeen.set(sessionId, latestTs(turns));
    const seenHere = new Set<string>();
    for (let len = minLength; len <= maxLength; len++) {
      for (let i = 0; i + len <= steps.length; i++) {
        const gram = steps.slice(i, i + len);
        const key = gram.join(STEP_SEPARATOR);
        if (seenHere.has(key)) continue;
        seenHere.add(key);
        const entry = support.get(key);
        if (entry) entry.sessions.add(sessionId);
        else support.set(key, { steps: gram, sessions: new Set([sessionId]) });
      }
    }
  }

  const candidates = [...support.entries()]
    .filter(([, v]) => v.sessions.size >= minSessions)
    .sort(
      (a, b) =>
        b[1].sessions.size - a[1].sessions.size || b[1].steps.length - a[1].steps.length || (a[0] < b[0] ? -1 : 1),
    );

  const kept: { key: string; steps: string[]; sessions: Set<string> }[] = [];
  for (const [key, v] of candidates) {
    const redundant = kept.some(
      (k) =>
        (isContiguousSubsequence(v.steps, k.steps) || isContiguousSubsequence(k.steps, v.steps)) &&
        k.sessions.size === v.sessions.size,
    );
    if (redundant) continue;
    kept.push({ key, steps: v.steps, sessions: v.sessions });
    if (kept.length >= maxPatterns) break;
  }

  return kept.map((k) => {
    const ids = [...k.sessions].sort((a, b) => {
      const ta = sessionLastSeen.get(a) ?? "";
      const tb = sessionLastSeen.get(b) ?? "";
      return tb < ta ? -1 : tb > ta ? 1 : a < b ? -1 : 1;
    });
    let lastSeenAt: string | null = null;
    for (const id of ids) {
      const ts = sessionLastSeen.get(id) ?? null;
      if (ts && (lastSeenAt === null || ts > lastSeenAt)) lastSeenAt = ts;
    }
    return {
      key: k.key,
      steps: k.steps,
      sessionCount: k.sessions.size,
      sessionIds: ids.slice(0, MAX_SESSION_IDS),
      lastSeenAt,
    };
  });
}
