// Route contract harness (G0 step 0.4). Test files mock the four externals with
// the factories in ./boundary, call `setupRouteGolden()` once, then invoke
// route handlers directly through `callRoute` and compare against committed
// files with `toMatchFileSnapshot` (CI=true never writes; record with -u).
import { FIXED_CLOCK_ISO, type RpcHandler } from "@membral/test-kit";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, vi } from "vitest";
import * as boundary from "./boundary";
import { resetCryptoSeq } from "./crypto-mock";

export { API_KEY, AUTH_COOKIE, GOOD_OAUTH_CODE, PROJECT_ID, SCOPED_KEY, USER_ID, USER_JWT } from "./boundary";

/** Fixed env every route file sees. OPENAI_API_KEY is empty so no LLM path runs. */
export const GOLDEN_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "http://supabase.golden.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "golden-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "golden-service-key",
  NEXT_PUBLIC_APP_URL: "http://localhost:3001",
  OPENAI_API_KEY: "",
  MEMBRAL_SIGNUPS_DISABLED: "",
};

const HEADER_SUBSET = [
  "content-type",
  "cache-control",
  "www-authenticate",
  "retry-after",
  "x-request-id",
  "location",
  "vary",
];

export type AuthAs = "none" | "jwt" | "key" | "scoped-key" | "bad-jwt" | "bad-key" | "cookie";

export interface CallOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** A string is sent verbatim; anything else is JSON-encoded. */
  body?: unknown;
  as?: AuthAs;
  ctx?: unknown;
}

export interface RouteResult {
  status: number;
  headers: Record<string, string>;
  afterCalls: number;
  body: string;
}

export function setupRouteGolden(extraRpc: () => Record<string, RpcHandler> = () => ({})): void {
  beforeEach(() => {
    for (const [k, v] of Object.entries(GOLDEN_ENV)) vi.stubEnv(k, v);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(FIXED_CLOCK_ISO) });
    let uuid = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () =>
        `00000000-0000-4000-a000-${String(++uuid).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetCryptoSeq();
    boundary.reset(extraRpc());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
}

function authHeaders(as: AuthAs | undefined): Record<string, string> {
  switch (as) {
    case "jwt":
      return { authorization: `Bearer ${boundary.USER_JWT}` };
    case "key":
      return { authorization: `Bearer ${boundary.API_KEY}` };
    case "scoped-key":
      return { authorization: `Bearer ${boundary.SCOPED_KEY}` };
    case "bad-jwt":
      return { authorization: "Bearer jwt-not-a-user" };
    case "bad-key":
      return { authorization: "Bearer lls_not_a_real_key" };
    case "cookie":
      boundary.setCookie(boundary.AUTH_COOKIE, boundary.USER_JWT);
      return {};
    default:
      return {};
  }
}

async function flush(): Promise<void> {
  // Fire-and-forget writes (mirror, alias seed, last_used_at) settle before the op log is read.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

// biome-ignore lint/suspicious/noExplicitAny: route handlers have varied signatures
type RouteHandler = (...args: any[]) => Promise<Response> | Response;

export async function callRoute(handler: RouteHandler, opts: CallOptions): Promise<RouteResult> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { ...authHeaders(opts.as), ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  const req = new NextRequest(`http://localhost:3001${opts.path}`, { method, headers, body });
  const res = opts.ctx === undefined ? await handler(req) : await handler(req, opts.ctx);
  const text = await res.text();
  await flush();
  const picked: Record<string, string> = {};
  const names = [...res.headers.keys()].sort();
  for (const name of names) {
    if (HEADER_SUBSET.includes(name) || name.startsWith("access-control-"))
      picked[name] = res.headers.get(name) as string;
  }
  return { status: res.status, headers: picked, afterCalls: boundary.afterCallCount(), body: text };
}

/** `<name>.json` next to the test file: status, header subset, after() count, body text. */
export async function expectContract(name: string, result: RouteResult): Promise<void> {
  await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./${name}.json`);
}

/** `<name>.oplog.json`: every write (and rpc) the fake saw during the test, in order. Reads are recorded
 * too now (boundary's `recordReads: true`, lock-extend 3B-2) but filtered out here, with `seq`
 * renumbered 1..n over the remaining writes exactly as it was before reads shared the same counter,
 * so every existing `.oplog.json` stays byte-identical; see `expectReadLog` for the reads. */
export async function expectOplog(name: string): Promise<void> {
  const writes = boundary
    .db()
    .oplog.filter((op) => op.op !== "select")
    .map((op, i) => ({ ...op, seq: i + 1 }));
  await expect(`${JSON.stringify(writes, null, 2)}\n`).toMatchFileSnapshot(`./${name}.oplog.json`);
}

/**
 * `<name>.readlog.json`: every `select` chain the fake saw during the test, in order, with `seq`
 * renumbered 1..n (independent of interleaved writes) so the read log is stable on its own.
 * Lock-extend 3B-2: records today's direct `code_sessions`/`api_keys` reads before they move into
 * repository functions in 3B-3/3B-4.
 */
export async function expectReadLog(name: string): Promise<void> {
  const reads = boundary
    .db()
    .oplog.filter((op) => op.op === "select")
    .map((op, i) => ({ ...op, seq: i + 1 }));
  await expect(`${JSON.stringify(reads, null, 2)}\n`).toMatchFileSnapshot(`./${name}.readlog.json`);
}

export const db = boundary.db;
export const setRateLimitAllowed = boundary.setRateLimitAllowed;
export const forceError = boundary.forceError;
