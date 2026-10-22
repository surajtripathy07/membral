import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateClient = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

const {
  CHAT_STALE_MS,
  CODE_STALE_MS,
  formatFreshnessCompactValue,
  formatFreshnessPrefix,
  getFreshness,
  getFreshnessForUser,
  isSourceStale,
  shapePulseFreshness,
} = await import("../freshness");
type FreshnessMap = import("../freshness").FreshnessMap;
type FreshnessPayload = import("../freshness").FreshnessPayload;

describe("getFreshness", () => {
  it("calls mcp_freshness with p_user_id and shapes the payload", async () => {
    const data = { claude: { last_item_at: "2026-07-20T00:00:00.000Z", last_synced_at: "2026-07-25T00:00:00.000Z" } };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    const supabase = { rpc } as unknown as Parameters<typeof getFreshness>[0];

    const result = await getFreshness(supabase, "user-1");

    expect(rpc).toHaveBeenCalledWith("mcp_freshness", { p_user_id: "user-1" });
    expect(result).not.toBeNull();
    expect(result?.corpus_current_through).toEqual(data);
    expect(typeof result?.generated_at).toBe("string");
  });

  it("degrades to null when the RPC returns an error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const supabase = { rpc } as unknown as Parameters<typeof getFreshness>[0];

    const result = await getFreshness(supabase, "user-1");
    expect(result).toBeNull();
  });

  it("degrades to null when the RPC call throws", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("connection refused"));
    const supabase = { rpc } as unknown as Parameters<typeof getFreshness>[0];

    const result = await getFreshness(supabase, "user-1");
    expect(result).toBeNull();
  });

  it("defaults corpus_current_through to {} when the RPC returns null data with no error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = { rpc } as unknown as Parameters<typeof getFreshness>[0];

    const result = await getFreshness(supabase, "user-1");
    expect(result).toEqual({ corpus_current_through: {}, generated_at: expect.any(String) });
  });
});

// ---- MINOR 5 fix (round-2 adversarial review): the stamp is now a PREFIX, ----
// ---- not a suffix — a truncating consumer reading only the START of a ----
// ---- huge payload must still see it. ----
describe("formatFreshnessPrefix", () => {
  it("returns an empty string when freshness is null", () => {
    expect(formatFreshnessPrefix(null)).toBe("");
  });

  it("returns an empty string when there are no sources", () => {
    const freshness: FreshnessPayload = { corpus_current_through: {}, generated_at: "2026-07-26T00:00:00.000Z" };
    expect(formatFreshnessPrefix(freshness)).toBe("");
  });

  it("formats a single source as a compact bracketed line using last_item_at, LEADING the text (bracket first, then a blank line)", () => {
    const freshness: FreshnessPayload = {
      corpus_current_through: { claude: { last_item_at: "2026-07-24T10:00:00.000Z", last_synced_at: null } },
      generated_at: "2026-07-26T00:00:00.000Z",
    };
    expect(formatFreshnessPrefix(freshness)).toBe("[corpus current through: claude 2026-07-24T10:00:00.000Z]\n\n");
  });

  it("joins multiple sources with a middle dot, sorted alphabetically regardless of input order", () => {
    const freshness: FreshnessPayload = {
      corpus_current_through: {
        code: { last_item_at: "2026-07-25T09:00:00.000Z", last_synced_at: null },
        claude: { last_item_at: "2026-07-24T10:00:00.000Z", last_synced_at: null },
      },
      generated_at: "2026-07-26T00:00:00.000Z",
    };
    expect(formatFreshnessPrefix(freshness)).toBe(
      "[corpus current through: claude 2026-07-24T10:00:00.000Z · code 2026-07-25T09:00:00.000Z]\n\n",
    );
  });

  it("falls back to 'unknown' for a source with a null last_item_at", () => {
    const freshness: FreshnessPayload = {
      corpus_current_through: { code: { last_item_at: null, last_synced_at: "2026-07-25T09:00:00.000Z" } },
      generated_at: "2026-07-26T00:00:00.000Z",
    };
    expect(formatFreshnessPrefix(freshness)).toBe("[corpus current through: code unknown]\n\n");
  });

  it("a truncating consumer (e.g. read only the first N chars) still sees the stamp — it's at the very start", () => {
    const freshness: FreshnessPayload = {
      corpus_current_through: { claude: { last_item_at: "2026-07-24T10:00:00.000Z", last_synced_at: null } },
      generated_at: "2026-07-26T00:00:00.000Z",
    };
    const hugePayload = "x".repeat(10_000);
    const text = formatFreshnessPrefix(freshness) + hugePayload;
    const firstNChars = text.slice(0, 50);
    expect(firstNChars).toContain("corpus current through");
  });
});

// ---- NOTE fix (round-2 adversarial review): the compact form embedded in ----
// ---- toolResult's JSON envelope — cuts ~15 pretty-printed lines to one. ----
describe("formatFreshnessCompactValue", () => {
  it("returns null when freshness is null", () => {
    expect(formatFreshnessCompactValue(null)).toBeNull();
  });

  it("returns null when there are no sources", () => {
    const freshness: FreshnessPayload = { corpus_current_through: {}, generated_at: "2026-07-26T00:00:00.000Z" };
    expect(formatFreshnessCompactValue(freshness)).toBeNull();
  });

  it("returns the compact line with NO brackets and NO surrounding whitespace (it's a JSON field value, not embedded text)", () => {
    const freshness: FreshnessPayload = {
      corpus_current_through: {
        chatgpt: { last_item_at: "2026-07-24T10:00:00.000Z", last_synced_at: null },
        claude: { last_item_at: "2026-07-25T09:00:00.000Z", last_synced_at: null },
      },
      generated_at: "2026-07-26T00:00:00.000Z",
    };
    expect(formatFreshnessCompactValue(freshness)).toBe(
      "chatgpt 2026-07-24T10:00:00.000Z · claude 2026-07-25T09:00:00.000Z",
    );
  });

  it("is significantly shorter than pretty-printing the full FreshnessPayload object", () => {
    const freshness: FreshnessPayload = {
      corpus_current_through: {
        claude: { last_item_at: "2026-07-24T10:00:00.000Z", last_synced_at: "2026-07-25T00:00:00.000Z" },
      },
      generated_at: "2026-07-26T00:00:00.000Z",
    };
    const compact = formatFreshnessCompactValue(freshness) ?? "";
    const fullPrettyPrinted = JSON.stringify(freshness, null, 2);
    expect(compact.length).toBeLessThan(fullPrettyPrinted.length / 2);
  });
});

describe("isSourceStale", () => {
  const NOW = new Date("2026-07-26T12:00:00.000Z");

  it("code: fresh just under the 2h threshold", () => {
    const lastSyncedAt = new Date(NOW.getTime() - (CODE_STALE_MS - 60_000)).toISOString();
    expect(isSourceStale("code", lastSyncedAt, NOW)).toBe(false);
  });

  it("code: stale just over the 2h threshold", () => {
    const lastSyncedAt = new Date(NOW.getTime() - (CODE_STALE_MS + 60_000)).toISOString();
    expect(isSourceStale("code", lastSyncedAt, NOW)).toBe(true);
  });

  it("chat (claude/chatgpt/grok): fresh just under the 7d threshold", () => {
    const lastSyncedAt = new Date(NOW.getTime() - (CHAT_STALE_MS - 60_000)).toISOString();
    expect(isSourceStale("claude", lastSyncedAt, NOW)).toBe(false);
    expect(isSourceStale("chatgpt", lastSyncedAt, NOW)).toBe(false);
    expect(isSourceStale("grok", lastSyncedAt, NOW)).toBe(false);
  });

  it("chat: stale just over the 7d threshold", () => {
    const lastSyncedAt = new Date(NOW.getTime() - (CHAT_STALE_MS + 60_000)).toISOString();
    expect(isSourceStale("claude", lastSyncedAt, NOW)).toBe(true);
  });

  it("a missing last_synced_at (no confirmed run) is stale for any source", () => {
    expect(isSourceStale("code", null, NOW)).toBe(true);
    expect(isSourceStale("claude", null, NOW)).toBe(true);
  });

  it("an unparseable timestamp is treated as stale, not a thrown error", () => {
    expect(isSourceStale("code", "not-a-date", NOW)).toBe(true);
  });
});

describe("shapePulseFreshness", () => {
  const NOW = new Date("2026-07-26T12:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
  const STALE_CHAT = new Date(NOW.getTime() - (CHAT_STALE_MS + 60_000)).toISOString();
  const STALE_CODE = new Date(NOW.getTime() - (CODE_STALE_MS + 60_000)).toISOString();

  it("collapses claude/chatgpt/grok into a single 'Chat' row using the freshest last_item_at", () => {
    const freshness: FreshnessMap = {
      claude: { last_item_at: "2026-07-20T00:00:00.000Z", last_synced_at: FRESH },
      chatgpt: { last_item_at: "2026-07-24T00:00:00.000Z", last_synced_at: FRESH },
    };
    const rows = shapePulseFreshness(freshness, NOW);
    const chatRow = rows.find((r) => r.key === "chat");
    expect(chatRow).toBeDefined();
    expect(chatRow?.currentThroughIso).toBe("2026-07-24T00:00:00.000Z");
    expect(chatRow?.stale).toBe(false);
  });

  it("marks the Chat row stale when ANY present chat source is stale", () => {
    const freshness: FreshnessMap = {
      claude: { last_item_at: "2026-07-01T00:00:00.000Z", last_synced_at: STALE_CHAT },
      chatgpt: { last_item_at: "2026-07-24T00:00:00.000Z", last_synced_at: FRESH },
    };
    const rows = shapePulseFreshness(freshness, NOW);
    expect(rows.find((r) => r.key === "chat")?.stale).toBe(true);
  });

  it("omits the Chat row entirely when no chat source is present", () => {
    const freshness: FreshnessMap = { code: { last_item_at: "2026-07-26T00:00:00.000Z", last_synced_at: FRESH } };
    const rows = shapePulseFreshness(freshness, NOW);
    expect(rows.find((r) => r.key === "chat")).toBeUndefined();
  });

  it("adds a Code row using the code-specific staleness threshold", () => {
    const freshness: FreshnessMap = { code: { last_item_at: "2026-07-26T10:00:00.000Z", last_synced_at: STALE_CODE } };
    const rows = shapePulseFreshness(freshness, NOW);
    const codeRow = rows.find((r) => r.key === "code");
    expect(codeRow).toEqual({ key: "code", label: "Code", currentThroughIso: "2026-07-26T10:00:00.000Z", stale: true });
  });

  it("omits Code entirely when there is no code data", () => {
    const freshness: FreshnessMap = { claude: { last_item_at: "2026-07-24T00:00:00.000Z", last_synced_at: FRESH } };
    const rows = shapePulseFreshness(freshness, NOW);
    expect(rows.find((r) => r.key === "code")).toBeUndefined();
  });

  it("returns an empty array for an empty freshness map", () => {
    expect(shapePulseFreshness({}, NOW)).toEqual([]);
  });

  // ---- MINOR 1 fix (adversarial review): compare epoch millis, not raw ISO strings ----

  it("picks the chronologically-latest last_item_at across mixed timezone-offset formats, not the lexically-largest string", () => {
    // Absolute time: claude = 2026-07-25T04:00:00Z (later); chatgpt = 2026-07-24T23:30:00Z (earlier).
    // Lexically, though, "23:00:00-05:00" < "23:30:00Z" (naive string compare would pick chatgpt — wrong).
    const freshness: FreshnessMap = {
      claude: { last_item_at: "2026-07-24T23:00:00-05:00", last_synced_at: FRESH },
      chatgpt: { last_item_at: "2026-07-24T23:30:00Z", last_synced_at: FRESH },
    };
    const rows = shapePulseFreshness(freshness, NOW);
    expect(rows.find((r) => r.key === "chat")?.currentThroughIso).toBe("2026-07-24T23:00:00-05:00");
  });
});

// ---- getFreshnessForUser (MAJOR 3 fix, adversarial review) ----
//
// getFreshnessServiceClient()-style client construction from env vars throws
// SYNCHRONOUSLY when they're missing — if that construction happened while
// still being evaluated as an argument to getFreshness(...), the throw
// escaped a trailing `.catch()` entirely (a hard 500 on /pulse, the actual
// bug this fixes). getFreshnessForUser wraps both the construction and the
// call in one try/catch so every failure mode degrades to null.
describe("getFreshnessForUser", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    mockCreateClient.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it("returns the freshness payload on the happy path", async () => {
    const payload = { corpus_current_through: {}, generated_at: "2026-07-26T00:00:00.000Z" };
    mockCreateClient.mockReturnValueOnce({ rpc: vi.fn().mockResolvedValue({ data: {}, error: null }) });

    const result = await getFreshnessForUser("user-1");
    expect(result?.corpus_current_through).toEqual(payload.corpus_current_through);
  });

  it("degrades to null (does NOT throw) when SUPABASE_SERVICE_ROLE_KEY is missing — the MAJOR 3 regression case", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(getFreshnessForUser("user-1")).resolves.toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("degrades to null when NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await expect(getFreshnessForUser("user-1")).resolves.toBeNull();
  });

  it("degrades to null when createClient itself throws", async () => {
    mockCreateClient.mockImplementationOnce(() => {
      throw new Error("bad client");
    });
    await expect(getFreshnessForUser("user-1")).resolves.toBeNull();
  });

  it("degrades to null when the RPC rejects", async () => {
    mockCreateClient.mockReturnValueOnce({ rpc: vi.fn().mockRejectedValue(new Error("rpc unavailable")) });
    await expect(getFreshnessForUser("user-1")).resolves.toBeNull();
  });
});
