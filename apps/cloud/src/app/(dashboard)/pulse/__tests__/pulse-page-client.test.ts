// parsePulseResponse — the non-React half of pulse-page-client.tsx's fetch
// handling. Covers the bug this file fixes: /pulse showed "Unexpected token
// <" when /api/spike?op=pulse 404'd and its HTML error page hit
// `res.json()` directly. parsePulseResponse must degrade to a plain,
// status-carrying Error instead of ever letting a JSON.parse SyntaxError
// escape.
import { describe, expect, it } from "vitest";
import { parsePulseResponse } from "../pulse-page-client";

describe("parsePulseResponse", () => {
  it("surfaces the HTTP status, not a parse error, for a 404 HTML body", async () => {
    const res = new Response("<html><body>404 Not Found</body></html>", { status: 404 });
    await expect(parsePulseResponse(res)).rejects.toThrow("failed to load (status 404)");
  });

  it("surfaces the HTTP status for a non-JSON 500 body", async () => {
    const res = new Response("Internal Server Error", { status: 500 });
    await expect(parsePulseResponse(res)).rejects.toThrow("failed to load (status 500)");
  });

  it("uses the JSON error field when the body IS valid JSON", async () => {
    const res = new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    await expect(parsePulseResponse(res)).rejects.toThrow("unauthorized");
  });

  it("shapes a successful response into recent/recentCode/freshness", async () => {
    const body = {
      recent: [
        { id: "c1", title: "t", source: "claude", date: "2026-09-20", area_id: null, area_label: null, orphan: true },
      ],
      recent_code_sessions: [{ id: "s1" }],
      freshness: { corpus_current_through: { claude: { last_item_at: "x", last_synced_at: "y" } } },
    };
    const res = new Response(JSON.stringify(body), { status: 200 });
    const parsed = await parsePulseResponse(res);
    expect(parsed.recent).toEqual(body.recent);
    expect(parsed.recentCode).toEqual(body.recent_code_sessions);
    expect(parsed.threads.hasSessions).toBe(true);
    expect(parsed.freshness).toEqual(body.freshness.corpus_current_through);
  });

  it("defaults missing fields to empty/null on a bare 200", async () => {
    const res = new Response(JSON.stringify({}), { status: 200 });
    const parsed = await parsePulseResponse(res);
    expect(parsed).toEqual({
      firstRun: null,
      recent: [],
      recentCode: [],
      freshness: null,
      threads: {
        openThreads: [],
        recentThreads: [],
        recurringBlockers: [],
        statsLine: null,
        hasSessions: false,
        threadsError: false,
        sessionTitles: {},
      },
    });
  });

  it("UX W5: carries session_titles through, keeping only string titles", async () => {
    const body = { session_titles: { "s-1": "Fix the rounding bug", "s-2": 7 } };
    const parsed = await parsePulseResponse(new Response(JSON.stringify(body), { status: 200 }));
    expect(parsed.threads.sessionTitles).toEqual({ "s-1": "Fix the rounding bug" });
  });

  it("shapes open_threads / recent_threads / recurring_blockers / stats_line into threads (W8 / P7)", async () => {
    const thread = { ref: "codehub.example/acme/billing#15178", refKind: "issue", open: true };
    const body = {
      open_threads: [thread],
      recent_threads: [thread, { ...thread, ref: "codehub.example/acme/billing#254702", open: false }],
      recurring_blockers: [{ id: "b1", text: "smoke job times out", recurrence_count: 3 }],
      stats_line: "Longest session on 2026-09-24: 4h 12m",
    };
    const parsed = await parsePulseResponse(new Response(JSON.stringify(body), { status: 200 }));
    expect(parsed.threads.openThreads).toEqual([thread]);
    expect(parsed.threads.recentThreads).toHaveLength(2);
    expect(parsed.threads.recurringBlockers[0]).toMatchObject({ recurrence_count: 3 });
    expect(parsed.threads.statsLine).toBe("Longest session on 2026-09-24: 4h 12m");

    const blank = await parsePulseResponse(new Response(JSON.stringify({ stats_line: "   " }), { status: 200 }));
    expect(blank.threads.statsLine).toBeNull();
  });

  it("F9: null thread fields (the server's read failed) set threadsError instead of reading as empty", async () => {
    const res = new Response(
      JSON.stringify({
        recent: [],
        open_threads: null,
        recent_threads: null,
        recurring_blockers: null,
      }),
      { status: 200 },
    );
    const parsed = await parsePulseResponse(res);
    expect(parsed.threads.threadsError).toBe(true);
    expect(parsed.threads.openThreads).toEqual([]);
  });
});
