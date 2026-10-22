// MCP tool-call telemetry (migration 098, table mcp_tool_calls).
//
// instrumentServer() replaces `server.registerTool` on the McpServer that
// createCloudMcpServer builds, before any tool is registered. Every register*
// helper receives that same server object, so every tool registered through
// registerTool is timed and recorded without the helper knowing. A tool added
// through any other path (e.g. the deprecated `server.tool()`) would skip it;
// server.test.ts asserts every registered handler is in INSTRUMENTED.
//
// Recording never blocks or breaks a tool response: the row is built inside a
// try/catch, the insert runs as a caught promise, and `waitUntil` (Next's
// `after()` from the route) only keeps the function alive until it lands.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getServiceClient } from "@/lib/db/clients";
import { log } from "@/lib/log";

export interface McpToolCallRow {
  user_id: string;
  api_key_id: string | null;
  client_name: string | null;
  client_version: string | null;
  tool: string;
  ok: boolean;
  error: string | null;
  latency_ms: number;
  result_chars: number;
  result_count: number | null;
  result_ids: string[] | null;
  degraded: boolean;
  paged: boolean;
  args: Record<string, unknown> | null;
}

export type ToolCallSink = (row: McpToolCallRow) => Promise<void>;

export interface McpTelemetryOptions {
  /** api_keys.id of the key that authenticated this request; null for a legacy profiles key or a JWT. */
  apiKeyId?: string | null;
  /** Keeps the serverless function alive until the insert settles (the route passes next/server `after`). */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Where rows go. Defaults to an insert into mcp_tool_calls with the service-role client. */
  sink?: ToolCallSink;
}

/** Every handler instrumentServer wrapped. Tests assert each registered tool's handler is in here. */
export const INSTRUMENTED = new WeakSet<object>();

const MAX_ERROR_CHARS = 300;
const MAX_QUERY_CHARS = 200;
const MAX_STRING_ARG_CHARS = 200;
const MAX_RESULT_IDS = 20;

// Free text the user typed to find something in their own corpus: kept, cut to 200 chars.
const FREE_TEXT_ARGS = new Set(["query", "topic"]);
// Short structured strings kept as-is (cut to 200 chars).
const STRING_ARGS = new Set(["since", "kind", "scope", "source", "project", "repo", "path", "id"]);
const SECRET_ARG = /token|secret|key|password|passwd|auth|credential|cookie|bearer/i;

function isIdLike(key: string): boolean {
  return key === "id" || key.endsWith("_id");
}

/**
 * The args column: numbers and booleans as passed; strings only for known
 * structured params and id-like keys; `query`/`topic` cut to 200 chars;
 * objects and other free text dropped; anything whose name looks like a
 * secret (recall_token included) dropped first.
 */
export function sanitizeArgs(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (SECRET_ARG.test(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      if (FREE_TEXT_ARGS.has(key)) out[key] = value.slice(0, MAX_QUERY_CHARS);
      else if (STRING_ARGS.has(key) || isIdLike(key)) out[key] = value.slice(0, MAX_STRING_ARG_CHARS);
    } else if (Array.isArray(value) && STRING_ARGS.has(key)) {
      const strings = value.filter((v): v is string => typeof v === "string").slice(0, 10);
      out[key] = strings.map((s) => s.slice(0, MAX_STRING_ARG_CHARS));
    }
  }
  return Object.keys(out).length ? out : null;
}

interface ToolResultLike {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}

/** Parse the JSON a tool returned, skipping the leading freshness line when the text starts with one. */
function parsePayload(text: string): unknown {
  // formatFreshnessPrefix writes "[corpus current through: ...]\n\n" before the JSON.
  const attempts = [text];
  const newline = text.indexOf("\n");
  if (newline >= 0) attempts.push(text.slice(newline + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** `{ freshness, data }` (toolResult's shape) unwraps to data; anything else is the payload itself. */
function unwrap(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in payload &&
    "freshness" in payload
  ) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

const LIST_KEYS = ["records", "results", "conversations", "items", "sessions", "projects", "rows"];

function resultList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of LIST_KEYS) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/** Ids a follow-up call could open: each row's id, plus session_id when a code hit carries a different one. */
function collectIds(list: unknown[]): string[] {
  const ids: string[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const { id, session_id } = row as { id?: unknown; session_id?: unknown };
    for (const candidate of [id, session_id]) {
      if (typeof candidate === "string" && !ids.includes(candidate)) ids.push(candidate);
    }
    if (ids.length >= MAX_RESULT_IDS) break;
  }
  return ids.slice(0, MAX_RESULT_IDS);
}

export interface ResultSummary {
  ok: boolean;
  error: string | null;
  result_chars: number;
  result_count: number | null;
  result_ids: string[] | null;
  degraded: boolean;
  paged: boolean;
}

export function summarizeResult(result: unknown): ResultSummary {
  const r = (result ?? {}) as ToolResultLike;
  const text = (r.content ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  const isError = r.isError === true;
  const summary: ResultSummary = {
    ok: !isError,
    error: isError ? text.slice(0, MAX_ERROR_CHARS) : null,
    result_chars: text.length,
    result_count: null,
    result_ids: null,
    degraded: /^SEARCH DEGRADED/m.test(text),
    paged: false,
  };
  if (isError) return summary;

  const data = unwrap(parsePayload(text));
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.degraded) summary.degraded = true;
    if (d.next_start !== undefined && d.next_start !== null) summary.paged = true;
  }
  const list = resultList(data);
  if (list) {
    summary.result_count = list.length;
    summary.result_ids = collectIds(list);
  }
  return summary;
}

type RequestExtra = { requestInfo?: { headers?: Record<string, string | string[] | undefined> } } | undefined;

/**
 * Client name/version: the MCP initialize clientInfo when this server saw it,
 * else the User-Agent header. The route is stateless (a fresh server per HTTP
 * request), so a tools/call request never carries initialize and the
 * User-Agent is what fills this in practice.
 */
export function clientInfo(server: McpServer, extra: RequestExtra): { name: string | null; version: string | null } {
  try {
    const fromInit = server.server.getClientVersion();
    if (fromInit?.name) return { name: fromInit.name.slice(0, 100), version: fromInit.version?.slice(0, 50) ?? null };
  } catch {
    // fall through to the header
  }
  const raw = extra?.requestInfo?.headers?.["user-agent"];
  const ua = Array.isArray(raw) ? raw[0] : raw;
  return parseUserAgent(ua);
}

/** "claude-code/2.0.1 (cli)" -> { name: "claude-code", version: "2.0.1" }. */
export function parseUserAgent(ua: string | undefined | null): { name: string | null; version: string | null } {
  if (!ua) return { name: null, version: null };
  const first = ua.trim().split(/\s+/)[0] ?? "";
  const slash = first.indexOf("/");
  if (slash <= 0) return { name: first.slice(0, 100) || null, version: null };
  return { name: first.slice(0, slash).slice(0, 100), version: first.slice(slash + 1).slice(0, 50) || null };
}

function defaultSink(): ToolCallSink {
  return async (row) => {
    const { error } = await getServiceClient().from("mcp_tool_calls").insert(row);
    if (error) throw new Error(error.message);
  };
}

// biome-ignore lint/suspicious/noExplicitAny: handlers take (args, extra) or (extra); the wrapper forwards whatever the SDK passes
type AnyHandler = (...a: any[]) => unknown;

/**
 * Replace `server.registerTool` so every tool registered after this call is
 * wrapped. Call it right after constructing the server, before any register*.
 */
export function instrumentServer(server: McpServer, userId: string, options: McpTelemetryOptions = {}): void {
  const sink = options.sink ?? defaultSink();
  const original = server.registerTool.bind(server);

  const record = (row: McpToolCallRow) => {
    const pending = Promise.resolve()
      .then(() => sink(row))
      .catch((err) => {
        log.warn("mcp tool-call telemetry insert failed", {
          tool: row.tool,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    try {
      options.waitUntil?.(pending);
    } catch {
      // outside a request scope (tests, scripts): the promise still runs
    }
  };

  const wrap = (tool: string, handler: AnyHandler): AnyHandler => {
    const wrapped: AnyHandler = async (...a: unknown[]) => {
      const started = performance.now();
      let result: unknown;
      let thrown: unknown;
      let didThrow = false;
      try {
        result = await handler(...a);
      } catch (err) {
        didThrow = true;
        thrown = err;
      }
      try {
        const extra = a[a.length - 1] as RequestExtra;
        const summary: ResultSummary = didThrow
          ? {
              ok: false,
              error: (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, MAX_ERROR_CHARS),
              result_chars: 0,
              result_count: null,
              result_ids: null,
              degraded: false,
              paged: false,
            }
          : summarizeResult(result);
        const client = clientInfo(server, extra);
        record({
          user_id: userId,
          api_key_id: options.apiKeyId ?? null,
          client_name: client.name,
          client_version: client.version,
          tool,
          latency_ms: Math.round(performance.now() - started),
          args: a.length > 1 ? sanitizeArgs(a[0]) : null,
          ...summary,
        });
      } catch (err) {
        log.warn("mcp tool-call telemetry skipped", { tool, error: err instanceof Error ? err.message : String(err) });
      }
      if (didThrow) throw thrown;
      return result;
    };
    INSTRUMENTED.add(wrapped);
    return wrapped;
  };

  server.registerTool = ((name: string, config: unknown, cb: AnyHandler) =>
    // biome-ignore lint/suspicious/noExplicitAny: forwards the SDK's generic registerTool signature unchanged
    (original as any)(name, config, wrap(name, cb))) as typeof server.registerTool;
}
