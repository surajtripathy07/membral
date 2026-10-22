import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockValidateApiKey = vi.fn();
vi.mock("@/lib/api-keys", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

// #172: the route-level per-IP `mcpTest` limit runs on every call (withRoute).
const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args) };
});

import { POST } from "../route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/mcp/test", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

function sseToolsBody(names: string[]): string {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    result: { tools: names.map((name) => ({ name })) },
  };
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe("POST /api/mcp/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 9 });
  });

  it("checks the per-IP mcpTest bucket on every call, before reading the body", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 42, remaining: 0 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ apiKey: "lls_goodkey" }));

    expect(mockEnforceRateLimit).toHaveBeenCalledWith("mcpTest", "mcpTest:ip:203.0.113.7");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(mockValidateApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("threads the client IP into validateApiKey (failed-key throttle) and answers its 429 with Retry-After", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: false, rateLimited: true, retryAfter: 33 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ apiKey: "lls_guess" }));

    expect(mockValidateApiKey).toHaveBeenCalledWith("lls_guess", "203.0.113.7");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("33");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed (non-lls_) key without touching the MCP server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ apiKey: "not-a-real-key" }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(mockValidateApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports failure for an invalid key and does not ping the MCP endpoint", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ apiKey: "lls_badkey" }));

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data).toEqual({ ok: false, error: "API key is not valid." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports success with the tool count on a real 200 + tools response", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: true, userId: "user-1" });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(sseToolsBody(["search_conversations", "get_conversation", "weekly_digest"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ apiKey: "lls_goodkey" }));

    const data = await res.json();
    expect(data).toEqual({ ok: true, toolCount: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/mcp");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer lls_goodkey");
    expect(headers.Accept).toContain("application/json");
    expect(headers.Accept).toContain("text/event-stream");
    const sent = JSON.parse(init.body as string);
    expect(sent.method).toBe("tools/list");
  });

  it("parses a plain-JSON (non-SSE) tools response", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: true, userId: "user-1" });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ apiKey: "lls_goodkey" }));

    const data = await res.json();
    expect(data).toEqual({ ok: true, toolCount: 1 });
  });

  it("reports failure when the MCP endpoint returns a non-200", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: true, userId: "user-1" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ apiKey: "lls_goodkey" }));

    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/401/);
  });

  it("fetches NEXT_PUBLIC_APP_URL's /api/mcp, never the (spoofable) request Host", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.codehub.test/");
    mockValidateApiKey.mockResolvedValueOnce({ valid: true, userId: "user-1" });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(sseToolsBody(["a"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new NextRequest("http://attacker.internal:8080/api/mcp/test", {
      method: "POST",
      headers: { "content-type": "application/json", host: "169.254.169.254" },
      body: JSON.stringify({ apiKey: "lls_goodkey" }),
    });
    await POST(req);

    expect(fetchMock.mock.calls[0][0]).toBe("https://app.codehub.test/api/mcp");
    vi.unstubAllEnvs();
  });

  it("does not echo the fetch error detail when the MCP endpoint is unreachable", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: true, userId: "user-1" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await POST(makeRequest({ apiKey: "lls_goodkey" }));

    expect(await res.json()).toEqual({ ok: false, error: "Could not reach the MCP endpoint." });
  });

  it("reports failure when the response carries no tools array", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: true, userId: "user-1" });
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`;
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ apiKey: "lls_goodkey" }));

    const data = await res.json();
    expect(data.ok).toBe(false);
  });
});
