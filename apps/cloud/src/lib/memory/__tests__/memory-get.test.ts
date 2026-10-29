import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCodeSession = vi.fn();
vi.mock("@/lib/mcp/code-tools", () => ({ getCodeSession: (...a: unknown[]) => mockGetCodeSession(...a) }));
vi.mock("../verify", async () => {
  const actual = await vi.importActual<typeof import("../verify")>("../verify");
  return {
    ...actual,
    buildServeContext: async () => ({
      repoNames: new Map(),
      mergedAt: new Map(),
      chatPrecontext: new Map(),
      sessionTimes: new Map(),
    }),
  };
});
vi.mock("@/lib/mcp/served-record-view", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/served-record-view")>("@/lib/mcp/served-record-view");
  return {
    ...actual,
    compactServedRecords: async (
      _db: unknown,
      records: Parameters<typeof actual.compactServedRecord>[0][],
      _userId: string,
      now?: number,
      wholeHandoff?: boolean,
    ) => records.map((r) => actual.compactServedRecord(r, undefined, undefined, now, wholeHandoff)),
  };
});

import { clampMemoryGetWindow, memoryGet } from "../memory-get";

const USER = "user-1";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    code_session_id: SESSION,
    code_project_id: "proj-1",
    agent_id: null,
    source: "extracted",
    kind: "decision",
    text: "CodeHub retries the import once",
    quote: "retry the import once, then stop",
    turn_idx: 5,
    turn_role: "user",
    ref: null,
    ref_kind: null,
    branch: null,
    head_sha: null,
    thread: null,
    paths: [],
    verified: true,
    durable: true,
    observed_durable: false,
    recurrence_count: 1,
    scope: "project",
    confidence: 1,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: "2026-10-01T10:00:00Z",
    ...over,
  };
}

/** A fake Db whose session_memories query records every filter applied. */
function fakeDb(rows: unknown[]) {
  const calls: [string, ...unknown[]][] = [];
  const record = (op: string, a: unknown[]) => {
    calls.push([op, ...a]);
    return q;
  };
  // biome-ignore lint/suspicious/noExplicitAny: test double
  const q: any = {
    select: () => q,
    eq: (...a: unknown[]) => record("eq", a),
    in: (...a: unknown[]) => record("in", a),
    is: (...a: unknown[]) => record("is", a),
    // biome-ignore lint/suspicious/noThenProperty: the query builder is awaited
    // biome-ignore lint/suspicious/noExplicitAny: thenable test double
    then: (res: any) => res({ data: rows, error: null }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test double
  return { db: { from: () => q } as any, calls };
}

const turns = Array.from({ length: 12 }, (_, i) => ({ idx: i, role: "user", kind: "prose", text: `turn ${i}` }));

describe("memoryGet", () => {
  beforeEach(() => {
    mockGetCodeSession.mockReset();
    mockGetCodeSession.mockResolvedValue({ turns });
  });

  it("returns the record, its quote and the turns around turn_idx", async () => {
    const { db } = fakeDb([row(ID_A)]);
    const out = await memoryGet(db, USER, null, { ids: [ID_A], window: 2 });
    expect(out.not_found).toEqual([]);
    expect(out.records).toHaveLength(1);
    const rec = out.records[0];
    expect(rec.id).toBe(ID_A);
    expect(rec.quote).toBe("retry the import once, then stop");
    const idxs = (rec.window?.turns as { idx: number }[]).map((t) => t.idx);
    expect(idxs).toEqual([3, 4, 5, 6, 7]);
    expect(mockGetCodeSession).toHaveBeenCalledWith(db, USER, SESSION, null);
  });

  it("opens a handoff note whole, not cut to the served cap", async () => {
    const note = "n".repeat(3000);
    const { db } = fakeDb([row(ID_A, { kind: "handoff", text: note })]);
    const out = await memoryGet(db, USER, null, { ids: [ID_A], include: ["quote"] });
    expect(out.records[0].text).toBe(note);
  });

  it("filters by user_id and, for a scoped key, by project; hides retired rows", async () => {
    const { db, calls } = fakeDb([]);
    await memoryGet(db, USER, "proj-9", { ids: [ID_A] });
    expect(calls).toContainEqual(["eq", "user_id", USER]);
    expect(calls).toContainEqual(["eq", "code_project_id", "proj-9"]);
    expect(calls).toContainEqual(["is", "retired_at", null]);
  });

  it("reports unknown, malformed and other-users' ids identically as not_found, without throwing", async () => {
    const { db } = fakeDb([row(ID_A)]);
    const out = await memoryGet(db, USER, null, { ids: [ID_B, "nope", ID_A] });
    expect(out.records.map((r) => r.id)).toEqual([ID_A]);
    expect(out.not_found).toEqual([ID_B, "nope"]);
  });

  it("rejects an oversized id and never echoes more than 64 chars", async () => {
    const { db } = fakeDb([row(ID_A)]);
    await expect(memoryGet(db, USER, null, { ids: ["x".repeat(65)] })).rejects.toThrow(/memory_get/);
    const out = await memoryGet(db, USER, null, { ids: ["y".repeat(64)] });
    expect(out.not_found[0]).toHaveLength(64);
  });

  it("shares one response budget: later records report truncated, not vanish", async () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ idx: i, role: "user", kind: "prose", text: "w".repeat(1000) }));
    mockGetCodeSession.mockResolvedValue({ turns: big });
    const ids = [ID_A, ID_B, "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
    const { db } = fakeDb(ids.map((i) => row(i)));
    const out = await memoryGet(db, USER, null, { ids, window: 40 });
    expect(out.records).toHaveLength(4);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(24_000 + 2_000);
    expect(out.records.some((r) => r.truncated)).toBe(true);
  });

  it("makes no query when every id is malformed", async () => {
    const from = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const out = await memoryGet({ from } as any, USER, null, { ids: ["abc"] });
    expect(from).not.toHaveBeenCalled();
    expect(out).toEqual({ records: [], not_found: ["abc"] });
  });

  it("include: [quote] skips the window and the session read; include: [window] drops the quote", async () => {
    const { db } = fakeDb([row(ID_A)]);
    const q = await memoryGet(db, USER, null, { ids: [ID_A], include: ["quote"] });
    expect(q.records[0].quote).toBeDefined();
    expect(q.records[0].window).toBeUndefined();
    expect(mockGetCodeSession).not.toHaveBeenCalled();
    const w = await memoryGet(db, USER, null, { ids: [ID_A], include: ["window"] });
    expect(w.records[0].quote).toBeUndefined();
    expect(w.records[0].window).toBeDefined();
  });

  it("reads each session once for records that share it; an unreadable session leaves the window off", async () => {
    const { db } = fakeDb([row(ID_A), row(ID_B, { turn_idx: 8 })]);
    const out = await memoryGet(db, USER, null, { ids: [ID_A, ID_B] });
    expect(out.records).toHaveLength(2);
    expect(mockGetCodeSession).toHaveBeenCalledTimes(1);

    mockGetCodeSession.mockResolvedValueOnce(null);
    const none = await memoryGet(db, USER, null, { ids: [ID_A] });
    expect(none.records[0].window).toBeUndefined();
  });

  it("rejects an empty or oversized ids list", async () => {
    const { db } = fakeDb([]);
    await expect(memoryGet(db, USER, null, { ids: [] })).rejects.toThrow(/ids/);
    await expect(memoryGet(db, USER, null, { ids: Array(11).fill(ID_A) })).rejects.toThrow(/ids/);
  });

  it("clamps the window to 1-40, default 4", () => {
    expect(clampMemoryGetWindow(undefined)).toBe(4);
    expect(clampMemoryGetWindow(0)).toBe(1);
    expect(clampMemoryGetWindow(99)).toBe(40);
  });
});
