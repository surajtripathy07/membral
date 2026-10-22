import { describe, expect, it, vi } from "vitest";
import { getServedAndUsed, resolveServedUsedDays, summarizeServedUsed } from "../served-used";

const ev = (o: Partial<Parameters<typeof summarizeServedUsed>[0][number]>) => ({
  id: "e",
  tool: "memory_search",
  served_at: "2026-10-10T00:00:00Z",
  surface: "mcp",
  record_ids: ["a"],
  influenced_edit: false,
  influenced_quote: false,
  influence_checked_at: "2026-10-10T00:00:00Z",
  ...o,
});

const NOW = new Date("2026-10-10T12:00:00Z");

describe("summarizeServedUsed", () => {
  it("counts records per surface into used / ignored / pending", () => {
    const s = summarizeServedUsed(
      [
        ev({ record_ids: ["a", "b", "c"], influenced_quote: true }),
        ev({ record_ids: ["d"], influenced_edit: true }),
        ev({ record_ids: ["e", "f"] }),
        ev({ record_ids: ["g"], influence_checked_at: null }),
        ev({ surface: "preamble", record_ids: ["h", "i"], influence_checked_at: null }),
        ev({ surface: "preamble", record_ids: [] }),
      ],
      7,
      "since",
      NOW,
    );
    expect(s.surfaces).toEqual([
      { surface: "mcp", served: 7, used: 4, ignored: 2, pending: 1, unlinked: 0 },
      { surface: "preamble", served: 2, used: 0, ignored: 0, pending: 2, unlinked: 0 },
    ]);
    expect(s.totals).toEqual({ served: 9, used: 4, ignored: 2, pending: 3, unlinked: 0 });
  });

  it("splits unchecked events at 24 h into pending and unlinked", () => {
    const s = summarizeServedUsed(
      [
        ev({ record_ids: ["a"], influence_checked_at: null, served_at: "2026-10-09T13:00:00Z" }),
        ev({ record_ids: ["b", "c"], influence_checked_at: null, served_at: "2026-10-09T11:00:00Z" }),
      ],
      7,
      "since",
      NOW,
    );
    expect(s.totals).toEqual({ served: 3, used: 0, ignored: 0, pending: 1, unlinked: 2 });
  });

  it("excludes session_summary events from every column", () => {
    const s = summarizeServedUsed(
      [ev({ tool: "session_summary", influence_checked_at: null }), ev({ record_ids: ["z"] })],
      7,
      "since",
      NOW,
    );
    expect(s.totals).toEqual({ served: 1, used: 0, ignored: 1, pending: 0, unlinked: 0 });
  });

  it("is empty for no events", () => {
    const s = summarizeServedUsed([], 7, "since", NOW);
    expect(s.surfaces).toEqual([]);
    expect(s.totals).toEqual({ served: 0, used: 0, ignored: 0, pending: 0, unlinked: 0 });
  });

  it("treats an unchecked event as pending even when flags are set", () => {
    const s = summarizeServedUsed([ev({ influenced_quote: true, influence_checked_at: null })], 7, "s", NOW);
    expect(s.totals).toMatchObject({ used: 0, pending: 1 });
  });
});

describe("resolveServedUsedDays", () => {
  it("defaults to 7 and clamps to 1..90", () => {
    expect(resolveServedUsedDays(null)).toBe(7);
    expect(resolveServedUsedDays("abc")).toBe(7);
    expect(resolveServedUsedDays("0")).toBe(7);
    expect(resolveServedUsedDays("30")).toBe(30);
    expect(resolveServedUsedDays("500")).toBe(90);
  });
});

describe("getServedAndUsed", () => {
  it("scopes by user_id and the window, and aggregates", async () => {
    const calls: Record<string, unknown[]> = {};
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "order"]) {
      builder[m] = vi.fn((...a: unknown[]) => {
        calls[m] = a;
        return builder;
      });
    }
    builder.range = vi.fn(() =>
      Promise.resolve({ data: [ev({ record_ids: ["a", "b"], influenced_quote: true })], error: null }),
    );
    const db = { from: vi.fn(() => builder) };
    const now = new Date("2026-10-10T00:00:00Z");
    // biome-ignore lint/suspicious/noExplicitAny: minimal client double
    const s = await getServedAndUsed(db as any, "user-1", 7, now);
    expect(db.from).toHaveBeenCalledWith("memory_recall_events");
    expect(calls.eq).toEqual(["user_id", "user-1"]);
    expect(calls.gte).toEqual(["served_at", "2026-10-03T00:00:00.000Z"]);
    expect(s.totals).toEqual({ served: 2, used: 2, ignored: 0, pending: 0, unlinked: 0 });
  });

  it("throws on a query error", async () => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "order"]) builder[m] = vi.fn(() => builder);
    builder.range = vi.fn(() => Promise.resolve({ data: null, error: { message: "bad" } }));
    // biome-ignore lint/suspicious/noExplicitAny: minimal client double
    await expect(getServedAndUsed({ from: () => builder } as any, "u")).rejects.toThrow("bad");
  });
});
