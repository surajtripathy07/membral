/**
 * Recurrence thresholds and scan limits (G2 step 2.2d). The single place
 * these numbers are spelled; `lib/memory/write/io.ts` imports and re-exports
 * the ones it exported before.
 */

/**
 * Write-time dedup: a new record this close (same user, project and kind,
 * another session) to a live record is the same fact again, not a new one.
 * Chosen from the local corpus (2026-09-25, 1.5k live records): the recall
 * echo pair (a session restating the injected preamble) sits at 0.981; true
 * restatements at 0.950/0.952/0.962; the closest DIFFERENT facts at 0.931
 * ("excerpts under 50 lines" vs "under 35 lines") and 0.903.
 */
export const CROSS_SESSION_DUP_COSINE_THRESHOLD = 0.94;

/**
 * Goal 2026-09-26 B7 (D-051), recurrence band: a new blocker/learning whose
 * cosine to a live record of the same kind from a DIFFERENT session lies in
 * `[RECURRENCE_COSINE_THRESHOLD, CROSS_SESSION_DUP_COSINE_THRESHOLD)` is the
 * same problem seen again, not an echo of the same sentence. It is KEPT (both
 * rows stay live), stamped `recurs_of = <the earliest row of that chain>`, and
 * that earliest row's `recurrence_count` is incremented — a count, never a
 * merge. The floor is the maintainer's semantic-dedup floor (0.80); same-
 * session near-duplicates keep merging as before (D-050).
 */
export const RECURRENCE_COSINE_THRESHOLD = 0.8;

/**
 * Kinds the recurrence band applies to. B7 names blockers only: a blocker hit
 * again in a later session is counted (`recurs_of` + `recurrence_count`), not
 * merged. Every other kind (learning, outcome, decision, preference) keeps the
 * plain ≥ 0.94 echo-drop and is otherwise a new row.
 */
export const RECURRENCE_KINDS: readonly string[] = ["blocker"];

/** How many live blockers `fetchOpenBlockersForRecurrence` reads before collapsing chains. */
export const RECURRENCE_OFFER_SCAN_LIMIT = 200;
