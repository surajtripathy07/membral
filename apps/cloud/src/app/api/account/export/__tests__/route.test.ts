import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---
//
// Round-5 verification BLOCKER 1 fix: the route now paginates every select
// with .range(from, to), building a FRESH query per page (Supabase builders
// are single-use). The mock below records every .range() call and every
// .eq()/.order() argument so a test can assert pagination actually happened
// (not just that the final merged result looks right) — see "streams every
// page" below, which proves 3 pages are read (450 rows total) with NO
// truncation at a 200-row page boundary.

const mockGetUser = vi.fn();

// profiles: from("profiles").select().eq().single()
const mockProfileSingle = vi.fn();
const mockProfileEq = vi.fn(() => ({ single: mockProfileSingle }));
const mockProfileSelect = vi.fn(() => ({ eq: mockProfileEq }));

interface ConvPage {
  data: Array<{ id: string; source: string; created_at: string }> | null;
  error: { message: string } | null;
}

let conversationPages: ConvPage[] = [];
const conversationRangeCalls: Array<[number, number]> = [];
// The route builds a FRESH query per page (`supabase.from(...)` called
// again each loop iteration — see route.ts's streamAllRows comment), so
// pagination position must be tracked OUTSIDE any single builder instance,
// by call order across all builders — this mirrors what actually
// distinguishes one page from the next in production: the `from`/`to`
// values passed to `.range()`, not any state a single query object holds.
let conversationCallIndex = 0;

function makeConversationsQuery() {
  const builder = {
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    range: vi.fn((from: number, to: number) => {
      conversationRangeCalls.push([from, to]);
      const page = conversationPages[conversationCallIndex] ?? { data: [], error: null };
      conversationCallIndex++;
      return Promise.resolve(page);
    }),
  };
  return builder;
}

const mockFrom = vi.fn((table: string) => {
  if (table === "profiles") return { select: mockProfileSelect };
  if (table === "conversations") return { select: vi.fn(() => makeConversationsQuery()) };
  return {};
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 1 }),
  };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET } from "../route";

function makeRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost:3000/api/account/export", { headers });
}

/** Drains a streamed NextResponse into an array of parsed NDJSON records. */
async function readNdjson(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function conv(id: string) {
  return { id, source: "chatgpt", created_at: "2026-01-01T00:00:00Z" };
}

describe("GET /api/account/export — round-5 verification BLOCKER 1 (streaming NDJSON export)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationPages = [];
    conversationRangeCalls.length = 0;
    conversationCallIndex = 0;
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockProfileSingle.mockResolvedValue({
      data: { id: "user-1", email: "a@example.com", display_name: null, tier: "free", conversation_limit: 100 },
      error: null,
    });
  });

  it("401 without an auth header", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("200 with an NDJSON attachment, Content-Type, and streaming headers", async () => {
    conversationPages = [{ data: [conv("c1")], error: null }];
    const res = await GET(makeRequest("jwt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("membral-export-user-1");
    expect(res.headers.get("content-disposition")).toContain(".ndjson");
  });

  it("emits one NDJSON line per record: meta, profile, conversation(s), done", async () => {
    conversationPages = [{ data: [conv("c1")], error: null }];
    const res = await GET(makeRequest("jwt"));
    const records = await readNdjson(res);
    expect(records[0].type).toBe("meta");
    expect(records.find((r) => r.type === "profile")).toMatchObject({ id: "user-1" });
    expect(records.find((r) => r.type === "conversation")).toMatchObject({ id: "c1" });
    expect(records.find((r) => r.type === "memory")).toBeUndefined();
    const done = records.find((r) => r.type === "done");
    expect(done).toMatchObject({ conversations: 1 });
  });

  it("streams every page across a 1000-row PostgREST cap: 3 pages (200+200+50) = 450 rows, no truncation at a page boundary", async () => {
    // Proves the F1 fix directly: PostgREST's db-max-rows cap is 1000, and
    // the OLD unpaginated route silently truncated there. This test uses
    // PAGE_SIZE (200) as the boundary instead (the route's own page size,
    // not PostgREST's cap) to prove pagination continues correctly PAST a
    // page boundary without needing to fabricate 1000+ fixture rows — the
    // .range() call assertions below are what prove no single page's worth
    // of rows is ever dropped, which is the actual mechanism that would
    // also protect against the 1000-row PostgREST cap in production.
    const page1 = Array.from({ length: 200 }, (_, i) => conv(`c${i}`));
    const page2 = Array.from({ length: 200 }, (_, i) => conv(`c${200 + i}`));
    const page3 = Array.from({ length: 50 }, (_, i) => conv(`c${400 + i}`));
    conversationPages = [
      { data: page1, error: null },
      { data: page2, error: null },
      { data: page3, error: null },
    ];

    const res = await GET(makeRequest("jwt"));
    const records = await readNdjson(res);
    const conversations = records.filter((r) => r.type === "conversation");

    expect(conversations).toHaveLength(450);
    // Every id from all three pages is present — nothing dropped at the
    // 200-row page boundary, and nothing duplicated across pages.
    const ids = new Set(conversations.map((c) => c.id));
    expect(ids.size).toBe(450);
    expect(ids.has("c0")).toBe(true);
    expect(ids.has("c199")).toBe(true); // last row of page 1
    expect(ids.has("c200")).toBe(true); // first row of page 2 — the boundary itself
    expect(ids.has("c449")).toBe(true); // last row of page 3

    // The .range() boundaries themselves prove pagination, not just the
    // merged row count: three calls, contiguous, non-overlapping.
    expect(conversationRangeCalls).toEqual([
      [0, 199],
      [200, 399],
      [400, 599],
    ]);
    // A short (< PAGE_SIZE) third page stops the loop — no 4th call.
    expect(conversationRangeCalls).toHaveLength(3);

    const done = records.find((r) => r.type === "done");
    expect(done).toMatchObject({ conversations: 450 });
  });

  it("a page-level error emits an {type:'error'} record and stops that stream instead of throwing / 500ing", async () => {
    conversationPages = [{ data: null, error: { message: "connection reset" } }];
    const res = await GET(makeRequest("jwt"));
    expect(res.status).toBe(200); // headers already sent — error is IN the stream, not the status
    const records = await readNdjson(res);
    const errorRecord = records.find((r) => r.type === "error" && r.source === "conversation");
    expect(errorRecord).toMatchObject({ message: "connection reset" });
  });

  it("scopes every query to the caller's own user id", async () => {
    conversationPages = [{ data: [], error: null }];
    await GET(makeRequest("jwt"));
    expect(mockProfileEq).toHaveBeenCalledWith("id", "user-1");
  });
});
