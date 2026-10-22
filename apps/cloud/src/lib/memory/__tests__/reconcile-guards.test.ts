import { describe, expect, it, vi } from "vitest";
import {
  dumpProblem,
  kickerContainerFor,
  kickerProblem,
  providerProblem,
  sameStoreProblem,
  storeProblem,
} from "../reconcile/guards";
import { writePlan } from "../reconcile/io";
import { capLiveProjections, LIVE_MAX_HIDES, liveReconcileEnabled, reconcileInserted } from "../reconcile/live";
import { capCheckScoped } from "../reconcile/plan";
import { acceptVerdict, findQuoteTurn, orientPair, quoteNamesSubject, type ReconRecord } from "../reconcile/verdict";

describe("providerProblem", () => {
  it("refuses an unset provider (a paid API would answer), a paid one, and a non-sonnet model", () => {
    expect(providerProblem({}, false)).toMatch(/exactly claude-code/);
    expect(providerProblem({ MEMBRAL_LLM_PROVIDER: "openai" }, false)).toMatch(/exactly claude-code/);
    expect(providerProblem({ MEMBRAL_LLM_PROVIDER: "claude-code", MEMBRAL_MODEL: "opus" }, false)).toMatch(/sonnet/);
  });
  it("passes claude-code with sonnet or the sonnet default; --no-llm needs no provider; hosted always refuses", () => {
    expect(providerProblem({ MEMBRAL_LLM_PROVIDER: "claude-code" }, false)).toBeNull();
    expect(providerProblem({ MEMBRAL_LLM_PROVIDER: "claude-code", MEMBRAL_MODEL: "sonnet" }, false)).toBeNull();
    expect(providerProblem({}, true)).toBeNull();
    expect(providerProblem({ VERCEL: "1", MEMBRAL_LLM_PROVIDER: "claude-code" }, false)).toMatch(/hosted/);
  });
});

describe("apply guards", () => {
  it("the store must match the expected host:port and be loopback", () => {
    expect(storeProblem("127.0.0.1:54521", "127.0.0.1:54521")).toBeNull();
    expect(storeProblem("127.0.0.1:54521", "127.0.0.1:54421")).not.toBeNull();
    expect(storeProblem("db.example.com:443", "db.example.com:443")).toMatch(/loopback/);
    expect(storeProblem(null, "127.0.0.1:54521")).not.toBeNull();
  });
  it("kicker: the db container's compose project decides which kicker must be stopped", () => {
    expect(kickerContainerFor("membral-w4b-db-1")).toBe("membral-w4b-kicker-1");
    expect(kickerProblem(["membral-w4b-kicker-1"], "membral-w4b-db-1")).toMatch(/running/);
    expect(kickerProblem(["membral-kicker-1"], "membral-w4b-db-1")).toBeNull();
  });
  it("dump: fresh, ends RESET ALL;, contains the user", () => {
    const ok = { mtimeMs: 1_000_000, nowMs: 1_000_000 + 60_000, tail: "...\nRESET ALL;\n", containsUser: true };
    expect(dumpProblem(ok)).toBeNull();
    expect(dumpProblem({ ...ok, nowMs: ok.mtimeMs + 3 * 3_600_000 })).toMatch(/older/);
    expect(dumpProblem({ ...ok, tail: "cut off" })).toMatch(/RESET ALL/);
    // plain pg_dump 17.x ends with \\unrestrict <token>; a cut-off one does not
    expect(dumpProblem({ ...ok, tail: "...\n\\unrestrict AbC123xyz\n" })).toBeNull();
    expect(dumpProblem({ ...ok, tail: "...\n\\unrestrict AbC123xyz\nCOPY foo" })).toMatch(/unrestrict/);
    expect(dumpProblem({ ...ok, tail: "...\n\\restrict AbC123xyz\nCREATE TABLE a (" })).toMatch(/unrestrict/);
    expect(dumpProblem({ ...ok, containsUser: false })).toMatch(/another store/);
  });
  it("same store: API and psql live counts must agree", () => {
    expect(sameStoreProblem(10, 10)).toBeNull();
    expect(sameStoreProblem(10, 11)).not.toBeNull();
    expect(sameStoreProblem(null, 0)).not.toBeNull();
  });
  it("caps are per project: a small project cannot hide behind a big store", () => {
    const hides = (n: number, project: string) => Array.from({ length: n }, () => ({ project_id: project }));
    expect(capCheckScoped([...hides(3, "small")], { small: 20, big: 5000 }).ok).toBe(false);
    expect(capCheckScoped([...hides(3, "big")], { small: 20, big: 5000 }).ok).toBe(true);
    expect(capCheckScoped([...hides(5, "p")], { p: 1000 }, 20).ok).toBe(false);
  });
});

const T0 = Date.parse("2026-09-01T00:00:00Z");
const rec = (id: string, over: Partial<ReconRecord> = {}): ReconRecord => ({
  id,
  kind: "decision",
  text: "Retry the 504 import with backoff",
  ref: null,
  code_project_id: "p",
  code_session_id: `s-${id}`,
  user_id: "u",
  turn_idx: 1,
  created_at: "2026-09-01T00:00:00Z",
  sessionStart: T0,
  ...over,
});

describe("verdict hardening", () => {
  const pair = orientPair(rec("o"), rec("n", { sessionStart: T0 + 86_400_000, text: "Do not retry the 504 import" }))!;
  it("duplicates needs lost_information to be exactly an empty string", () => {
    const dupPair = orientPair(
      rec("a", { text: "alpha beta gamma delta epsilon" }),
      rec("b", { sessionStart: T0 + 86_400_000, text: "alpha beta gamma delta epsilon" }),
    )!;
    const go = (lost: string | null | undefined) =>
      acceptVerdict({ relation: "duplicates", lost_information: lost }, { pair: dupPair, turns: [], cosine: 0.95 })
        .relation;
    expect(go("")).toBe("duplicates");
    expect(go("  ")).toBe("duplicates");
    expect(go(null)).toBe("unrelated");
    expect(go(undefined)).toBe("unrelated");
    expect(go("the second half")).toBe("unrelated");
  });
  it("a quote found only in a tool result (recall output reprinting the old record) is not evidence", () => {
    const quote = "Retry the 504 import with backoff";
    expect(findQuoteTurn(quote, [{ idx: 2, text: quote, kind: "tool_result" }])).toBeNull();
    expect(findQuoteTurn(quote, [{ idx: 2, text: quote, kind: "prose" }])).toBe(2);
    expect(
      acceptVerdict(
        { relation: "supersedes", evidence_quote: quote },
        { pair, turns: [{ idx: 2, text: quote, kind: "tool_result" }] },
      ).relation,
    ).toBe("unrelated");
  });
  it("naming the subject needs two shared content tokens, not one", () => {
    expect(quoteNamesSubject("the import finished cleanly today", "Retry the 504 import with backoff")).toBe(false);
    expect(quoteNamesSubject("do not retry the 504 import", "Retry the 504 import with backoff")).toBe(true);
  });
});

describe("live reconcile flag", () => {
  const env = {
    MEMBRAL_RECONCILE: "1",
    MEMBRAL_LOCAL: "1",
    MEMBRAL_LLM_PROVIDER: "claude-code",
    MEMBRAL_MODEL: "sonnet",
  };
  it("is off unless exactly 1 on a local claude-code setup", () => {
    expect(liveReconcileEnabled({})).toBe(false);
    expect(liveReconcileEnabled({ ...env, MEMBRAL_RECONCILE: "true" })).toBe(false);
    expect(liveReconcileEnabled({ ...env, VERCEL: "1" })).toBe(false);
    expect(liveReconcileEnabled({ ...env, MEMBRAL_LLM_PROVIDER: "openai" })).toBe(false);
    expect(liveReconcileEnabled({ ...env, MEMBRAL_LOCAL: "0" })).toBe(false);
    expect(liveReconcileEnabled(env)).toBe(true);
  });
  it("flag off: no read and no model call, returns 0", async () => {
    const from = vi.fn();
    const llm = { callJson: vi.fn() };
    expect(await reconcileInserted({ from } as never, "u", "p", ["a"], llm as never, { env: {} })).toBe(0);
    expect(from).not.toHaveBeenCalled();
    expect(llm.callJson).not.toHaveBeenCalled();
  });
  it("flag on: a failing read never throws", async () => {
    const from = vi.fn(() => {
      throw new Error("db down");
    });
    expect(await reconcileInserted({ from } as never, "u", "p", ["a"], { callJson: vi.fn() } as never, { env })).toBe(
      0,
    );
  });
  it("flag on: a stalled pass is abandoned at the timeout", async () => {
    const from = vi.fn(() => new Promise(() => {}));
    const t = await reconcileInserted({ from } as never, "u", "p", ["a"], { callJson: vi.fn() } as never, {
      env,
      timeoutMs: 20,
    });
    expect(t).toBe(0);
  });
  it("needs MEMBRAL_MODEL explicitly sonnet (an unset model runs the CLI default)", () => {
    const { MEMBRAL_MODEL: _m, ...unset } = env;
    expect(liveReconcileEnabled(unset)).toBe(false);
    expect(liveReconcileEnabled({ ...env, MEMBRAL_MODEL: "opus" })).toBe(false);
  });
  it("refuses a client that is not on claude-code/sonnet", async () => {
    const from = vi.fn();
    const llm = { modelName: "claude-code/default", callJson: vi.fn() };
    expect(await reconcileInserted({ from } as never, "u", "p", ["a"], llm as never, { env })).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });
  it("a timed-out pass writes nothing, even when its work finishes later", async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }));
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    // The scope read stalls past the timeout, then fails; nothing may reach the writer.
    const from = vi.fn(() => gate);
    expect(
      await reconcileInserted({ from, rpc } as never, "u", "p", ["a"], { callJson: vi.fn() } as never, {
        env,
        timeoutMs: 10,
      }),
    ).toBe(0);
    release({ data: [], error: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(rpc).not.toHaveBeenCalled();
  });
  it("caps what one insert may hide", () => {
    expect(capLiveProjections(Array.from({ length: 9 }, (_, i) => i))).toHaveLength(LIVE_MAX_HIDES);
  });
});

describe("writePlan is one atomic call", () => {
  const link = {
    from_id: "n",
    to_id: "o",
    relation: "supersedes" as const,
    quote: "q",
    verified: true,
    session_id: "s",
    turn_idx: 1,
    from_started_at: "2026-09-10T00:00:00Z",
    project_id: "p",
  };
  const proj = {
    id: "o",
    project_id: "p",
    superseded_by: "n",
    supersede_kind: "supersedes" as const,
    valid_to: "2026-09-10T00:00:00Z",
  };
  it("sends links, abstentions and projections in a single rpc", async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const n = await writePlan(
      { rpc } as never,
      "u",
      { runId: "r", model: "m", promptVersion: "v" },
      [link],
      [{ from_id: "n", to_id: "x", session_id: "s" }],
      [proj],
    );
    expect(n).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    const args = (rpc.mock.calls[0] as unknown[])[1] as { p_links: unknown[]; p_projections: unknown[] };
    expect(args.p_links).toHaveLength(2);
    expect(args.p_projections).toHaveLength(1);
  });
  it("a failed rpc throws and nothing else is attempted (no link without its projection)", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    const from = vi.fn();
    await expect(
      writePlan({ rpc, from } as never, "u", { runId: "r", model: "m", promptVersion: "v" }, [link], [], [proj]),
    ).rejects.toThrow(/apply failed/);
    expect(from).not.toHaveBeenCalled();
  });
  it("shouldStop before the call writes nothing", async () => {
    const rpc = vi.fn();
    expect(
      await writePlan(
        { rpc } as never,
        "u",
        { runId: "r", model: "m", promptVersion: "v" },
        [link],
        [],
        [proj],
        () => true,
      ),
    ).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
});
