import { describe, expect, it, vi } from "vitest";
import { candidateKinds, propose, type ReconSource } from "../reconcile/engine";
import { writeDryRunMemo } from "../reconcile/io";
import { type JudgeItem, type JudgeLlm, judgePairs } from "../reconcile/judge";
import {
  acceptVerdict,
  artifactInBoth,
  isArtifactToken,
  isStrictSuperset,
  orientPair,
  RECONCILE_PROMPT_VERSION,
  type ReconRecord,
} from "../reconcile/verdict";

const T0 = Date.parse("2026-09-01T00:00:00Z");
const DAY = 86_400_000;
const MIN = 60_000;
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

describe("v2: prompt version", () => {
  it("is bumped so v1 memo rows are not reused", () => {
    expect(RECONCILE_PROMPT_VERSION).toBe("l1-v2");
  });
});

describe("v2 supersedes: the newer record's own text states the replacing state", () => {
  const older = r("old", { text: "Import sync retries the 504 import with backoff every time" });
  const newer = r("new", {
    sessionStart: T0 + DAY,
    text: "Never retry the 504 import with backoff: a retry double-writes rows, so fail fast instead.",
  });
  const pair = orientPair(older, newer)!;
  const evidence = "never retry the 504 import with backoff";
  const turns = [{ idx: 3, text: "Decision: never retry the 504 import with backoff; fail fast." }];
  const good = {
    relation: "supersedes",
    evidence_quote: evidence,
    subject: "504 import retry",
    replacing_state_quote: "a retry double-writes rows, so fail fast instead",
  };
  const go = (over: Record<string, unknown>) => acceptVerdict({ ...good, ...over }, { pair, turns }).relation;

  it("accepts a quote taken from the newer record's text and a subject in both", () => {
    const a = acceptVerdict(good, { pair, turns });
    expect(a).toMatchObject({ relation: "supersedes", verified: true, subject: "504 import retry" });
    expect(a.replacing_state_quote).toBe(good.replacing_state_quote);
  });
  it("rejects a replacing_state_quote that is only in the session, not in the newer record's text", () => {
    expect(go({ replacing_state_quote: "fail fast." + " and the session said more" })).toBe("unrelated");
    expect(go({ replacing_state_quote: "Decision: never retry the 504 import with backoff; fail fast." })).toBe(
      "unrelated",
    );
  });
  it("rejects a missing or empty replacing_state_quote and a missing or empty subject", () => {
    expect(go({ replacing_state_quote: null })).toBe("unrelated");
    expect(go({ replacing_state_quote: "" })).toBe("unrelated");
    expect(go({ subject: "" })).toBe("unrelated");
    expect(go({ subject: null })).toBe("unrelated");
    expect(go({ subject: "   " })).toBe("unrelated");
  });
  it("rejects a subject that is not in both records", () => {
    expect(go({ subject: "payments webhook signing" })).toBe("unrelated");
  });
  it("rejects 'refines' as a hiding link", () => {
    const a = acceptVerdict({ ...good, relation: "refines" }, { pair, turns });
    expect(a).toMatchObject({ relation: "refines", verified: false });
  });
});

describe("v2 resolves: outcome and blocker name the same artifact, checked in code", () => {
  const blocker = r("b", {
    kind: "blocker",
    text: "The sync smoke test in PR #459 still fails on a cold runner",
  });
  const outcome = r("o", {
    kind: "outcome",
    sessionStart: T0 + DAY,
    text: "PR #459 merged after the sync smoke test passed on a cold runner",
  });
  const pair = orientPair(blocker, outcome)!;
  const turns = [{ idx: 3, text: "PR #459 merged after the sync smoke test passed on a cold runner today" }];
  const base = { relation: "resolves", evidence_quote: "merged after the sync smoke test passed on a cold runner" };
  it("accepts when shared_artifact is a token present in both texts", () => {
    expect(acceptVerdict({ ...base, shared_artifact: "#459" }, { pair, turns })).toMatchObject({
      relation: "resolves",
      verified: true,
      shared_artifact: "#459",
    });
  });
  it("abstains when the artifact is missing, absent from one record, or only a topic word", () => {
    expect(acceptVerdict(base, { pair, turns }).relation).toBe("unrelated");
    expect(acceptVerdict({ ...base, shared_artifact: "#460" }, { pair, turns }).relation).toBe("unrelated");
    expect(acceptVerdict({ ...base, shared_artifact: "smoke" }, { pair, turns }).relation).toBe("unrelated");
  });
  it("abstains when the token is in the outcome but not the blocker (nearby-topic outcome)", () => {
    const other = r("b2", { kind: "blocker", text: "Prompt hook recall is still unlogged on the server" });
    const p = orientPair(
      other,
      r("o2", { kind: "outcome", sessionStart: T0 + DAY, text: "PR #459 logs the preamble only" }),
    )!;
    expect(acceptVerdict({ ...base, shared_artifact: "#459" }, { pair: p, turns }).relation).toBe("unrelated");
  });
  it("artifact tokens: numbers, files, packages, migrations count; plain words and short tokens do not", () => {
    for (const t of ["#459", "migration 124", "reconcile.ts", "@membral/cli", "memory_links", "applySql"])
      expect(isArtifactToken(t)).toBe(true);
    for (const t of ["smoke", "preamble", "ab", "", "the import"]) expect(isArtifactToken(t)).toBe(false);
    expect(artifactInBoth("reconcile.ts", "edit reconcile.ts now", "fixed in Reconcile.ts")).toBe(true);
    expect(artifactInBoth("#45", "see #459", "see #45")).toBe(false); // word-bounded
  });
});

describe("v2 duplicates: a strict superset is not a duplicate", () => {
  const older = r("d1", { text: "Blocker freshness uses BLOCKER_FRESH_DAYS equal to seven everywhere" });
  const same = r("d2", {
    sessionStart: T0 + DAY,
    text: "Blocker freshness uses BLOCKER_FRESH_DAYS equal to seven everywhere!",
  });
  const superset = r("d3", {
    sessionStart: T0 + DAY,
    text: "Blocker freshness uses BLOCKER_FRESH_DAYS equal to seven everywhere, and the preamble also drops resolved blockers after two days",
  });
  const dup = { relation: "duplicates", lost_information: "" };
  it("a paraphrase with nothing added stays a duplicate", () => {
    expect(acceptVerdict(dup, { pair: orientPair(older, same)!, turns: [], cosine: 0.9 }).relation).toBe("duplicates");
  });
  it("a newer record that holds all of the older and adds more links 'refines' (unverified), never hides", () => {
    const a = acceptVerdict(dup, { pair: orientPair(older, superset)!, turns: [], cosine: 0.9 });
    expect(a).toMatchObject({ relation: "refines", verified: false });
    expect(isStrictSuperset(older.text, superset.text)).toBe(true);
    expect(isStrictSuperset(older.text, same.text)).toBe(false);
  });
  it("lost_information must still be exactly empty", () => {
    expect(
      acceptVerdict(
        { relation: "duplicates", lost_information: "seven" },
        { pair: orientPair(older, same)!, turns: [], cosine: 0.9 },
      ).relation,
    ).toBe("unrelated");
  });
});

describe("v2 direction: by TURN time, ambiguous orders do not link", () => {
  it("uses turn times when both exist, even against the session start order", () => {
    const a = r("a", { sessionStart: T0, turnTs: T0 + 3 * DAY });
    const b = r("b", { sessionStart: T0 + DAY, turnTs: T0 + DAY });
    expect(orientPair(a, b)?.from.id).toBe("a");
    expect(orientPair(b, a)?.from.id).toBe("a");
  });
  it("falls back to session start only when a turn time is missing", () => {
    const a = r("a", { sessionStart: T0, turnTs: T0 + 3 * DAY });
    const b = r("b", { sessionStart: T0 + DAY });
    expect(orientPair(a, b)?.from.id).toBe("b");
    expect(orientPair(r("c", { sessionStart: T0 }), r("d", { sessionStart: T0 + DAY }))?.from.id).toBe("d");
  });
  it("different sessions less than 5 minutes apart => no link; 5 minutes or more links", () => {
    expect(orientPair(r("a", { turnTs: T0 }), r("b", { turnTs: T0 + 4 * MIN }))).toBeNull();
    expect(orientPair(r("a", { sessionStart: T0 }), r("b", { sessionStart: T0 + 2 * MIN }))).toBeNull();
    expect(orientPair(r("a", { turnTs: T0 }), r("b", { turnTs: T0 + 5 * MIN }))?.from.id).toBe("b");
  });
  it("one session still orders by turn_idx regardless of timestamps", () => {
    const a = r("a", { code_session_id: "s", turn_idx: 2, turnTs: T0 + DAY });
    const b = r("b", { code_session_id: "s", turn_idx: 9, turnTs: T0 });
    expect(orientPair(a, b)?.from.id).toBe("b");
  });
  it("propose reads turn times from the source", async () => {
    const mk = (id: string, sid: string) => ({
      ...r(id, { code_session_id: sid }),
      embedding: [1, 0],
      valid_to: null,
    });
    const rows = [mk("x", "sx"), mk("y", "sy")];
    // session starts say y is newer; turn times say x is newer
    const src: ReconSource = {
      scope: async () => rows,
      sessionStarts: async () =>
        new Map([
          ["sx", T0],
          ["sy", T0 + DAY],
        ]),
      hybrid: async () => ["x", "y"],
      turns: async () => [{ idx: 3, text: "never retry the 504 import with backoff", kind: "prose" }],
      turnTimes: async () =>
        new Map([
          ["sx:3", T0 + 5 * DAY],
          ["sy:3", T0 + DAY],
        ]),
    };
    const llm: JudgeLlm = {
      callJson: vi.fn(async () => ({ data: { verdicts: [] }, record: { cost_usd: 0 } })) as never,
    };
    const res = await propose(src, llm, { maxCalls: 5, conversationId: "c" });
    const first = (llm.callJson as ReturnType<typeof vi.fn>).mock.calls[0][0].userPrompt as string;
    // the newer (x) is judged against the older (y): OLDER line carries y's session day
    expect(first).toContain("OLDER");
    expect(res.pairsJudged).toBe(1);
    expect(candidateKinds("decision")).toEqual(["decision"]);
  });
});

describe("v2 judge: one retry with a shorter batch", () => {
  const item = (i: number): JudgeItem => ({
    pair: orientPair(r(`o${i}`, { sessionStart: T0 }), r(`n${i}`, { sessionStart: T0 + DAY }))!,
    cosine: 0.9,
    turns: [],
  });
  it("retries a failed batch as two halves; success on retry is answered and counted", async () => {
    let n = 0;
    const llm: JudgeLlm = {
      callJson: vi.fn(async () => {
        if (n++ === 0) throw new Error("timeout 120s");
        return { data: { verdicts: [] }, record: { cost_usd: 0 } };
      }) as never,
    };
    const res = await judgePairs(llm, [item(0), item(1), item(2), item(3)], { conversationId: "c", maxCalls: 10 });
    expect(llm.callJson).toHaveBeenCalledTimes(3);
    expect(res.calls).toBe(3);
    expect(res.retries).toBe(1);
    expect(res.failed).toBe(false);
    expect(res.judged.every((j) => j.answered)).toBe(true);
  });
  it("a half that fails again abstains, is not answered, and reports failed (no third attempt)", async () => {
    const llm: JudgeLlm = {
      callJson: vi.fn(async () => {
        throw new Error("timeout");
      }) as never,
    };
    const res = await judgePairs(llm, [item(0), item(1)], { conversationId: "c", maxCalls: 10 });
    expect(llm.callJson).toHaveBeenCalledTimes(3);
    expect(res.failed).toBe(true);
    expect(res.judged.every((j) => !j.answered)).toBe(true);
  });
  it("the retry respects the call cap", async () => {
    const llm: JudgeLlm = {
      callJson: vi.fn(async () => {
        throw new Error("timeout");
      }) as never,
    };
    const res = await judgePairs(llm, [item(0), item(1)], { conversationId: "c", maxCalls: 1 });
    expect(llm.callJson).toHaveBeenCalledTimes(1);
    expect(res.calls).toBe(1);
  });
});

describe("v2 dry-run memo: stores judged pairs, never projects", () => {
  it("writeDryRunMemo sends verified=false rows and an EMPTY projection list", async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }));
    await writeDryRunMemo(
      { rpc } as never,
      "u1",
      { runId: "r1", model: "claude-code/sonnet", promptVersion: "l1-v2" },
      [
        { from_id: "n", to_id: "o", relation: "supersedes", session_id: "s", link: { quote: "q", turn_idx: 4 } },
        { from_id: "n2", to_id: "o2", relation: "unrelated", session_id: "s", link: null },
      ],
    );
    const [name, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe("apply_memory_reconciliation");
    expect(args.p_projections).toEqual([]);
    expect((args.p_links as Array<{ verified: boolean }>).every((l) => l.verified === false)).toBe(true);
    expect(args.p_prompt_version).toBe("l1-v2");
  });
  it("propose hands onJudged only answered pairs, so unanswered ones are re-judged on resume", async () => {
    const mk = (id: string, sid: string) => ({
      ...r(id, { code_session_id: sid }),
      embedding: [1, 0],
      valid_to: null,
    });
    const rows = [mk("o", "so"), mk("n", "sn")];
    const src: ReconSource = {
      scope: async () => rows,
      sessionStarts: async () =>
        new Map([
          ["so", T0],
          ["sn", T0 + DAY],
        ]),
      hybrid: async () => ["o", "n"],
      turns: async () => [],
    };
    const seen: string[] = [];
    const ok: JudgeLlm = {
      callJson: vi.fn(async () => ({ data: { verdicts: [] }, record: { cost_usd: 0 } })) as never,
    };
    await propose(src, ok, {
      maxCalls: 5,
      conversationId: "c",
      onJudged: (b) => void b.forEach((x) => seen.push(`${x.from_id}>${x.to_id}:${x.relation}`)),
    });
    expect(seen).toEqual(["n>o:unrelated"]);
    const none: string[] = [];
    await propose(src, ok, {
      maxCalls: 0,
      conversationId: "c",
      onJudged: (b) => void b.forEach((x) => none.push(x.from_id)),
    });
    expect(none).toEqual([]);
  });
});
