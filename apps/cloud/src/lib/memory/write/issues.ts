// G2 step 2.4h: the pure row shaping behind write/io.ts's writeSessionIssues (write.ts until 2.4h)
// (code_session_issues, migration 099). The delete-on-replace, the upsert,
// its conflict target and the error lines stay in the IO module.
import type { GroundedSessionIssue } from "../extract";

/** One code_session_issues row, keys in the order the upsert sent them. */
export interface SessionIssueRow {
  session_id: string;
  user_id: string;
  ref: string;
  number: GroundedSessionIssue["number"];
  kind: GroundedSessionIssue["kind"];
  role: GroundedSessionIssue["role"];
  evidence_quote: string;
  turn_idx: GroundedSessionIssue["turn_idx"];
}

/** Maps a session's grounded issues to rows; `ref` and `evidence_quote` are capped at 500 chars. */
export function sessionIssueRows(
  sessionId: string,
  userId: string,
  issues: readonly GroundedSessionIssue[],
): SessionIssueRow[] {
  return issues.map((i) => ({
    session_id: sessionId,
    user_id: userId,
    ref: i.ref.slice(0, 500),
    number: i.number,
    kind: i.kind,
    role: i.role,
    evidence_quote: i.evidence_quote.slice(0, 500),
    turn_idx: i.turn_idx,
  }));
}
