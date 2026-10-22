// Unit tests for ChatGPT's fetchConversationList pagination -- mirrors
// claude-fetch-list.test.ts's coverage (cancel-mid-pagination, the cursor
// stop-condition, out-of-order/malformed timestamps not truncating a page)
// but exercises ChatGPT's OWN epoch-seconds `update_time` field, which is
// the exact conversion CLAUDE.md's Extension Runtime Rules call out
// explicitly ("ChatGPT `update_time` is epoch seconds; always convert to ISO
// before comparing with stored ISO timestamps"). The sync-window cutoff
// (#120) is just another ISO `sinceTimestamp` value from this function's
// point of view -- these tests double as short-circuit-at-list-time
// coverage for the window feature.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateController } from "../common/rate-controller.js";
import { fetchConversationList } from "../providers/chatgpt.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const PAGE_LIMIT = 100;

interface FictionalConv {
  id: string;
  title: string;
  create_time: number;
  update_time: number | null;
}

/** `updatedAtSeconds` is epoch SECONDS, matching ChatGPT's real payload shape. */
function fictionalPage(prefix: string, count: number, updatedAtSeconds: number): FictionalConv[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    title: `CodeHub planning thread ${i}`,
    create_time: updatedAtSeconds,
    update_time: updatedAtSeconds,
  }));
}

function jsonResponse(items: FictionalConv[], total?: number) {
  return { ok: true, status: 200, json: async () => ({ items, total: total ?? items.length }) };
}

const noop = () => {};

describe("ChatGPT fetchConversationList", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("pages normally to the end when never cancelled", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(fictionalPage("p1", PAGE_LIMIT, 1719792000)))
      .mockResolvedValueOnce(jsonResponse(fictionalPage("p2", 3, 1719878400)));

    const rc = new RateController("test");
    const result = await fetchConversationList("token", "cookie=1", null, noop, rc, () => false);

    expect(result).toHaveLength(PAGE_LIMIT + 3);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("stops mid-pagination when cancelled after the first page, without a second page fetch", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(fictionalPage("p1", PAGE_LIMIT, 1719792000)))
      .mockResolvedValueOnce(jsonResponse(fictionalPage("p2", 3, 1719878400)));

    let calls = 0;
    const isCancelled = () => {
      calls++;
      return calls > 1;
    };

    const rc = new RateController("test");
    const result = await fetchConversationList("token", "cookie=1", null, noop, rc, isCancelled);

    expect(result).toHaveLength(PAGE_LIMIT);
    expect(result[0].id).toBe("p1-0");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("cancelled before any page starts makes zero fetch calls", async () => {
    const rc = new RateController("test");
    const result = await fetchConversationList("token", "cookie=1", null, noop, rc, () => true);

    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stops at the cursor/window-cutoff boundary (converting epoch seconds to ISO first) without needing cancellation", async () => {
    // 2024-06-05T00:00:00.000Z and 2024-06-01T00:00:00.000Z in epoch seconds.
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { id: "new-1", title: "CodeHub thread", create_time: 1717545600, update_time: 1717545600 },
        // At the cutoff exactly -- stop-condition boundary, must NOT be included.
        { id: "old-1", title: "CodeHub thread (old)", create_time: 1717200000, update_time: 1717200000 },
      ]),
    );

    const rc = new RateController("test");
    const result = await fetchConversationList("token", "cookie=1", "2024-06-01T00:00:00.000Z", noop, rc, () => false);

    expect(result.map((c) => c.id)).toEqual(["new-1"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a null update_time mid-page is included, not dropped, and is NOT a stop signal", async () => {
    const cursor = "2024-01-01T00:00:00.000Z";
    const page1 = fictionalPage("p1", PAGE_LIMIT, 1719792000); // 2024-06-01
    page1[10].update_time = null;
    const page2 = fictionalPage("p2", 3, 1719878400); // 2024-06-02

    mockFetch.mockResolvedValueOnce(jsonResponse(page1)).mockResolvedValueOnce(jsonResponse(page2));

    const rc = new RateController("test");
    const result = await fetchConversationList("token", "cookie=1", cursor, noop, rc, () => false);

    expect(result).toHaveLength(PAGE_LIMIT + 3);
    expect(result.some((c) => c.id === "p1-10")).toBe(true);
    expect(result.some((c) => c.id === "p1-49")).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("an out-of-order OLD item in the middle of an otherwise-newer page does not truncate the rest of the page or stop pagination", async () => {
    const cursor = "2024-01-01T00:00:00.000Z";
    const page1 = fictionalPage("p1", PAGE_LIMIT, 1719792000); // 2024-06-01
    page1[10].update_time = 1701388800; // 2023-12-01, at-or-before the cursor
    page1[10].create_time = 1701388800;
    const page2 = fictionalPage("p2", 3, 1719878400); // 2024-06-02

    mockFetch.mockResolvedValueOnce(jsonResponse(page1)).mockResolvedValueOnce(jsonResponse(page2));

    const rc = new RateController("test");
    const result = await fetchConversationList("token", "cookie=1", cursor, noop, rc, () => false);

    expect(result.some((c) => c.id === "p1-10")).toBe(false);
    expect(result).toHaveLength(PAGE_LIMIT - 1 + 3);
    expect(result.some((c) => c.id === "p1-49")).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("a sync-window cutoff (e.g. 30 days back) excludes everything older, never fetching it item-by-item", async () => {
    // The sync-window cutoff is just another ISO sinceTimestamp -- this
    // exercises it directly to document the #120 short-circuit behavior at
    // the provider level: a whole page at-or-before the window floor stops
    // pagination, and only pages listed as newer than the floor come back
    // for the per-conversation fetch stage to work through.
    const windowCutoff = "2024-07-01T00:00:00.000Z"; // e.g. "last 30 days" from 2024-07-31
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { id: "within-window", title: "recent", create_time: 1722384000, update_time: 1722384000 }, // 2024-07-31
        { id: "outside-window", title: "stale", create_time: 1704067200, update_time: 1704067200 }, // 2024-01-01
      ]),
    );

    const rc = new RateController("test");
    const result = await fetchConversationList("token", "cookie=1", windowCutoff, noop, rc, () => false);

    // Item-level exclusion: the older-than-window item is filtered out of
    // the list result, so it's never handed to the per-conversation fetch
    // stage (requirement 3 -- never fetched item-by-item).
    expect(result.map((c) => c.id)).toEqual(["within-window"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
