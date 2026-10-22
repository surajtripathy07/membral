// G2 step 2.4h: the pure row shaping lifted out of writeSessionIssues. The
// delete and the upsert stay in write/io.ts; these pin the rows (keys, key
// order and the 500-char caps) it produced before.
import { describe, expect, it } from "vitest";
import type { GroundedSessionIssue } from "../../extract";
import { sessionIssueRows } from "../issues";

const issue = (over: Partial<GroundedSessionIssue> = {}): GroundedSessionIssue =>
  ({
    ref: "acme/widgets#42",
    number: 42,
    kind: "issue",
    role: "worked",
    role_source: "observed",
    evidence_quote: "fixes #42",
    turn_idx: 3,
    ...over,
  }) as GroundedSessionIssue;

describe("sessionIssueRows", () => {
  it("maps each issue to a row with the migration 099 columns, in the original order", () => {
    const rows = sessionIssueRows("sess-1", "user-1", [issue()]);
    expect(rows).toEqual([
      {
        session_id: "sess-1",
        user_id: "user-1",
        ref: "acme/widgets#42",
        number: 42,
        kind: "issue",
        role: "worked",
        evidence_quote: "fixes #42",
        turn_idx: 3,
      },
    ]);
    expect(Object.keys(rows[0])).toEqual([
      "session_id",
      "user_id",
      "ref",
      "number",
      "kind",
      "role",
      "evidence_quote",
      "turn_idx",
    ]);
  });

  it("drops role_source and caps ref and evidence_quote at 500 chars", () => {
    const [row] = sessionIssueRows("s", "u", [issue({ ref: "r".repeat(600), evidence_quote: "q".repeat(501) })]);
    expect(row.ref).toHaveLength(500);
    expect(row.evidence_quote).toHaveLength(500);
    expect(row).not.toHaveProperty("role_source");
  });

  it("returns no rows for no issues, preserving input order otherwise", () => {
    expect(sessionIssueRows("s", "u", [])).toEqual([]);
    const rows = sessionIssueRows("s", "u", [issue({ number: 1 }), issue({ number: 2 })]);
    expect(rows.map((r) => r.number)).toEqual([1, 2]);
  });
});
