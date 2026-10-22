// Unit tests for Claude's fetchConversationList pagination -- specifically
// the cancel-mid-pagination requirement (goal 2026-07-26 step 15, #27/#57
// requirement 7 + CLAUDE.md's "Cancel mechanism" rule): a sync must be
// cancellable mid-run, and cancelling must stop paging WITHOUT losing the
// conversations already listed on completed pages.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateController } from "../common/rate-controller.js";
import { fetchConversationList } from "../providers/claude.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const DEFAULT_PAGE_SIZE = 50;

interface FictionalConv {
  uuid: string;
  name: string;
  created_at: string | null;
  updated_at: string | null;
}

function fictionalPage(prefix: string, count: number, updatedAt: string): FictionalConv[] {
  return Array.from({ length: count }, (_, i) => ({
    uuid: `${prefix}-${i}`,
    name: `CodeHub planning thread ${i}`,
    created_at: updatedAt,
    updated_at: updatedAt,
  }));
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe("Claude fetchConversationList", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("pages normally to the end when never cancelled", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(fictionalPage("p1", DEFAULT_PAGE_SIZE, "2024-06-01T00:00:00.000Z")))
      .mockResolvedValueOnce(jsonResponse(fictionalPage("p2", 3, "2024-06-02T00:00:00.000Z")));

    const rc = new RateController("test");
    const result = await fetchConversationList("session-key", "org-1", null, rc, () => false);

    expect(result).toHaveLength(DEFAULT_PAGE_SIZE + 3);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("stops mid-pagination when cancelled after the first page, without a second page fetch", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(fictionalPage("p1", DEFAULT_PAGE_SIZE, "2024-06-01T00:00:00.000Z")))
      .mockResolvedValueOnce(jsonResponse(fictionalPage("p2", 3, "2024-06-02T00:00:00.000Z")));

    let calls = 0;
    // False on the first top-of-loop check (before page 1 fetches), true from
    // then on -- so cancellation is observed right after page 1 completes,
    // before a page-2 request is ever made.
    const isCancelled = () => {
      calls++;
      return calls > 1;
    };

    const rc = new RateController("test");
    const result = await fetchConversationList("session-key", "org-1", null, rc, isCancelled);

    // Page 1's conversations are NOT lost -- cancellation stops future work,
    // it doesn't discard work already done.
    expect(result).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(result[0].id).toBe("p1-0");
    // Only the first page's request happened -- no page-2 fetch after cancel.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("cancelled before any page starts makes zero fetch calls", async () => {
    const rc = new RateController("test");
    const result = await fetchConversationList("session-key", "org-1", null, rc, () => true);

    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stops at the cursor boundary (pagination stop condition) without needing cancellation", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          uuid: "new-1",
          name: "CodeHub thread",
          created_at: "2024-06-05T00:00:00.000Z",
          updated_at: "2024-06-05T00:00:00.000Z",
        },
        // At the cursor exactly -- stop-condition boundary, must NOT be included.
        {
          uuid: "old-1",
          name: "CodeHub thread (old)",
          created_at: "2024-06-01T00:00:00.000Z",
          updated_at: "2024-06-01T00:00:00.000Z",
        },
      ]),
    );

    const rc = new RateController("test");
    const result = await fetchConversationList("session-key", "org-1", "2024-06-01T00:00:00.000Z", rc, () => false);

    expect(result.map((c) => c.id)).toEqual(["new-1"]);
    // Only one page requested -- stopping mid-page must not trigger a further page fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("B2 regression: a null/unparseable timestamp mid-page is included, not dropped, and is NOT a stop signal -- items after it in the same page and the next page are still returned", async () => {
    const cursor = "2024-01-01T00:00:00.000Z";
    const page1 = fictionalPage("p1", DEFAULT_PAGE_SIZE, "2024-06-01T00:00:00.000Z");
    // Poison one entry mid-page with a null timestamp -- the old behavior
    // treated this as "at or before the cursor," dropping the item AND
    // truncating every item after it in the page, AND stopping pagination
    // entirely (page 2 would never be fetched).
    page1[10].updated_at = null;
    const page2 = fictionalPage("p2", 3, "2024-06-02T00:00:00.000Z");

    mockFetch.mockResolvedValueOnce(jsonResponse(page1)).mockResolvedValueOnce(jsonResponse(page2));

    const rc = new RateController("test");
    const result = await fetchConversationList("session-key", "org-1", cursor, rc, () => false);

    // Every item from page 1 survives, including the null-timestamp entry
    // itself and everything listed after it.
    expect(result).toHaveLength(DEFAULT_PAGE_SIZE + 3);
    expect(result.some((c) => c.id === "p1-10")).toBe(true);
    expect(result.some((c) => c.id === "p1-49")).toBe(true);
    // Pagination continued to page 2 -- the null-timestamp item did not stop it.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("MN1 regression: an out-of-order OLD item in the middle of an otherwise-newer page does not truncate the rest of the page or stop pagination", async () => {
    const cursor = "2024-01-01T00:00:00.000Z";
    const page1 = fictionalPage("p1", DEFAULT_PAGE_SIZE, "2024-06-01T00:00:00.000Z");
    // A single out-of-order entry that IS genuinely at-or-before the cursor,
    // sitting in the middle of an otherwise all-newer page.
    page1[10].updated_at = "2023-12-01T00:00:00.000Z";
    page1[10].created_at = "2023-12-01T00:00:00.000Z";
    const page2 = fictionalPage("p2", 3, "2024-06-02T00:00:00.000Z");

    mockFetch.mockResolvedValueOnce(jsonResponse(page1)).mockResolvedValueOnce(jsonResponse(page2));

    const rc = new RateController("test");
    const result = await fetchConversationList("session-key", "org-1", cursor, rc, () => false);

    // The old (at-or-before-cursor) item is correctly excluded...
    expect(result.some((c) => c.id === "p1-10")).toBe(false);
    // ...but everything else in the page, and the next page, still comes through.
    expect(result).toHaveLength(DEFAULT_PAGE_SIZE - 1 + 3);
    expect(result.some((c) => c.id === "p1-49")).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
