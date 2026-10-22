import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInsert = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: vi.fn(() => ({ insert: mockInsert })) })),
}));

const mockWarn = vi.fn();
vi.mock("@/lib/log", () => ({ log: { warn: (...a: unknown[]) => mockWarn(...a) } }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import {
  INSTRUMENTED,
  instrumentServer,
  type McpToolCallRow,
  parseUserAgent,
  sanitizeArgs,
  summarizeResult,
} from "../telemetry";

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function text(t: string, isError?: boolean) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) };
}

function setup(
  handler: (args: Record<string, unknown>) => Promise<unknown>,
  sinkImpl?: (row: McpToolCallRow) => Promise<void>,
) {
  const server = new McpServer({ name: "t", version: "0" });
  const rows: McpToolCallRow[] = [];
  const waited: Promise<unknown>[] = [];
  instrumentServer(server, "user-1", {
    apiKeyId: "key-1",
    sink:
      sinkImpl ??
      (async (row) => {
        rows.push(row);
      }),
    waitUntil: (p) => waited.push(p),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test registers a minimal tool
  server.registerTool("search_conversations", { inputSchema: {} as any }, handler as any);
  const registered = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
  const call = async (args: Record<string, unknown>, extra: unknown = {}) => {
    const out = await registered["search_conversations"].handler(args, extra);
    await Promise.all(waited);
    return out;
  };
  return { rows, call, handler: registered["search_conversations"].handler };
}

describe("instrumentServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the registered handler as instrumented", () => {
    const { handler } = setup(async () => text("{}"));
    expect(INSTRUMENTED.has(handler)).toBe(true);
  });

  it("records ok, latency, result ids and count for a toolResult-shaped payload", async () => {
    const payload = { freshness: "fresh", data: [{ id: "a" }, { id: "b", session_id: "s-b" }] };
    const { rows, call } = setup(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return text(JSON.stringify(payload));
    });
    const out = await call({ query: "q", limit: 5 });
    expect(out.content[0].text).toBe(JSON.stringify(payload));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      user_id: "user-1",
      api_key_id: "key-1",
      tool: "search_conversations",
      ok: true,
      error: null,
      result_count: 2,
      result_ids: ["a", "b", "s-b"],
      degraded: false,
      paged: false,
      args: { query: "q", limit: 5 },
    });
    expect(row.latency_ms).toBeGreaterThanOrEqual(10);
    expect(row.result_chars).toBe(JSON.stringify(payload).length);
  });

  it("records ok=false with a short error on isError", async () => {
    const { rows, call } = setup(async () => text(`Invalid since: ${"x".repeat(500)}`, true));
    const out = await call({});
    expect(out.isError).toBe(true);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error?.startsWith("Invalid since")).toBe(true);
    expect(rows[0].error?.length).toBe(300);
  });

  it("records ok=false on throw and rethrows the original error", async () => {
    const { rows, call } = setup(async () => {
      throw new Error("boom");
    });
    await expect(call({})).rejects.toThrow("boom");
    expect(rows[0]).toMatchObject({ ok: false, error: "boom", result_chars: 0 });
  });

  it("detects degraded (JSON field and SEARCH DEGRADED text) and paged (next_start)", async () => {
    const degradedJson = setup(async () =>
      text(JSON.stringify({ freshness: "f", data: { records: [{ id: "m1" }], degraded: "SEARCH DEGRADED: x" } })),
    );
    await degradedJson.call({});
    expect(degradedJson.rows[0]).toMatchObject({ degraded: true, result_ids: ["m1"], result_count: 1 });

    const degradedText = setup(async () => text("SEARCH DEGRADED: keyword-only"));
    await degradedText.call({});
    expect(degradedText.rows[0].degraded).toBe(true);

    const paged = setup(async () => text(JSON.stringify({ freshness: "f", data: { messages: [], next_start: 40 } })));
    await paged.call({});
    expect(paged.rows[0]).toMatchObject({ paged: true, result_ids: null });

    const lastPart = setup(async () =>
      text(JSON.stringify({ freshness: "f", data: { messages: [], next_start: null } })),
    );
    await lastPart.call({});
    expect(lastPart.rows[0].paged).toBe(false);
  });

  it("parses JSON after a freshness prefix line", async () => {
    const { rows, call } = setup(async () =>
      text(`[corpus current through: chats 2m ago]\n\n${JSON.stringify({ records: [{ id: "r1" }] })}`),
    );
    await call({});
    expect(rows[0].result_ids).toEqual(["r1"]);
  });

  it("caps result_ids at 20", async () => {
    const list = Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}` }));
    const { rows, call } = setup(async () => text(JSON.stringify({ freshness: "f", data: list })));
    await call({});
    expect(rows[0].result_ids).toHaveLength(20);
    expect(rows[0].result_count).toBe(30);
  });

  it("a failing sink never breaks the tool response and logs a warning", async () => {
    const { call } = setup(
      async () => text('{"ok":true}'),
      async () => {
        throw new Error("insert refused");
      },
    );
    const out = await call({});
    expect(out.content[0].text).toBe('{"ok":true}');
    expect(mockWarn).toHaveBeenCalledWith(
      "mcp tool-call telemetry insert failed",
      expect.objectContaining({ error: "insert refused" }),
    );
  });

  it("the default sink inserts into mcp_tool_calls; a Supabase error is logged, not thrown", async () => {
    mockInsert.mockResolvedValue({ error: { message: "permission denied" } });
    const server = new McpServer({ name: "t", version: "0" });
    const waited: Promise<unknown>[] = [];
    instrumentServer(server, "user-1", { waitUntil: (p) => waited.push(p) });
    // biome-ignore lint/suspicious/noExplicitAny: test registers a minimal tool
    server.registerTool("list_code_projects", { inputSchema: {} as any }, (async () => text("[]")) as any);
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })
      ._registeredTools;
    const out = await registered["list_code_projects"].handler({}, {});
    await Promise.all(waited);
    expect(out.content[0].text).toBe("[]");
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ tool: "list_code_projects", api_key_id: null }));
    expect(mockWarn).toHaveBeenCalledWith(
      "mcp tool-call telemetry insert failed",
      expect.objectContaining({ error: "permission denied" }),
    );
  });

  it("takes the client from User-Agent when initialize was not seen", async () => {
    const { rows, call } = setup(async () => text("[]"));
    await call({}, { requestInfo: { headers: { "user-agent": "opencode/0.9.1 ai-sdk" } } });
    expect(rows[0]).toMatchObject({ client_name: "opencode", client_version: "0.9.1" });
  });
});

describe("sanitizeArgs", () => {
  it("drops recall_token and secret-looking keys, truncates query to 200", () => {
    const out = sanitizeArgs({
      query: "q".repeat(500),
      recall_token: "rt_abc",
      api_key: "lls_x",
      secret: "s",
      limit: 10,
      include_tool_io: true,
      since: "2026-09-24",
      id: "conv-1",
      session_id: "sess-1",
    });
    expect(out).toEqual({
      query: "q".repeat(200),
      limit: 10,
      include_tool_io: true,
      since: "2026-09-24",
      id: "conv-1",
      session_id: "sess-1",
    });
  });

  it("drops objects and unlisted free text; keeps short arrays of listed params", () => {
    expect(
      sanitizeArgs({ assertion: { a: 1 }, statement: "free text", kind: ["decision", "rule"], topic: "t" }),
    ).toEqual({ kind: ["decision", "rule"], topic: "t" });
    expect(sanitizeArgs({})).toBeNull();
    expect(sanitizeArgs(undefined)).toBeNull();
  });
});

describe("summarizeResult / parseUserAgent", () => {
  it("counts result chars across content blocks", () => {
    expect(summarizeResult(text("hello")).result_chars).toBe(5);
  });

  it("parses User-Agent strings", () => {
    expect(parseUserAgent("claude-code/2.0.14 (cli)")).toEqual({ name: "claude-code", version: "2.0.14" });
    expect(parseUserAgent("node")).toEqual({ name: "node", version: null });
    expect(parseUserAgent(undefined)).toEqual({ name: null, version: null });
  });
});
