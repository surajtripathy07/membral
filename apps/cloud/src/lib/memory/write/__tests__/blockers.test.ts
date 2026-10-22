// G2 step 2.4g: the pure blocker logic lifted out of write.ts's
// fetchLaterResolutionCandidates. The end-to-end read keeps its coverage in
// lib/memory/__tests__; these pin the filtering, ordering and row shaping it
// produced before.
import { describe, expect, it } from "vitest";
import {
  candidateSessionIds,
  type FetchedLaterResolutionRow,
  LATER_RESOLUTION_SCAN_LIMIT,
  laterResolutionCutoff,
  planLaterResolutionCandidates,
  sessionsStartedBefore,
  unsupersededOtherSessionRows,
} from "../blockers";

function row(id: string, session: string, over: Partial<FetchedLaterResolutionRow> = {}): FetchedLaterResolutionRow {
  return {
    id,
    code_session_id: session,
    text: `t-${id}`,
    quote: null,
    created_at: "2026-09-20T00:00:00.000Z",
    ref: null,
    paths: null,
    supersedes: null,
    ...over,
  };
}

describe("LATER_RESOLUTION_SCAN_LIMIT", () => {
  it("is 200", () => {
    expect(LATER_RESOLUTION_SCAN_LIMIT).toBe(200);
  });
});

describe("laterResolutionCutoff", () => {
  it("is staleDays whole days before now, ISO", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    expect(laterResolutionCutoff(now, 14)).toBe("2026-09-14T12:00:00.000Z");
    expect(laterResolutionCutoff(now, 0)).toBe("2026-09-28T12:00:00.000Z");
  });
});

describe("unsupersededOtherSessionRows", () => {
  it("drops this session's rows and rows another read row supersedes, keeping read order", () => {
    const rows = [
      row("a", "s1"),
      row("b", "self"),
      row("c", "s2", { supersedes: "d" }),
      row("d", "s1"),
      row("e", "s3"),
    ];
    expect(unsupersededOtherSessionRows(rows, "self").map((r) => r.id)).toEqual(["a", "c", "e"]);
  });

  it("honours a supersedes pointer even from this session's own rows", () => {
    const rows = [row("a", "self", { supersedes: "b" }), row("b", "s1"), row("c", "s1")];
    expect(unsupersededOtherSessionRows(rows, "self").map((r) => r.id)).toEqual(["c"]);
  });

  it("returns empty for no rows", () => {
    expect(unsupersededOtherSessionRows([], "self")).toEqual([]);
  });
});

describe("candidateSessionIds", () => {
  it("dedupes in first-seen order", () => {
    expect(candidateSessionIds([row("a", "s2"), row("b", "s1"), row("c", "s2")])).toEqual(["s2", "s1"]);
  });
});

describe("sessionsStartedBefore", () => {
  it("keeps only sessions started strictly before, excluding a null started_at", () => {
    const before = Date.parse("2026-09-20T00:00:00.000Z");
    const got = sessionsStartedBefore(
      [
        { id: "early", started_at: "2026-09-19T23:59:59.000Z" },
        { id: "equal", started_at: "2026-09-20T00:00:00.000Z" },
        { id: "late", started_at: "2026-09-21T00:00:00.000Z" },
        { id: "unknown", started_at: null },
      ],
      before,
    );
    expect([...got]).toEqual(["early"]);
  });
});

describe("planLaterResolutionCandidates", () => {
  it("filters to started-before sessions, caps in read order, drops supersedes", () => {
    const others = [row("a", "s1"), row("b", "late"), row("c", "s1", { supersedes: "x" }), row("d", "s2")];
    const out = planLaterResolutionCandidates(others, new Set(["s1", "s2"]), 2);
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
    for (const r of out) expect("supersedes" in r).toBe(false);
  });

  it("normalises ref and paths: non-string ref → null, non-array paths → null, non-string path entries dropped", () => {
    const others = [
      row("a", "s1", { ref: "feature/x", paths: ["a.ts", 3 as unknown as string, "b.ts"] }),
      row("b", "s1", { ref: undefined as unknown as string, paths: "a.ts" as unknown as string[] }),
    ];
    const out = planLaterResolutionCandidates(others, new Set(["s1"]), 10);
    expect(out).toEqual([
      {
        id: "a",
        code_session_id: "s1",
        text: "t-a",
        quote: null,
        created_at: "2026-09-20T00:00:00.000Z",
        ref: "feature/x",
        paths: ["a.ts", "b.ts"],
      },
      {
        id: "b",
        code_session_id: "s1",
        text: "t-b",
        quote: null,
        created_at: "2026-09-20T00:00:00.000Z",
        ref: null,
        paths: null,
      },
    ]);
  });

  it("returns empty when no session started before", () => {
    expect(planLaterResolutionCandidates([row("a", "s1")], new Set(), 5)).toEqual([]);
  });
});
