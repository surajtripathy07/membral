import { createFakeDb, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import {
  EDIT_TOOL_NAMES,
  MEMBRAL_RECALL_TOOLS,
  MIN_QUOTE_CHARS,
  pathMatches,
  reconcileRecallInfluence,
} from "../influence";

const USER = "user-1";
const OTHER = "user-2";
const SESSION = "sess-row-1";
const HARNESS = "0f6c1d2e-harness-id";
const SERVED_AT = "2026-10-01T10:00:00.000Z";
const QUOTE = "key the cache on repo plus branch, never on path";

function turn(idx: number, ts: string, extra: Partial<Row> = {}): Row {
  return {
    user_id: USER,
    session_id: SESSION,
    idx,
    role: "assistant",
    kind: "prose",
    text: null,
    tool_name: null,
    file_path: null,
    ts,
    ...extra,
  };
}

function event(extra: Partial<Row> = {}): Row {
  return {
    id: "ev-1",
    user_id: USER,
    tool: "preamble",
    surface: "preamble",
    record_ids: ["rec-1"],
    served_at: SERVED_AT,
    code_session_id: null,
    harness_session_id: HARNESS,
    influenced_edit: false,
    influenced_quote: false,
    matched_turn_idx: null,
    influence_checked_at: null,
    ...extra,
  };
}

function setup(tables: { events?: Row[]; records?: Row[]; turns?: Row[]; sessions?: Row[] }) {
  const db = createFakeDb({
    flavour: "db",
    tables: {
      code_sessions: tables.sessions ?? [{ id: SESSION, user_id: USER, source_session_id: HARNESS }],
      memory_recall_events: tables.events ?? [event()],
      session_memories: tables.records ?? [
        { id: "rec-1", user_id: USER, quote: QUOTE, paths: ["apps/cloud/src/lib/cache.ts"] },
      ],
      code_session_turns: tables.turns ?? [],
    },
  });
  return db;
}

describe("reconcileRecallInfluence", () => {
  it("quote hit: a later assistant turn contains the served quote verbatim (whitespace-normalised)", async () => {
    const db = setup({
      turns: [
        turn(0, "2026-10-01T09:59:00.000Z", { role: "user", text: "go" }),
        turn(3, "2026-10-01T10:05:00.000Z", {
          text: `As noted:   key the cache on repo plus\n branch, never on path. Doing that now.`,
        }),
      ],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res).toEqual({ checked: 1, influencedQuote: 1, influencedEdit: 0 });
    const [ev] = db.getRows("memory_recall_events");
    expect(ev).toMatchObject({ influenced_quote: true, influenced_edit: false, matched_turn_idx: 3 });
    expect(ev.code_session_id).toBe(SESSION); // filled in from the harness-id match
    expect(ev.influence_checked_at).toEqual(expect.any(String));
  });

  it("no quote hit from a tool_use turn's written text (only prose turns count)", async () => {
    const db = setup({
      turns: [
        turn(3, "2026-10-01T10:05:00.000Z", {
          kind: "tool_use",
          tool_name: "Write",
          file_path: "docs/notes/cache.md",
          text: `Ruling: ${QUOTE}.`,
        }),
      ],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res).toEqual({ checked: 1, influencedQuote: 0, influencedEdit: 0 });
    expect(db.getRows("memory_recall_events")[0]).toMatchObject({ influenced_quote: false, matched_turn_idx: null });
  });

  it("edit hit: a later edit tool turn targets a path on a served record (suffix match)", async () => {
    const db = setup({
      turns: [
        turn(2, "2026-10-01T10:01:00.000Z", {
          kind: "tool_use",
          tool_name: "Read",
          file_path: "/Users/dev/repo/apps/cloud/src/lib/cache.ts",
        }),
        turn(4, "2026-10-01T10:02:00.000Z", {
          kind: "tool_use",
          tool_name: "Edit",
          file_path: "/Users/dev/repo/apps/cloud/src/lib/cache.ts",
        }),
      ],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res).toEqual({ checked: 1, influencedQuote: 0, influencedEdit: 1 });
    expect(db.getRows("memory_recall_events")[0]).toMatchObject({
      influenced_edit: true,
      influenced_quote: false,
      matched_turn_idx: 4,
    });
  });

  it("MCP event: no hit when the matching turns are earlier than served_at minus the 30s tolerance", async () => {
    const db = setup({
      events: [event({ tool: "memory_search", surface: "mcp", code_session_id: SESSION, harness_session_id: null })],
      turns: [
        turn(1, "2026-10-01T09:59:29.000Z", { text: QUOTE }), // 31s before served_at
        turn(2, "2026-10-01T09:30:00.000Z", {
          kind: "tool_use",
          tool_name: "Write",
          file_path: "apps/cloud/src/lib/cache.ts",
        }),
      ],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res).toEqual({ checked: 1, influencedQuote: 0, influencedEdit: 0 });
    const [ev] = db.getRows("memory_recall_events");
    expect(ev).toMatchObject({ influenced_edit: false, influenced_quote: false, matched_turn_idx: null });
    expect(ev.influence_checked_at).toEqual(expect.any(String));
  });

  it("MCP event: a turn stamped within 30s BEFORE served_at still counts (clock skew)", async () => {
    const db = setup({
      events: [event({ tool: "memory_search", surface: "mcp", code_session_id: SESSION, harness_session_id: null })],
      turns: [turn(1, "2026-10-01T09:59:40.000Z", { text: QUOTE })], // 20s before served_at
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res.influencedQuote).toBe(1);
  });

  it("preamble event: every turn of the session counts, whatever its ts (or none)", async () => {
    const db = setup({
      turns: [
        turn(1, "2026-10-01T08:00:00.000Z", { text: QUOTE }), // hours "before" served_at
        turn(2, null as unknown as string, {
          kind: "tool_use",
          tool_name: "Edit",
          file_path: "/r/apps/cloud/src/lib/cache.ts",
        }),
      ],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res).toEqual({ checked: 1, influencedQuote: 1, influencedEdit: 1 });
    expect(db.getRows("memory_recall_events")[0].matched_turn_idx).toBe(1);
  });

  it("an MCP event echoing this session's preamble recall_token is reconciled; another token is not", async () => {
    const db = setup({
      events: [
        event({ recall_token: "tok-session" }),
        event({
          id: "ev-mcp-match",
          tool: "memory_search",
          surface: "mcp",
          recall_token: "tok-session",
          harness_session_id: null,
          served_at: "2026-10-01T10:10:00.000Z",
          record_ids: ["rec-2"],
        }),
        event({
          id: "ev-mcp-other",
          tool: "memory_search",
          surface: "mcp",
          recall_token: "tok-elsewhere",
          harness_session_id: null,
          served_at: "2026-10-01T10:10:00.000Z",
          record_ids: ["rec-2"],
        }),
      ],
      records: [
        { id: "rec-1", user_id: USER, quote: "a quote nobody repeats anywhere at all", paths: [] },
        { id: "rec-2", user_id: USER, quote: QUOTE, paths: [] },
      ],
      turns: [turn(7, "2026-10-01T10:11:00.000Z", { text: `Per memory: ${QUOTE}.` })],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res).toEqual({ checked: 2, influencedQuote: 1, influencedEdit: 0 });
    const byId = new Map(db.getRows("memory_recall_events").map((r) => [r.id, r]));
    expect(byId.get("ev-mcp-match")).toMatchObject({
      influenced_quote: true,
      matched_turn_idx: 7,
      code_session_id: SESSION,
    });
    expect(byId.get("ev-mcp-other")).toMatchObject({
      influenced_quote: false,
      code_session_id: null,
      influence_checked_at: null,
    });
  });

  it("does not match a same-user event with a null code_session_id and a different harness id", async () => {
    const db = setup({
      events: [event({ harness_session_id: "some-other-harness-session" })],
      turns: [turn(3, "2026-10-01T10:05:00.000Z", { text: QUOTE })],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res.checked).toBe(0);
    expect(db.getRows("memory_recall_events")[0]).toMatchObject({
      code_session_id: null,
      influence_checked_at: null,
    });
  });

  it(`ignores quotes shorter than ${MIN_QUOTE_CHARS} characters`, async () => {
    const short = "use the cache"; // 13 chars
    const db = setup({
      records: [{ id: "rec-1", user_id: USER, quote: short, paths: [] }],
      turns: [turn(5, "2026-10-01T10:05:00.000Z", { text: `I will ${short} here.` })],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res.influencedQuote).toBe(0);
    expect(db.getRows("memory_recall_events")[0].influenced_quote).toBe(false);
  });

  it("is user-scoped: another user's event, record and session are never read or written", async () => {
    const db = setup({
      sessions: [
        { id: SESSION, user_id: USER, source_session_id: HARNESS },
        { id: "sess-other", user_id: OTHER, source_session_id: HARNESS },
      ],
      events: [event({ id: "ev-other", user_id: OTHER })],
      records: [{ id: "rec-1", user_id: OTHER, quote: QUOTE, paths: [] }],
      turns: [turn(3, "2026-10-01T10:05:00.000Z", { text: QUOTE })],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res.checked).toBe(0);
    expect(db.getRows("memory_recall_events")[0]).toMatchObject({
      code_session_id: null,
      influence_checked_at: null,
      influenced_quote: false,
    });

    // The user's own event whose record id belongs to another user: no quote hit.
    const db2 = setup({
      records: [{ id: "rec-1", user_id: OTHER, quote: QUOTE, paths: [] }],
      turns: [turn(3, "2026-10-01T10:05:00.000Z", { text: QUOTE })],
    });
    const res2 = await reconcileRecallInfluence(db2.client, USER, SESSION);
    expect(res2).toEqual({ checked: 1, influencedQuote: 0, influencedEdit: 0 });
  });

  it("leaves an event tied to a different code session alone", async () => {
    const db = setup({
      events: [event({ code_session_id: "some-other-session" })],
      turns: [turn(3, "2026-10-01T10:05:00.000Z", { text: QUOTE })],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res.checked).toBe(0);
    expect(db.getRows("memory_recall_events")[0].influence_checked_at).toBeNull();
  });
});

describe("influence helpers", () => {
  it("pathMatches: exact or turn-path ends with '/'+record path; record path must contain '/'", () => {
    expect(pathMatches("/repo/src/a.ts", "src/a.ts")).toBe(true);
    expect(pathMatches("src/a.ts", "./src/a.ts")).toBe(true);
    expect(pathMatches("./src/a.ts", "src/a.ts")).toBe(true);
    expect(pathMatches("/repo/src/a.ts", "/repo/src/a.ts")).toBe(true);
    expect(pathMatches("/repo/xsrc/a.ts", "src/a.ts")).toBe(false);
    expect(pathMatches("/repo/src/a.ts", "")).toBe(false);
    // No reverse direction: a bare turn path never matches a longer record path.
    expect(pathMatches("index.ts", "src/a/index.ts")).toBe(false);
    // A record path without a "/" never matches, not even exactly.
    expect(pathMatches("/repo/src/index.ts", "index.ts")).toBe(false);
    expect(pathMatches("index.ts", "index.ts")).toBe(false);
  });

  it("edit of a bare `index.ts` against a record path `src/a/index.ts` is no hit", async () => {
    const db = setup({
      records: [{ id: "rec-1", user_id: USER, quote: null, paths: ["src/a/index.ts", "index.ts"] }],
      turns: [turn(2, "2026-10-01T10:02:00.000Z", { kind: "tool_use", tool_name: "Edit", file_path: "index.ts" })],
    });
    const res = await reconcileRecallInfluence(db.client, USER, SESSION);
    expect(res.influencedEdit).toBe(0);
  });

  it("EDIT_TOOL_NAMES covers both harnesses' edit/write tools and no read tool", () => {
    expect(EDIT_TOOL_NAMES).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit", "edit", "write"]));
    expect(EDIT_TOOL_NAMES).not.toContain("Read");
    expect(EDIT_TOOL_NAMES).not.toContain("read");
  });

  describe("turn-matched MCP events (#405)", () => {
    const T0 = "2026-10-02T13:07:44.000Z";
    const at = (secs: number) => new Date(Date.parse(T0) + secs * 1000).toISOString();
    const mcp = (id: string, secs: number, extra: Partial<Row> = {}): Row =>
      event({
        id,
        tool: "memory_search",
        surface: "mcp",
        recall_token: null,
        harness_session_id: null,
        served_at: at(secs),
        ...extra,
      });
    // The event is logged just before the result returns, so served_at is slightly BEFORE the result ts.
    const result = (idx: number, secs: number, name = "mcp__membral__memory_search", extra: Partial<Row> = {}) =>
      turn(idx, at(secs), { kind: "tool_result", tool_name: name, ...extra });
    const quoteTurn = (idx: number, secs: number) => turn(idx, at(secs), { text: `Per memory: ${QUOTE}.` });
    const claimed = (db: ReturnType<typeof setup>) =>
      new Map(db.getRows("memory_recall_events").map((r) => [r.id, r.code_session_id]));

    it("claims a null-token event 1.0s before the tool_result and computes influence", async () => {
      const db = setup({ events: [mcp("ev-a", -1)], turns: [result(5, 0), quoteTurn(7, 10)] });
      const res = await reconcileRecallInfluence(db.client, USER, SESSION);
      expect(res).toEqual({ checked: 1, influencedQuote: 1, influencedEdit: 0 });
      expect(db.getRows("memory_recall_events")[0]).toMatchObject({
        code_session_id: SESSION,
        influenced_quote: true,
        matched_turn_idx: 7,
      });
    });

    it("works with caller-supplied turns (no turns read)", async () => {
      const db = setup({ events: [mcp("ev-a", -1)], turns: [] });
      const res = await reconcileRecallInfluence(db.client, USER, SESSION, [
        {
          idx: 5,
          role: "user",
          kind: "tool_result",
          text: null,
          tool_name: "mcp__membral__memory_search",
          file_path: null,
          ts: at(0),
        },
        {
          idx: 7,
          role: "assistant",
          kind: "prose",
          text: `Per memory: ${QUOTE}.`,
          tool_name: null,
          file_path: null,
          ts: at(10),
        },
      ]);
      expect(res).toEqual({ checked: 1, influencedQuote: 1, influencedEdit: 0 });
    });

    it("misses an event 6s before or 3s after the result; hits at the -5s and +2s edges", async () => {
      for (const [secs, hit] of [
        [-6, false],
        [3, false],
        [-5, true],
        [2, true],
      ] as const) {
        const db = setup({ events: [mcp("ev-a", secs)], turns: [result(5, 0)] });
        await reconcileRecallInfluence(db.client, USER, SESSION);
        expect(claimed(db).get("ev-a"), `served_at ${secs}s`).toBe(hit ? SESSION : null);
      }
    });

    it("does not match on tool_use turns", async () => {
      const db = setup({ events: [mcp("ev-a", 1)], turns: [result(1, 0, undefined, { kind: "tool_use" })] });
      expect((await reconcileRecallInfluence(db.client, USER, SESSION)).checked).toBe(0);
    });

    it("assigns two results and two events one-to-one by nearest", async () => {
      // result@0 and result@3: ev-b@-0.5 is nearest to the first, ev-c@2.5 to the second.
      // ev-a@-4 is inside both windows but loses to the nearer events.
      const db = setup({
        events: [mcp("ev-a", -4), mcp("ev-b", -0.5), mcp("ev-c", 2.5)],
        turns: [result(1, 0), result(2, 3)],
      });
      const res = await reconcileRecallInfluence(db.client, USER, SESSION);
      expect(res.checked).toBe(2);
      expect(claimed(db)).toEqual(
        new Map([
          ["ev-a", null],
          ["ev-b", SESSION],
          ["ev-c", SESSION],
        ]),
      );
    });

    it("one result claims at most one event when two events are in the window", async () => {
      const db = setup({ events: [mcp("ev-a", -1), mcp("ev-b", -2)], turns: [result(1, 0)] });
      const res = await reconcileRecallInfluence(db.client, USER, SESSION);
      expect(res.checked).toBe(1);
      expect(claimed(db)).toEqual(
        new Map([
          ["ev-a", SESSION],
          ["ev-b", null],
        ]),
      );
    });

    it("leaves an event bound to another session untouched", async () => {
      const db = setup({ events: [mcp("ev-a", -1, { code_session_id: "sess-other" })], turns: [result(1, 0)] });
      expect((await reconcileRecallInfluence(db.client, USER, SESSION)).checked).toBe(0);
      expect(db.getRows("memory_recall_events")[0]).toMatchObject({
        code_session_id: "sess-other",
        influence_checked_at: null,
      });
    });

    it("leaves another user's event untouched", async () => {
      const db = setup({ events: [mcp("ev-a", -1, { user_id: OTHER })], turns: [result(1, 0)] });
      expect((await reconcileRecallInfluence(db.client, USER, SESSION)).checked).toBe(0);
      expect(db.getRows("memory_recall_events")[0]).toMatchObject({
        code_session_id: null,
        influence_checked_at: null,
      });
    });

    it("swap scenario: an event carrying another session's token is not claimed", async () => {
      // Sessions A (this) and B of one user make overlapping calls; B's event carries tokB.
      const db = setup({
        events: [event({ recall_token: "tokA" }), mcp("ev-b", -1, { recall_token: "tokB" })],
        turns: [result(1, 0)],
      });
      await reconcileRecallInfluence(db.client, USER, SESSION);
      expect(claimed(db).get("ev-b")).toBeNull();
    });

    it("never matches session_summary (turn or event)", async () => {
      const db = setup({
        events: [mcp("ev-a", -1, { tool: "session_summary" })],
        turns: [result(1, 0, "mcp__membral__session_summary")],
      });
      expect((await reconcileRecallInfluence(db.client, USER, SESSION)).checked).toBe(0);
      expect(db.getRows("memory_recall_events")[0].code_session_id).toBeNull();
    });

    it("opencode: one tool_use row (no tool_result), hit at +20s, miss at +30s, tool_result ignored", async () => {
      for (const [secs, hit] of [
        [20, true],
        [-5, true],
        [30, false],
        [-6, false],
      ] as const) {
        const db = setup({
          events: [mcp("ev-a", secs)],
          turns: [turn(1, at(0), { kind: "tool_use", tool_name: "membral_memory_search" })],
        });
        await reconcileRecallInfluence(db.client, USER, SESSION);
        expect(claimed(db).get("ev-a"), `served_at ${secs}s`).toBe(hit ? SESSION : null);
      }
      const db = setup({ events: [mcp("ev-a", 1)], turns: [result(1, 0, "membral_memory_search")] });
      expect((await reconcileRecallInfluence(db.client, USER, SESSION)).checked).toBe(0);
    });

    it("requires the same tool", async () => {
      const db = setup({
        events: [mcp("ev-a", -1, { tool: "memory_recall" }), mcp("ev-b", -1.2)],
        turns: [result(1, 0, "mcp__membral__memory_search")],
      });
      expect((await reconcileRecallInfluence(db.client, USER, SESSION)).checked).toBe(1);
      expect(claimed(db)).toEqual(
        new Map([
          ["ev-a", null],
          ["ev-b", SESSION],
        ]),
      );
    });

    it("claiming update is compare-and-set on code_session_id is null", async () => {
      const db = setup({ events: [mcp("ev-a", -1)], turns: [result(1, 0)] });
      await reconcileRecallInfluence(db.client, USER, SESSION);
      const upd = db.oplog.find((o) => o.table === "memory_recall_events" && o.op === "update");
      expect(upd?.filters).toContain("is.code_session_id=null");
    });

    it("lost race: a row claimed by another session before our update is left alone and not counted", async () => {
      const db = setup({ events: [mcp("ev-a", -1)], turns: [result(1, 0)] });
      const rows = db.getRows("memory_recall_events");
      const client = db.client as unknown as { from: (t: string) => Record<string, unknown> };
      const from = client.from.bind(client);
      client.from = (t: string) => {
        const q = from(t);
        if (t === "memory_recall_events") {
          const upd = (q.update as (p: Row) => unknown).bind(q);
          q.update = (patch: Row) => {
            rows[0].code_session_id = "sess-other"; // the other session wins just before our write
            return upd(patch);
          };
        }
        return q;
      };
      const res = await reconcileRecallInfluence(db.client, USER, SESSION);
      expect(res.checked).toBe(0);
      expect(db.getRows("memory_recall_events")[0]).toMatchObject({
        code_session_id: "sess-other",
        influence_checked_at: null,
      });
    });

    it("tool name lookup ignores Object.prototype keys; no summary tool is listed", async () => {
      const db = setup({ events: [mcp("ev-a", -1)], turns: [result(1, 0, "constructor")] });
      expect((await reconcileRecallInfluence(db.client, USER, SESSION)).checked).toBe(0);
      expect(Object.keys(MEMBRAL_RECALL_TOOLS).some((n) => n.includes("session_summary"))).toBe(false);
    });
  });
});
