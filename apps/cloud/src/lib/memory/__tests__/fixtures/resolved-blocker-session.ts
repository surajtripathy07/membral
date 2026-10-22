// P8 fixture (goal 2026-09-24 memory-on-prod): a session that opens a blocker and then resolves
// it far past the old re-ask horizon (the first 400 rendered lines after the earliest blocker).
// It has the same shape as D3 session c750738a, where "reload the extension to close #27"
// (raised at t1417) closed at t1589 and "goal pending sign-off" closed at the last turn. The
// repo name is fictional (CodeHub), per CLAUDE.md rule 2.
import type { RenderedTurn } from "../../render";

export const RESOLVED_BLOCKER_OPEN_IDX = 1;
export const LATE_BLOCKER_OPEN_IDX = 460;
export const FILLER_TURNS = 520;

export const BLOCKER_OPEN_LINE =
  "[#1 assistant] Blocked: the CodeHub deploy token is missing, so the staging migration cannot run until you add it.";
export const LATE_BLOCKER_OPEN_LINE =
  "[#460 assistant] Blocked on your sign-off: the release notes need your approval before the tag is pushed.";
export const LATE_BLOCKER_FOLLOW_LINE = "[#461 user] approved, push the tag";
export const BLOCKER_RESOLVED_LINE =
  "[#521 assistant] The deploy token is in place now and the staging migration ran cleanly.";

function line(idx: number, role: "user" | "assistant", text: string): RenderedTurn {
  const l = `[#${idx} ${role}] ${text}`;
  return { idx, role, kind: "prose", line: l, isProse: true, charLen: l.length };
}

/** Rendered turns 0..FILLER_TURNS+1, in idx order. Every line is prose, so no rendered line is dropped. */
export function resolvedBlockerSessionLines(): RenderedTurn[] {
  const out: RenderedTurn[] = [line(0, "user", "please run the staging migration for CodeHub")];
  out.push({ ...line(1, "assistant", ""), line: BLOCKER_OPEN_LINE, charLen: BLOCKER_OPEN_LINE.length });
  for (let i = 2; i <= FILLER_TURNS; i++) {
    if (i === LATE_BLOCKER_OPEN_IDX) {
      out.push({ ...line(i, "assistant", ""), line: LATE_BLOCKER_OPEN_LINE });
    } else if (i === LATE_BLOCKER_OPEN_IDX + 1) {
      out.push({ ...line(i, "user", ""), line: LATE_BLOCKER_FOLLOW_LINE });
    } else {
      out.push(line(i, i % 2 === 0 ? "user" : "assistant", `unrelated work step ${i}`));
    }
  }
  out.push({ ...line(FILLER_TURNS + 1, "assistant", ""), line: BLOCKER_RESOLVED_LINE });
  return out;
}
