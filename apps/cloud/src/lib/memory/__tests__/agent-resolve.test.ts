// memory_resolve (#436): resolve, deferred verification and Undo over the
// memory tests' fake Supabase double.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOLVE_NOT_FOUND, resolveBlockerByAgent, verifyAgentResolutions } from "../agent-resolve";
import { listDismissedBlockers, undoBlockerDismissal } from "../blocker-dismiss";
import { mintRecallToken } from "../recall-token";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const ID = {
  root: "11111111-1111-4111-8111-000000000001",
  again: "11111111-1111-4111-8111-000000000002",
  others: "11111111-1111-4111-8111-000000000003",
  retired: "11111111-1111-4111-8111-000000000004",
  decision: "11111111-1111-4111-8111-000000000005",
};
const TEXT = "The staging deploy fails on the missing secret";
const QUOTE = "the staging deploy works now that the secret is set in the vault";
const NOW = new Date("2026-10-04T10:00:00Z");

function memory(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    user_id: USER,
    code_project_id: "p1",
    code_session_id: "s-old",
    kind: "blocker",
    text: TEXT,
    quote: null,
    turn_role: "assistant",
    recurs_of: null,
    retired_at: null,
    retire_reason: null,
    resolution_quote: null,
    resolution_turn_idx: null,
    resolved_by_session_id: null,
    resolved_by_harness_session_id: null,
    created_at: "2026-10-02T00:00:00Z",
    ...over,
  };
}

function tables(turnText: string): Record<string, Row[]> {
  return {
    session_memories: [
      memory(ID.root),
      memory(ID.again, { recurs_of: ID.root, created_at: "2026-10-03T00:00:00Z" }),
      memory(ID.others, { user_id: OTHER }),
      memory(ID.retired, { retired_at: "2026-10-01T00:00:00Z", retire_reason: "user_resolved" }),
      memory(ID.decision, { kind: "decision" }),
    ],
    memory_recall_events: [],
    code_sessions: [{ id: "s-res", user_id: USER, source_session_id: "h-1" }],
    code_session_turns: [
      { session_id: "s-res", user_id: USER, idx: 0, text: "let me look at the deploy", ts: "2026-10-04T09:58:00Z" },
      { session_id: "s-res", user_id: USER, idx: 1, text: turnText, ts: "2026-10-04T09:59:30Z" },
    ],
  };
}

describe("memory_resolve (#436)", () => {
  let token: string;
  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    token = mintRecallToken(USER, "p1");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function resolved(turnText = `Done: ${QUOTE}.`) {
    const t = tables(turnText);
    t.memory_recall_events.push({ user_id: USER, surface: "preamble", recall_token: token, harness_session_id: "h-1" });
    const supabase = makeFakeSupabase(t);
    const out = await resolveBlockerByAgent(supabase, USER, null, { id: ID.again, quote: QUOTE, recall_token: token });
    const read = async (id: string) =>
      (await supabase.from("session_memories").select("*").eq("id", id).maybeSingle()).data as Row;
    return { supabase, out, read };
  }

  it("retires the caller's own live blocker and its recurrence chain, with the quote and the harness session", async () => {
    const { out, read } = await resolved();
    expect(out).toEqual({ resolved: true, ids: expect.arrayContaining([ID.root, ID.again]), will_verify: true });
    expect(out.ids).toHaveLength(2);
    for (const id of [ID.root, ID.again]) {
      const r = await read(id);
      expect(r.retire_reason).toBe("agent_resolved");
      expect(r.resolution_quote).toBe(QUOTE);
      expect(r.resolved_by_harness_session_id).toBe("h-1");
      expect(r.resolved_by_session_id).toBeNull();
      expect(r.retired_at).toBe(NOW.toISOString());
    }
  });

  it("gives one generic error for another user's id, a retired blocker and a non-blocker", async () => {
    for (const id of [ID.others, ID.retired, ID.decision, "11111111-1111-4111-8111-0000000000ff"]) {
      const supabase = makeFakeSupabase(tables(""));
      await expect(resolveBlockerByAgent(supabase, USER, null, { id, quote: QUOTE })).rejects.toThrow(
        RESOLVE_NOT_FOUND,
      );
    }
    const supabase = makeFakeSupabase(tables(""));
    await resolveBlockerByAgent(supabase, OTHER, null, { id: ID.others, quote: QUOTE });
    const { data } = await supabase.from("session_memories").select("*").eq("id", ID.root).maybeSingle();
    expect((data as Row).retired_at).toBeNull();
  });

  it("rejects a malformed id or an over-long quote", async () => {
    const supabase = makeFakeSupabase(tables(""));
    await expect(resolveBlockerByAgent(supabase, USER, null, { id: "nope", quote: QUOTE })).rejects.toThrow(/uuid/);
    await expect(resolveBlockerByAgent(supabase, USER, null, { id: ID.root, quote: "x".repeat(501) })).rejects.toThrow(
      /quote/,
    );
  });

  it("without a known session the row stays retired and will_verify is false", async () => {
    const supabase = makeFakeSupabase(tables(""));
    const out = await resolveBlockerByAgent(supabase, USER, null, { id: ID.root, quote: QUOTE });
    expect(out.will_verify).toBe(false);
  });

  it("deferred verification: the quote found in the session's turns fills the receipt", async () => {
    const { supabase, read } = await resolved();
    const v = await verifyAgentResolutions(supabase, USER, "s-res");
    expect(v.verified.sort()).toEqual([ID.root, ID.again].sort());
    const r = await read(ID.again);
    expect(r.resolved_by_session_id).toBe("s-res");
    expect(r.resolution_turn_idx).toBe(1);
    expect(r.retire_reason).toBe("agent_resolved");
  });

  it("deferred verification: quote absent → stays retired, no receipt", async () => {
    const { supabase, read } = await resolved("nothing about it here, moving on to other work entirely");
    expect(await verifyAgentResolutions(supabase, USER, "s-res")).toEqual({ verified: [] });
    const r = await read(ID.again);
    expect(r.retire_reason).toBe("agent_resolved");
    expect(r.resolution_quote).toBe(QUOTE);
    expect(r.resolved_by_session_id).toBeNull();
  });

  it("deferred verification: a quote said only after the call gives no receipt", async () => {
    const t = tables(`Done: ${QUOTE}.`);
    t.code_session_turns[1].ts = "2026-10-04T10:05:00Z";
    t.memory_recall_events.push({ user_id: USER, surface: "preamble", recall_token: token, harness_session_id: "h-1" });
    const db = makeFakeSupabase(t);
    await resolveBlockerByAgent(db, USER, null, { id: ID.root, quote: QUOTE, recall_token: token });
    expect(await verifyAgentResolutions(db, USER, "s-res")).toEqual({ verified: [] });
    const { data } = await db.from("session_memories").select("*").eq("id", ID.root).maybeSingle();
    expect((data as Row).retire_reason).toBe("agent_resolved");
    expect((data as Row).resolved_by_session_id).toBeNull();
  });

  it("Undo restores an agent-resolved blocker, and the Dismissed list shows it", async () => {
    const { supabase, out, read } = await resolved();
    const listed = await listDismissedBlockers(supabase, USER);
    // The fixture's pre-retired user_resolved row is the other entry.
    expect(listed.filter((d) => d.by_agent)).toEqual([
      expect.objectContaining({ reason: "resolved", ids: expect.any(Array) }),
    ]);
    const lifted = await undoBlockerDismissal(supabase, USER, out.ids);
    expect(lifted.sort()).toEqual([...out.ids].sort());
    const r = await read(ID.root);
    expect(r.retired_at).toBeNull();
    expect(r.resolved_by_harness_session_id).toBeNull();
  });
});

describe("memory_resolve verification without a recall_token (#436)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A session whose memory_resolve tool_result turn lands `resultOffsetMs` after the call. */
  function session(turnText: string, resultOffsetMs: number, extra: Row[] = []) {
    const t = tables(turnText);
    t.session_memories.push(...extra);
    t.code_sessions = [{ id: "s-res", user_id: USER, source_session_id: "h-9" }];
    t.code_session_turns.push(
      {
        session_id: "s-res",
        user_id: USER,
        idx: 2,
        kind: "tool_use",
        tool_name: "mcp__membral__memory_resolve",
        text: null,
        ts: new Date(NOW.getTime() - 3_000).toISOString(),
      },
      {
        session_id: "s-res",
        user_id: USER,
        idx: 3,
        kind: "tool_result",
        tool_name: "mcp__membral__memory_resolve",
        text: "[tool_result elided: ok]",
        ts: new Date(NOW.getTime() + resultOffsetMs).toISOString(),
      },
    );
    return makeFakeSupabase(t);
  }
  const read = async (db: ReturnType<typeof makeFakeSupabase>, id: string) =>
    (await db.from("session_memories").select("*").eq("id", id).maybeSingle()).data as Row;

  it("the session's own memory_resolve turn claims the call; the quote then fills the receipt", async () => {
    const db = session(`Done: ${QUOTE}.`, 1_000);
    const out = await resolveBlockerByAgent(db, USER, null, { id: ID.root, quote: QUOTE });
    expect(out.will_verify).toBe(false);
    const v = await verifyAgentResolutions(db, USER, "s-res");
    expect(v.verified.sort()).toEqual([ID.root, ID.again].sort());
    expect((await read(db, ID.root)).resolved_by_session_id).toBe("s-res");
  });

  it("a memory_resolve turn outside the window claims nothing: the row stays retired, unverified", async () => {
    const db = session(`Done: ${QUOTE}.`, 60_000);
    await resolveBlockerByAgent(db, USER, null, { id: ID.root, quote: QUOTE });
    expect(await verifyAgentResolutions(db, USER, "s-res")).toEqual({ verified: [] });
    const r = await read(db, ID.root);
    expect(r.retire_reason).toBe("agent_resolved");
    expect(r.resolved_by_session_id).toBeNull();
  });

  it("a claimed call whose quote is absent stays retired with no receipt", async () => {
    const db = session("nothing relevant was said in this whole session at all", 1_000);
    await resolveBlockerByAgent(db, USER, null, { id: ID.root, quote: QUOTE });
    expect(await verifyAgentResolutions(db, USER, "s-res")).toEqual({ verified: [] });
    const r = await read(db, ID.root);
    expect(r.retire_reason).toBe("agent_resolved");
    expect(r.resolved_by_session_id).toBeNull();
  });

  it("two concurrent calls in one window: no claim", async () => {
    const second = "22222222-2222-4222-8222-000000000001";
    const db = session(`Done: ${QUOTE}.`, 1_000, [memory(second, { text: "Another blocker in the same project" })]);
    await resolveBlockerByAgent(db, USER, null, { id: ID.root, quote: QUOTE });
    vi.setSystemTime(new Date(NOW.getTime() + 500));
    await resolveBlockerByAgent(db, USER, null, { id: second, quote: QUOTE });
    expect(await verifyAgentResolutions(db, USER, "s-res")).toEqual({ verified: [] });
    expect((await read(db, ID.root)).resolved_by_session_id).toBeNull();
    expect((await read(db, second)).retire_reason).toBe("agent_resolved");
  });

  it("the quote check folds whitespace and case and needs no shared word with the blocker", async () => {
    const quote = "All   green NOW — rerun passed";
    const db = session("ok so: all green now — RERUN\npassed, shipping it", 1_000);
    await resolveBlockerByAgent(db, USER, null, { id: ID.root, quote });
    expect((await verifyAgentResolutions(db, USER, "s-res")).verified).toHaveLength(2);
  });

  it("refuses a quote shorter than 12 characters at call time", async () => {
    const db = session("", 1_000);
    await expect(resolveBlockerByAgent(db, USER, null, { id: ID.root, quote: "  fixed  " })).rejects.toThrow(/12-500/);
    expect((await read(db, ID.root)).retired_at).toBeNull();
  });
});

describe("memory_resolve verification cost and harness names (#436)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Records every (table, columns) select the fake sees. */
  function spySelects(db: ReturnType<typeof makeFakeSupabase>): [string, string][] {
    const seen: [string, string][] = [];
    const from = db.from.bind(db);
    (db as { from: unknown }).from = (table: string) => {
      const b = from(table as never) as unknown as { select: (c: string, ...r: unknown[]) => unknown };
      const select = b.select.bind(b);
      b.select = (cols: string, ...rest: unknown[]) => {
        seen.push([table, cols]);
        return select(cols, ...rest);
      };
      return b;
    };
    return seen;
  }

  it("a session with no resolve calls and no linked rows reads no turn text", async () => {
    const db = makeFakeSupabase(tables(`Done: ${QUOTE}.`));
    const seen = spySelects(db);
    expect(await verifyAgentResolutions(db, USER, "s-res")).toEqual({ verified: [] });
    const turnReads = seen.filter(([t]) => t === "code_session_turns").map(([, c]) => c);
    expect(turnReads).toHaveLength(1);
    expect(turnReads[0]).not.toContain("text");
  });

  it("Codex's bare memory_resolve counts only with mcpServer 'membral', on the tool_use turn", async () => {
    const run = async (mcpServer: string) => {
      const t = tables(`Done: ${QUOTE}.`);
      t.code_sessions = [{ id: "s-res", user_id: USER, source_session_id: "codex-1" }];
      t.code_session_turns.push({
        session_id: "s-res",
        user_id: USER,
        idx: 2,
        kind: "tool_use",
        tool_name: "memory_resolve",
        props: { mcpServer },
        text: null,
        ts: new Date(NOW.getTime() - 2_000).toISOString(),
      });
      const db = makeFakeSupabase(t);
      await resolveBlockerByAgent(db, USER, null, { id: ID.root, quote: QUOTE });
      return verifyAgentResolutions(db, USER, "s-res");
    };
    expect((await run("membral")).verified.sort()).toEqual([ID.root, ID.again].sort());
    expect(await run("other-server")).toEqual({ verified: [] });
  });
});
