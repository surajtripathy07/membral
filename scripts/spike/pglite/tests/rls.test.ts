import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error plain ESM helper
import { boot, USER, USER_B, keys, SECRET } from "./setup.mjs";
// @ts-expect-error plain ESM helper
import { signJwt } from "../shim.mjs";

let env: Awaited<ReturnType<typeof boot>>;
beforeAll(async () => { env = await boot(); }, 120_000);
afterAll(() => env?.restore());
const as = (key: string) => createClient("http://pglite.local", key, { auth: { persistSession: false, autoRefreshToken: false } });

describe("RLS under real roles through the shim", () => {
  it("anon key alone selects 0 rows from code_sessions and session_memories", async () => {
    for (const t of ["code_sessions", "session_memories"]) {
      const r = await as(keys.anon).from(t).select("id");
      console.log("ANON select", t, JSON.stringify({ rows: r.data?.length, err: r.error?.message }));
      expect(r.data ?? []).toHaveLength(0); // permission error or RLS-empty both mean no rows leak
    }
  });
  it("anon cannot insert", async () => {
    const r = await as(keys.anon).from("code_projects").insert({ user_id: USER, repo_identity: "evil/x" });
    console.log("ANON insert code_projects", r.status, r.error?.message);
    expect(r.error).not.toBeNull();
    expect((await env.db.query("select 1 from code_projects where repo_identity='evil/x'")).rows).toHaveLength(0);
  });
  it("user A cannot read user B's rows (code_sessions, session_memories) and sees own", async () => {
    const a = as(keys.user(USER));
    for (const t of ["code_sessions", "session_memories"]) {
      const mine = await a.from(t).select("id, user_id");
      console.log("A reads", t, JSON.stringify({ n: mine.data?.length, err: mine.error?.message }));
      expect(mine.data?.length).toBeGreaterThan(0);
      expect(mine.data?.every((r: { user_id: string }) => r.user_id === USER)).toBe(true);
      const theirs = await a.from(t).select("id").eq("user_id", USER_B);
      expect(theirs.data ?? []).toHaveLength(0);
    }
  });
  it("user A cannot update or insert-as user B", async () => {
    const a = as(keys.user(USER));
    const upd = await a.from("code_sessions").update({ title: "pwned" }).eq("user_id", USER_B).select("id");
    expect(upd.data ?? []).toHaveLength(0);
    const ins = await a.from("code_projects").insert({ user_id: USER_B, repo_identity: "spoof/x" });
    console.log("A insert-as-B code_projects", ins.status, ins.error?.message);
    expect(ins.error).not.toBeNull();
    expect((await env.db.query("select title from code_sessions where user_id=$1", [USER_B])).rows[0].title).toBe("B secret work");
  });
  it("service_role sees both users; bad/forged/expired tokens are rejected", async () => {
    const all = await as(keys.service).from("code_sessions").select("user_id");
    expect(new Set(all.data?.map((r: { user_id: string }) => r.user_id))).toEqual(new Set([USER, USER_B]));
    const forged = await as(signJwt({ role: "service_role" }, "wrong-secret-wrong-secret-wrong-secret")).from("code_sessions").select("id");
    expect(forged.error?.code).toBe("PGRST301");
    const expired = await as(signJwt({ role: "authenticated", sub: USER, exp: 1 }, SECRET)).from("code_sessions").select("id");
    expect(expired.error?.code).toBe("PGRST301");
    const evilRole = await as(signJwt({ role: "postgres", sub: USER }, SECRET)).from("code_sessions").select("id");
    expect(evilRole.error?.code).toBe("PGRST301");
  });
});
