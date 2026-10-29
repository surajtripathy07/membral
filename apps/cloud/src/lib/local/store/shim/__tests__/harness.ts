// Shared bootstrap for the shim tests: the production store path (createPgliteHandle, vector only, prelude and
// migrations through migrate.ts) over in-memory PGlite + every migration + fictional seed (CodeHub).
// A real supabase-js client whose fetch is handleRestRequest, so the Requests are exactly what the app builds.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { signJwt } from "../../../auth-stub/jwt";
import { createPgliteHandle } from "../../boot";
import { applyMigrations, applyPrelude } from "../../migrate";
import type { StoreHandle } from "../../types";
import { handleRestRequest } from "../handler";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
export const MIGRATIONS_DIR = path.join(APP, "supabase", "migrations");
export const PRELUDE = path.join(APP, "supabase", "local", "auth-prelude.sql");

export interface TestStore extends StoreHandle {
  db: PGlite;
  /** Number of noteWrite() calls. */
  writes: number;
  close(): Promise<void>;
}

async function openTestStore(): Promise<TestStore> {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  await db.exec("set search_path = public, extensions; set timezone = 'UTC'");
  await applyPrelude(db, PRELUDE);
  await db.exec("set search_path = public, extensions; set timezone = 'UTC'");
  await applyMigrations(db, MIGRATIONS_DIR);
  await db.exec("set search_path = public, extensions; set timezone = 'UTC'");
  const handle = createPgliteHandle(db, {
    onWrite: () => {
      store.writes++;
    },
  });
  const store: TestStore = Object.assign(handle, { db, writes: 0, close: () => db.close() });
  return store;
}

export const SECRET = "shim-test-secret-shim-test-secret-0123";
export const URL_BASE = "http://pglite.local";
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

export const keys = {
  anon: signJwt({ role: "anon", iss: "t" }, SECRET),
  service: signJwt({ role: "service_role", iss: "t" }, SECRET),
  user: (sub: string, extra: Record<string, unknown> = {}) =>
    signJwt({ role: "authenticated", aud: "authenticated", sub, iss: "t", ...extra }, SECRET),
};

// biome-ignore lint/suspicious/noExplicitAny: a client over an untyped schema, so table names are free-form
export type Client = SupabaseClient<any, "public", any>;

export interface Env {
  store: TestStore;
  /** Raw fetch into the shim (a URL path under /rest/v1 plus query), with a bearer token. */
  raw: (path: string, init?: RequestInit & { token?: string }) => Promise<Response>;
  client: (token: string) => Client;
  slow: string[];
}

let cached: Promise<Env> | undefined;
export function boot(): Promise<Env> {
  cached ??= (async () => {
    const store = await openTestStore();
    await seed(store);
    const raw: Env["raw"] = async (path, init = {}) => {
      const { token, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
      if (token && !headers.has("apikey")) headers.set("apikey", token);
      return handleRestRequest(new Request(`${URL_BASE}/rest/v1/${path}`, { ...rest, headers }), store, {
        jwtSecret: SECRET,
      });
    };
    const client = (token: string): Client =>
      createClient(URL_BASE, token, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
            handleRestRequest(new Request(input as RequestInfo, init), store, { jwtSecret: SECRET })) as typeof fetch,
        },
      });
    return { store, raw, client, slow: [] } as Env;
  })();
  return cached as Promise<Env>;
}

async function seed(store: TestStore): Promise<void> {
  await store.db.exec(`
  insert into auth.users(id,email) values ('${USER_A}','a@codehub.test'),('${USER_B}','b@codehub.test') on conflict do nothing;
  insert into profiles(id,email,tier,conversation_limit) values ('${USER_A}','a@codehub.test','free',50),('${USER_B}','b@codehub.test','free',50) on conflict (id) do nothing;
  insert into code_projects(id,user_id,repo_identity,display_name) values
   ('${ids.projA}','${USER_A}','codehub/acme-api','Acme API'),('${ids.projB}','${USER_B}','codehub/b-private','B Private');
  insert into code_sessions(id,user_id,code_project_id,source,source_session_id,content_hash,git_branch,started_at,title) values
   ('${ids.s1}','${USER_A}','${ids.projA}','claude-code','sess-1','h1','feat/retry', now() - interval '1 day','Fix import 504'),
   ('${ids.s2}','${USER_A}','${ids.projA}','claude-code','sess-2','h2','main', now() - interval '2 days','Queue env accessors'),
   ('${ids.s3}','${USER_A}','${ids.projA}','claude-code','sess-3','h3','main', now() - interval '40 days','Old work'),
   ('${ids.sB}','${USER_B}','${ids.projB}','claude-code','sess-b1','hb1',null, now(),'B secret work');
  insert into session_memories(id,user_id,code_session_id,code_project_id,source,kind,text,quote,turn_idx,turn_role,content_hash,session_title) values
   ('${ids.m1}','${USER_A}','${ids.s1}','${ids.projA}','extractor','decision','Retry the import on a 504 with exponential backoff','retry on 504 with backoff',3,'assistant','c1','Fix import 504'),
   ('${ids.m2}','${USER_A}','${ids.s2}','${ids.projA}','extractor','learning','The queue env accessors live in queue.ts and must not be converted','leave queue.ts alone',5,'user','c2','Queue env accessors'),
   ('${ids.mB}','${USER_B}','${ids.sB}','${ids.projB}','extractor','decision','B private decision','q',1,'user','cb1','B secret work');
  insert into conversations(user_id,source,source_id,title,created_at) values
   ('${USER_A}','chatgpt','c-1','Trip planning', now() - interval '3 days'),
   ('${USER_A}','chatgpt','c-2','Recipe ideas', now() - interval '2 days'),
   ('${USER_A}','claude-code','c-3','Mirrored code session', now() - interval '1 days');
  insert into extracted_metadata(conversation_id,summary,topics,conversation_type) select id,'s',array['travel','food'],'planning' from conversations where source='chatgpt';
  insert into llm_spend(user_id,pass,model,cost_usd,spent_at) values ('${USER_A}','extract','m',0.25, now()),('${USER_A}','extract','m',0.5, now() - interval '1 day');
  `);
}
