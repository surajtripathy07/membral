// `membral mcp`: a stdio MCP server for clients that cannot speak HTTP MCP
// (and for registries that start a server in a container with no stack).
//
// With an API key: every JSON-RPC message is forwarded to <api>/api/mcp with
// `Authorization: Bearer <key>` (the same stateless HTTP route Claude Code
// uses) and the reply, JSON or SSE, is written back as one line.
// Without a key, or when the stack is unreachable or rejects the request:
// `initialize`, `ping` and `tools/list` are answered from the manifest in
// @membral/core (drift-tested against the cloud registry), and `tools/call`
// returns an error result telling the caller to start a stack.
//
// Wire format: newline-delimited JSON-RPC (MCP stdio transport). stdout
// carries protocol messages ONLY; every diagnostic goes to stderr.
import { createInterface } from "node:readline";
import { MCP_SERVER_INFO, MCP_TOOL_MANIFEST, MCP_TOOL_MANIFEST_INSTRUCTIONS } from "@membral/core";

export const NO_STACK_MESSAGE = "no Membral stack configured; run membral local up";

// Same set as the MCP SDK's SUPPORTED_PROTOCOL_VERSIONS.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
export const KEY_REJECTED_MESSAGE =
  "Membral rejected the API key; check the key, or run membral login or membral local up";
/** initialize, ping and tools/list must answer fast, so a host that accepts but never replies falls back. */
const QUICK_TIMEOUT_MS = 4_000;
const CALL_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };

export interface McpStdioOptions {
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  log: (msg: string) => void;
  /** Empty = offline mode. */
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Test hooks; defaults are 4 s for initialize/ping/tools/list and 30 s for tools/call. */
  quickTimeoutMs?: number;
  callTimeoutMs?: number;
}

function ok(id: Rpc["id"], result: unknown): Json {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(id: Rpc["id"], code: number, message: string): Json {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Answer from the built-in manifest. Returns null for notifications. */
export function offlineReply(msg: Rpc, reason: string = NO_STACK_MESSAGE): Json | null {
  const isNotification = msg.id === undefined || msg.id === null;
  // A request without an id is a notification: it never gets a reply.
  if (isNotification) return null;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      return ok(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
        instructions: MCP_TOOL_MANIFEST_INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: MCP_TOOL_MANIFEST });
    case "tools/call":
      return ok(msg.id, { content: [{ type: "text", text: reason }], isError: true });
    default:
      return err(msg.id, -32601, `Method not found: ${msg.method ?? ""}`);
  }
}

/** Pull JSON-RPC messages out of an SSE body (`data:` lines, blank-line separated events). */
export function parseSse(body: string): Json[] {
  const out: Json[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const v = JSON.parse(data);
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    } catch {
      /* skip a malformed event */
    }
  }
  return out;
}

export async function runMcpStdio(opts: McpStdioOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const online = opts.apiUrl !== "" && opts.apiKey !== "";
  const endpoint = `${opts.apiUrl.replace(/\/+$/, "")}/api/mcp`;
  const pending = new Set<Promise<void>>();

  const emit = (m: Json) => opts.write(`${JSON.stringify(m)}\n`);

  /** Forward one message. Returns the replies, or why the stack could not serve it. */
  async function proxy(
    msg: Rpc,
  ): Promise<{ replies: Json[] } | { failed: "unreachable" | "rejected" | "http"; status?: number }> {
    const isCall = msg.method === "tools/call";
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(
          isCall ? (opts.callTimeoutMs ?? CALL_TIMEOUT_MS) : (opts.quickTimeoutMs ?? QUICK_TIMEOUT_MS),
        ),
      });
      if (res.status === 202 || res.status === 204) return { replies: [] };
      if (res.status === 401 || res.status === 403) return { failed: "rejected", status: res.status };
      if (res.status >= 500) return { failed: "unreachable", status: res.status };
      const text = await res.text();
      if (res.ok) {
        if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
          return { replies: parseSse(text) };
        }
        if (!text.trim()) return { replies: [] };
        const v = JSON.parse(text);
        return { replies: Array.isArray(v) ? v : [v] };
      }
      // Other 4xx (400, 429, ...): surface the stack's own JSON-RPC error unchanged.
      try {
        const v = JSON.parse(text);
        const list: Json[] = Array.isArray(v) ? v : [v];
        if (list.length > 0 && list.every((m) => m && typeof m === "object" && m.jsonrpc === "2.0")) {
          return { replies: list };
        }
      } catch {
        /* not JSON */
      }
      return { failed: "http", status: res.status };
    } catch (e) {
      opts.log(`membral mcp: stack unreachable (${e instanceof Error ? e.name : "error"})`);
      return { failed: "unreachable" };
    }
  }

  async function handle(msg: Rpc): Promise<void> {
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
      // A response from the client, or junk: nothing to answer.
      if (msg && typeof msg === "object" && "id" in msg && !("result" in msg) && !("error" in msg)) {
        emit(err(msg.id, -32600, "Invalid Request"));
      }
      return;
    }
    if (online) {
      const r = await proxy(msg);
      if ("replies" in r) {
        for (const m of r.replies) emit(m);
        return;
      }
      const isCall = msg.method === "tools/call";
      const hasId = msg.id !== undefined && msg.id !== null;
      if (r.failed === "rejected") {
        opts.log(`membral mcp: stack answered HTTP ${r.status}; the API key was rejected`);
        const reply = offlineReply(msg, KEY_REJECTED_MESSAGE);
        if (reply) emit(reply);
        return;
      }
      if (r.failed === "http") {
        // A non-JSON-RPC 4xx: do not claim there is no stack.
        opts.log(`membral mcp: stack answered HTTP ${r.status}`);
        if (hasId) {
          if (isCall) {
            emit(
              ok(msg.id, {
                content: [{ type: "text", text: `Membral stack answered HTTP ${r.status}` }],
                isError: true,
              }),
            );
          } else {
            emit(err(msg.id, -32603, `Membral stack answered HTTP ${r.status}`));
          }
        }
        return;
      }
      const reply = offlineReply(msg);
      if (reply) emit(reply);
      return;
    }
    const reply = offlineReply(msg);
    if (reply) emit(reply);
  }

  const rl = createInterface({ input: opts.input, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      emit(err(null, -32700, "Parse error"));
      return;
    }
    if (Array.isArray(parsed) && parsed.length === 0) {
      emit(err(null, -32600, "Invalid Request"));
      return;
    }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      const p = handle(msg as Rpc)
        .catch((e) => opts.log(`membral mcp: ${e instanceof Error ? e.message : "internal error"}`))
        .finally(() => pending.delete(p));
      pending.add(p);
    }
  });
  await new Promise<void>((resolve) => rl.once("close", resolve));
  await Promise.all(pending);
}
