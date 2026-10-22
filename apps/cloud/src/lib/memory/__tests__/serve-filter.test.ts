import { describe, expect, it } from "vitest";
import { sameFactByVector } from "../dedupe";
import {
  asOfDay,
  collapseSameFact,
  currentOnly,
  groupSameFact,
  markSuperseded,
  pickSurvivor,
  type SameFactRow,
} from "../serve-filter";

const row = (id: string, over: Partial<SameFactRow> = {}): SameFactRow => ({
  id,
  kind: "decision",
  text: "Blocker freshness uses one constant, BLOCKER_FRESH_DAYS = 7, across preamble search and recall",
  ref: null,
  code_project_id: "p1",
  code_session_id: `s-${id}`,
  created_at: "2026-10-01T00:00:00Z",
  verified: true,
  ...over,
});

describe("asOfDay", () => {
  it("gives the UTC day, empty on garbage", () => {
    expect(asOfDay("2026-10-04T23:59:59Z")).toBe("2026-10-04");
    expect(asOfDay("nope")).toBe("");
    expect(asOfDay(null)).toBe("");
  });
});

describe("groupSameFact / collapseSameFact", () => {
  it("collapses identical-text rows of one project and kind, counting distinct sessions", () => {
    const rows = [row("a"), row("b"), row("c", { code_session_id: "s-a" })];
    const out = collapseSameFact(rows, () => undefined);
    expect(out.rows).toHaveLength(1);
    expect(out.seenIn.get(out.rows[0].id)).toBe(2);
  });

  it("never merges across projects or kinds", () => {
    expect(groupSameFact([row("a"), row("b", { code_project_id: "p2" })])).toHaveLength(2);
    expect(groupSameFact([row("a"), row("b", { kind: "learning" })])).toHaveLength(2);
  });

  it("keeps different identifiers apart (migration 118 vs 119)", () => {
    const t = (n: number) => `Applied migration ${n} to the local stack and verified the new function exists there`;
    expect(groupSameFact([row("a", { text: t(118) }), row("b", { text: t(119) })])).toHaveLength(2);
  });

  it("takes the extra meaning rule only when the text rule says no", () => {
    const a = row("a", { text: "Stop the kicker before any exclusion run on the second stack" });
    const b = row("b", { text: "Halt extraction worker prior to excluding sessions in the other stack" });
    expect(groupSameFact([a, b])).toHaveLength(2);
    expect(groupSameFact([a, b], () => true)).toHaveLength(1);
  });
});

describe("pickSurvivor: real session time, never insert order", () => {
  it("picks the newest session even when it was inserted first", () => {
    const old = row("old", { created_at: "2026-10-09T00:00:00Z" }); // re-extracted last
    const fresh = row("fresh", { created_at: "2026-10-01T00:00:00Z" });
    const t = (r: SameFactRow) => (r.id === "fresh" ? Date.parse("2026-09-30") : Date.parse("2026-09-01"));
    expect(pickSurvivor([old, fresh], t).id).toBe("fresh");
    expect(pickSurvivor([fresh, old], t).id).toBe("fresh");
  });

  it("prefers a verified member, falls back to created_at when no session time is known", () => {
    const u = row("u", { verified: false, created_at: "2026-10-09T00:00:00Z" });
    const v = row("v", { verified: true, created_at: "2026-10-01T00:00:00Z" });
    expect(pickSurvivor([u, v], () => undefined).id).toBe("v");
    expect(
      pickSurvivor(
        [row("x", { created_at: "2026-10-01T00:00:00Z" }), row("y", { created_at: "2026-10-02T00:00:00Z" })],
        () => undefined,
      ).id,
    ).toBe("y");
  });
});

describe("sameFactByVector", () => {
  const a = { kind: "decision", ref: null, text: "Stop the kicker before any exclusion run on the second stack" };
  const b = {
    kind: "decision",
    ref: null,
    text: "Stop the extraction kicker before an exclusion run on the other stack",
  };
  it("needs the cosine at the cut, same kind, no clashing identifiers", () => {
    expect(sameFactByVector(a, b, 0.9, 0.86)).toBe(true);
    expect(sameFactByVector(a, b, 0.85, 0.86)).toBe(false);
    expect(sameFactByVector(a, { ...b, kind: "learning" }, 0.99, 0.86)).toBe(false);
    expect(sameFactByVector(a, { ...b, text: `${b.text} migration 119` }, 0.99, 0.86)).toBe(false);
    expect(sameFactByVector(a, { ...b, ref: "#12" }, 0.99, 0.86)).toBe(false);
  });
});

describe("vector rule limits", () => {
  it("a reversal worded with different tokens is not merged even at cosine 0.99 (containment guard)", () => {
    const retry = { kind: "decision", ref: null, text: "Retry the 504 import after a short backoff, it is safe here" };
    const never = {
      kind: "decision",
      ref: null,
      text: "Never rerun that batch; abandon it because the vendor rejects 504 payloads",
    };
    expect(sameFactByVector(retry, never, 0.99, 0.86)).toBe(false);
    // Known limit (resolved by L1's model verdict, not a word list): a reversal that reuses the same tokens still passes.
    const negated = {
      kind: "decision",
      ref: null,
      text: "Do not retry the 504 import after a short backoff, it is safe here",
    };
    expect(sameFactByVector(retry, negated, 0.99, 0.86)).toBe(true);
  });
});

describe("complete linkage", () => {
  it("B and C that each match A but not each other do not share a group", () => {
    const t = (n: number) => `Applied migration ${n} to the local stack and verified the new function exists there`;
    const generic = "Applied migration to the local stack and verified the new function exists there";
    const groups = groupSameFact(
      [row("a", { text: generic }), row("b", { text: t(118) }), row("c", { text: t(119) })],
      (x, y) => x.id === "a" || y.id === "a",
    );
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("currentOnly (guarded: L1 columns do not exist yet)", () => {
  const rows = markSuperseded([
    { id: "new", supersedes: "old", created_at: "2026-10-05T00:00:00Z" },
    { id: "old", supersedes: null, created_at: "2026-09-01T00:00:00Z" },
    { id: "plain", supersedes: null, created_at: "2026-09-02T00:00:00Z" },
  ]);
  it("hides a row while its replacement is live", () => {
    expect(currentOnly(rows).map((r) => r.id)).toEqual(["new", "plain"]);
  });
  it("include_superseded serves everything", () => {
    expect(currentOnly(rows, { includeSuperseded: true })).toHaveLength(3);
  });
  it("a past date keeps a row whose replacement came after that date", () => {
    expect(currentOnly(rows, { asOfMs: Date.parse("2026-09-20") }).map((r) => r.id)).toContain("old");
    expect(currentOnly(rows, { asOfMs: Date.parse("2026-10-06") }).map((r) => r.id)).not.toContain("old");
  });
  it("a replacement that is not live hides nothing", () => {
    expect(currentOnly(rows, { isLive: () => false })).toHaveLength(3);
  });
  it("rows without any L1 field are never hidden (no-op until L1 lands)", () => {
    const plain = [{ id: "a" }, { id: "b", valid_to: null, superseded_by: null }];
    expect(currentOnly(plain)).toHaveLength(2);
  });
  it("uses L1's valid_to/superseded_by when present", () => {
    expect(currentOnly([{ id: "a", valid_to: "2026-10-01T00:00:00Z", superseded_by: "z" }])).toHaveLength(0);
  });
});
