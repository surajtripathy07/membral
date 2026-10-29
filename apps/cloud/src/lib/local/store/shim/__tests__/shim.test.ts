import { beforeAll, describe, expect, it } from "vitest";
import { boot, type Env, ids, keys, USER_A, USER_B } from "./harness";

let env: Env;
beforeAll(async () => {
  env = await boot();
}, 240_000);

const svc = () => env.client(keys.service);
const asA = () => env.client(keys.user(USER_A));

describe("census shapes", () => {
  it("many-to-one embed with alias, order desc, gte filter, limit", async () => {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const r = await svc()
      .from("code_sessions")
      .select("id, git_branch, project:code_projects(display_name, repo_identity)")
      .eq("user_id", USER_A)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(10);
    expect(r.error).toBeNull();
    expect((r.data as { id: string }[]).map((x) => x.id)).toEqual([ids.s1, ids.s2]);
    expect(r.data?.[0]).toMatchObject({ project: { display_name: "Acme API" } });
  });
  it("!inner embed with an embedded filter, neq, range and count", async () => {
    const r = await svc()
      .from("conversations")
      .select("id, title, extracted_metadata!inner(topics, conversation_type)", { count: "exact" })
      .eq("user_id", USER_A)
      .neq("source", "claude-code")
      .eq("extracted_metadata.conversation_type", "planning")
      .order("created_at", { ascending: false })
      .range(0, 19);
    expect(r.error).toBeNull();
    expect(r.count).toBe(2);
    expect((r.data as { title: string }[])[0]?.title).toBe("Recipe ideas");
  });
  it("one-to-many embed, and an ambiguous relationship is PGRST201", async () => {
    const r = await svc().from("code_projects").select("id, code_sessions(id)").eq("id", ids.projA).single();
    expect(r.error).toBeNull();
    expect((r.data as unknown as { code_sessions: unknown[] }).code_sessions).toHaveLength(3);
    const amb = await svc().from("code_sessions").select("id, session_memories(id, kind)").eq("id", ids.s1).single();
    expect(amb.error?.code).toBe("PGRST201");
  });
  it("in, is null, not, or, ilike, contains", async () => {
    const c = svc();
    expect((await c.from("code_sessions").select("id").in("id", [ids.s1, ids.s2])).data).toHaveLength(2);
    expect((await c.from("code_sessions").select("id").eq("user_id", USER_A).is("git_branch", null)).data).toHaveLength(
      0,
    );
    expect(
      (await c.from("code_sessions").select("id").eq("user_id", USER_A).not("git_branch", "is", null)).data,
    ).toHaveLength(3);
    expect(
      (await c.from("code_sessions").select("id").eq("user_id", USER_A).or("git_branch.eq.main,title.ilike.%504%"))
        .data,
    ).toHaveLength(3);
    expect(
      (
        await c
          .from("code_sessions")
          .select("id")
          .eq("user_id", USER_A)
          .or("git_branch.eq.main,and(title.ilike.%504%,source.eq.claude-code)")
      ).data,
    ).toHaveLength(3);
    expect((await c.from("extracted_metadata").select("topics").contains("topics", ["travel"])).data).toHaveLength(2);
    expect((await c.from("extracted_metadata").select("topics").contains("topics", ["nope"])).data).toHaveLength(0);
  });
  it("textSearch on a tsvector column", async () => {
    const r = await svc()
      .from("session_memories")
      .select("id")
      .eq("user_id", USER_A)
      .textSearch("text_fts", "backoff", { type: "plain", config: "english" });
    expect(r.error).toBeNull();
    expect((r.data as { id: string }[]).map((x) => x.id)).toEqual([ids.m1]);
  });
  it("order with nullsFirst and two keys", async () => {
    const r = await svc()
      .from("code_sessions")
      .select("id, git_branch")
      .eq("user_id", USER_A)
      .order("git_branch", { ascending: true, nullsFirst: true })
      .order("started_at", { ascending: false });
    expect(r.error).toBeNull();
    expect(r.data).toHaveLength(3);
  });
  it("count exact with head", async () => {
    const r = await svc().from("conversations").select("*", { count: "exact", head: true }).eq("user_id", USER_A);
    expect(r.error).toBeNull();
    expect(r.count).toBe(3);
    expect(r.data).toBeNull();
  });
  it("insert, upsert merge, ignore-duplicates with on_conflict, return=minimal", async () => {
    const c = svc();
    const ins = await c
      .from("code_projects")
      .insert({ user_id: USER_A, repo_identity: "codehub/new", display_name: "New" })
      .select("id, display_name")
      .single();
    expect(ins.error).toBeNull();
    expect(ins.data).toMatchObject({ display_name: "New" });
    const merge = await c
      .from("code_projects")
      .upsert(
        { user_id: USER_A, repo_identity: "codehub/new", display_name: "Renamed" },
        { onConflict: "user_id,repo_identity" },
      )
      .select("display_name");
    expect(merge.error).toBeNull();
    expect(merge.data).toEqual([{ display_name: "Renamed" }]);
    const ign = await c
      .from("code_projects")
      .upsert(
        { user_id: USER_A, repo_identity: "codehub/new", display_name: "Ignored" },
        { onConflict: "user_id,repo_identity", ignoreDuplicates: true },
      );
    expect(ign.error).toBeNull();
    const after = await c.from("code_projects").select("display_name").eq("repo_identity", "codehub/new").single();
    expect(after.data).toEqual({ display_name: "Renamed" });
    const dup = await c.from("code_projects").insert({ user_id: USER_A, repo_identity: "codehub/new" });
    expect(dup.error?.code).toBe("23505");
  });
  it("update and delete with filters, maybeSingle and single", async () => {
    const c = svc();
    const none = await c.from("profiles").select("id").eq("id", "99999999-9999-4999-8999-999999999999").maybeSingle();
    expect(none).toMatchObject({ data: null, error: null });
    const upd = await c
      .from("profiles")
      .update({ display_name: "Local" })
      .eq("id", USER_A)
      .select("id, display_name")
      .single();
    expect(upd.data).toEqual({ id: USER_A, display_name: "Local" });
    const del = await c.from("code_projects").delete().eq("repo_identity", "codehub/new").select("id");
    expect(del.data).toHaveLength(1);
  });
  it("rpc via POST returning a scalar, and via GET", async () => {
    const r = await svc().rpc("llm_spend_sum", {
      p_user_id: USER_A,
      p_since: new Date(Date.now() - 7 * 864e5).toISOString(),
    });
    if (r.error) throw new Error(JSON.stringify(r.error));
    const g = await svc().rpc(
      "llm_spend_sum",
      { p_user_id: USER_A, p_since: new Date(Date.now() - 7 * 864e5).toISOString() },
      { get: true },
    );
    expect(g.error).toBeNull();
    expect(g.data).toEqual(r.data);
  });
});

describe("the five fixes", () => {
  it("1 JSON-path columns in select, filter and order", async () => {
    const turns = [
      {
        idx: 0,
        role: "assistant",
        kind: "tool_use",
        text: "a",
        tool_name: "Bash",
        file_path: null,
        ts: "2026-01-01T00:00:00Z",
        props: { action: "merge", n: 2 },
      },
      {
        idx: 1,
        role: "assistant",
        kind: "tool_use",
        text: "b",
        tool_name: "Bash",
        file_path: null,
        ts: "2026-01-01T00:00:01Z",
        props: { action: "close", n: 9 },
      },
      {
        idx: 2,
        role: "assistant",
        kind: "tool_use",
        text: "c",
        tool_name: "Bash",
        file_path: null,
        ts: "2026-01-01T00:00:02Z",
        props: {},
      },
    ];
    const imp = await svc().rpc("import_code_session_turns", {
      p_user_id: USER_A,
      p_session_id: ids.s1,
      p_turns: turns,
    });
    expect(imp.error).toBeNull();
    expect(imp.data).toBe(3);
    const c = svc();
    const sel = await c
      .from("code_session_turns")
      .select("idx, action:props->>action")
      .eq("session_id", ids.s1)
      .order("idx");
    expect(sel.error).toBeNull();
    expect(sel.data).toEqual([
      { idx: 0, action: "merge" },
      { idx: 1, action: "close" },
      { idx: 2, action: null },
    ]);
    const flt = await c
      .from("code_session_turns")
      .select("idx")
      .eq("session_id", ids.s1)
      .not("props->action", "is", null)
      .order("props->>n", { ascending: false });
    expect(flt.error).toBeNull();
    expect(flt.data).toEqual([{ idx: 1 }, { idx: 0 }]);
    const eq = await c.from("code_session_turns").select("idx").eq("session_id", ids.s1).eq("props->>action", "merge");
    expect(eq.data).toEqual([{ idx: 0 }]);
    const num = await c.from("code_session_turns").select("idx").eq("session_id", ids.s1).gt("props->>n", "5");
    expect(num.data).toEqual([{ idx: 1 }]);
  });
  it("2 rpc picks the overload by argument names and coerces jsonb and integer args", async () => {
    const refs = [] as unknown[];
    const five = await svc().rpc("import_code_session_turns", {
      p_user_id: USER_A,
      p_session_id: ids.s2,
      p_turns: [],
      p_forge_refs: refs,
      p_forge_refs_version: 1,
    });
    expect(five.error).toBeNull();
    expect(five.data).toBe(0);
    const bad = await svc().rpc("import_code_session_turns", { p_user_id: USER_A, p_session_id: ids.s2 } as never);
    expect(bad.error?.code).toBe("PGRST202");
  });
  it("2 rpc: an unknown function or argument set is PGRST202; two matching overloads are PGRST203", async () => {
    expect((await svc().rpc("llm_spend_sum", { nope: 1 } as never)).error?.code).toBe("PGRST202");
    expect((await svc().rpc("does_not_exist", {})).error?.code).toBe("PGRST202");
    const f = (args: { name: string; hasDefault: boolean }[]) => ({
      name: "f",
      args: args.map((a) => ({ ...a, type: "text" })),
      positional: false,
      retset: false,
      returns: "scalar" as const,
    });
    const { resolveOverload } = await import("../rpc");
    const { RestError } = await import("../parse");
    expect(() =>
      resolveOverload(
        "f",
        [
          f([{ name: "a", hasDefault: false }]),
          f([
            { name: "a", hasDefault: false },
            { name: "b", hasDefault: true },
          ]),
        ],
        ["a"],
      ),
    ).toThrow(RestError);
    try {
      resolveOverload(
        "f",
        [
          f([{ name: "a", hasDefault: false }]),
          f([
            { name: "a", hasDefault: false },
            { name: "b", hasDefault: true },
          ]),
        ],
        ["a"],
      );
    } catch (e) {
      expect((e as InstanceType<typeof RestError>).code).toBe("PGRST203");
      expect((e as InstanceType<typeof RestError>).status).toBe(300);
    }
  });
  it("2 rpc coerces array arguments from the declared type", async () => {
    const { coerceArg } = await import("../rpc");
    expect(coerceArg({ name: "x", type: "uuid[]", hasDefault: false }, [ids.s1, ids.s2], false)).toBe(
      `{"${ids.s1}","${ids.s2}"}`,
    );
    expect(coerceArg({ name: "x", type: "jsonb", hasDefault: false }, [{ a: 1 }], false)).toBe('[{"a":1}]');
    expect(coerceArg({ name: "x", type: "jsonb", hasDefault: false }, { a: 1 }, true)).toBe('{"a":1}');
    expect(coerceArg({ name: "x", type: "text[]", hasDefault: false }, ['a"b', "c,d"], false)).toBe('{"a\\"b","c,d"}');
  });
  it("3 single() after a write that matched nothing gives 406 with details", async () => {
    const r = await env.raw("profiles?id=eq.99999999-9999-4999-8999-999999999999&select=id", {
      method: "PATCH",
      token: keys.service,
      headers: {
        prefer: "return=representation",
        accept: "application/vnd.pgrst.object+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ display_name: "x" }),
    });
    expect(r.status).toBe(406);
    const b = await r.json();
    expect(b.code).toBe("PGRST116");
    expect(b.details).toBe("The result contains 0 rows");
  });
  it("4 unsupported features answer 400 PGRST1xx, never an empty result", async () => {
    for (const q of [
      "code_sessions?select=id&id=wfoo.bar",
      "code_sessions?select=id&foo.order=a",
      "code_sessions?select=id&order=id.sideways",
    ]) {
      const r = await env.raw(q, { token: keys.service });
      expect(r.status, q).toBe(400);
      expect((await r.json()).code, q).toMatch(/^PGRST1/);
    }
    const p = await env.raw("code_sessions?select=id", { token: keys.service, headers: { prefer: "tx=rollback" } });
    expect(p.status).toBe(400);
    const lim = await env.raw("code_sessions?select=id&limit=abc", { token: keys.service });
    expect(lim.status).toBe(416);
    expect((await lim.json()).code).toBe("PGRST103");
  });
  it("5 noteWrite on every non-GET and never on GET", async () => {
    const before = env.store.writes;
    await svc().from("code_sessions").select("id").limit(1);
    await svc().from("code_sessions").select("id", { count: "exact", head: true });
    expect(env.store.writes).toBe(before);
    await svc().from("profiles").update({ display_name: "n" }).eq("id", USER_A);
    await svc().from("code_projects").delete().eq("repo_identity", "nothing");
    await svc().rpc("llm_spend_sum", { p_user_id: USER_A, p_since: "2020-01-01T00:00:00Z" });
    expect(env.store.writes).toBe(before + 3);
  });
});

describe("RLS and tokens", () => {
  it("an authenticated user sees only their rows", async () => {
    const r = await asA().from("session_memories").select("id");
    expect(r.error).toBeNull();
    expect((r.data as { id: string }[]).map((x) => x.id).sort()).toEqual([ids.m1, ids.m2].sort());
    const b = await env.client(keys.user(USER_B)).from("session_memories").select("id");
    expect((b.data as { id: string }[]).map((x) => x.id)).toEqual([ids.mB]);
  });
  it("service_role sees every row", async () => {
    const r = await svc().from("session_memories").select("id");
    expect(r.data).toHaveLength(3);
  });
  it("anon sees none", async () => {
    const r = await env.client(keys.anon).from("session_memories").select("id");
    expect(r.data ?? []).toHaveLength(0);
  });
  it("a user cannot write another user's row", async () => {
    const r = await asA().from("code_projects").update({ display_name: "hijack" }).eq("id", ids.projB).select("id");
    expect(r.data ?? []).toHaveLength(0);
  });
  it("forged, none-alg, expired and malformed tokens are refused", async () => {
    const forged = (await import("../../../auth-stub/jwt")).signJwt(
      { role: "service_role" },
      "wrong-secret-wrong-secret-wrong-secret",
    );
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"role":"service_role"}').toString("base64url")}.`;
    const expired = (await import("../../../auth-stub/jwt")).signJwt(
      { role: "service_role", exp: 1 },
      (await import("./harness")).SECRET,
    );
    for (const t of [forged, none, expired, "garbage"]) {
      const r = await env.raw("session_memories?select=id", { token: t });
      expect([401, 403]).toContain(r.status);
      expect(await r.text()).not.toContain(ids.m1);
    }
    const noAuth = await env.raw("session_memories?select=id");
    expect([401, 403]).toContain(noAuth.status);
  });
  it("a token claiming an unknown role is refused", async () => {
    const t = (await import("../../../auth-stub/jwt")).signJwt(
      { role: "postgres" },
      (await import("./harness")).SECRET,
    );
    const r = await env.raw("session_memories?select=id", { token: t });
    expect([401, 403]).toContain(r.status);
  });
});

describe("injection", () => {
  it("column names, JSON-path keys, order and select are refused or bound", async () => {
    const evil = [
      "code_sessions?select=id;drop table profiles",
      "code_sessions?select=id&order=id;drop table profiles",
      "code_sessions?select=id&order=title->>'x'.asc",
      "code_sessions?select=id&title->>x'or'1=eq.1",
      'code_sessions?select=id&"id"=eq.1',
      "code_sessions?select=id,(select 1)",
      "code_sessions?select=id&id=eq.1);drop table profiles;--",
      "pg_catalog.pg_user?select=*",
      "profiles;select 1?select=id",
    ];
    for (const q of evil) {
      const r = await env.raw(q, { token: keys.service });
      await r.text();
      expect(r.status, q).toBeGreaterThanOrEqual(400);
    }
    const still = await svc().from("profiles").select("id", { count: "exact", head: true });
    expect(still.count).toBe(2);
  });
  it("a hostile value is bound, not interpolated", async () => {
    const r = await svc().from("profiles").select("id").eq("email", "x'; drop table profiles;--");
    expect(r.error).toBeNull();
    expect(r.data).toEqual([]);
    expect((await svc().from("profiles").select("id", { count: "exact", head: true })).count).toBe(2);
  });
});

describe("slow requests", () => {
  it("warn once a request exceeds 2 s", async () => {
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = vi.spyOn(Date, "now");
    let t = 0;
    now.mockImplementation(() => (t += 2500));
    try {
      await env.raw("profiles?select=id", { token: keys.service });
    } finally {
      now.mockRestore();
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("credentials and conflict targets", () => {
  it("a non-Bearer Authorization header is 401 even with a valid service apikey", async () => {
    const r = await env.raw("profiles?select=id", {
      headers: { authorization: `Token ${keys.user(USER_A)}`, apikey: keys.service },
    });
    expect(r.status).toBe(401);
    await r.text();
    const ok = await env.raw("profiles?select=id", { headers: { apikey: keys.service } });
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it("ignore-duplicates without on_conflict targets the primary key, so another unique violation is a 409", async () => {
    const row = {
      id: "2dddddd1-1111-4111-8111-111111111111",
      user_id: USER_A,
      code_project_id: ids.projA,
      source: "claude-code",
      source_session_id: "sess-1", // same (user_id, source, source_session_id) as seed s1, different id
      content_hash: "hx",
    };
    const post = (body: unknown) =>
      env.raw("code_sessions", {
        method: "POST",
        token: keys.service,
        headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(body),
      });
    const dup = await post(row);
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { code: string }).code).toBe("23505");
    // a primary-key duplicate is ignored
    const same = await post({ ...row, id: ids.s1 });
    expect(same.status).toBe(201);
    await same.text();
  });
});
