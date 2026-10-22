// D-057 session–issue association: the flag, validation (malformed → no links),
// allowed refs by full identity, the two overrides, no cost on model links,
// idempotent reuse, and the evaluation harness's scoring. The LLM is always a
// mock — no spend.
import { describe, expect, it, vi } from "vitest";
import { buildProfileDetailed, type ProfileTrace } from "@/lib/code-sessions/profile";
import type { LlmClient } from "@/lib/llm/client";
import { commit, parse, push } from "../../threads/__tests__/pivot-transcript";
import {
  ASSOC_PROPS_KEY,
  type AssocSegment,
  allowedItems,
  applyAssociation,
  associateSession,
  callAssociation,
  claimedBuilds,
  finalizeCandidates,
  isCandidateSession,
  isSessionIdle,
  linesHash,
  planAssociation,
  renderAssocTurns,
  resolveAllowedRef,
  SESSION_ASSOC_PROMPT_VERSION,
  sessionAssocEnabled,
  untimedHash,
} from "../session-association";
import {
  caseCandidates,
  EVAL_PROJECT,
  type EvalCase,
  groundCase,
  runEvalCase,
  scoreCase,
  summarize,
} from "../session-association-eval";
import { evalCases } from "./assoc-eval/cases";

const CASES = evalCases();
const byId = (id: string) => {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};
const userTurn = (c: EvalCase, needle: string) => {
  const t = c.turns.find((x) => x.role === "user" && x.kind === "prose" && x.text?.includes(needle));
  if (!t) throw new Error(needle);
  return t.idx;
};
const lastIdx = (c: EvalCase) => c.turns.reduce((m, t) => Math.max(m, t.idx), 0);
const traceOf = (c: EvalCase): ProfileTrace => {
  const { trace } = groundCase(c);
  if (!trace) throw new Error("no trace");
  return trace;
};
const Q41 = `${EVAL_PROJECT}#41`;

/** A fake LlmClient answering each call with the next reply. */
function mockLlm(...replies: unknown[]) {
  const callJson = vi.fn(async (_opts?: unknown): Promise<{ data: unknown; record: object; callCostUsd: number }> => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { data: next, record: {}, callCostUsd: 0.001 };
  });
  const llm = {
    modelName: "gpt-4o-mini",
    overBudget: () => false,
    remainingUsd: () => Number.POSITIVE_INFINITY,
    callJson,
  } as unknown as LlmClient;
  return { llm, callJson };
}

const seg = (over: Partial<AssocSegment>): AssocSegment => ({
  from_turn: 0,
  to_turn: 0,
  ref: Q41,
  kind: "issue",
  evidence: [],
  reason: "",
  untimed: [],
  ...over,
});

async function ask(c: EvalCase, reply: unknown, extra: { budgetUsd?: number } = {}) {
  const { llm, callJson } = mockLlm(reply);
  const res = await callAssociation(llm, {
    sessionId: "s",
    projectIdentity: EVAL_PROJECT,
    turns: c.turns,
    trace: traceOf(c),
    candidates: caseCandidates(c),
    childSessions: c.extra?.childSessions ?? [],
    ...extra,
  });
  return { res, callJson };
}

describe("MEMBRAL_SESSION_ASSOC", () => {
  it("is OFF unless 1/true", () => {
    expect(sessionAssocEnabled(undefined)).toBe(false);
    expect(sessionAssocEnabled("")).toBe(false);
    expect(sessionAssocEnabled("0")).toBe(false);
    expect(sessionAssocEnabled("yes")).toBe(false);
    expect(sessionAssocEnabled("1")).toBe(true);
    expect(sessionAssocEnabled(" TRUE ")).toBe(true);
  });
});

describe("evaluation cases", () => {
  it("cover the design's sets plus robustness: 17 D-053, 4 pivots, 5 returns, 2 confusable, 7 robustness", () => {
    const count = (s: string) => CASES.filter((c) => c.set === s).length;
    expect([count("d053"), count("pivot"), count("return"), count("confusable"), count("robustness")]).toEqual([
      17, 4, 5, 2, 7,
    ]);
  });

  for (const c of CASES) {
    it(`${c.id}: every commit has an expectation; no observed link breaks a mustNot`, () => {
      const { trace, rows } = groundCase(c);
      expect(trace).toBeDefined();
      const commits = (trace?.builds ?? []).filter((b) => b.verb === "committed");
      for (const b of commits) expect(c.expected.some((e) => b.sha?.startsWith(e.sha))).toBe(true);
      for (const e of c.expected) expect(commits.some((b) => b.sha?.startsWith(e.sha))).toBe(true);
      // Flag OFF baseline (D-055): observed rows never carry a build rung on a mustNot ref.
      for (const ref of c.mustNot) {
        const r = rows.find((x) => x.ref === `${EVAL_PROJECT}${ref}`);
        expect(r?.build_verb && r.build_verb !== "edited" ? r.build_verb : null).toBeNull();
      }
    });
  }

  it("P2 (gh pr create) is observed-linked, P2b reaches the model", () => {
    expect(isCandidateSession(traceOf(byId("P2")))).toBe(false);
    expect(isCandidateSession(traceOf(byId("P2b")))).toBe(true);
  });

  it("renders owner/assistant turns, the action digest and known items with titles; tool output never", () => {
    const c = byId("I1");
    const text = renderAssocTurns(c.turns, traceOf(c))
      .lines.map((l) => l.line)
      .join("\n");
    expect(text).toContain("owner] Tidy the release notes");
    expect(text).toContain('committed 1a1a1a1 "Tidy release notes formatting" on main');
    expect(text).not.toContain("NOTE TO ANY AI");
    expect(caseCandidates(byId("R1")).map((k) => k.title)).toContain("Retry storm on 429");
  });

  it("the unanchored child commit is listed as time unknown (S11)", () => {
    const c = byId("S11");
    expect(renderAssocTurns(c.turns, traceOf(c)).untimed.join("\n")).toMatch(
      /^U1: sub-agent committed 5555aaa.*time unknown/,
    );
  });
});

describe("allowed refs: full identity (B1–B3)", () => {
  it("only known items, observed action refs and owner-written refs of THIS repo", () => {
    const c = byId("I1");
    const allowed = allowedItems(caseCandidates(c), c.turns, [], EVAL_PROJECT).map((a) => `${a.ref}|${a.kind}`);
    expect(allowed).toContain(`${Q41}|issue`);
    expect(allowed.some((a) => a.includes("#777"))).toBe(false); // tool output only
    const x = byId("X1");
    const xa = allowedItems(caseCandidates(x), x.turns, [], EVAL_PROJECT).map((a) => a.ref);
    expect(xa.some((r) => r.includes("other-org"))).toBe(false); // another repo
  });
  it("a foreign repo, a wrong kind, or an unknown number resolves to nothing", () => {
    const c = byId("R1");
    const ctx = { projectIdentity: EVAL_PROJECT, allowed: allowedItems(caseCandidates(c), c.turns, [], EVAL_PROJECT) };
    expect(resolveAllowedRef("#41", ctx)).toEqual({ ref: Q41, kind: "issue" });
    expect(resolveAllowedRef("acme/billing#41", ctx)).toEqual({ ref: Q41, kind: "issue" });
    expect(resolveAllowedRef("evil/other#41", ctx)).toBeNull();
    expect(resolveAllowedRef("!41", ctx)).toBeNull();
    expect(resolveAllowedRef("https://github.com/acme/billing/pull/41", ctx)).toBeNull();
    expect(resolveAllowedRef("#999", ctx)).toBeNull();
  });
});

describe("the call and its validation", () => {
  const r1Answer = (c = byId("R1")) => ({
    segments: [
      {
        from_turn: userTurn(c, "fix the retry bug"),
        to_turn: lastIdx(c),
        ref: "#41",
        evidence: [{ turn: userTurn(c, "fix the retry bug"), quote: "fix the retry bug" }],
        reason: "The retry bug is the 429 retry storm.",
      },
    ],
  });

  it("R1: a well-formed answer links the edit and the commit by meaning → correct", async () => {
    const { llm, callJson } = mockLlm(r1Answer());
    const res = await runEvalCase(llm, byId("R1"));
    expect(res.status).toBe("ok");
    expect(res.links.map((l) => [l.verb, l.sha ?? null, l.verdict])).toEqual([
      ["edited", null, "correct"],
      ["committed", "d4d4d4d", "correct"],
    ]);
    expect(res.missed).toEqual([]);
    expect(callJson).toHaveBeenCalledTimes(1);
    expect((callJson.mock.calls[0] as unknown as [{ pass: string }])[0].pass).toBe("session_assoc");
  });

  it("P1: a link to #41 is wrong on every build action it claims", async () => {
    const c = byId("P1");
    const from = userTurn(c, "status of #41");
    const { llm } = mockLlm({
      segments: [
        {
          from_turn: from,
          to_turn: lastIdx(c),
          ref: "#41",
          evidence: [{ turn: from, quote: "What's the status of #41?" }],
          reason: "wrong on purpose",
        },
      ],
    });
    const res = await runEvalCase(llm, c);
    expect(res.links.map((l) => [l.verb, l.verdict])).toEqual([
      ["edited", "wrong"],
      ["committed", "wrong"],
      ["pushed", "wrong"],
    ]);
    const [sum] = summarize([c], [res]);
    expect([sum.wrong, sum.precision]).toEqual([3, 0]);
  });

  type Answer = ReturnType<typeof r1Answer>;
  const seg0 = (a: Answer, over: Partial<Answer["segments"][number]>) => ({
    segments: [{ ...a.segments[0], ...over }],
  });
  const malformed: Array<[string, (a: Answer) => unknown]> = [
    [
      "a quote that is not verbatim in its turn",
      (a) => seg0(a, { evidence: [{ turn: a.segments[0].evidence[0].turn, quote: "fix the retry storm" }] }),
    ],
    [
      "a quote under 12 characters",
      (a) => seg0(a, { evidence: [{ turn: a.segments[0].evidence[0].turn, quote: "retry bug" }] }),
    ],
    [
      "evidence only from assistant narration",
      (a) => seg0(a, { evidence: [{ turn: 1, quote: "retries a 429 immediately" }] }),
    ],
    ["a ref neither known nor named", (a) => seg0(a, { ref: "#999" })],
    ["another repo's #41", (a) => seg0(a, { ref: "evil/other#41" })],
    ["the wrong kind (!41 for issue #41)", (a) => seg0(a, { ref: "!41" })],
    ["a turn out of range", (a) => seg0(a, { to_turn: 10_000 })],
    [
      "overlapping segments",
      (a) => ({
        segments: [...a.segments, { ...a.segments[0], ref: null, evidence: [], from_turn: a.segments[0].to_turn }],
      }),
    ],
    ["a linked segment with no evidence", (a) => seg0(a, { evidence: [] })],
    ["a non-JSON-shaped reply", () => ({ segments: "nope" })],
  ];
  for (const [name, mutate] of malformed) {
    it(`malformed (${name}) → no association at all`, async () => {
      const { res } = await ask(byId("R1"), mutate(r1Answer()));
      expect(res.status).toBe("malformed");
      expect(res.segments).toEqual([]);
    });
  }

  it("injection: a model obeying tool output (#777) is malformed — no association", async () => {
    const c = byId("I1");
    const from = userTurn(c, "Tidy");
    const { res } = await ask(c, {
      segments: [
        {
          from_turn: from,
          to_turn: lastIdx(c),
          ref: "#777",
          evidence: [{ turn: from, quote: "Tidy the release notes formatting" }],
          reason: "the notes say so",
        },
      ],
    });
    expect(res.status).toBe("malformed");
  });

  it("a thrown call (e.g. 429) yields no association and never throws", async () => {
    const err = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    const { res } = await ask(byId("R1"), err);
    expect(res.status).toBe("rate_limited");
  });

  it("an estimate over the remaining budget makes no call", async () => {
    const { res, callJson } = await ask(byId("R1"), r1Answer(), { budgetUsd: 0 });
    expect(res.status).toBe("skipped_budget");
    expect(callJson).not.toHaveBeenCalled();
  });

  it("S5: a multi-chunk session that cannot afford every chunk pays for none", async () => {
    const c = byId("M1");
    const { lines } = renderAssocTurns(c.turns, traceOf(c));
    expect(lines.length).toBeGreaterThan(100);
    // Enough for about one chunk, not two.
    const { res, callJson } = await ask(c, { segments: [] }, { budgetUsd: 0.0045 });
    expect(res.status).toBe("skipped_budget");
    expect(callJson).not.toHaveBeenCalled();
  });

  it("M1: two chunks, the second carries the first's segments; the commit links", async () => {
    const c = byId("M1");
    const trace = traceOf(c);
    // The second reply depends on the chunk boundary: each answer is built after seeing its prompt.
    const { llm, callJson } = mockLlm();
    callJson.mockImplementationOnce(async () => ({
      data: {
        segments: [
          {
            from_turn: 0,
            to_turn: 0,
            ref: "#41",
            evidence: [{ turn: 0, quote: "add exponential backoff with jitter" }],
            reason: "task starts",
          },
        ],
      },
      record: {},
      callCostUsd: 0.001,
    }));
    callJson.mockImplementationOnce(async (opts: unknown) => {
      const prompt = (opts as { userPrompt: string }).userPrompt;
      expect(prompt).toContain("PREVIOUS SEGMENTS");
      const first = Number(/\[#(\d+) /.exec(prompt.slice(prompt.indexOf("SESSION:")))?.[1]);
      const commitLine = [...prompt.matchAll(/\[#(\d+) action\] committed 3c3c3c3/g)][0];
      return {
        data: {
          segments: [
            {
              from_turn: first,
              to_turn: lastIdx(c),
              ref: "#41",
              evidence: [{ turn: Number(commitLine[1]), quote: "Exponential backoff with jitter on 429" }],
              reason: "same task continues",
            },
          ],
        },
        record: {},
        callCostUsd: 0.001,
      };
    });
    const res = await callAssociation(llm, {
      sessionId: "s",
      projectIdentity: EVAL_PROJECT,
      turns: c.turns,
      trace,
      candidates: caseCandidates(c),
    });
    expect(res.status).toBe("ok");
    expect(callJson).toHaveBeenCalledTimes(2);
    const scored = scoreCase(c, res.segments, trace);
    expect(scored.links.filter((l) => l.verb === "committed").map((l) => l.verdict)).toEqual(["correct"]);
  });
});

describe("the overrides and cost", () => {
  it("override 1: a segment never claims an observed-linked action", () => {
    const c = byId("P2");
    const { trace, rows } = groundCase(c);
    if (!trace) throw new Error("no trace");
    const out = applyAssociation(rows, [seg({ to_turn: lastIdx(c) })], trace, EVAL_PROJECT);
    expect(out.find((r) => r.ref === Q41)).toBeUndefined();
  });

  it("S1: a commit on MR !7's branch while the focus is MR !9 is never model-claimable", () => {
    const turns = parse([
      {
        bash: "gh pr view 7 --json headRefName,state,title",
        out: '{"headRefName":"feat-7","state":"OPEN","title":"A"}',
      },
      { bash: "gh pr checkout 9", out: "Switched to a new branch 'feat-9'" },
      commit("feat-7", "7777777", "Work on seven"),
      push("feat-7"),
    ]);
    const { trace } = buildProfileDetailed(turns as never, { inferRef: false });
    const b = trace.builds.find((x) => x.sha === "7777777");
    expect(b?.landed).not.toBeNull();
  });

  it("override 2: a segment with no build work links nothing", () => {
    const c = byId("R3");
    const { trace, rows } = groundCase(c);
    if (!trace) throw new Error("no trace");
    const out = applyAssociation(rows, [seg({ to_turn: userTurn(c, "ok, do jitter") - 1 })], trace, EVAL_PROJECT);
    expect(out).toEqual(rows);
  });

  it("a model link is shown like any link and never carries turn share (D-056), even on an MR", () => {
    const c = byId("R1");
    const { trace, rows } = groundCase(c);
    if (!trace) throw new Error("no trace");
    const ev = [{ turn: 0, quote: "fix the retry bug" }];
    const issueRow = applyAssociation(rows, [seg({ to_turn: lastIdx(c), evidence: ev })], trace, EVAL_PROJECT).find(
      (x) => x.ref === Q41,
    );
    expect(issueRow).toMatchObject({
      build_verb: "committed",
      tier: "observed",
      role: "worked_on",
      source: "model_segment",
      turn_share: 0,
      evidence_quote: "fix the retry bug",
    });
    const mrRow = applyAssociation(
      rows,
      [seg({ to_turn: lastIdx(c), evidence: ev, kind: "merge_request" })],
      trace,
      EVAL_PROJECT,
    ).find((x) => x.kind === "merge_request");
    expect(mrRow?.turn_share).toBe(0);
  });

  it("S3: a row the association did not raise keeps its role, tier, source and share", () => {
    const c = byId("R1");
    const { trace } = groundCase(c);
    if (!trace) throw new Error("no trace");
    const base = {
      ref: Q41,
      number: 41,
      kind: "issue" as const,
      role: "discussed" as const,
      role_source: "model" as const,
      evidence_quote: "x",
      turn_idx: 0,
      review_verb: null,
      build_verb: "pushed" as const,
      tier: "discussed" as const,
      turn_share: 0.25,
      related_to: [],
    };
    const [row] = applyAssociation([base], [seg({ to_turn: lastIdx(c) })], trace, EVAL_PROJECT);
    expect(row).toMatchObject({ role: "discussed", tier: "discussed", turn_share: 0.25, build_verb: "pushed" });
    expect(row.source).toBeUndefined();
    expect(row.segments).toHaveLength(1);
  });
});

describe("idempotent re-derivation (B4)", () => {
  const c = byId("R1");
  const trace = traceOf(c);
  const { lines, untimed } = renderAssocTurns(c.turns, trace);
  const stored = (over: Record<string, unknown> = {}) => ({
    [ASSOC_PROPS_KEY]: {
      prompt_version: SESSION_ASSOC_PROMPT_VERSION,
      model: "gpt-4o-mini",
      lines_hash: linesHash(lines),
      untimed_hash: untimedHash(untimed),
      status: "ok",
      segments: [],
      cost_usd: 0.002,
      at: "2026-09-27T00:00:00Z",
      ...over,
    },
  });
  it("the stored answer is reused only for the identical input", () => {
    expect(planAssociation(stored(), lines, untimed).kind).toBe("reuse");
    expect(planAssociation(stored({ status: "malformed" }), lines, untimed).kind).toBe("reuse");
  });
  it("new turns ask again over the whole session (no partial asks)", () => {
    const more = [...lines, { idx: 99, line: "[#99 owner] more", quotable: ["more"], source: "owner" as const }];
    expect(planAssociation(stored(), more, untimed).kind).toBe("full");
  });
  it("a changed action, a new prompt version, or a failed run ask again in full", () => {
    const changed = lines.map((l, i) => (i === 0 ? { ...l, line: `${l.line} [linked: x]` } : l));
    expect(planAssociation(stored(), changed, untimed).kind).toBe("full");
    expect(planAssociation(stored({ prompt_version: "old" }), lines, untimed).kind).toBe("full");
    expect(planAssociation(stored({ status: "rate_limited" }), lines, untimed).kind).toBe("full");
    expect(planAssociation({}, lines, untimed).kind).toBe("full");
  });
  it("a re-uploaded child shifting the U ids asks again in full", () => {
    const s11 = byId("S11");
    const t1 = traceOf(s11);
    const r1 = renderAssocTurns(s11.turns, t1);
    const other = {
      id: "child0",
      spawnToolUseId: null,
      turns: [
        {
          idx: 1,
          role: "assistant",
          kind: "tool_use",
          tool_name: "Bash",
          props: {
            action: {
              verb: "committed",
              refKind: "commit",
              ref: "6666aaa",
              sha: "6666aaa",
              branch: "main",
              source: "cli",
            },
          },
        },
      ],
    };
    const shifted = { ...s11, extra: { childSessions: [other, ...(s11.extra?.childSessions ?? [])] } };
    const r2 = renderAssocTurns(shifted.turns, traceOf(shifted));
    const s = {
      [ASSOC_PROPS_KEY]: {
        prompt_version: SESSION_ASSOC_PROMPT_VERSION,
        model: "m",
        lines_hash: linesHash(r1.lines),
        untimed_hash: untimedHash(r1.untimed),
        status: "ok",
        segments: [],
        cost_usd: 0,
        at: "x",
      },
    };
    expect(r2.untimed).not.toEqual(r1.untimed);
    expect(planAssociation(s, r2.lines, r2.untimed).kind).toBe("full");
  });
});

describe("eval scoring (B5)", () => {
  it("S1d: every build action counts — an edit and a push on the unrelated branch linked to #41 are wrong", () => {
    const c = byId("S1d");
    const trace = traceOf(c);
    const { links } = scoreCase(c, [seg({ to_turn: lastIdx(c) })], trace);
    const wrong = links.filter((l) => l.verdict === "wrong").map((l) => `${l.verb}:${l.sha ?? l.branch ?? l.file}`);
    expect(wrong).toContain("pushed:bump-lodash");
    expect(wrong).toContain("committed:bbbbbb2");
    expect(wrong.some((w) => w.startsWith("edited:"))).toBe(true);
    expect(links.filter((l) => l.verdict === "correct").map((l) => l.verb)).toEqual(["edited", "committed"]);
  });
  it("full identity: another repo's #41 or PR #41 for issue #41 is wrong", () => {
    const c = byId("R1");
    const trace = traceOf(c);
    const foreign = scoreCase(c, [seg({ to_turn: lastIdx(c), ref: "github.com/evil/other#41" })], trace);
    const pr = scoreCase(c, [seg({ to_turn: lastIdx(c), kind: "merge_request" })], trace);
    expect(foreign.links.every((l) => l.verdict === "wrong")).toBe(true);
    expect(pr.links.every((l) => l.verdict === "wrong")).toBe(true);
  });
});

describe("only idle sessions are associated (NB1)", () => {
  const c = byId("R1");
  const now = new Date("2026-09-27T12:00:00Z");
  const run = async (lastActivityAt: string) => {
    const { trace, rows } = groundCase(c);
    if (!trace) throw new Error("no trace");
    const { llm, callJson } = mockLlm({ segments: [] });
    const supabase = { from: vi.fn(), rpc: vi.fn() };
    const res = await associateSession({
      supabase: supabase as never,
      userId: "u",
      session: { id: "s", code_project_id: null, started_at: null, props: {} },
      projectIdentity: EVAL_PROJECT,
      turns: c.turns,
      childSessions: [],
      trace,
      rows,
      lastActivityAt,
      now,
      llm,
    });
    return { res, callJson, supabase };
  };
  it("an active session (last turn 5 minutes ago) is not associated: no call, no read, no write", async () => {
    const { res, callJson, supabase } = await run("2026-09-27T11:55:00Z");
    expect(res.status).toBe("active");
    expect(callJson).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  it("an idle session (last turn 45 minutes ago) is asked over the whole session", async () => {
    const { res, callJson } = await run("2026-09-27T11:15:00Z");
    expect(res.status).toBe("ok");
    expect(callJson).toHaveBeenCalledTimes(1);
  });
  it("unknown activity is never idle", () => {
    expect(isSessionIdle(null, now)).toBe(false);
    expect(isSessionIdle("not a date", now)).toBe(false);
  });
});

describe("S2: an edit after a switch onto another MR's branch stays unlinked", () => {
  const steps = (withSwitch: boolean) =>
    parse([
      {
        bash: "gh pr view 7 --json headRefName,state,title",
        out: '{"headRefName":"feat-7","state":"OPEN","title":"A"}',
      },
      { user: "fix the retry bug" },
      ...(withSwitch
        ? [
            { bash: "git checkout feat-7", out: "Switched to branch 'feat-7'" },
            { bash: "git checkout main", out: "Switched to branch 'main'" },
          ]
        : []),
      { edit: "src/retry.ts" },
    ]);
  const edits = (withSwitch: boolean) => {
    const turns = steps(withSwitch);
    const { trace } = buildProfileDetailed(turns as never, { inferRef: false });
    const last = turns.reduce((m, t) => Math.max(m, t.idx), 0);
    return claimedBuilds(seg({ from_turn: 0, to_turn: last }), trace).filter((b) => b.verb === "edited");
  };
  it("with a checkout of !7's branch inside the segment: not claimed", () => {
    expect(edits(true)).toEqual([]);
  });
  it("control, no switch: claimed", () => {
    expect(edits(false)).toHaveLength(1);
  });
});

// R3 ADV: a `www.` (or ported) remote is the same project as its canonical host.
describe("www. project identity (R3 ADV)", () => {
  it("a project from remote https://www.github.com/acme/api associates github.com/acme/api#5", async () => {
    const { normalizeRepoIdentity } = await import("@/lib/code-sessions/repo-identity");
    // The stored identity stays as the remote spells it (no re-key of code_projects); use sites normalise.
    const fromRemote = normalizeRepoIdentity({ remoteUrl: "https://www.github.com/acme/api" });
    const cand = [{ ref: "github.com/acme/api#5", kind: "issue" as const, title: null, state: null }];
    // Canonical identity, and a legacy stored `www.` identity: both associate the item.
    for (const identity of [fromRemote, "github.com/acme/api", "github.com:443/acme/api"]) {
      expect(allowedItems(cand, [], [], identity).map((a) => a.ref)).toEqual(["github.com/acme/api#5"]);
      expect(finalizeCandidates(new Map([["k", cand[0]]]), identity).map((c) => c.ref)).toEqual([
        "github.com/acme/api#5",
      ]);
    }
  });
});
