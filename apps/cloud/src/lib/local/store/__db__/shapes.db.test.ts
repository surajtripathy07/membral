// JSON-path columns, contains, ilike and textSearch at their real call sites.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getFirstUserMessages,
  getKnownSessionDigests,
  getSessionToolUseIndex,
  listChildSessions,
} from "@/lib/code-sessions/queries";
import { getServiceClient } from "@/lib/db/clients";
import { memoryRecall } from "@/lib/memory/recall";
import { type DbEnv, ids, openDb, USER_A } from "../../../../../test/db-store";
import { newUserWithSessions } from "./helpers";

let env: DbEnv;
beforeAll(async () => {
  env = await openDb();
}, 300_000);

describe("JSON-path sites", () => {
  it("props->subAgent, props->>ownerText, props->>toolUseId and props->actions_version", async () => {
    const { userId, projectId, sessions } = await newUserWithSessions(env, 1);
    const parent = sessions[0] as string;
    const [{ source_session_id: parentSsid }] = (await env.query(
      "select source_session_id from code_sessions where id=$1",
      [parent],
    )) as { source_session_id: string }[];
    const childId = crypto.randomUUID();
    await env.query(
      "insert into code_sessions(id,user_id,code_project_id,source,source_session_id,parent_source_session_id,content_hash,started_at,title,turn_count,props) " +
        "values ($1,$2,$3,'claude-code',$4,$5,'hc',now(),'Child',1,$6::jsonb)",
      [
        childId,
        userId,
        projectId,
        `child-${childId}`,
        parentSsid,
        JSON.stringify({ subAgent: { agentType: "scout" }, actions_version: 7 }),
      ],
    );
    await env.query(
      "insert into code_session_turns(user_id,session_id,idx,role,kind,text,ts,props) values " +
        "($1,$2,0,'user','prose','Please look at queue.ts for me',now(),$3::jsonb)," +
        "($1,$2,1,'assistant','tool_use',null,now(),$4::jsonb)",
      [userId, parent, JSON.stringify({ ownerText: "look at queue.ts" }), JSON.stringify({ toolUseId: "toolu_01" })],
    );
    const db = getServiceClient();
    const kids = await listChildSessions(db, userId, "claude-code", parentSsid);
    expect(kids).toHaveLength(1);
    expect(JSON.stringify(kids[0])).toContain("scout");
    const first = await getFirstUserMessages(db, userId, [parent]);
    expect(first.get(parent)).toContain("queue.ts");
    expect(await getSessionToolUseIndex(db, userId, parent)).toEqual([{ idx: 1, toolUseId: "toolu_01" }]);
    const digests = await getKnownSessionDigests(db, userId, [`child-${childId}`]);
    expect(digests.error).toBeNull();
    expect(JSON.stringify(digests.data)).toContain('"actions_version":7');
  });
  it("a not-null filter on a JSON path (.not('props->action','is',null))", async () => {
    const { userId, sessions } = await newUserWithSessions(env, 1);
    await env.query(
      "insert into code_session_turns(user_id,session_id,idx,role,kind,text,ts,props) values " +
        "($1,$2,0,'assistant','tool_use',null,now(),$3::jsonb),($1,$2,1,'assistant','tool_use',null,now(),'{}'::jsonb)",
      [userId, sessions[0], JSON.stringify({ action: { type: "commit" } })],
    );
    const r = await getServiceClient()
      .from("code_session_turns")
      .select("idx")
      .eq("user_id", userId)
      .not("props->action", "is", null);
    expect(r.error).toBeNull();
    expect((r.data as { idx: number }[]).map((x) => x.idx)).toEqual([0]);
  });
});

describe("array contains, ilike and textSearch", () => {
  it("contains on session_memories.paths via memoryRecall(path)", async () => {
    const recs = await memoryRecall(getServiceClient(), USER_A, null, { path: "src/queue.ts", durable_only: false });
    expect(recs.map((r) => r.id)).toContain(ids.m2);
    expect(recs.map((r) => r.id)).not.toContain(ids.m1);
  });
  it("contains on a text[] column through the client", async () => {
    const r = await getServiceClient()
      .from("session_memories")
      .select("id")
      .eq("user_id", USER_A)
      .contains("paths", ["src/import.ts"]);
    expect(r.error).toBeNull();
    expect((r.data as { id: string }[]).map((x) => x.id)).toEqual([ids.m1]);
  });
  it("ilike on a text column", async () => {
    const r = await getServiceClient()
      .from("session_memories")
      .select("id")
      .eq("user_id", USER_A)
      .ilike("text", "%EXPONENTIAL%");
    expect(r.error).toBeNull();
    expect((r.data as { id: string }[]).map((x) => x.id)).toEqual([ids.m1]);
  });
  it("textSearch on the text_fts tsvector column", async () => {
    const r = await getServiceClient()
      .from("session_memories")
      .select("id")
      .eq("user_id", USER_A)
      .textSearch("text_fts", "backoff", { type: "plain", config: "english" });
    expect(r.error).toBeNull();
    expect((r.data as { id: string }[]).map((x) => x.id)).toContain(ids.m1);
  });
});
