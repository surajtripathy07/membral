import { describe, expect, it, vi } from "vitest";
import { cosineTop, mergeCandidates, pairKey } from "../reconcile/candidates";
import { candidateKinds, propose, type ReconSource } from "../reconcile/engine";
import { buildPrompt, type JudgeLlm, judgePairs } from "../reconcile/judge";
import { applySql, capCheck, type PlannedLink, plannedLink, projectionFor, undoSql } from "../reconcile/plan";
import {
  acceptVerdict,
  findQuoteTurn,
  orientPair,
  parseVerdicts,
  type ReconRecord,
  relationAllowed,
} from "../reconcile/verdict";
import { groupSameFact } from "../serve-filter";

const T0 = Date.parse("2026-09-01T00:00:00Z");
const DAY = 86_400_000;
function r(id: string, over: Partial<ReconRecord> = {}): ReconRecord {
  return {
    id,
    kind: "decision",
    text: "Retry the 504 import with backoff because the gateway recovers",
    ref: null,
    code_project_id: "p1",
    code_session_id: `s-${id}`,
    user_id: "u1",
    turn_idx: 3,
    created_at: "2026-09-01T00:00:00Z",
    sessionStart: T0,
    ...over,
  };
}
const older = r("old", { sessionStart: T0 });
const newer = r("new", { sessionStart: T0 + 5 * DAY, text: "Do not retry the 504 import; it is not idempotent" });
const turns = [
  { idx: 3, text: "We decided: do not retry the 504 import; it is not idempotent, so a retry double-writes." },
];

describe("orientPair: newer is always from", () => {
  it("orders by session start, either argument order", () => {
    expect(orientPair(older, newer)?.from.id).toBe("new");
    expect(orientPair(newer, older)?.from.id).toBe("new");
  });
  it("one session: higher turn_idx is newer; equal or missing turn => no link", () => {
    const a = r("a", { code_session_id: "s", turn_idx: 2 });
    const b = r("b", { code_session_id: "s", turn_idx: 9 });
    expect(orientPair(a, b)?.from.id).toBe("b");
    expect(orientPair(a, r("c", { code_session_id: "s", turn_idx: 2 }))).toBeNull();
    expect(orientPair(a, r("d", { code_session_id: "s", turn_idx: null }))).toBeNull();
  });
  it("never across users or projects, never the same record, never equal start times", () => {
    expect(orientPair(older, r("x", { user_id: "u2", sessionStart: T0 + DAY }))).toBeNull();
    expect(orientPair(older, r("y", { code_project_id: "p2", sessionStart: T0 + DAY }))).toBeNull();
    expect(orientPair(older, older)).toBeNull();
    expect(orientPair(older, r("z", { sessionStart: T0 }))).toBeNull();
    expect(orientPair(older, r("w", { sessionStart: undefined }))).toBeNull();
  });
});

describe("acceptVerdict", () => {
  const pair = orientPair(older, newer)!;
  const quote = "do not retry the 504 import; it is not idempotent";
  it("keeps supersedes with a verbatim quote that names the subject", () => {
    const a = acceptVerdict(
      { relation: "supersedes", evidence_quote: quote, subject: "504 import retry", replacing_state_quote: quote },
      { pair, turns },
    );
    expect(a).toMatchObject({ relation: "supersedes", verified: true, turn_idx: 3 });
  });
  it("abstains when the quote is not in the session's turns, or missing, or does not name the subject", () => {
    expect(
      acceptVerdict({ relation: "supersedes", evidence_quote: "something nobody wrote here at all" }, { pair, turns })
        .relation,
    ).toBe("unrelated");
    expect(acceptVerdict({ relation: "supersedes" }, { pair, turns }).relation).toBe("unrelated");
    const off = [{ idx: 1, text: "a long unrelated remark about lunch plans and the weather today" }];
    expect(
      acceptVerdict(
        { relation: "supersedes", evidence_quote: "a long unrelated remark about lunch plans" },
        { pair, turns: off },
      ).relation,
    ).toBe("unrelated");
  });
  it("abstains on an unknown relation, a missing verdict and garbage", () => {
    expect(acceptVerdict({ relation: "obsoletes" }, { pair, turns }).relation).toBe("unrelated");
    expect(acceptVerdict(undefined, { pair, turns }).relation).toBe("unrelated");
    expect(parseVerdicts("nope").size).toBe(0);
    expect(parseVerdicts({ verdicts: [{ pair: "x" }] }).size).toBe(0);
  });
  it("duplicates needs nothing lost AND cosine >= 0.70 or containment >= 0.4", () => {
    const dup = orientPair(
      r("d1", { text: "Use BLOCKER_FRESH_DAYS = 7 for blocker freshness everywhere", sessionStart: T0 }),
      r("d2", { text: "Blocker freshness uses BLOCKER_FRESH_DAYS = 7 everywhere", sessionStart: T0 + DAY }),
    )!;
    expect(
      acceptVerdict({ relation: "duplicates", lost_information: "" }, { pair: dup, turns: [], cosine: 0.9 }).relation,
    ).toBe("duplicates");
    expect(
      acceptVerdict(
        { relation: "duplicates", lost_information: "the 7-day value" },
        { pair: dup, turns: [], cosine: 0.9 },
      ).relation,
    ).toBe("unrelated");
    const far = orientPair(
      r("f1", { text: "alpha beta gamma delta", sessionStart: T0 }),
      r("f2", { text: "epsilon zeta eta theta", sessionStart: T0 + DAY }),
    )!;
    expect(
      acceptVerdict({ relation: "duplicates", lost_information: "" }, { pair: far, turns: [], cosine: 0.3 }).relation,
    ).toBe("unrelated");
  });
  it("an outcome is never a target; resolves needs a blocker target; refines is stored unverified", () => {
    const out = orientPair(
      r("o1", { kind: "outcome", sessionStart: T0 }),
      r("o2", { kind: "outcome", sessionStart: T0 + DAY }),
    )!;
    expect(relationAllowed("supersedes", out)).toBe(false);
    const res = orientPair(
      r("b", { kind: "blocker", sessionStart: T0 }),
      r("o", { kind: "outcome", sessionStart: T0 + DAY }),
    )!;
    expect(relationAllowed("resolves", res)).toBe(true);
    expect(relationAllowed("resolves", pair)).toBe(false);
    expect(acceptVerdict({ relation: "refines" }, { pair, turns }).verified).toBe(false);
  });
  it("findQuoteTurn tolerates case, spacing and curly quotes", () => {
    expect(findQuoteTurn("Do NOT   retry the 504 import", turns)).toBe(3);
    expect(findQuoteTurn("short", turns)).toBeNull();
  });
});

describe("candidates", () => {
  it("unions hybrid, cosine, ref; drops self and memoised pairs; caps at 12", () => {
    const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const out = mergeCandidates(
      "me",
      { hybrid: ["me", "h1", "h2"], cosine: ["h2", "c1"], ref: ids("r", 20) },
      new Set([pairKey("me", "h1")]),
    );
    expect(out.map((c) => c.id).slice(0, 3)).toEqual(["h2", "c1", "r0"]);
    expect(out.find((c) => c.id === "h2")?.via).toEqual(["hybrid", "cosine"]);
    expect(out).toHaveLength(12);
    expect(out.some((c) => c.id === "h1" || c.id === "me")).toBe(false);
  });
  it("cosineTop applies the 0.55 floor and top-8", () => {
    const s = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, cosine: 0.9 - i * 0.05 }));
    expect(cosineTop(s)).toHaveLength(8);
    expect(cosineTop([{ id: "x", cosine: 0.5 }])).toEqual([]);
  });
});

describe("plan", () => {
  const link = (over: Partial<PlannedLink>): PlannedLink => ({
    from_id: "n1",
    to_id: "o1",
    relation: "supersedes",
    quote: "q",
    verified: true,
    session_id: "s",
    turn_idx: 1,
    from_started_at: "2026-09-10T00:00:00Z",
    project_id: "p1",
    ...over,
  });
  it("projects verified hiding links only, OLDEST replacement wins, never sets retired_at", () => {
    const p = projectionFor([
      link({}),
      link({ from_id: "n2", from_started_at: "2026-09-20T00:00:00Z" }),
      link({ to_id: "o2", relation: "refines" }),
      link({ to_id: "o3", verified: false }),
    ]);
    expect(p).toEqual([
      {
        id: "o1",
        project_id: "p1",
        superseded_by: "n1",
        supersede_kind: "supersedes",
        valid_to: "2026-09-10T00:00:00Z",
      },
    ]);
    expect(JSON.stringify(p)).not.toContain("retired");
  });
  it("skips a replacement that is itself retired", () => {
    expect(projectionFor([link({})], new Set(["n1"]))).toEqual([]);
  });
  it("caps: more than 10% of live or more than 400 aborts", () => {
    expect(capCheck(10, 100).ok).toBe(true);
    expect(capCheck(11, 100).ok).toBe(false);
    expect(capCheck(401, 100000).ok).toBe(false);
  });
  it("undo clears only where the projection still points at the planned replacement, and marks the links undone", () => {
    const sql = undoSql("run1", "u1", projectionFor([link({})]));
    expect(sql).toMatch(/superseded_by = 'n1'/);
    expect(sql).toMatch(/undone_at = now\(\)/);
    expect(sql).not.toMatch(/retired_at/);
    expect(applySql("run1", "u1", "m", "v", [link({})], projectionFor([link({})]))).toMatch(/^begin;[\s\S]*commit;/);
  });
  it("applySql upgrades a pre-existing 'unrelated' memo row and only projects behind a verified hiding link", () => {
    const sql = applySql("run1", "u1", "m", "v", [link({})], projectionFor([link({})]), [
      { from_id: "n1", to_id: "o1", session_id: "s" },
    ]);
    expect(sql).toMatch(/do update set relation = excluded\.relation/);
    expect(sql).toMatch(/memory_links\.relation = 'unrelated'/);
    expect(sql).toMatch(
      /exists \(select 1 from public\.memory_links k where[^;]*k\.verified[^;]*k\.relation = 'supersedes'/,
    );
    // an abstention for a pair that also has a hiding link is not inserted twice
    expect(sql.match(/'n1', 'o1'/g)).toHaveLength(1);
  });
  it("plannedLink carries the newer record's session and start", () => {
    const l = plannedLink(orientPair(older, newer)!, {
      relation: "supersedes",
      quote: "q",
      verified: true,
      turn_idx: 3,
    });
    expect(l).toMatchObject({ from_id: "new", to_id: "old", session_id: "s-new" });
  });
});

describe("judgePairs", () => {
  const item = (i: number) => ({
    pair: orientPair(older, r(`n${i}`, { sessionStart: T0 + DAY * (i + 1) }))!,
    cosine: null,
    turns,
  });
  it("batches at 40 pairs per call and honours the run-wide call cap", async () => {
    const llm: JudgeLlm = {
      callJson: vi.fn(async () => ({ data: { verdicts: [] }, record: { cost_usd: 0 } })) as never,
    };
    const res = await judgePairs(
      llm,
      Array.from({ length: 85 }, (_, i) => item(i)),
      { conversationId: "c", maxCalls: 2 },
    );
    expect(llm.callJson).toHaveBeenCalledTimes(2);
    expect(res.calls).toBe(2);
    expect(res.skipped).toBe(5);
    expect(res.judged).toHaveLength(85);
  });
  it("a failed call abstains for the batch and reports failed", async () => {
    const llm: JudgeLlm = {
      callJson: vi.fn(async () => {
        throw new Error("429");
      }) as never,
    };
    const res = await judgePairs(llm, [item(0)], { conversationId: "c", maxCalls: 5 });
    expect(res.failed).toBe(true);
    expect(res.judged[0].accepted.relation).toBe("unrelated");
  });
  it("the prompt never contains the model-set direction: it shows OLDER and NEWER", () => {
    expect(buildPrompt([item(0)])).toMatch(/OLDER[\s\S]*NEWER/);
  });
});

describe("propose (engine)", () => {
  const mk = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "decision",
    text: "Retry the 504 import with backoff because the gateway recovers",
    ref: null,
    code_project_id: "p1",
    code_session_id: `s-${id}`,
    user_id: "u1",
    turn_idx: 3,
    created_at: "2026-09-01T00:00:00Z",
    embedding: [1, 0],
    valid_to: null,
    ...over,
  });
  const src = (rows: ReturnType<typeof mk>[], starts: Record<string, number>): ReconSource => ({
    scope: async () => rows,
    sessionStarts: async () => new Map(Object.entries(starts)),
    hybrid: async () => rows.map((x) => x.id),
    turns: async () => turns,
  });
  it("links within one project only and never targets an outcome", async () => {
    const rows = [
      mk("old"),
      mk("new", { text: "Do not retry the 504 import; it is not idempotent" }),
      mk("other", { code_project_id: "p2" }),
      mk("out", { kind: "outcome" }),
    ];
    const llm: JudgeLlm = {
      callJson: vi.fn(async () => ({
        data: {
          verdicts: [
            {
              pair: 0,
              relation: "supersedes",
              evidence_quote: "do not retry the 504 import; it is not idempotent",
              subject: "504 import retry",
              replacing_state_quote: "Do not retry the 504 import; it is not idempotent",
            },
          ],
        },
        record: { cost_usd: 0 },
      })) as never,
    };
    const res = await propose(
      src(rows, { "s-old": T0, "s-new": T0 + DAY, "s-other": T0, "s-out": T0 + 2 * DAY }),
      llm,
      { maxCalls: 5, conversationId: "c" },
    );
    expect(res.links.map((l) => `${l.from_id}>${l.to_id}:${l.relation}`)).toEqual(["new>old:supersedes"]);
    expect(res.links.every((l) => l.to_id !== "out" && l.to_id !== "other" && l.from_id !== "other")).toBe(true);
  });
  it("no provider => no links and no calls (the existing planSupersede rule stays the fallback)", async () => {
    const res = await propose(src([mk("old"), mk("new")], { "s-old": T0, "s-new": T0 + DAY }), null, {
      maxCalls: 5,
      conversationId: "c",
    });
    expect(res.links).toEqual([]);
    expect(res.calls).toBe(0);
    expect(res.shortlists.get("new")?.map((c) => c.id)).toEqual(["old"]);
  });
  it("a memoised pair is never re-judged", async () => {
    const llm: JudgeLlm = { callJson: vi.fn() as never };
    const res = await propose(src([mk("old"), mk("new")], { "s-old": T0, "s-new": T0 + DAY }), llm, {
      maxCalls: 5,
      conversationId: "c",
      seen: new Set([pairKey("old", "new")]),
    });
    expect(llm.callJson).not.toHaveBeenCalled();
    expect(res.pairsJudged).toBe(0);
  });
  it("candidateKinds: outcomes only meet blockers", () => {
    expect(candidateKinds("outcome")).toEqual(["blocker"]);
    expect(candidateKinds("preference")).toEqual([]);
  });
});

describe("groupSameFact with duplicate_of (L1)", () => {
  const g = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "decision",
    text: `completely different wording number ${id}`,
    ref: null,
    code_project_id: "p1",
    code_session_id: `s-${id}`,
    created_at: "2026-10-01T00:00:00Z",
    ...over,
  });
  it("a duplicates target joins its survivor's group whatever the text says, following chains", () => {
    const groups = groupSameFact([g("a"), g("b", { duplicate_of: "a" }), g("c", { duplicate_of: "b" }), g("z")]);
    expect(groups.map((x) => x.map((m) => m.id))).toEqual([["a", "b", "c"], ["z"]]);
  });
  it("a link to a record outside the set does nothing", () => {
    expect(groupSameFact([g("b", { duplicate_of: "gone" })])).toHaveLength(1);
  });
});

describe("propose: a target whose replacement was retired is reconsidered", () => {
  const mk = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "decision",
    text: "Retry the 504 import with backoff because the gateway recovers",
    ref: null,
    code_project_id: "p1",
    code_session_id: `s-${id}`,
    user_id: "u1",
    turn_idx: 3,
    created_at: "2026-09-01T00:00:00Z",
    embedding: [1, 0],
    valid_to: null as string | null,
    superseded_by: null as string | null,
    ...over,
  });
  const src = (rows: ReturnType<typeof mk>[]): ReconSource => ({
    scope: async () => rows,
    sessionStarts: async () => new Map(rows.map((r, i) => [r.code_session_id, T0 + i * DAY])),
    hybrid: async () => rows.map((x) => x.id),
    turns: async () => [],
  });
  it("valid_to counts as unset when superseded_by is no longer live; a live replacement still hides", async () => {
    const stale = mk("old", { valid_to: "2026-09-02T00:00:00Z", superseded_by: "gone" });
    const held = mk("old2", { valid_to: "2026-09-02T00:00:00Z", superseded_by: "new" });
    const res = await propose(src([stale, held, mk("new")]), null, { maxCalls: 0, conversationId: "c" });
    const offered = res.shortlists.get("new")?.map((c) => c.id) ?? [];
    expect(offered).toContain("old");
    expect(offered).not.toContain("old2");
  });
});
