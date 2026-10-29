import { PassThrough } from "node:stream";
import { MCP_TOOL_MANIFEST } from "@membral/core";
import { describe, expect, it, vi } from "vitest";
import { NO_STACK_MESSAGE, parseSse, runMcpStdio } from "../mcp-stdio.js";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

async function run(
  messages: unknown[],
  extra: {
    apiUrl?: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
    rawLines?: string[];
    quickTimeoutMs?: number;
  } = {},
) {
  const input = new PassThrough();
  const out: string[] = [];
  const logs: string[] = [];
  const done = runMcpStdio({
    input,
    write: (l) => out.push(l),
    log: (m) => logs.push(m),
    apiUrl: extra.apiUrl ?? "",
    apiKey: extra.apiKey ?? "",
    fetchImpl: extra.fetchImpl,
    quickTimeoutMs: extra.quickTimeoutMs,
  });
  for (const l of extra.rawLines ?? messages.map((m) => JSON.stringify(m))) input.write(`${l}\n`);
  input.end();
  await done;
  return { out, logs, replies: out.map((l) => JSON.parse(l)) };
}

describe("membral mcp offline (no profile, no key)", () => {
  it("answers initialize, drops the notification, and lists the 10 built-in tools", async () => {
    const { replies } = await run([
      INIT,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(replies).toHaveLength(2);
    expect(replies[0].id).toBe(1);
    expect(replies[0].result.protocolVersion).toBe("2025-03-26");
    expect(replies[0].result.capabilities).toEqual({ tools: {} });
    expect(replies[0].result.serverInfo.name).toBe("membral-cloud");
    expect(replies[1].result.tools).toHaveLength(10);
    expect(replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual(MCP_TOOL_MANIFEST.map((t) => t.name));
  });

  it("negotiates an unknown protocol version down to a supported one", async () => {
    const { replies } = await run([{ ...INIT, params: { ...INIT.params, protocolVersion: "1999-01-01" } }]);
    expect(replies[0].result.protocolVersion).toBe("2025-11-25");
  });

  it("tools/call returns an isError result; ping works; unknown method is -32601", async () => {
    const { replies } = await run([
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_search", arguments: { query: "x" } } },
      { jsonrpc: "2.0", id: 4, method: "ping" },
      { jsonrpc: "2.0", id: 5, method: "resources/list" },
      { jsonrpc: "2.0", method: "notifications/unknown" },
    ]);
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    expect(byId[3].result.isError).toBe(true);
    expect(byId[3].result.content[0].text).toBe(NO_STACK_MESSAGE);
    expect(byId[4].result).toEqual({});
    expect(byId[5].error.code).toBe(-32601);
    expect(replies).toHaveLength(3);
  });

  it("gives no reply to id-less initialize/ping/tools/list, and rejects an empty batch", async () => {
    const { replies } = await run([
      { jsonrpc: "2.0", method: "initialize", params: INIT.params },
      { jsonrpc: "2.0", method: "ping" },
      { jsonrpc: "2.0", method: "tools/list" },
      [],
    ]);
    expect(replies).toHaveLength(1);
    expect(replies[0].error.code).toBe(-32600);
  });

  it("accepts the oldest SDK protocol version", async () => {
    const { replies } = await run([{ ...INIT, params: { ...INIT.params, protocolVersion: "2024-10-07" } }]);
    expect(replies[0].result.protocolVersion).toBe("2024-10-07");
  });

  it("reports malformed JSON as -32700 and never writes non-protocol text to stdout", async () => {
    const { out, replies } = await run([], { rawLines: ["{not json", JSON.stringify(INIT)] });
    expect(replies.find((r) => r.error)?.error.code).toBe(-32700);
    for (const l of out) {
      expect(l.endsWith("\n")).toBe(true);
      expect(JSON.parse(l).jsonrpc).toBe("2.0");
    }
  });
});

describe("membral mcp proxy", () => {
  const reply = { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "hit" }] } };

  it("forwards with bearer auth and the HTTP route's Accept header, passing JSON through", async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const msg = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "memory_search", arguments: {} } };
    const { replies } = await run([msg], {
      apiUrl: "http://stack.test/",
      apiKey: "lls_fake",
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(replies).toEqual([reply]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://stack.test/api/mcp");
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer lls_fake");
    expect(h.accept).toContain("application/json");
    expect(h.accept).toContain("text/event-stream");
    expect(JSON.parse(init.body as string)).toEqual(msg);
  });

  it("reads an SSE reply and writes no reply for a 202 notification", async () => {
    const sse = `event: message\ndata: ${JSON.stringify(reply)}\n\n`;
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const { replies } = await run(
      [
        { jsonrpc: "2.0", id: 7, method: "tools/call", params: {} },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ],
      { apiUrl: "http://stack.test", apiKey: "k", fetchImpl: f as unknown as typeof fetch },
    );
    expect(replies).toEqual([reply]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("falls back to the built-in list when the stack is unreachable, and logs to stderr only", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { replies, logs } = await run(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search" } },
      ],
      { apiUrl: "http://stack.test", apiKey: "k", fetchImpl: f as unknown as typeof fetch },
    );
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    expect(byId[1].result.tools).toHaveLength(10);
    expect(byId[2].result.isError).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("401 on tools/call is a key-rejected error (not the no-stack text); on tools/list it falls back and logs the status only", async () => {
    const f = vi.fn(async () => new Response("no", { status: 401 }));
    const { replies, logs } = await run(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      { apiUrl: "http://stack.test", apiKey: "lls_secret", fetchImpl: f as unknown as typeof fetch },
    );
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    expect(byId[1].result.isError).toBe(true);
    expect(byId[1].result.content[0].text).toContain("rejected the API key");
    expect(byId[1].result.content[0].text).not.toContain("no Membral stack");
    expect(byId[2].result.tools).toHaveLength(10);
    expect(logs.some((l) => l.includes("401"))).toBe(true);
    expect(logs.join("\n")).not.toContain("lls_secret");
  });

  it("passes a JSON-RPC error body from a 429/400 through unchanged", async () => {
    const body = { jsonrpc: "2.0", id: 9, error: { code: -32000, message: "Too many requests" } };
    const f = vi.fn(
      async () => new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json" } }),
    );
    const { replies } = await run([{ jsonrpc: "2.0", id: 9, method: "tools/call", params: {} }], {
      apiUrl: "http://stack.test",
      apiKey: "k",
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(replies).toEqual([body]);
  });

  it("a non-JSON 4xx is reported as that HTTP status, a 5xx falls back to the no-stack text", async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) =>
      JSON.parse(init?.body as string).id === 1
        ? new Response("<html>", { status: 400 })
        : new Response("boom", { status: 503 }),
    );
    const { replies } = await run(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} },
      ],
      { apiUrl: "http://stack.test", apiKey: "k", fetchImpl: f as unknown as typeof fetch },
    );
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    expect(byId[1].result.content[0].text).toBe("Membral stack answered HTTP 400");
    expect(byId[2].result.content[0].text).toBe(NO_STACK_MESSAGE);
  });

  it("a host that accepts but never answers falls back for tools/list after the quick timeout", async () => {
    const f = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("timeout", "TimeoutError")));
        }),
    );
    const { replies } = await run([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], {
      apiUrl: "http://stack.test",
      apiKey: "k",
      fetchImpl: f as unknown as typeof fetch,
      quickTimeoutMs: 20,
    });
    expect(replies[0].result.tools).toHaveLength(10);
  });
});

describe("parseSse", () => {
  it("joins multi-line data and skips junk events", () => {
    expect(parseSse('data: {"a":1}\n\ndata: oops\n\n: comment\n\ndata: {"b":2}\n\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
