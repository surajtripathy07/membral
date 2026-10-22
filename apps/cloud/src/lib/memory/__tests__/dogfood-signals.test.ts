import { describe, expect, it, vi } from "vitest";
import {
  type EventRow,
  getContradictedCandidates,
  getDogfoodSignals,
  getDogfoodSignalsWindows,
  isoWeek,
  summarizeDogfood,
} from "../dogfood-signals";

const ev = (o: Partial<EventRow>): EventRow => ({
  id: "e1",
  tool: "memory_search",
  surface: "mcp",
  record_ids: [],
  influenced_edit: false,
  influenced_quote: false,
  influence_checked_at: null,
  served_at: "2026-10-08T10:00:00Z",
  code_session_id: "s1",
  ...o,
});

describe("isoWeek", () => {
  it("follows ISO-8601 week numbering", () => {
    expect(isoWeek("2026-10-08T10:00:00Z")).toBe("2026-W41");
    expect(isoWeek("2026-01-01T00:00:00Z")).toBe("2026-W01");
    expect(isoWeek("2027-01-01T00:00:00Z")).toBe("2026-W53");
  });
});

describe("summarizeDogfood", () => {
  const s = summarizeDogfood(
    {
      events: [
        ev({ id: "a", record_ids: ["r1", "r2"], influence_checked_at: "x", influenced_quote: true }),
        ev({ id: "b", record_ids: ["r3"], influence_checked_at: "x", surface: "prompt_hook", tool: "memory_search" }),
        ev({ id: "c", record_ids: [], empty_reason: "below_floor" }),
        ev({
          id: "d",
          record_ids: [],
          empty_reason: "no_match",
          code_session_id: null,
          served_at: "2026-10-01T00:00:00Z",
        }),
        ev({ id: "e", record_ids: [], tool: "preamble" }),
      ],
      verdicts: [
        { code_session_id: "s1", verdict: "contradicted", created_at: "2026-10-08T11:00:00Z" },
        { code_session_id: "s2", verdict: "confirmed", created_at: "2026-10-09T11:00:00Z" },
        { code_session_id: "s2", verdict: "unused", created_at: "2026-10-09T11:00:00Z" },
      ],
      feedback: [
        {
          id: "f1",
          sentiment: "stale",
          surface: "prompt_hook",
          quote: "that recall was stale",
          code_session_id: "s1",
          turn_idx: 4,
          created_at: "2026-10-08T12:00:00Z",
        },
      ],
      hooks: [
        {
          id: "s1",
          ended_at: "2026-10-08T13:00:00Z",
          hook_outcomes: { calls: 5, injected: 2, empty: 1, budget_hit: 1, timeout: 1, errors: 0 },
        },
        { id: "s3", ended_at: "2026-10-08T13:00:00Z", hook_outcomes: null },
      ],
    },
    7,
    "2026-10-03T00:00:00Z",
  );

  it("totals every source", () => {
    expect(s.totals.served).toBe(3);
    expect(s.totals.used).toBe(2);
    expect(s.totals.ignored).toBe(1);
    expect(s.totals.empty).toBe(2);
    expect(s.totals.empty_below_floor).toBe(1);
    expect(s.totals.empty_no_match).toBe(1);
    expect(s.totals.contradicted).toBe(1);
    expect(s.totals.confirmed).toBe(1);
    expect(s.totals.feedback).toMatchObject({ stale: 1, total: 1 });
    expect(s.totals.hook).toEqual({ calls: 5, injected: 2, empty: 1, budget_hit: 1, timeout: 1, errors: 0 });
  });

  it("splits per ISO week and per session", () => {
    expect(s.weeks.map((w) => w.week)).toEqual(["2026-W40", "2026-W41"]);
    expect(s.weeks[0]).toMatchObject({ empty: 1, served: 0 });
    const s1 = s.sessions.find((x) => x.code_session_id === "s1");
    expect(s1).toMatchObject({ served: 3, contradicted: 1, empty: 1, last_at: "2026-10-08T13:00:00Z" });
    expect(s.sessions.find((x) => x.code_session_id === "s2")).toMatchObject({ confirmed: 1 });
    expect(s.sessions[0]?.code_session_id).toBe("s2");
  });

  it("keeps the latest quotes", () => {
    expect(s.quotes).toEqual([expect.objectContaining({ id: "f1", turn_idx: 4 })]);
  });

  it("caps quotes at 10, newest first", () => {
    const feedback = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`,
      sentiment: "useful",
      surface: null,
      quote: `q${i}`,
      code_session_id: "s1",
      turn_idx: i,
      created_at: `2026-10-0${(i % 9) + 1}T00:00:${String(i).padStart(2, "0")}Z`,
    }));
    const out = summarizeDogfood({ events: [], verdicts: [], feedback, hooks: [] }, 30, "x");
    expect(out.quotes).toHaveLength(10);
    expect(out.quotes[0]?.id).toBe("f8");
  });
});

function client(tables: Record<string, { data: unknown[] | null; error: { message: string } | null }[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const db = {
    from: vi.fn((table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "neq", "not", "order"]) {
        builder[m] = vi.fn((...args: unknown[]) => {
          calls.push({ table, method: m, args });
          return builder;
        });
      }
      builder.range = vi.fn(() => Promise.resolve(tables[table]?.shift() ?? { data: [], error: null }));
      return builder;
    }),
  };
  return { db, calls };
}

describe("getDogfoodSignals", () => {
  it("scopes every read by user_id and the window", async () => {
    const { db, calls } = client({});
    // biome-ignore lint/suspicious/noExplicitAny: minimal client double
    const out = await getDogfoodSignals(db as any, "user-1", 7, new Date("2026-10-10T00:00:00Z"));
    expect(out.since).toBe("2026-10-03T00:00:00.000Z");
    const tables = ["memory_recall_events", "served_record_verdicts", "session_feedback", "code_sessions"];
    for (const t of tables) {
      expect(calls).toContainEqual({ table: t, method: "eq", args: ["user_id", "user-1"] });
    }
    expect(calls).toContainEqual({ table: "served_record_verdicts", method: "neq", args: ["verdict", "unused"] });
  });

  it("reads 7 and 30 days in one pass: one query per table, narrower window filtered", async () => {
    const recent = ev({ id: "r", served_at: "2026-10-09T00:00:00Z", record_ids: [] });
    const older = ev({ id: "o", served_at: "2026-09-25T00:00:00Z", record_ids: [] });
    const { db, calls } = client({ memory_recall_events: [{ data: [older, recent], error: null }] });
    // biome-ignore lint/suspicious/noExplicitAny: minimal client double
    const [week, month] = await getDogfoodSignalsWindows(db as any, "u", [7, 30], new Date("2026-10-10T00:00:00Z"));
    expect(calls.filter((c) => c.table === "memory_recall_events" && c.method === "gte")).toHaveLength(1);
    expect(week?.totals.empty).toBe(1);
    expect(month?.totals.empty).toBe(2);
  });

  it("reads zero from a database without 125/126", async () => {
    const missing = { data: null, error: { message: "column memory_recall_events.empty_reason does not exist" } };
    const { db } = client({
      memory_recall_events: [missing, { data: [ev({ id: "x", record_ids: [] })], error: null }],
      served_record_verdicts: [{ data: null, error: { message: 'relation "served_record_verdicts" does not exist' } }],
      session_feedback: [{ data: null, error: { message: "Could not find the table in the schema cache" } }],
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal client double
    const out = await getDogfoodSignals(db as any, "u", 7);
    expect(out.totals.empty).toBe(1);
    expect(out.totals.contradicted).toBe(0);
    expect(out.quotes).toEqual([]);
  });

  it("throws on any other error", async () => {
    const { db } = client({ session_feedback: [{ data: null, error: { message: "boom" } }] });
    // biome-ignore lint/suspicious/noExplicitAny: minimal client double
    await expect(getDogfoodSignals(db as any, "u", 7)).rejects.toThrow("boom");
  });
});

describe("getContradictedCandidates", () => {
  it("maps contradicted verdicts with their record text", async () => {
    const { db, calls } = client({
      served_record_verdicts: [
        {
          data: [
            {
              memory_id: "m1",
              quote: "the PR merged yesterday",
              turn_idx: 3,
              code_session_id: "s1",
              updated_at: "2026-10-09T00:00:00Z",
              session_memories: { text: "PR open", quote: "opened PR" },
            },
          ],
          error: null,
        },
      ],
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal client double
    const out = await getContradictedCandidates(db as any, "user-1", 30);
    expect(calls).toContainEqual({ table: "served_record_verdicts", method: "eq", args: ["verdict", "contradicted"] });
    expect(out).toEqual([
      {
        id: "m1",
        text: "PR open",
        record_quote: "opened PR",
        quote: "the PR merged yesterday",
        code_session_id: "s1",
        turn_idx: 3,
        contradicted_at: "2026-10-09T00:00:00Z",
      },
    ]);
  });
});

describe("windows and unlinked", () => {
  it("served = used + ignored + pending + unlinked, and unlinked is counted", () => {
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const r = summarizeDogfood(
      {
        events: [
          {
            id: "e1",
            tool: "memory_search",
            surface: "mcp",
            record_ids: ["a", "b"],
            influenced_edit: false,
            influenced_quote: false,
            influence_checked_at: null,
            served_at: old,
            code_session_id: null,
          } as never,
        ],
        verdicts: [],
        feedback: [],
        hooks: [],
      },
      7,
      new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
    );
    const t = r.totals;
    expect(t.unlinked).toBe(2);
    expect(t.served).toBe(t.used + t.ignored + t.pending + t.unlinked);
  });
});
