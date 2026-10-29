// Shared by the db tests. Not a test file (no .db.test.ts suffix).
import { type DbEnv, ids } from "../../../../../test/db-store";

/** A fresh user with one project and `n` sessions, so a test that writes never touches the shared seed. */
export async function newUserWithSessions(env: DbEnv, n = 2) {
  const userId = await env.newUser();
  const projectId = crypto.randomUUID();
  await env.query("insert into code_projects(id,user_id,repo_identity,display_name) values ($1,$2,$3,'Scratch')", [
    projectId,
    userId,
    `codehub/scratch-${projectId.slice(0, 8)}`,
  ]);
  const sessions: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    sessions.push(id);
    await env.query(
      "insert into code_sessions(id,user_id,code_project_id,source,source_session_id,content_hash,started_at,title,turn_count) " +
        "values ($1,$2,$3,'claude-code',$4,$5, now() - interval '1 hour', $6, 3)",
      [id, userId, projectId, `scratch-${id}`, `h-${id}`, `Scratch ${i}`],
    );
  }
  return { userId, projectId, sessions };
}

export { ids };
