// Migration 138 (#598): the embed-retry selection and apply functions, on both stores.
import { beforeAll, describe, expect, it } from "vitest";
import { type DbEnv, openDb } from "../../../../../test/db-store";
import { newUserWithSessions } from "./helpers";

let env: DbEnv;
let svc: ReturnType<DbEnv["client"]>;
beforeAll(async () => {
  env = await openDb();
  svc = env.client(env.keys.service);
}, 300_000);

const vec = (n: number) => `[${[n, ...new Array(1535).fill(0.5)].join(",")}]`;

async function seed(
  userId: string,
  projectId: string,
  sessionId: string,
  tag: string,
  text: string,
  ageMin: number | null,
) {
  const id = crypto.randomUUID();
  await env.query(
    `insert into session_memories(id,user_id,code_session_id,code_project_id,source,kind,text,quote,turn_idx,turn_role,content_hash,paths,embedding_failed_at)
     values ($1,$2,$3,$4,'extractor','learning',$5,'q',1,'assistant',$6,'{}', case when $7::int is null then null else now() - make_interval(mins => $7::int) end)`,
    [id, userId, sessionId, projectId, text, `${tag}-${id}`, ageMin],
  );
  return id;
}

describe("memory embed retry (migration 138)", () => {
  it("selects only due, empty-text-free, unembedded rows of the one user, oldest first, bounded", async () => {
    const a = await newUserWithSessions(env, 1);
    const b = await newUserWithSessions(env, 1);
    const old1 = await seed(a.userId, a.projectId, a.sessions[0], "o1", "failed long ago", 120);
    const old2 = await seed(a.userId, a.projectId, a.sessions[0], "o2", "failed a bit later", 60);
    await seed(a.userId, a.projectId, a.sessions[0], "recent", "failed just now", 1); // inside the window
    await seed(a.userId, a.projectId, a.sessions[0], "never", "never failed (unconfigured or handoff)", null);
    await seed(a.userId, a.projectId, a.sessions[0], "empty", "  ", 120);
    await seed(b.userId, b.projectId, b.sessions[0], "other", "another user's row", 120);

    const batch = await svc.rpc("memory_embed_retry_batch", { p_user_id: a.userId, p_retry_seconds: 900, p_limit: 10 });
    expect(batch.error).toBeNull();
    expect((batch.data as { id: string }[]).map((r) => r.id)).toEqual([old1, old2]);

    const bounded = await svc.rpc("memory_embed_retry_batch", {
      p_user_id: a.userId,
      p_retry_seconds: 900,
      p_limit: 1,
    });
    expect((bounded.data as { id: string }[]).map((r) => r.id)).toEqual([old1]);

    const users = await svc.rpc("memory_embed_retry_users", { p_retry_seconds: 900, p_limit: 1000 });
    expect(users.data).toEqual(expect.arrayContaining([a.userId, b.userId]));
  });

  it("apply: a vector sets embedding and model and clears the marker; null bumps the marker; scoped by user", async () => {
    const a = await newUserWithSessions(env, 1);
    const b = await newUserWithSessions(env, 1);
    const ok = await seed(a.userId, a.projectId, a.sessions[0], "ok", "good", 120);
    const bad = await seed(a.userId, a.projectId, a.sessions[0], "bad", "bad", 120);
    const theirs = await seed(b.userId, b.projectId, b.sessions[0], "theirs", "not yours", 120);

    const r = await svc.rpc("memory_embed_retry_apply", {
      p_user_id: a.userId,
      p_rows: [
        { id: ok, embedding: vec(1) },
        { id: bad, embedding: null },
        { id: theirs, embedding: vec(2) },
      ],
      p_embedding_model: "nomic-embed-text",
    });
    expect(r.error).toBeNull();
    expect(r.data).toBe(2); // the other user's row is untouched

    const rows = await env.query(
      "select id, embedding is not null as has_vec, embedding_model, embedding_failed_at > now() - interval '1 minute' as bumped, embedding_failed_at is null as cleared from session_memories where id = any($1)",
      [[ok, bad, theirs]],
    );
    const by = new Map(rows.map((x) => [x.id as string, x]));
    expect(by.get(ok)).toMatchObject({ has_vec: true, embedding_model: "nomic-embed-text", cleared: true });
    expect(by.get(bad)).toMatchObject({ has_vec: false, bumped: true });
    expect(by.get(theirs)).toMatchObject({ has_vec: false, cleared: false });

    // The bumped row is inside the window again, so it is no longer due.
    const due = await svc.rpc("memory_embed_retry_batch", { p_user_id: a.userId, p_retry_seconds: 900, p_limit: 10 });
    expect(due.data).toEqual([]);
  });

  it("apply never overwrites a row that was embedded meanwhile", async () => {
    const a = await newUserWithSessions(env, 1);
    const id = await seed(a.userId, a.projectId, a.sessions[0], "race", "x", 120);
    await env.query("update session_memories set embedding = $2::vector where id = $1", [id, vec(3)]);
    const r = await svc.rpc("memory_embed_retry_apply", {
      p_user_id: a.userId,
      p_rows: [{ id, embedding: vec(9) }],
      p_embedding_model: "m",
    });
    expect(r.data).toBe(0);
  });
});
