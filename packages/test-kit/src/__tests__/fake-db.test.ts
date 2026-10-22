import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeDb, DB_MAX_ROWS, FakeDb, FIXED_CLOCK_ISO, type Row } from "../index.js";

describe("memory flavour", () => {
  it("keeps tables by reference and drops inserts, reporting them to onInsert", async () => {
    const tables: Record<string, Row[]> = { t: [{ id: "a", n: 1 }] };
    const seen: Row[] = [];
    const db = createFakeDb({ flavour: "memory", tables, onInsert: (_t, r) => seen.push(r) });
    const res = await db.client.from("t").insert({ id: "b" });
    expect(res).toEqual({ data: null, error: null });
    expect(tables.t).toHaveLength(1);
    expect(seen).toEqual([{ id: "b" }]);
    expect(db.oplog).toEqual([{ seq: 1, table: "t", op: "insert", payload: { id: "b" } }]);
  });

  it("filters with contains/not/is/gte, records .or() without applying it, has no .single()", async () => {
    const tables: Record<string, Row[]> = {
      t: [
        { id: "a", tags: ["x", "y"], d: null, at: "2026-01-02" },
        { id: "b", tags: ["x"], d: 1, at: null },
      ],
    };
    const db = createFakeDb({ flavour: "memory", tables });
    const q = db.client.from("t").select("*").contains("tags", ["x"]).or("id.eq.b");
    expect((await q).data.map((r: Row) => r.id)).toEqual(["a", "b"]);
    expect(q.orFilters).toEqual(["id.eq.b"]);
    expect((await db.client.from("t").select().not("d", "is", null)).data).toEqual([tables.t[1]]);
    expect((await db.client.from("t").select().is("d", null)).data).toEqual([tables.t[0]]);
    expect((await db.client.from("t").select().gte("at", "2026-01-01")).data).toEqual([tables.t[0]]);
    expect(db.client.from("t").single).toBeUndefined();
    expect(db.client.from("t").lte).toBeUndefined();
  });

  it("applies upsert on build with deterministic ids, update/delete in place, order then limit then range", async () => {
    const tables: Record<string, Row[]> = { t: [{ id: "a", k: 1, v: 0 }] };
    const db = createFakeDb({ flavour: "memory", tables });
    const up = db.client.from("t").upsert(
      [
        { k: 1, v: 5 },
        { k: 2, v: 6 },
      ],
      { onConflict: "k" },
    );
    expect(tables.t.map((r) => r.v)).toEqual([5, 6]);
    expect(tables.t[1].id).toBe("fake-1-1");
    expect((await up.select()).data).toHaveLength(2);
    const arr = tables.t;
    await db.client.from("t").delete().eq("k", 2);
    expect(tables.t).toBe(arr);
    expect(tables.t).toHaveLength(1);
    await db.client.from("t").update({ v: 9 }).eq("id", "a");
    expect(tables.t[0].v).toBe(9);
    tables.t.push({ id: "c", v: 1 }, { id: "d", v: 3 });
    const r = await db.client.from("t").select().order("v", { ascending: false }).limit(3).range(1, 5);
    expect(r.data.map((x: Row) => x.id)).toEqual(["d", "c"]);
  });

  it("serves rpc handlers and the migration-109 props patch", async () => {
    const tables: Record<string, Row[]> = { code_sessions: [{ id: "s", user_id: "u", props: { a: 1, b: 2 } }] };
    const db = createFakeDb({ flavour: "memory", tables, rpc: { f: (a) => ({ data: a.x, error: null }) } });
    expect(await db.client.rpc("f", { x: 3 })).toEqual({ data: 3, error: null });
    expect(await db.client.rpc("g", {})).toEqual({ data: null, error: { message: "no fake rpc handler for g" } });
    await db.client.rpc("code_session_props_patch", {
      p_session_id: "s",
      p_user_id: "u",
      p_set: { c: 3 },
      p_remove: ["a"],
    });
    expect(tables.code_sessions[0].props).toEqual({ b: 2, c: 3 });
    expect(db.oplog.map((o) => o.op)).toEqual(["rpc", "rpc", "rpc"]);
  });
});

describe("code-sessions flavour", () => {
  const cs = () => createFakeDb({ flavour: "code-sessions" });

  it("seeds copies, stamps inserts with counter ids and the injected clock", async () => {
    const db = createFakeDb({ flavour: "code-sessions", clock: () => "2026-05-05T00:00:00.000Z" });
    const seedRow = { id: "x" };
    db.seed("t", [seedRow]);
    expect(db.getRows("t")[0]).not.toBe(seedRow);
    const { data } = await db.from("t").insert({ n: 1 }).select().single();
    expect(data).toEqual({ id: "fa4e0000-0000-4000-8000-000000000001", created_at: "2026-05-05T00:00:00.000Z", n: 1 });
    expect(await db.from("t").insert({ n: 2 })).toEqual({ data: null, error: null });
  });

  it("clamps unpaginated selects and wide ranges to DB_MAX_ROWS", async () => {
    const db = cs();
    db.seed(
      "t",
      Array.from({ length: DB_MAX_ROWS + 5 }, (_, i) => ({ id: i })),
    );
    expect(((await db.from("t").select()).data as Row[]).length).toBe(DB_MAX_ROWS);
    expect(((await db.from("t").select().range(0, 5000)).data as Row[]).length).toBe(DB_MAX_ROWS);
    expect(((await db.from("t").select().limit(3)).data as Row[]).length).toBe(3);
    expect((await db.from("t").select("id", { count: "exact", head: true })).count).toBe(DB_MAX_ROWS + 5);
  });

  it("applies .or() eq/neq terms, orders nulls first ascending, errors on an empty .single()", async () => {
    const db = cs();
    db.seed("t", [
      { id: "a", s: "x", o: 2 },
      { id: "b", s: "y", o: null },
      { id: "c", s: "z", o: 1 },
    ]);
    expect(((await db.from("t").select().or("s.eq.x,s.eq.z")).data as Row[]).map((r) => r.id)).toEqual(["a", "c"]);
    expect(((await db.from("t").select().order("o")).data as Row[]).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(await db.from("t").select().eq("id", "nope").single()).toEqual({
      data: null,
      error: { message: "no rows" },
    });
    expect(db.from("t").contains).toBeUndefined();
  });

  it("rejects a duplicate conflict key inside one upsert and merges onto existing rows", async () => {
    const db = cs();
    db.seed("t", [{ id: "a", k: 1, v: 0, created_at: "old" }]);
    const dup = await db.from("t").upsert([{ k: 2 }, { k: 2 }], { onConflict: "k" });
    expect(dup.error?.message).toMatch(/cannot affect row a second time/);
    await db.from("t").upsert({ k: 1, v: 7 }, { onConflict: "k" });
    expect(db.getRows("t")).toEqual([{ id: "a", k: 1, v: 7, created_at: "old" }]);
    expect(db.oplog.at(-1)).toMatchObject({ op: "upsert", onConflict: "k", payload: { k: 1, v: 7 } });
  });

  it("delete replaces the table array; asClient is {from, rpc}; unknown rpc errors", async () => {
    const db = cs();
    db.seed("t", [{ id: "a" }, { id: "b" }]);
    const before = db.getRows("t");
    await db.asClient().from("t").delete().eq("id", "a");
    expect(db.getRows("t")).not.toBe(before);
    expect(db.getRows("t")).toEqual([{ id: "b" }]);
    expect(Object.keys(db.asClient()).sort()).toEqual(["from", "rpc"]);
    expect(await db.rpc("x", {})).toEqual({ data: null, error: { message: "no fake rpc x" } });
    expect(db.oplog[0]).toEqual({ seq: 1, table: "t", op: "delete", filters: ['eq.id="a"'], payload: null });
  });

  it("subclasses like the old FakeSupabase class", () => {
    class Sub extends FakeDb {
      constructor() {
        super({ flavour: "code-sessions" });
      }
    }
    expect(new Sub().getRows("t")).toEqual([]);
  });

  it("import_code_session_turns (migration 112): replaces one session's turns, all or nothing", async () => {
    const db = cs();
    db.seed("code_sessions", [
      { id: "s1", user_id: "u1" },
      { id: "s2", user_id: "u1" },
    ]);
    db.seed("code_session_turns", [
      { id: "old-0", user_id: "u1", session_id: "s1", idx: 0 },
      { id: "old-1", user_id: "u1", session_id: "s1", idx: 1 },
      { id: "other", user_id: "u1", session_id: "s2", idx: 0 },
    ]);
    const call = (args: Record<string, unknown>) =>
      db.client.rpc("import_code_session_turns", { p_user_id: "u1", p_session_id: "s1", ...args });
    const ids = () =>
      db
        .getRows("code_session_turns")
        .map((r) => r.id)
        .sort();
    const before = ids();

    const wrongUser = await call({ p_user_id: "u2", p_turns: [] });
    expect(wrongUser.data).toBeNull();
    expect(wrongUser.error?.message).toMatch(/not found/);
    expect((await call({ p_turns: { idx: 0 } })).error).not.toBeNull();
    const dup = await call({
      p_turns: [
        { idx: 0, role: "user", kind: "prose" },
        { idx: 0, role: "user", kind: "prose" },
      ],
    });
    expect(dup.error?.code).toBe("23505");
    const badTs = await call({ p_turns: [{ idx: 0, role: "user", kind: "prose", ts: "not-a-date" }] });
    expect(badTs.error?.code).toBe("22007");
    const noRole = await call({ p_turns: [{ idx: 0, kind: "prose" }] });
    expect(noRole.error?.code).toBe("23502");
    const noKind = await call({ p_turns: [{ idx: 0, role: "user", kind: null }] });
    expect(noKind.error?.code).toBe("23502");
    expect(ids()).toEqual(before);

    const ok = await call({ p_turns: [{ idx: 0, role: "user", kind: "prose", text: "new" }] });
    expect(ok).toEqual({ data: 1, error: null });
    const turns = db.getRows("code_session_turns");
    expect(turns.map((r) => r.id).sort()).toEqual(["fa4e0000-0000-4000-8000-000000000001", "other"]);
    const fresh = turns.find((r) => r.session_id === "s1");
    expect(fresh).toMatchObject({ user_id: "u1", idx: 0, text: "new", tool_name: null, props: {} });
    expect(db.oplog.at(-1)).toMatchObject({ table: "import_code_session_turns", op: "rpc" });
  });
});

describe("kg flavour", () => {
  it("copies initial rows, ids from a module-level counter prefixed by table", async () => {
    const init = { t: [{ id: "a" }] };
    const a = createFakeDb({ flavour: "kg", tables: init });
    expect(a.tables.t[0]).not.toBe(init.t[0]);
    const r1 = await a.supabase.from("t").insert({ x: 1 }).select("id").single();
    const b = createFakeDb({ flavour: "kg" });
    const r2 = await b.supabase.from("t").insert({ x: 2 }).select("id").single();
    const n1 = Number(String(r1.data.id).split("-")[1]);
    expect(r1.data.id).toMatch(/^t-\d+$/);
    expect(r2.data.id).toBe(`t-${n1 + 1}`);
  });

  it("ignores order/limit/or/not, returns copies, is() is strict, select after update is a read", async () => {
    const db = createFakeDb({ flavour: "kg", tables: { t: [{ id: "b" }, { id: "a", d: null }] } });
    const { data } = await db.supabase.from("t").select().order("id").limit(1).or("x").not("d", "is", null);
    expect(data.map((r: Row) => r.id)).toEqual(["b", "a"]);
    data[0].id = "mutated";
    expect(db.tables.t[0].id).toBe("b");
    expect((await db.supabase.from("t").select().is("d", null)).data).toEqual([{ id: "a", d: null }]);
    await db.supabase.from("t").update({ v: 1 }).eq("id", "a").select();
    expect(db.tables.t[1].v).toBeUndefined();
    await db.supabase.from("t").update({ v: 1 }).eq("id", "a");
    expect(db.tables.t[1].v).toBe(1);
    expect(db.supabase.rpc).toBeUndefined();
    expect(db.supabase.from("t").delete).toBeUndefined();
  });

  it("upsert keys on user_id and returns only created rows; head selects return [] with a count", async () => {
    const db = createFakeDb({ flavour: "kg", tables: { p: [{ id: "p1", user_id: "u1", v: 0 }] } });
    const r = await db.supabase.from("p").upsert(
      [
        { user_id: "u1", v: 1 },
        { id: "p2", user_id: "u2" },
      ],
      { onConflict: "user_id" },
    );
    expect(r.data).toEqual([{ id: "p2", user_id: "u2" }]);
    expect(db.tables.p[0].v).toBe(1);
    expect(await db.supabase.from("p").select("*", { count: "exact", head: true })).toEqual({
      data: [],
      error: null,
      count: 2,
    });
  });
});

describe("db flavour (forward default)", () => {
  it("stores inserts with per-instance deterministic ids and the fixed clock", async () => {
    const a = createFakeDb();
    const b = createFakeDb();
    await a.client.from("t").insert({ n: 1 });
    await b.client.from("t").insert({ n: 1 });
    expect(a.tables.t).toEqual(b.tables.t);
    expect(a.tables.t[0]).toEqual({ id: "fa4e0000-0000-4000-8000-000000000001", created_at: FIXED_CLOCK_ISO, n: 1 });
  });

  it("honours nextId injection and has the full filter surface", async () => {
    let n = 0;
    const db = createFakeDb({ nextId: (t) => `${t}#${++n}` });
    await db.client.from("t").insert([
      { tags: ["a"], d: null },
      { tags: ["b"], d: 1 },
    ]);
    expect(db.tables.t.map((r) => r.id)).toEqual(["t#1", "t#2"]);
    expect((await db.client.from("t").select().contains("tags", ["b"]).not("d", "is", null).single()).data.id).toBe(
      "t#2",
    );
  });

  it("logs writes on resolve, not on build, and reads only with recordReads", async () => {
    const db = createFakeDb();
    const pending = db.client.from("t").insert({ id: "x" });
    expect(db.oplog).toEqual([]);
    await pending;
    await db.client.from("t").select().eq("id", "x");
    await db.client.from("t").update({ v: 1 }).eq("id", "x");
    expect(db.oplog.map((o) => [o.seq, o.op])).toEqual([
      [1, "insert"],
      [2, "update"],
    ]);
    const reads = createFakeDb({ recordReads: true });
    await reads.client.from("t").select().in("id", ["a"]);
    expect(reads.oplog).toEqual([
      { seq: 1, table: "t", op: "select", filters: ['in.id=["a"]'], payload: { columns: "*", modifiers: [] } },
    ]);
  });

  it("records the select columns and modifiers in call order without changing results", async () => {
    const tables = {
      t: [
        { id: "a", v: 1 },
        { id: "b", v: 2 },
        { id: "c", v: null },
      ],
    };
    const plain = createFakeDb({ tables: structuredClone(tables) });
    const reads = createFakeDb({ tables: structuredClone(tables), recordReads: true });
    const chain = (d: FakeDb) =>
      d.client
        .from("t")
        .select("id, v")
        .order("v", { ascending: false, nullsFirst: true })
        .order("id")
        .limit(2)
        .range(0, 1);
    expect(await chain(reads)).toEqual(await chain(plain));
    await reads.client.from("t").select("id", { count: "exact", head: true }).eq("id", "a");
    await reads.client.from("t").select("id").eq("id", "a").single();
    await reads.client.from("t").select().eq("id", "z").maybeSingle();
    await reads.client.from("t").update({ v: 3 }).eq("id", "a").select("id").single();
    expect(reads.oplog.map((o) => [o.op, o.payload])).toEqual([
      ["select", { columns: "id, v", modifiers: ["order.v.desc.nullsfirst", "order.id.asc", "limit.2", "range.0.1"] }],
      ["select", { columns: "id", modifiers: ["count.exact.head"] }],
      ["select", { columns: "id", modifiers: ["single"] }],
      ["select", { columns: "*", modifiers: ["maybeSingle"] }],
      ["update", { v: 3 }],
    ]);
  });

  it("snapshot is stable-sorted and detached from live state", async () => {
    const db = createFakeDb({ tables: { z: [{ id: "2", b: 1, a: 2 }, { id: "1" }], a: [] } });
    const snap = db.snapshot();
    expect(Object.keys(snap)).toEqual(["a", "z"]);
    expect(JSON.stringify(snap.z)).toBe('[{"id":"1"},{"a":2,"b":1,"id":"2"}]');
    snap.z[0].id = "changed";
    expect(db.tables.z[1].id).toBe("1");
  });

  it("auth.getUser reads auth.users; seedApiKey stores sha256 like api-keys.ts", async () => {
    const db = createFakeDb();
    const jwt = db.seedUser({ id: "u1", email: "dev@example.test" });
    expect(await db.client.auth.getUser(jwt)).toEqual({
      data: { user: { id: "u1", email: "dev@example.test" } },
      error: null,
    });
    expect((await db.auth.getUser("bogus")).data.user).toBeNull();
    const hash = db.seedApiKey("u1", "lls_test_key");
    expect(hash).toBe(createHash("sha256").update("lls_test_key").digest("hex"));
    const { data } = await db.client.from("profiles").select("id").eq("api_key_hash", hash).single();
    expect(data.id).toBe("u1");
  });
});

describe("db flavour: PostgREST semantics", () => {
  const turns = (): Row[] => [
    { id: "a", s: 3, created_at: "2026-02-01T00:00:00.000Z", props: { action: { k: "run" }, kind: "tool", n: 2 } },
    { id: "b", s: 1, created_at: "2025-12-31T23:59:59.999Z", props: { kind: "prose", n: 10 } },
    { id: "c", s: null, created_at: "2026-01-01T00:00:00.000Z", props: { action: null, kind: "tool" } },
  ];

  it("resolves JSON paths in filters: -> keeps jsonb null distinct from SQL NULL, ->> is text", async () => {
    const db = createFakeDb({ tables: { t: turns() } });
    const ids = async (q: PromiseLike<{ data: unknown }>) => ((await q).data as Row[]).map((r) => r.id);
    expect(await ids(db.client.from("t").select("id").not("props->action", "is", null))).toEqual(["a", "c"]);
    expect(await ids(db.client.from("t").select("id").is("props->>action", null))).toEqual(["b", "c"]);
    expect(await ids(db.client.from("t").select("id").eq("props->>kind", "tool"))).toEqual(["a", "c"]);
    expect(await ids(db.client.from("t").select("id").neq("props->>kind", "tool"))).toEqual(["b"]);
    expect(await ids(db.client.from("t").select("id").gt("props->n", 5))).toEqual(["b"]);
    expect(await ids(db.client.from("t").select("id").in("props->>kind", ["prose"]))).toEqual(["b"]);
    expect(await ids(db.client.from("t").select("id").like("props->>kind", "to%"))).toEqual(["a", "c"]);
    expect(await ids(db.client.from("t").select("id").ilike("props->>kind", "PROSE"))).toEqual(["b"]);
    expect(await ids(db.client.from("t").select("id").order("props->n", { ascending: false }))).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("projects the select list with aliases and path keys; * and embeds keep whole rows", async () => {
    const db = createFakeDb({ tables: { t: turns() } });
    const { data } = await db.client.from("t").select("id, act:props->action, props->>kind").eq("id", "a");
    expect(data).toEqual([{ id: "a", act: { k: "run" }, kind: "tool" }]);
    expect((await db.client.from("t").select("id, act:props->action").eq("id", "c")).data).toEqual([
      { id: "c", act: null },
    ]);
    expect((await db.client.from("t").select("*").eq("id", "b")).data).toEqual([turns()[1]]);
    expect((await db.client.from("t").select("id, other(*)").eq("id", "b")).data).toEqual([turns()[1]]);
    const ins = await db.client.from("t").insert({ id: "d", s: 9 }).select("id").single();
    expect(ins).toEqual({ data: { id: "d" }, error: null });
  });

  it("accumulates .order() calls (first is primary) with nulls last ascending, first descending", async () => {
    const rows: Row[] = [
      { id: "1", g: "x", o: 2 },
      { id: "2", g: "y", o: null },
      { id: "3", g: "x", o: 1 },
      { id: "4", g: null, o: 5 },
      { id: "5", g: "y", o: 0 },
    ];
    const db = createFakeDb({ tables: { t: rows } });
    const ids = async (q: PromiseLike<{ data: unknown }>) => ((await q).data as Row[]).map((r) => r.id);
    expect(await ids(db.client.from("t").select().order("g").order("o"))).toEqual(["3", "1", "5", "2", "4"]);
    expect(
      await ids(db.client.from("t").select().order("g", { ascending: false }).order("o", { ascending: false })),
    ).toEqual(["4", "2", "5", "1", "3"]);
    expect(await ids(db.client.from("t").select().order("o", { ascending: false, nullsFirst: false }))).toEqual([
      "4",
      "1",
      "3",
      "5",
      "2",
    ]);
  });

  it("upsert with ignoreDuplicates keeps the stored row and tolerates in-call duplicates", async () => {
    const db = createFakeDb({ tables: { t: [{ id: "a", k: "x", v: 1 }] } });
    const res = await db.client
      .from("t")
      .upsert(
        [
          { k: "x", v: 2 },
          { k: "y", v: 3 },
          { k: "y", v: 4 },
        ],
        { onConflict: "k", ignoreDuplicates: true },
      )
      .select("k, v");
    expect(res).toEqual({ data: [{ k: "y", v: 3 }], error: null });
    expect(db.tables.t.map((r) => [r.k, r.v])).toEqual([
      ["x", 1],
      ["y", 3],
    ]);
    const dup = await db.client.from("t").upsert(
      [
        { k: "z", v: 1 },
        { k: "z", v: 2 },
      ],
      { onConflict: "k" },
    );
    expect(dup.error?.message).toMatch(/cannot affect row a second time/);
  });

  it(".or() compares timestamps without splitting on '.', supports and(...) and quoted values", async () => {
    const db = createFakeDb({ tables: { t: turns() } });
    const ids = async (q: PromiseLike<{ data: unknown }>) => ((await q).data as Row[]).map((r) => r.id);
    expect(await ids(db.client.from("t").select().or("s.gt.1,created_at.lt.2026-01-01T00:00:00.000Z"))).toEqual([
      "a",
      "b",
    ]);
    const t = '"2026-01-01T00:00:00.000Z"';
    expect(await ids(db.client.from("t").select().or(`created_at.gt.${t},and(created_at.eq.${t},id.gt.b)`))).toEqual([
      "a",
      "c",
    ]);
    expect(await ids(db.client.from("t").select().or("s.is.null,s.gte.3"))).toEqual(["a", "c"]);
    expect(await ids(db.client.from("t").select().or("props->>kind.eq.prose,s.in.(3)"))).toEqual(["a", "b"]);
    expect(await ids(db.client.from("t").select().or("id.like.a*,id.neq.c"))).toEqual(["a", "b"]);
  });

  it(".single() errors with PGRST116 on 0 or 2+ rows; .maybeSingle() on 2+", async () => {
    const db = createFakeDb({ tables: { t: turns() } });
    const pgrst = expect.objectContaining({ code: "PGRST116" });
    expect(await db.client.from("t").select().eq("id", "nope").single()).toEqual({ data: null, error: pgrst });
    expect(await db.client.from("t").select().single()).toEqual({ data: null, error: pgrst });
    expect(await db.client.from("t").select().maybeSingle()).toEqual({ data: null, error: pgrst });
    expect(await db.client.from("t").select().eq("id", "nope").maybeSingle()).toEqual({ data: null, error: null });
    expect((await db.client.from("t").select("id").eq("id", "b").maybeSingle()).data).toEqual({ id: "b" });
  });
});
