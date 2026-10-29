// The `db` test project's store (apps/cloud/vitest.db.config.ts). One set of test files, two stores:
//
//   MEMBRAL_TEST_STORE=pglite     (default) boots the embedded store in memory with B1's bootEmbeddedStore() (prelude +
//                                 every migration), and answers supabase-js through the in-process shim.
//   MEMBRAL_TEST_STORE=postgrest  talks to a real Supabase stack: SUPABASE_URL, SUPABASE_ANON_KEY,
//                                 SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET (to sign per-user tokens) and
//                                 SUPABASE_DB_URL (the `pg` connection used for seeding and inspection).
//
// App code under test keeps calling getServiceClient(): the environment below makes that client land on the same store.
// Fictional data only (CodeHub). The seed is idempotent, so a postgrest run can be repeated on one stack.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { signJwt } from "../src/lib/local/auth-stub/jwt";
import { bootEmbeddedStore } from "../src/lib/local/store/boot";
import { handleRestRequest } from "../src/lib/local/store/shim/handler";
import type { StoreHandle } from "../src/lib/local/store/types";

export type StoreMode = "pglite" | "postgrest";
export const MODE: StoreMode = process.env.MEMBRAL_TEST_STORE === "postgrest" ? "postgrest" : "pglite";
export const isPglite = MODE === "pglite";

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIM_SECRET = "db-test-secret-db-test-secret-0123456789";
const SHIM_URL = "http://pglite.local";
// The default of every local Supabase stack (supabase/config.toml), overridable for a stack with its own secret.
const STACK_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

export const USER_A = "00000000-0000-4000-8000-00000000000a";
export const USER_B = "00000000-0000-4000-8000-00000000000b";
export const ids = {
  projA: "11111111-1111-4111-8111-111111111111",
  projB: "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  s1: "21111111-1111-4111-8111-111111111111",
  s2: "22222222-2222-4222-8222-222222222222",
  s3: "23333333-3333-4333-8333-333333333333",
  sB: "4bbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb",
  m1: "31111111-1111-4111-8111-111111111111",
  m2: "32222222-2222-4222-8222-222222222222",
  mB: "4bbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb",
};

// biome-ignore lint/suspicious/noExplicitAny: a client over an untyped schema, so table names are free-form
export type Client = SupabaseClient<any, "public", any>;

export interface DbEnv {
  mode: StoreMode;
  /** Secret that signs (and, on the shim, verifies) JWTs. */
  secret: string;
  keys: { anon: string; service: string; user: (sub: string, extra?: Record<string, unknown>) => string };
  /** A supabase-js client over the store with the given bearer token. */
  client: (token: string) => Client;
  /** Raw REST call (a path under /rest/v1 plus query), with an optional bearer token. */
  raw: (p: string, init?: RequestInit & { token?: string }) => Promise<Response>;
  /** One parameterised statement as the database owner (RLS does not apply). */
  query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  /** Several statements, no parameters, as the database owner. */
  exec: (sql: string) => Promise<void>;
  /** Inserts a fresh user (auth.users + profiles) and returns its id: for tests that write. */
  newUser: () => Promise<string>;
  /** The embedded store handle (pglite mode only). */
  store?: StoreHandle;
}

const KEY = Symbol.for("membral.db-test-env");
type G = typeof globalThis & { [KEY]?: Promise<DbEnv> };

/** Boots (once per process) the store chosen by MEMBRAL_TEST_STORE and returns the shared environment. */
export function openDb(): Promise<DbEnv> {
  const g = globalThis as G;
  g[KEY] ??= boot();
  return g[KEY] as Promise<DbEnv>;
}

function uuid(): string {
  return crypto.randomUUID();
}

async function boot(): Promise<DbEnv> {
  for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_BASE_URL"]) {
    delete process.env[k];
  }
  process.env.MEMBRAL_EMBEDDING_MODEL = "text-embedding-3-small"; // not the bundled model: keyword path
  const env = isPglite ? await bootPglite() : await bootPostgrest();
  await seed(env);
  return env;
}

function envOf(
  base: Pick<DbEnv, "mode" | "secret" | "raw" | "query" | "exec" | "store"> & { url: string; anon: string; service: string },
  fetchImpl?: typeof fetch,
): DbEnv {
  const sign = (claims: Record<string, unknown>) => signJwt(claims, base.secret);
  const client = (token: string): Client =>
    createClient(base.url, token, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
    });
  const env: DbEnv = {
    mode: base.mode,
    secret: base.secret,
    keys: {
      anon: base.anon,
      service: base.service,
      user: (sub, extra = {}) => sign({ role: "authenticated", aud: "authenticated", sub, iss: "t", ...extra }),
    },
    client,
    raw: base.raw,
    query: base.query,
    exec: base.exec,
    store: base.store,
    async newUser() {
      const id = uuid();
      await base.query("insert into auth.users(id,email) values ($1,$2) on conflict do nothing", [id, `${id}@codehub.test`]);
      await base.query(
        "insert into profiles(id,email,tier,conversation_limit) values ($1,$2,'free',50) on conflict (id) do nothing",
        [id, `${id}@codehub.test`],
      );
      return id;
    },
  };
  return env;
}

async function bootPglite(): Promise<DbEnv> {
  Object.assign(process.env, {
    MEMBRAL_LOCAL: "1",
    MEMBRAL_STORE: "pglite",
    MEMBRAL_PGDATA: "memory://",
    MEMBRAL_MIGRATIONS_DIR: path.join(CLOUD, "supabase", "migrations"),
    MEMBRAL_PRELUDE_PATH: path.join(CLOUD, "supabase", "local", "auth-prelude.sql"),
    SUPABASE_JWT_SECRET: SHIM_SECRET,
    NEXT_PUBLIC_SUPABASE_URL: SHIM_URL,
  });
  delete process.env.VERCEL;
  const booted = await bootEmbeddedStore({ signals: false });
  if (!booted) throw new Error("bootEmbeddedStore returned no store: a store is already registered in this process");
  const { handle, db } = booted;
  const anon = signJwt({ role: "anon", iss: "t" }, SHIM_SECRET);
  const service = signJwt({ role: "service_role", iss: "t" }, SHIM_SECRET);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon;
  process.env.SUPABASE_SERVICE_ROLE_KEY = service;
  const shimFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handleRestRequest(new Request(input as RequestInfo, init), handle, { jwtSecret: SHIM_SECRET })) as typeof fetch;
  return envOf(
    {
      mode: "pglite",
      secret: SHIM_SECRET,
      url: SHIM_URL,
      anon,
      service,
      store: handle,
      raw: (p, init = {}) => {
        const { token, ...rest } = init;
        const headers = new Headers(rest.headers);
        if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
        if (token && !headers.has("apikey")) headers.set("apikey", token);
        return shimFetch(`${SHIM_URL}/rest/v1/${p}`, { ...rest, headers });
      },
      query: async (sql, params) => (await handle.query(sql, params)).rows,
      exec: async (sql) => {
        await db.exec(sql);
      },
    },
    shimFetch,
  );
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`MEMBRAL_TEST_STORE=postgrest needs ${name} (see apps/cloud/test/db-store.ts)`);
  return v;
}

async function bootPostgrest(): Promise<DbEnv> {
  const url = need("SUPABASE_URL").replace(/\/+$/, "");
  const anon = need("SUPABASE_ANON_KEY");
  const service = need("SUPABASE_SERVICE_ROLE_KEY");
  const secret = process.env.SUPABASE_JWT_SECRET || STACK_SECRET;
  const client = new pg.Client({ connectionString: need("SUPABASE_DB_URL") });
  await client.connect();
  // The prelude is idempotent and a no-op on a stack GoTrue already migrated; it adds the local_auth_* functions.
  const fs = await import("node:fs");
  // The auth schema is owned by supabase_admin on the stock image; apply the prelude as that role.
  const adminUrl = new URL(need("SUPABASE_DB_URL"));
  adminUrl.username = "supabase_admin";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(fs.readFileSync(path.join(CLOUD, "supabase", "local", "auth-prelude.sql"), "utf8"));
  await admin.end();
  // Let PostgREST see the functions just created.
  await client.query("notify pgrst, 'reload schema'");
  await new Promise((r) => setTimeout(r, 1500));
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: service,
  });
  delete process.env.MEMBRAL_LOCAL;
  delete process.env.MEMBRAL_STORE;
  return envOf({
    mode: "postgrest",
    secret,
    url,
    anon,
    service,
    raw: (p, init = {}) => {
      const { token, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set("apikey", anon);
      if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
      return fetch(`${url}/rest/v1/${p}`, { ...rest, headers });
    },
    query: async (sql, params) => (await client.query(sql, params)).rows,
    exec: async (sql) => {
      await client.query(sql);
    },
  });
}

async function seed(env: DbEnv): Promise<void> {
  await env.exec(`
  insert into auth.users(id,email) values ('${USER_A}','a@codehub.test'),('${USER_B}','b@codehub.test') on conflict do nothing;
  insert into profiles(id,email,tier,conversation_limit) values ('${USER_A}','a@codehub.test','free',50),('${USER_B}','b@codehub.test','free',50) on conflict (id) do nothing;
  insert into code_projects(id,user_id,repo_identity,display_name) values
   ('${ids.projA}','${USER_A}','codehub/acme-api','Acme API'),('${ids.projB}','${USER_B}','codehub/b-private','B Private') on conflict do nothing;
  insert into code_sessions(id,user_id,code_project_id,source,source_session_id,content_hash,git_branch,started_at,title) values
   ('${ids.s1}','${USER_A}','${ids.projA}','claude-code','sess-1','h1','feat/retry', now() - interval '1 day','Fix import 504'),
   ('${ids.s2}','${USER_A}','${ids.projA}','claude-code','sess-2','h2','main', now() - interval '2 days','Queue env accessors'),
   ('${ids.s3}','${USER_A}','${ids.projA}','claude-code','sess-3','h3','main', now() - interval '40 days','Old work'),
   ('${ids.sB}','${USER_B}','${ids.projB}','claude-code','sess-b1','hb1',null, now(),'B secret work') on conflict do nothing;
  insert into session_memories(id,user_id,code_session_id,code_project_id,source,kind,text,quote,turn_idx,turn_role,content_hash,session_title,paths) values
   ('${ids.m1}','${USER_A}','${ids.s1}','${ids.projA}','extractor','decision','Retry the import on a 504 with exponential backoff','retry on 504 with backoff',3,'assistant','c1','Fix import 504','{src/import.ts}'),
   ('${ids.m2}','${USER_A}','${ids.s2}','${ids.projA}','extractor','learning','The queue env accessors live in queue.ts and must not be converted','leave queue.ts alone',5,'user','c2','Queue env accessors','{src/queue.ts}'),
   ('${ids.mB}','${USER_B}','${ids.sB}','${ids.projB}','extractor','decision','B private decision','q',1,'user','cb1','B secret work','{}') on conflict do nothing;
  insert into served_record_verdicts(user_id,code_session_id,memory_id,surface,verdict,quote,turn_idx,prompt_version)
   select '${USER_A}','${ids.s1}','${ids.m1}','mcp','contradicted','actually no backoff needed',9,'v1'
   where not exists (select 1 from served_record_verdicts where memory_id='${ids.m1}');
  insert into conversations(user_id,source,source_id,title,created_at) values
   ('${USER_A}','chatgpt','c-1','Trip planning', now() - interval '3 days'),
   ('${USER_A}','chatgpt','c-2','Recipe ideas', now() - interval '2 days'),
   ('${USER_A}','claude-code','c-3','Mirrored code session', now() - interval '1 days') on conflict do nothing;
  insert into extracted_metadata(conversation_id,summary,topics,conversation_type)
   select id,'s',array['travel','food'],'planning' from conversations c
   where c.user_id='${USER_A}' and c.source='chatgpt' and not exists (select 1 from extracted_metadata e where e.conversation_id=c.id);
  insert into llm_spend(user_id,pass,model,cost_usd,spent_at)
   select '${USER_A}','seed','m',0.25, now() where not exists (select 1 from llm_spend where user_id='${USER_A}' and pass='seed');
  insert into llm_spend(user_id,pass,model,cost_usd,spent_at)
   select '${USER_A}','seed','m',0.5, now() - interval '1 day' where (select count(*) from llm_spend where user_id='${USER_A}' and pass='seed') < 2;
  `);
}
