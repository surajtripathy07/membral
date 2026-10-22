// The four external boundaries a route contract test mocks — @supabase/supabase-js,
// @supabase/ssr, next/headers and next/server's `after` — all backed by ONE
// FakeDb per test (behaviour-lock review F4). No internal module is mocked.
// Plus two nondeterminism sources that are not domain code: global
// crypto.randomUUID (spied in harness.ts) and node's `crypto` randomBytes /
// randomInt (partially mocked via ./crypto-mock, only by test files whose route mints codes/keys).
//
// This file imports nothing from next/*: the vi.mock factories load it, and
// importing a mocked module from its own factory would recurse.
import { readFileSync } from "node:fs";
import { createFakeDb, type FakeDb, hashApiKey, type Row, type RpcHandler } from "@membral/test-kit";

export const USER_ID = "00000000-0000-4000-8000-00000000c0de";
export const USER_JWT = "jwt-golden-user";
export const API_KEY = "lls_test_golden_unscoped_key_0001";
export const SCOPED_KEY = "lls_test_golden_scoped_key_0002";
export const PROJECT_ID = "5eed0000-0000-4000-8000-000000000001";
/** api_keys row id for SCOPED_KEY (seeded below), used by /api/keys/devices/[id]. */
export const SCOPED_KEY_ID = "5eed0000-0000-4000-8000-000000000300";
export const AUTH_COOKIE = "sb-golden-auth-token";
/** The one OAuth code the fake exchanges successfully. */
export const GOOD_OAUTH_CODE = "code-ok";

const SEED: Record<string, Row[]> = JSON.parse(readFileSync(new URL("./fixtures/seed.json", import.meta.url), "utf8"));

interface State {
  db: FakeDb;
  cookies: Map<string, string>;
  afterCalls: unknown[];
  rateLimitAllowed: boolean;
  rpc: Record<string, RpcHandler>;
  /** Lock-extend 2: one-shot forced errors, keyed by table name / rpc name / a fixed sentinel. */
  forcedErrors: Map<string, { message: string; skip: number }>;
}

let state: State | null = null;

function s(): State {
  if (!state) throw new Error("boundary.reset() was not called");
  return state;
}

/** Fresh fake per test, seeded from fixtures/seed.json plus the user, both keys and `extraRpc` handlers. */
export function reset(extraRpc: Record<string, RpcHandler> = {}): FakeDb {
  let n = 0;
  const rpc: Record<string, RpcHandler> = {
    rate_limit_check: () => ({
      data: {
        allowed: s().rateLimitAllowed,
        retry_after: s().rateLimitAllowed ? 0 : 42,
        remaining: s().rateLimitAllowed ? 9 : 0,
      },
      error: null,
    }),
    // Queue RPC (migration 1xx): returns how many sessions it queued.
    memory_extraction_enqueue: (a) => ({
      data: ((a.p_requeue as unknown[]) ?? []).length + ((a.p_ensure as unknown[]) ?? []).length,
      error: null,
    }),
    project_alias_seed: () => ({ data: null, error: null }),
    ...extraRpc,
  };
  const db = createFakeDb({
    flavour: "db",
    tables: structuredClone(SEED),
    rpc,
    nextId: () => `9e4e0000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    // Lock-extend 3B-2: record `select` chains too, read back only by
    // `expectReadLog` — `expectOplog` still filters them out so every
    // existing `.oplog.json` stays byte-identical.
    recordReads: true,
  });
  db.seedUser({ id: USER_ID, email: "dev@codehub.test", jwt: USER_JWT });
  db.seedApiKey(USER_ID, API_KEY);
  // A code-project-scoped device key (api_keys table, migration 052).
  const scopedHash = hashApiKey(SCOPED_KEY);
  db.seed("api_keys", [
    {
      id: SCOPED_KEY_ID,
      user_id: USER_ID,
      key_hash: scopedHash,
      scope_node_id: null,
      scope_code_project_id: PROJECT_ID,
      device_id: null,
      revoked_at: null,
      last_used_at: null,
    },
  ]);
  state = { db, cookies: new Map(), afterCalls: [], rateLimitAllowed: true, rpc, forcedErrors: new Map() };
  return db;
}

export const db = (): FakeDb => s().db;
export const setCookie = (name: string, value: string): void => void s().cookies.set(name, value);
export const setRateLimitAllowed = (allowed: boolean): void => {
  s().rateLimitAllowed = allowed;
};
export const afterCallCount = (): number => s().afterCalls.length;

/**
 * Lock-extend 2: force the NEXT operation against `name` — a table name for a
 * `.from(table)` query, an rpc function name, or the sentinel
 * "auth.admin.deleteUser" — to fail with `message`. One-shot: consumed the
 * first time that name resolves, so it never leaks into a later call in the
 * same test. Lets a route's own generic `if (error) return 500` branches be
 * recorded without a real failure injection point elsewhere in the fake.
 * Lock-extend 2b: `skip` lets the first N resolutions of `name` pass through
 * untouched, for a route whose failing write follows earlier reads of the
 * same table (e.g. /api/sync's bulk upsert after its quota/lookup reads).
 */
export const forceError = (name: string, message = "boundary: forced error", skip = 0): void => {
  s().forcedErrors.set(name, { message, skip });
};

function takeForcedError(name: string): { message: string } | null {
  const forced = s().forcedErrors.get(name);
  if (forced === undefined) return null;
  if (forced.skip > 0) {
    forced.skip--;
    return null;
  }
  s().forcedErrors.delete(name);
  return { message: forced.message };
}

// --- select-column projection ------------------------------------------------
// The fake returns whole rows whatever `.select(cols)` names; PostgREST returns
// only the named columns. Bodies that echo rows would otherwise lock fake
// behaviour, so plain column lists are projected here (missing column -> null).
// Embeds, aliases, casts and `*` are left unprojected.

function parseCols(cols: unknown): string[] | null {
  if (typeof cols !== "string") return null;
  if (/[*():!]/.test(cols)) return null;
  const list = cols
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function pick(row: unknown, cols: string[]): unknown {
  if (!row || typeof row !== "object") return row;
  const out: Row = {};
  for (const c of cols) out[c] = (row as Row)[c] ?? null;
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: wraps the fake's loosely typed query builder
function project(res: any, cols: string[] | null): any {
  if (!cols || !res || res.error || res.data == null) return res;
  const data = Array.isArray(res.data) ? res.data.map((r: unknown) => pick(r, cols)) : pick(res.data, cols);
  return { ...res, data };
}

// biome-ignore lint/suspicious/noExplicitAny: wraps the fake's loosely typed query builder
function wrapQuery(q: any, table: string): any {
  let cols: string[] | null = null;
  // A forced error (see `forceError` below) pre-empts the fake's own result on
  // whichever resolution method the caller happens to use (then/single/
  // maybeSingle) for THIS table.
  // biome-ignore lint/suspicious/noExplicitAny: proxy over the fake builder
  const proxy: any = new Proxy(q, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === "select") {
        return (c?: string, o?: unknown) => {
          cols = parseCols(c);
          target.select(c, o);
          return proxy;
        };
      }
      if (prop === "then") {
        // biome-ignore lint/suspicious/noExplicitAny: PromiseLike passthrough
        return (f?: any, r?: any) =>
          target
            .then((res: unknown) => {
              const forced = takeForcedError(table);
              return forced ? { data: null, error: forced } : project(res, cols);
            })
            .then(f, r);
      }
      if (prop === "single" || prop === "maybeSingle") {
        return () =>
          target[prop]().then((res: unknown) => {
            const forced = takeForcedError(table);
            return forced ? { data: null, error: forced } : project(res, cols);
          });
      }
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          const out = v.apply(target, args);
          return out === target ? proxy : out;
        };
      }
      return v;
    },
  });
  return proxy;
}

function dataClient(authExtra: Record<string, unknown> = {}) {
  return {
    from: (t: string) => wrapQuery(s().db.from(t), t),
    rpc: (name: string, args: Record<string, unknown>) => {
      const forced = takeForcedError(name);
      if (forced) return Promise.resolve({ data: null, error: forced });
      return s().db.rpc(name, args ?? {});
    },
    auth: {
      getUser: (jwt?: string) => s().db.auth.getUser(jwt),
      // /api/account/delete's only write: the fake has no real cascade, so this
      // just drops the row from the fake's `auth.users` table (the same one
      // `auth.getUser` reads), enough to lock the route's own {deleted:true}
      // contract without modelling a real cascade delete.
      admin: {
        deleteUser: async (id: string) => {
          const forced = takeForcedError("auth.admin.deleteUser");
          if (forced) return { data: { user: null }, error: forced };
          const users = s().db.tables["auth.users"];
          if (users) s().db.tables["auth.users"] = users.filter((u) => u.id !== id);
          return { data: { user: null }, error: null };
        },
      },
      ...authExtra,
    },
  };
}

// --- module factories (used as vi.mock factories by every test file) ---------

export function supabaseJsModule() {
  return { createClient: (_url: string, _key: string, _opts?: unknown) => dataClient() };
}

interface CookieAdapter {
  cookies: { getAll(): { name: string; value: string }[] };
}

export function supabaseSsrModule() {
  return {
    createServerClient: (_url: string, _key: string, opts: CookieAdapter) => {
      const cookieJwt = () => opts.cookies.getAll().find((c) => c.name === AUTH_COOKIE)?.value;
      return dataClient({
        getUser: () => s().db.auth.getUser(cookieJwt()),
        exchangeCodeForSession: async (code: string) => {
          if (code !== GOOD_OAUTH_CODE) {
            return {
              data: { user: null, session: null },
              error: { message: "invalid flow state, no valid flow state found" },
            };
          }
          const user = {
            id: USER_ID,
            email: "dev@codehub.test",
            created_at: "2025-12-01T00:00:00.000Z",
            identities: [{ provider: "google" }],
          };
          return { data: { user, session: { access_token: USER_JWT } }, error: null };
        },
        signOut: async () => ({ error: null }),
      });
    },
  };
}

export function nextHeadersModule() {
  return {
    cookies: async () => ({
      getAll: () => [...s().cookies].map(([name, value]) => ({ name, value })),
      get: (name: string) => (s().cookies.has(name) ? { name, value: s().cookies.get(name) } : undefined),
      has: (name: string) => s().cookies.has(name),
      set: (name: string, value: string) => void s().cookies.set(name, value),
      delete: (name: string) => void s().cookies.delete(name),
    }),
    headers: async () => new Headers(),
  };
}

/** `after()` RECORDS its callback or promise and never runs it: the deferred work reaches LLMs and the network. */
export function after(task: unknown): void {
  s().afterCalls.push(task);
}
