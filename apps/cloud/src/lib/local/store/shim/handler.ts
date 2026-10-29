// The in-process PostgREST shim for the embedded store (docs/design/2026-10-25_docker-free-store.md, rung two).
// supabase-js builds a Request for /rest/v1/...; serverSupabaseFetch() hands it here instead of to the network.
// There is NO HTTP route for this: the shim is reachable only from code in this process.
//
// Per request: verify the HS256 JWT, then run everything in ONE store transaction as the token's role with its
// claims set, so row-level security sees the same thing it sees behind real PostgREST. A response of 400 or above
// rolls the transaction back (a write whose `.single()` check fails must not stay applied).
import { verifyJwt } from "../../auth-stub/jwt";
import type { StoreHandle, StoreTx } from "../types";
import { IDENT, type ParsedQuery, parsePrefer, parseQuery, parseSelect, RestError, unsupported } from "./parse";
import { FN_SQL, type FnInfo, fnFromRow, resolveOverload, rpcSql } from "./rpc";
import {
  type Built,
  countSql,
  deleteSql,
  FK_SQL,
  type Fk,
  fkFromRow,
  hasEmbed,
  insertSql,
  selectSql,
  updateSql,
  type WriteResult,
} from "./sql";

const BASE = "/rest/v1";
const ROLES = new Set(["anon", "authenticated", "service_role"]);
const SLOW_MS = 2000;
const OBJECT_ACCEPT = "vnd.pgrst.object";

interface Cache {
  fks?: Fk[];
  fns: Map<string, FnInfo[]>;
  pks: Map<string, string[]>;
}
const caches = new WeakMap<StoreHandle, Cache>();
function cacheFor(store: StoreHandle): Cache {
  let c = caches.get(store);
  if (!c) {
    c = { fns: new Map(), pks: new Map() };
    caches.set(store, c);
  }
  return c;
}

const HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}
const empty = (status: number, extra: Record<string, string> = {}) => new Response(null, { status, headers: extra });

function errorBody(code: string, message: string, details: string | null = null, hint: string | null = null) {
  return { code, message, details, hint };
}

const PG_STATUS: Record<string, number> = { "23505": 409, "23503": 409, "42P01": 404, "25006": 405, "42883": 404 };
function pgStatus(code: string, role: string): number {
  if (code === "42501") return role === "anon" ? 401 : 403;
  if (PG_STATUS[code]) return PG_STATUS[code] as number;
  return 400;
}

function toResponse(e: unknown, role: string): Response {
  if (e instanceof RestError) return json(e.status, errorBody(e.code, e.message, e.details, e.hint));
  const err = e as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown };
  const sqlstate = typeof err.code === "string" && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null;
  const message = typeof err.message === "string" ? err.message : "Unexpected error";
  if (!sqlstate) return json(500, errorBody("PGRST000", message));
  return json(
    pgStatus(sqlstate, role),
    errorBody(
      sqlstate,
      message,
      typeof err.detail === "string" ? err.detail : null,
      typeof err.hint === "string" ? err.hint : null,
    ),
  );
}

/** Thrown inside the transaction callback to roll it back while still returning a response. */
class Rollback {
  constructor(readonly response: Response) {}
}

function contentRange(from: number, n: number, total: number): string {
  return n > 0 ? `${from}-${from + n - 1}/${total}` : `*/${total}`;
}

function rejectUnsupportedHeaders(prefer: Record<string, string>, accept: string): void {
  if (prefer.missing === "default") throw unsupported("Prefer: missing=default");
  if (prefer.tx) throw unsupported("Prefer: tx");
  if ("handling" in prefer || "max-affected" in prefer) throw unsupported("Prefer: handling / max-affected");
  if (prefer.params) throw unsupported("Prefer: params");
  if (/text\/csv|vnd\.pgrst\.plan|geo\+json|octet-stream/.test(accept)) throw unsupported(`Accept: ${accept}`);
}

async function loadFks(tx: StoreTx, cache: Cache): Promise<Fk[]> {
  if (!cache.fks) cache.fks = (await tx.query(FK_SQL)).rows.map(fkFromRow);
  return cache.fks;
}

async function loadPk(tx: StoreTx, cache: Cache, table: string): Promise<string[]> {
  const hit = cache.pks.get(table);
  if (hit) return hit;
  const r = await tx.query(
    `select a.attname as col from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indisprimary and i.indrelid = ('public.' || quote_ident($1::text))::regclass order by array_position(i.indkey::int2[], a.attnum)`,
    [table],
  );
  const pk = r.rows.map((x) => String(x.col));
  cache.pks.set(table, pk);
  return pk;
}

async function loadFns(tx: StoreTx, cache: Cache, name: string): Promise<FnInfo[]> {
  const hit = cache.fns.get(name);
  if (hit) return hit;
  const r = await tx.query(FN_SQL, [name]);
  const fns = r.rows.map((row) => fnFromRow(name, row));
  if (fns.length) cache.fns.set(name, fns);
  return fns;
}

const run = (tx: StoreTx, b: Built) => tx.query(b.sql, b.params);

function singleResponse(rows: unknown[], status: number, extra: Record<string, string>): Response {
  if (rows.length !== 1) {
    return json(
      406,
      errorBody(
        "PGRST116",
        "JSON object requested, multiple (or no) rows returned",
        `The result contains ${rows.length} rows`,
      ),
      extra,
    );
  }
  return json(status, rows[0], extra);
}

// ---- rpc ------------------------------------------------------------------------------------------------------

async function handleRpc(
  tx: StoreTx,
  cache: Cache,
  fnName: string,
  req: Request,
  url: URL,
  prefer: Record<string, string>,
  accept: string,
): Promise<Response> {
  const method = req.method.toUpperCase();
  let args: Record<string, unknown> = {};
  const fromQuery = method === "GET" || method === "HEAD";
  if (fromQuery) {
    for (const [k] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(k)) throw unsupported(`"${k}" on an rpc result`);
    }
    args = Object.fromEntries(url.searchParams.entries());
  } else {
    if ([...url.searchParams.keys()].length) throw unsupported("query-string filters on an rpc result");
    const text = await req.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new RestError(400, "PGRST102", "Empty or invalid json");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RestError(400, "PGRST102", "rpc arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  }
  const fn = resolveOverload(fnName, await loadFns(tx, cache, fnName), Object.keys(args));
  const r = await run(tx, rpcSql(fn, args, fromQuery));
  const d = (r.rows[0]?.d ?? null) as unknown;
  const extra: Record<string, string> = {};
  if (prefer.count) {
    const n = Array.isArray(d) ? d.length : d === null ? 0 : 1;
    extra["content-range"] = contentRange(0, n, n);
  }
  if (method === "HEAD") return empty(200, extra);
  if (fn.returns === "void") return empty(204, extra);
  if (accept.includes(OBJECT_ACCEPT) && Array.isArray(d)) return singleResponse(d, 200, extra);
  return json(200, d, extra);
}

// ---- reads ----------------------------------------------------------------------------------------------------

async function handleRead(
  tx: StoreTx,
  cache: Cache,
  table: string,
  method: string,
  pq: ParsedQuery,
  prefer: Record<string, string>,
  accept: string,
): Promise<Response> {
  const items = parseSelect(pq.select);
  const fks = hasEmbed(items) ? await loadFks(tx, cache) : [];
  const rowsQuery = selectSql(table, pq, items, fks);
  const wantCount = !!prefer.count;
  const total = wantCount ? Number((await run(tx, countSql(table, pq, items, fks))).rows[0]?.n ?? 0) : null;
  const from = pq.offset ?? 0;
  if (method === "HEAD")
    return empty(200, total === null ? {} : ({ "content-range": `*/${total}` } as Record<string, string>));
  const rows = ((await run(tx, rowsQuery)).rows[0]?.d ?? []) as unknown[];
  const extra: Record<string, string> =
    total === null ? {} : { "content-range": contentRange(from, rows.length, total) };
  if (accept.includes(OBJECT_ACCEPT)) return singleResponse(rows, 200, extra);
  return json(200, rows, extra);
}

// ---- writes ---------------------------------------------------------------------------------------------------

async function handleWrite(
  tx: StoreTx,
  cache: Cache,
  table: string,
  req: Request,
  method: string,
  pq: ParsedQuery,
  prefer: Record<string, string>,
  accept: string,
): Promise<Response> {
  const rep = prefer.return === "representation";
  const result: WriteResult = rep ? { mode: "rows", items: parseSelect(pq.select) } : { mode: "count" };
  const wantCount = !!prefer.count;
  const status = method === "POST" ? 201 : rep ? 200 : 204;
  let built: Built;
  if (method === "POST") {
    const rows = await readJsonRows(req);
    if (!rows.length) return rep ? json(201, []) : empty(201);
    const resolution = prefer.resolution;
    const pk =
      (resolution === "merge-duplicates" || resolution === "ignore-duplicates") && !pq.onConflict
        ? await loadPk(tx, cache, table)
        : [];
    built = insertSql(table, rows, pq, { resolution, pk }, result);
  } else if (method === "PATCH") {
    const body = await readJson(req);
    if (body === null || typeof body !== "object" || Array.isArray(body))
      throw new RestError(400, "PGRST102", "An update body must be a JSON object");
    built = updateSql(table, body as Record<string, unknown>, pq, result);
  } else {
    built = deleteSql(table, pq, result);
  }
  const r = await run(tx, built);
  if (!rep) {
    const n = Number(r.rows[0]?.n ?? 0);
    return empty(status, wantCount ? { "content-range": contentRange(0, n, n) } : ({} as Record<string, string>));
  }
  const rows = (r.rows[0]?.d ?? []) as unknown[];
  const extra: Record<string, string> = wantCount ? { "content-range": contentRange(0, rows.length, rows.length) } : {};
  if (accept.includes(OBJECT_ACCEPT)) return singleResponse(rows, status, extra);
  return json(status, rows, extra);
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new RestError(400, "PGRST102", "Empty or invalid json");
  }
}

async function readJsonRows(req: Request): Promise<Record<string, unknown>[]> {
  const body = await readJson(req);
  const rows = Array.isArray(body) ? body : [body];
  for (const r of rows) {
    if (r === null || typeof r !== "object" || Array.isArray(r))
      throw new RestError(400, "PGRST102", "All object keys must match");
  }
  return rows as Record<string, unknown>[];
}

// ---- entry point ----------------------------------------------------------------------------------------------

export interface ShimOptions {
  jwtSecret: string;
}

export async function handleRestRequest(req: Request, store: StoreHandle, opts: ShimOptions): Promise<Response> {
  const started = Date.now();
  const method = req.method.toUpperCase();
  const url = new URL(req.url);
  try {
    return await handle(req, method, url, store, opts);
  } finally {
    const ms = Date.now() - started;
    // statement_timeout does nothing on PGlite, so a runaway query is only visible here.
    if (ms > SLOW_MS) console.warn(`[store-shim] slow request: ${method} ${url.pathname} took ${ms} ms`);
  }
}

async function handle(
  req: Request,
  method: string,
  url: URL,
  store: StoreHandle,
  opts: ShimOptions,
): Promise<Response> {
  if (!url.pathname.startsWith(`${BASE}/`)) {
    return json(404, errorBody("PGRST125", `Invalid path specified in request URL`));
  }
  const path = url.pathname.slice(BASE.length + 1);
  const authz = req.headers.get("authorization");
  // `apikey` stands in only when there is NO Authorization header; a non-Bearer one is a bad credential (401).
  const token = authz === null ? req.headers.get("apikey") : /^bearer /i.test(authz) ? authz.slice(7).trim() : null;
  const claims = token ? verifyJwt(token, opts.jwtSecret, Math.floor(Date.now() / 1000)) : null;
  if (!claims) return json(401, errorBody("PGRST301", "JWT invalid, expired or missing"));
  const role = claims.role;
  if (typeof role !== "string" || !ROLES.has(role))
    return json(401, errorBody("PGRST301", "JWT role claim is not allowed"));

  const isRead = method === "GET" || method === "HEAD";
  if (!isRead && method !== "POST" && method !== "PATCH" && method !== "DELETE") {
    return json(405, errorBody("PGRST117", `Unsupported HTTP method: ${method}`));
  }

  // Everything that needs no database is checked first, so a bad request does not queue behind the store.
  let plan: (tx: StoreTx, cache: Cache) => Promise<Response>;
  try {
    const prefer = parsePrefer(req.headers.get("prefer"));
    const accept = req.headers.get("accept") ?? "";
    rejectUnsupportedHeaders(prefer, accept);
    if (path.startsWith("rpc/")) {
      const fnName = path.slice(4);
      if (!IDENT.test(fnName))
        throw new RestError(404, "PGRST202", `Could not find the function public.${fnName} in the schema cache`);
      if (method !== "GET" && method !== "HEAD" && method !== "POST")
        throw new RestError(405, "PGRST101", "Only GET and POST are allowed on functions");
      plan = (tx, cache) => handleRpc(tx, cache, fnName, req, url, prefer, accept);
    } else {
      if (!IDENT.test(path)) throw new RestError(404, "PGRST125", "Invalid path specified in request URL");
      const pq = parseQuery([...url.searchParams.entries()]);
      plan = isRead
        ? (tx, cache) => handleRead(tx, cache, path, method, pq, prefer, accept)
        : (tx, cache) => handleWrite(tx, cache, path, req, method, pq, prefer, accept);
    }
  } catch (e) {
    return toResponse(e, role);
  }

  const cache = cacheFor(store);
  try {
    return await store.transaction(async (tx) => {
      let resp: Response;
      try {
        // PostgREST runs GET in a read-only transaction; a volatile function called by GET fails the same way here.
        if (isRead) await tx.query("set transaction read only");
        await tx.query(`set local role "${role}"`);
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
        await tx.query("set local search_path = public, extensions");
        await tx.query("set local timezone = 'UTC'");
        resp = await plan(tx, cache);
      } catch (e) {
        throw new Rollback(toResponse(e, role));
      }
      if (resp.status >= 400) throw new Rollback(resp);
      return resp;
    });
  } catch (e) {
    if (e instanceof Rollback) return e.response;
    return toResponse(e, role);
  } finally {
    if (!isRead) store.noteWrite();
  }
}
