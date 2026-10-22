// R3 ADV finding 5 (D-064): writeSessionIssueRows matches stored and offered rows by item identity
// (itemKeyResolver), not exact spelling — a re-derived row spelled differently replaces its stored
// copy instead of landing beside it; two forges' `#5` stay two rows; other sessions/users untouched.
import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import type { GroundedSessionIssue } from "../extract";
import { writeSessionIssueRows } from "../session-issues";

function grounded(over: Partial<GroundedSessionIssue> & { ref: string }): GroundedSessionIssue {
  return {
    number: 5,
    kind: "issue",
    role: "worked_on",
    role_source: "observed",
    evidence_quote: "fix acme/api#5",
    turn_idx: 0,
    review_verb: null,
    build_verb: "committed",
    tier: "observed",
    turn_share: 1,
    related_to: [],
    ...over,
  } as GroundedSessionIssue;
}

function stored(over: Partial<Row> & { id: string; ref: string }): Row {
  return {
    session_id: "s1",
    user_id: "u1",
    number: 5,
    kind: "issue",
    role: "referenced",
    evidence_quote: "acme/api#5",
    turn_idx: 0,
    review_verb: "viewed",
    build_verb: null,
    tier: "observed",
    turn_share: 1,
    related_to: [],
    ...over,
  };
}

/** The same item, stored under its hosted spelling by this session — and the same ref in another session and another user. */
function seed(): Record<string, Row[]> {
  return {
    code_session_issues: [
      stored({ id: "a", ref: "github.com/acme/api#5" }),
      stored({ id: "other-session", ref: "github.com/acme/api#5", session_id: "s2" }),
      stored({ id: "other-user", ref: "github.com/acme/api#5", user_id: "u2" }),
    ],
  };
}

const mine = (tables: Record<string, Row[]>) =>
  tables.code_session_issues.filter((r) => r.session_id === "s1" && r.user_id === "u1");
const others = (tables: Record<string, Row[]>) =>
  tables.code_session_issues
    .filter((r) => r.session_id !== "s1" || r.user_id !== "u1")
    .map((r) => [r.id, r.ref, r.role, r.turn_share]);

describe("writeSessionIssueRows: identity, not spelling (R3 ADV 5)", () => {
  // The stored role `referenced` is kept for a `default`-sourced row (the existing keep rule) — across spellings.
  const reDerived = [grounded({ ref: "acme/api#5", role: "worked_on", role_source: "default" })];

  it("(a) replace run: a host-less re-derivation of the stored hosted row leaves exactly one row, hosted spelling and keep rule intact", async () => {
    const tables = seed();
    await writeSessionIssueRows(makeFakeSupabase(tables), "u1", "s1", reDerived, true);
    expect(mine(tables).map((r) => [r.id, r.ref, r.kind, r.role])).toEqual([
      ["a", "github.com/acme/api#5", "issue", "referenced"],
    ]);
  });

  it("(b) tail run: same input, still exactly one row, hosted spelling kept", async () => {
    const tables = seed();
    await writeSessionIssueRows(makeFakeSupabase(tables), "u1", "s1", reDerived, false);
    expect(mine(tables).map((r) => [r.id, r.ref, r.kind, r.role])).toEqual([
      ["a", "github.com/acme/api#5", "issue", "referenced"],
    ]);
  });

  it("(a2) reverse: stored host-less, offered hosted -> one row, the hosted spelling wins (both run modes)", async () => {
    for (const replace of [true, false]) {
      const tables = { code_session_issues: [stored({ id: "h", ref: "acme/api#5" })] };
      await writeSessionIssueRows(
        makeFakeSupabase(tables),
        "u1",
        "s1",
        [grounded({ ref: "github.com/acme/api#5", role: "referenced" })],
        replace,
      );
      expect(mine(tables).map((r) => [r.ref, r.role])).toEqual([["github.com/acme/api#5", "referenced"]]);
    }
  });

  it("(c) the same owner/repo#N on two forges are two items: both rows kept, on either run mode", async () => {
    for (const replace of [true, false]) {
      const tables = seed();
      await writeSessionIssueRows(
        makeFakeSupabase(tables),
        "u1",
        "s1",
        [
          grounded({ ref: "github.com/acme/api#5", role: "referenced" }),
          grounded({ ref: "codehub.example/acme/api#5" }),
        ],
        replace,
      );
      expect(
        mine(tables)
          .map((r) => r.ref)
          .sort(),
      ).toEqual(["codehub.example/acme/api#5", "github.com/acme/api#5"]);
      // The stored github row was re-offered under its own spelling and role: upserted in place, never dropped.
      expect(mine(tables).find((r) => r.ref === "github.com/acme/api#5")?.id).toBe("a");
    }
  });

  it("(d) another session's and another user's rows for the same ref are never dropped or rewritten", async () => {
    for (const replace of [true, false]) {
      const tables = seed();
      const before = others(tables);
      await writeSessionIssueRows(makeFakeSupabase(tables), "u1", "s1", reDerived, replace);
      expect(others(tables)).toEqual(before);
      // A replace run that offers nothing still only clears this session's rows.
      await writeSessionIssueRows(makeFakeSupabase(tables), "u1", "s1", [], true);
      expect(mine(tables)).toEqual([]);
      expect(others(tables)).toEqual(before);
    }
  });
});
