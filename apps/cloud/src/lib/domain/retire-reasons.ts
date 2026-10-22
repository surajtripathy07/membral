/**
 * The closed set of `memory_records.retire_reason` values (G2 step 2.2b).
 * The column itself stays `string | null` in the generated DB types; this
 * module is the single place the literals are spelled.
 */

/** Rows superseded by a re-run of the same session's extraction (the default for `retireRowsByIds`). */
export const RERUN_RETIRE_REASON = "rerun";

/** Exact-duplicate rows retired in favour of the kept row. */
export const DUPLICATE_RETIRE_REASON = "duplicate";

/**
 * P8 (goal 2026-09-24 memory-on-prod): `retire_reason` for a blocker the
 * end-of-session re-ask judged resolved in the same session. The row is
 * kept (never deleted) but inserted retired, so no serving path shows it as
 * an open blocker; not `unverified*`, so `--reverify` never lifts it.
 */
export const RESOLVED_IN_SESSION_RETIRE_REASON = "resolved_in_session";

/**
 * `retire_reason` for a preference/blocker from a SUB-AGENT session whose
 * receipt is a role-"user" turn: that turn is the parent agent's brief, not
 * the owner. Written by scripts/memory/retire-subagent-brief.ts for rows
 * stored before tail-capture.ts dropped them at extraction.
 */
export const SUBAGENT_BRIEF_RETIRE_REASON = "subagent_brief";

/**
 * `retire_reason` for an open blocker a LATER session resolved. The row
 * carries the receipt in `resolved_by_session_id` / `resolution_quote` /
 * `resolution_turn_idx` (migration 092). Not `unverified*`, so `--reverify`
 * never lifts it.
 */
export const RESOLVED_LATER_RETIRE_REASON = "resolved_later";

/**
 * `retire_reason` for an open blocker a LATER session observably closed.
 * Not `unverified*`, so `--reverify` never lifts it. Distinct from
 * `resolved_later` (the LLM-judged path) so the two can be counted apart.
 */
export const RESOLVED_OBSERVED_RETIRE_REASON = "resolved_observed";

/**
 * `retire_reason` for a memory a NEWER live memory restates (same user, kind,
 * scope and — for 'project' scope — project; cosine >= the semantic-dedup
 * threshold, computed in Postgres by `memory_semantic_duplicates`, migration
 * 101). The newest row of each duplicate cluster stays live. Not
 * `unverified*`, so `--reverify` never lifts it.
 */
export const SEMANTIC_DUPLICATE_RETIRE_REASON = "semantic_duplicate";

/** The user clicked "resolved" on an open blocker. */
export const USER_RESOLVED_RETIRE_REASON = "user_resolved";

/** The user clicked "ignore" on an open blocker. */
export const USER_IGNORED_RETIRE_REASON = "user_ignored";

/**
 * #436: an agent closed the blocker through the MCP tool `memory_resolve`.
 * `resolution_quote` holds the agent's quote; `resolved_by_harness_session_id`
 * (migration 119) the calling session, verified when its transcript uploads
 * (lib/memory/agent-resolve.ts). Undo on Today lifts it like a user click.
 */
export const AGENT_RESOLVED_RETIRE_REASON = "agent_resolved";

/** `retire_reason` prefix for a row that failed grounding (grounding.ts) — the ONLY reason `--reverify` may un-retire (migration 086). */
export const UNVERIFIED_RETIRE_PREFIX = "unverified";

/** Suffix on a row carryUserDismissals inserted retired: still a user dismissal (Undo lifts it), never a match target. */
export const CARRIED_SUFFIX = ":carried";

/** Every fixed retire-reason literal, sorted. Parameterised forms (`unverified[:<detail>]`, `<user reason>:carried`) are in `RetireReason`. */
export const RETIRE_REASONS = [
  AGENT_RESOLVED_RETIRE_REASON,
  DUPLICATE_RETIRE_REASON,
  RERUN_RETIRE_REASON,
  RESOLVED_IN_SESSION_RETIRE_REASON,
  RESOLVED_LATER_RETIRE_REASON,
  RESOLVED_OBSERVED_RETIRE_REASON,
  SEMANTIC_DUPLICATE_RETIRE_REASON,
  SUBAGENT_BRIEF_RETIRE_REASON,
  USER_IGNORED_RETIRE_REASON,
  USER_RESOLVED_RETIRE_REASON,
] as const;

export type FixedRetireReason = (typeof RETIRE_REASONS)[number];
type UserClickedRetireReason =
  | typeof USER_RESOLVED_RETIRE_REASON
  | typeof USER_IGNORED_RETIRE_REASON
  | typeof AGENT_RESOLVED_RETIRE_REASON;

export type RetireReason =
  | FixedRetireReason
  | typeof UNVERIFIED_RETIRE_PREFIX
  | `${typeof UNVERIFIED_RETIRE_PREFIX}:${string}`
  | `${UserClickedRetireReason}${typeof CARRIED_SUFFIX}`;

const FIXED = new Set<string>(RETIRE_REASONS);

/** True for every value the closed `RetireReason` union admits. */
export function isRetireReason(x: string): x is RetireReason {
  if (FIXED.has(x)) return true;
  if (x === UNVERIFIED_RETIRE_PREFIX || x.startsWith(`${UNVERIFIED_RETIRE_PREFIX}:`)) return true;
  return (
    x === `${USER_RESOLVED_RETIRE_REASON}${CARRIED_SUFFIX}` ||
    x === `${USER_IGNORED_RETIRE_REASON}${CARRIED_SUFFIX}` ||
    x === `${AGENT_RESOLVED_RETIRE_REASON}${CARRIED_SUFFIX}`
  );
}
