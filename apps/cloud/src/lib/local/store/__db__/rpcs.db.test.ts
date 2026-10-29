// Every rpc the app calls, with valid arguments, must answer without an error on both stores.
import { beforeAll, describe, expect, it } from "vitest";
import { type DbEnv, ids, openDb, USER_A } from "../../../../../test/db-store";

let env: DbEnv;
let svc: ReturnType<DbEnv["client"]>;
beforeAll(async () => {
  env = await openDb();
  svc = env.client(env.keys.service);
}, 300_000);

const U = USER_A;
const NIL = "00000000-0000-4000-8000-0000000000ff";
const since = () => new Date(Date.now() - 30 * 864e5).toISOString();

// [name, args]. Read-only calls run against the seeded user; writers use a fresh user (see below).
const readers: [string, () => Record<string, unknown>][] = [
  ["code_context_for", () => ({ p_user_id: U, p_query: "retry", p_scope_code_project_id: null })],
  ["code_project_detail", () => ({ p_user_id: U, p_project_id: ids.projA, p_scope_code_project_id: null })],
  ["code_projects_list", () => ({ p_user_id: U, p_scope_code_project_id: null })],
  ["code_session_detail", () => ({ p_user_id: U, p_session_id: ids.s1, p_scope_code_project_id: null })],
  ["llm_spend_global_sum", () => ({ p_since: since() })],
  [
    "llm_spend_sum",
    () => ({ p_user_id: U, p_since: since(), p_run_id: null, p_include_passes: null, p_exclude_passes: null }),
  ],
  ["mcp_freshness", () => ({ p_user_id: U })],
  [
    "mcp_recent_conversations",
    () => ({
      p_user_id: U,
      p_since: since(),
      p_limit: 5,
      p_source: null,
      p_scope_id: null,
      p_scope_code_project_id: null,
      p_include_chat: true,
      p_include_code: true,
    }),
  ],
  ["mcp_scoped_conversation", () => ({ p_user_id: U, p_conversation_id: NIL, p_scope_id: null })],
  [
    "mcp_search_unified",
    () => ({
      p_user_id: U,
      p_query: "retry",
      p_query_embedding: null,
      p_limit: 5,
      p_scope_id: null,
      p_include_code: true,
      p_since: null,
    }),
  ],
  [
    "memory_anchor_records",
    () => ({ p_user_id: U, p_code_project_id: ids.projA, p_tokens: ["src/queue.ts"], p_kinds: null, p_limit: 5 }),
  ],
  [
    "memory_search_scored",
    () => ({
      p_user_id: U,
      p_query: "retry backoff",
      p_query_embedding: null,
      p_code_project_id: null,
      p_kinds: null,
      p_scope: null,
      p_path: null,
      p_include_retired: false,
      p_limit: 5,
      p_since: null,
      p_embedding_model: null,
      p_min_similarity: null,
    }),
  ],
  ["memory_semantic_duplicates", () => ({ p_user: U, p_record_ids: [ids.m1], p_min_sim: 0.9, p_kinds: null })],
  ["memory_title_anchor_records", () => ({ p_user_id: U, p_project_id: ids.projA, p_tokens: ["import"], p_limit: 5 })],
  ["project_alias_seed", () => ({ p_user: U })],
  ["rate_limit_check", () => ({ p_key: `db-test-${crypto.randomUUID()}`, p_limit: 5, p_window_seconds: 60 })],
  ["raw_units_retry_due", () => ({ p_user_id: U, p_code_session_id: ids.s1, p_retry_seconds: 60 })],
  [
    "search_conversations",
    () => ({ query_text: "trip", query_embedding: null, match_count: 5, search_user_id: U, p_lane: null }),
  ],
  ["user_first_session_at", () => ({ p_user_ids: [U] })],
  [
    "memory_raw_pools",
    () => ({
      p_user_id: U,
      p_query: "retry",
      p_query_embedding: null,
      p_embedding_model: null,
      p_min_similarity: null,
      p_code_project_id: null,
      p_want_r23: false,
    }),
  ],
  ["memory_raw_cover", () => ({ p_user_id: U, p_unit_ids: [], p_record_ids: [ids.m1] })],
  ["memory_raw_term_stats", () => ({ p_user_id: U, p_terms: ["retry", "queue"] })],
];

describe("rpcs that read", () => {
  for (const [name, args] of readers) {
    it(`${name} answers without an error`, async () => {
      const r = await svc.rpc(name as never, args() as never);
      expect(r.error, JSON.stringify(r.error)).toBeNull();
    });
  }
  it("the rpc results carry real data for the seeded user", async () => {
    const list = await svc.rpc("code_projects_list" as never, { p_user_id: U, p_scope_code_project_id: null } as never);
    expect(JSON.stringify(list.data)).toContain("Acme API");
    const spend = await svc.rpc(
      "llm_spend_sum" as never,
      {
        p_user_id: U,
        p_since: since(),
        p_run_id: null,
        p_include_passes: ["seed"],
        p_exclude_passes: null,
      } as never,
    );
    expect(Number(spend.data)).toBeGreaterThanOrEqual(0.75);
  });
});

describe("rpcs that write (a fresh user each)", () => {
  it("increment_memory_recurrence", async () => {
    const r = await svc.rpc(
      "increment_memory_recurrence" as never,
      {
        p_user_id: U,
        p_ids: [ids.m1],
        p_counts: [0],
      } as never,
    );
    expect(r.error, JSON.stringify(r.error)).toBeNull();
  });
  it("apply_memory_reconciliation with no links", async () => {
    const r = await svc.rpc(
      "apply_memory_reconciliation" as never,
      {
        p_user_id: U,
        p_run_id: crypto.randomUUID(),
        p_model: "m",
        p_prompt_version: "v1",
        p_links: [],
        p_projections: [],
      } as never,
    );
    expect(r.error, JSON.stringify(r.error)).toBeNull();
  });
  it("code_session_props_patch sets, removes and honours expect", async () => {
    const uid = await env.newUser();
    const [{ id: pid }] = (await env.query(
      "insert into code_projects(user_id,repo_identity,display_name) values ($1,'codehub/rpc','Rpc') returning id",
      [uid],
    )) as { id: string }[];
    const [{ id: sid }] = (await env.query(
      "insert into code_sessions(user_id,code_project_id,source,source_session_id,content_hash,props) values ($1,$2,'claude-code',$3,'h','{}'::jsonb) returning id",
      [uid, pid, `rpc-${uid}`],
    )) as { id: string }[];
    const r = await svc.rpc(
      "code_session_props_patch" as never,
      {
        p_user_id: uid,
        p_session_id: sid,
        p_set: { shape: "ok" },
        p_remove: [],
        p_expect: {},
      } as never,
    );
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const row = (await env.query("select props from code_sessions where id=$1", [sid])) as {
      props: { shape?: string };
    }[];
    expect(row[0]?.props.shape).toBe("ok");
  });
  it("raw-unit rpcs: replace, stage, commit with empty batches", async () => {
    const uid = await env.newUser();
    const [{ id: pid }] = (await env.query(
      "insert into code_projects(user_id,repo_identity,display_name) values ($1,'codehub/raw','Raw') returning id",
      [uid],
    )) as { id: string }[];
    const [{ id: sid }] = (await env.query(
      "insert into code_sessions(user_id,code_project_id,source,source_session_id,content_hash) values ($1,$2,'claude-code',$3,'h') returning id",
      [uid, pid, `raw-${uid}`],
    )) as { id: string }[];
    const rep = await svc.rpc(
      "replace_session_raw_units" as never,
      {
        p_user_id: uid,
        p_code_session_id: sid,
        p_rows: [],
        p_source_hash: "s1",
        p_units_version: 1,
        p_content_hash: "h",
      } as never,
    );
    expect(rep.error, JSON.stringify(rep.error)).toBeNull();
    const run = crypto.randomUUID();
    const stage = await svc.rpc(
      "stage_session_raw_units" as never,
      {
        p_user_id: uid,
        p_code_session_id: sid,
        p_run_id: run,
        p_rows: [],
        p_stale_seconds: 600,
      } as never,
    );
    expect(stage.error, JSON.stringify(stage.error)).toBeNull();
    const commit = await svc.rpc(
      "commit_session_raw_units" as never,
      {
        p_user_id: uid,
        p_code_session_id: sid,
        p_run_id: run,
        p_expected_count: 0,
        p_source_hash: "s1",
        p_units_version: 1,
        p_content_hash: "h",
      } as never,
    );
    expect(commit.error, JSON.stringify(commit.error)).toBeNull();
  });
  it("forge refs: replace_code_session_forge_refs and both import_code_session_turns overloads", async () => {
    const uid = await env.newUser();
    const [{ id: pid }] = (await env.query(
      "insert into code_projects(user_id,repo_identity,display_name) values ($1,'codehub/forge','Forge') returning id",
      [uid],
    )) as { id: string }[];
    const [{ id: sid }] = (await env.query(
      "insert into code_sessions(user_id,code_project_id,source,source_session_id,content_hash) values ($1,$2,'claude-code',$3,'h') returning id",
      [uid, pid, `forge-${uid}`],
    )) as { id: string }[];
    const turns = [{ idx: 0, role: "user", kind: "text", text: "hello", ts: new Date().toISOString() }];
    const three = await svc.rpc(
      "import_code_session_turns" as never,
      {
        p_user_id: uid,
        p_session_id: sid,
        p_turns: turns,
      } as never,
    );
    expect(three.error, JSON.stringify(three.error)).toBeNull();
    const five = await svc.rpc(
      "import_code_session_turns" as never,
      {
        p_user_id: uid,
        p_session_id: sid,
        p_turns: turns,
        p_forge_refs: [],
        p_forge_refs_version: 1,
      } as never,
    );
    expect(five.error, JSON.stringify(five.error)).toBeNull();
    const rep = await svc.rpc(
      "replace_code_session_forge_refs" as never,
      {
        p_user_id: uid,
        p_session_id: sid,
        p_forge_refs: [],
        p_forge_refs_version: 1,
        p_expected_content_hash: "h",
        p_expected_turn_ids_md5: null,
      } as never,
    );
    expect(rep.error, JSON.stringify(rep.error)).toBeNull();
  });
  it("extraction queue: enqueue, claim, finish", async () => {
    const uid = await env.newUser();
    const [{ id: pid }] = (await env.query(
      "insert into code_projects(user_id,repo_identity,display_name) values ($1,'codehub/q','Q') returning id",
      [uid],
    )) as { id: string }[];
    const [{ id: sid }] = (await env.query(
      "insert into code_sessions(user_id,code_project_id,source,source_session_id,content_hash,turn_count) values ($1,$2,'claude-code',$3,'h',3) returning id",
      [uid, pid, `q-${uid}`],
    )) as { id: string }[];
    const enq = await svc.rpc(
      "memory_extraction_enqueue" as never,
      { p_user: uid, p_requeue: [sid], p_ensure: [] } as never,
    );
    expect(enq.error, JSON.stringify(enq.error)).toBeNull();
    const claim = await svc.rpc(
      "memory_extraction_claim" as never,
      {
        p_user: uid,
        p_lease_seconds: 60,
        p_backfill_limit: 5,
        p_max_attempts: 3,
        p_max_age_days: 30,
      } as never,
    );
    expect(claim.error, JSON.stringify(claim.error)).toBeNull();
    const claimed = (claim.data as { session_id: string; lease_token: string }[])[0];
    expect(claimed?.session_id).toBe(sid);
    const fin = await svc.rpc(
      "memory_extraction_finish" as never,
      {
        p_session: sid,
        p_token: claimed?.lease_token,
        p_status: "done",
        p_reason: null,
        p_attempts: 1,
      } as never,
    );
    expect(fin.error, JSON.stringify(fin.error)).toBeNull();
  });
});
