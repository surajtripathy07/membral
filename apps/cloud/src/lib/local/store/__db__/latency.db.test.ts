// memory_search_scored at 3,000 rows stays fast on the embedded store (the store's real planner, not a mock).
import { beforeAll, describe, expect, it } from "vitest";
import { type DbEnv, isPglite, openDb } from "../../../../../test/db-store";

let env: DbEnv;
beforeAll(async () => {
  env = await openDb();
}, 300_000);

describe.runIf(isPglite)("memory_search_scored latency (pglite only)", () => {
  it("answers in under 1.5 s p95 over 3,000 rows", async () => {
    const userId = await env.newUser();
    const projectId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    await env.query(
      "insert into code_projects(id,user_id,repo_identity,display_name) values ($1,$2,'codehub/lat','Lat')",
      [projectId, userId],
    );
    await env.query(
      "insert into code_sessions(id,user_id,code_project_id,source,source_session_id,content_hash,title) values ($1,$2,$3,'claude-code',$4,'h','Lat')",
      [sessionId, userId, projectId, `lat-${sessionId}`],
    );
    await env.exec(`insert into session_memories(user_id,code_session_id,code_project_id,source,kind,text,quote,turn_idx,turn_role,content_hash,session_title,paths)
      select '${userId}','${sessionId}','${projectId}','extractor','learning',
        'record ' || g || ' about retry backoff queue worker number ' || (g % 97), 'q' || g, g, 'assistant', 'lat-' || g, 'Lat', '{}'
      from generate_series(1,3000) g`);
    await env.exec("analyze session_memories");
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const r = await env.client(env.keys.service).rpc(
        "memory_search_scored" as never,
        {
          p_user_id: userId,
          p_query: "retry backoff",
          p_query_embedding: null,
          p_code_project_id: null,
          p_kinds: null,
          p_scope: null,
          p_path: null,
          p_include_retired: false,
          p_limit: 10,
          p_since: null,
          p_embedding_model: null,
          p_min_similarity: null,
        } as never,
      );
      times.push(performance.now() - t);
      expect(r.error, JSON.stringify(r.error)).toBeNull();
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95) - 1] ?? 0).toBeLessThan(1500);
  });
});
