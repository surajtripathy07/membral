// The five row-level-security checks, run against the real policies of whichever store is under test.
import { beforeAll, describe, expect, it } from "vitest";
import { signJwt } from "@/lib/local/auth-stub/jwt";
import { type DbEnv, ids, openDb, USER_A, USER_B } from "../../../../../test/db-store";

let env: DbEnv;
beforeAll(async () => {
  env = await openDb();
}, 300_000);

const asA = () => env.client(env.keys.user(USER_A));

describe("RLS and tokens", () => {
  it("an authenticated user sees only their rows", async () => {
    const r = await asA().from("session_memories").select("id");
    expect(r.error).toBeNull();
    expect((r.data as { id: string }[]).map((x) => x.id)).toContain(ids.m1);
    expect((r.data as { id: string }[]).map((x) => x.id)).not.toContain(ids.mB);
    const b = await env.client(env.keys.user(USER_B)).from("session_memories").select("id");
    expect((b.data as { id: string }[]).map((x) => x.id)).toEqual([ids.mB]);
  });
  it("service_role sees every user's rows", async () => {
    const r = await env.client(env.keys.service).from("session_memories").select("id");
    const got = (r.data as { id: string }[]).map((x) => x.id);
    expect(got).toEqual(expect.arrayContaining([ids.m1, ids.m2, ids.mB]));
  });
  it("anon sees none", async () => {
    const r = await env.client(env.keys.anon).from("session_memories").select("id");
    expect(r.data ?? []).toHaveLength(0);
  });
  it("a user cannot write another user's row", async () => {
    const r = await asA().from("code_projects").update({ display_name: "hijack" }).eq("id", ids.projB).select("id");
    expect(r.data ?? []).toHaveLength(0);
    const rows = await env.query("select display_name from code_projects where id=$1", [ids.projB]);
    expect((rows[0] as { display_name: string }).display_name).toBe("B Private");
  });
  it("forged, none-alg, expired and malformed tokens are refused", async () => {
    const forged = signJwt({ role: "service_role" }, "wrong-secret-wrong-secret-wrong-secret");
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"role":"service_role"}').toString("base64url")}.`;
    const expired = signJwt({ role: "service_role", exp: 1 }, env.secret);
    for (const t of [forged, none, expired, "garbage"]) {
      const r = await env.raw("session_memories?select=id", { token: t });
      expect([401, 403]).toContain(r.status);
      expect(await r.text()).not.toContain(ids.m1);
    }
  });
});
