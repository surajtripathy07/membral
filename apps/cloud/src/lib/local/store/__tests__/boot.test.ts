// Real PGlite on temp directories: lifecycle of the embedded store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEmbeddedStore, createPgliteHandle } from "../boot";
import { acquireLock, LOCK_FILE } from "../lock";
import { migrationVersion } from "../migrate";
import { getStore, storeState } from "../registry";

const APP = path.resolve(__dirname, "../../../../..");
const MIG = path.join(APP, "supabase", "migrations");
const PRELUDE = path.join(APP, "supabase", "local", "auth-prelude.sql");
const dirs: string[] = [];
let closers: Array<() => Promise<void>> = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "membral-boot-"));
  dirs.push(d);
  return d;
}
function localEnv(dataDir: string) {
  vi.stubEnv("MEMBRAL_LOCAL", "1");
  vi.stubEnv("MEMBRAL_STORE", "pglite");
  vi.stubEnv("MEMBRAL_PGDATA", dataDir);
  vi.stubEnv("VERCEL", "");
}
const opts = { migrationsDir: MIG, preludeFile: PRELUDE, signals: false };

beforeEach(() => {
  closers = [];
});
afterEach(async () => {
  for (const c of closers) await c().catch(() => undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("migrationVersion", () => {
  it("matches the CLI format (version before the first underscore, name after)", () => {
    expect(migrationVersion("001_init_schema.sql")).toEqual({ version: "001", name: "init_schema" });
    expect(migrationVersion("20240101000000_x.sql")).toEqual({ version: "20240101000000", name: "x" });
    expect(migrationVersion("bare.sql")).toEqual({ version: "bare", name: "" });
  });
});

describe("bootEmbeddedStore", () => {
  it("boots nothing when not local, not pglite, or on Vercel", async () => {
    const d = tmp();
    localEnv(d);
    vi.stubEnv("MEMBRAL_LOCAL", "");
    expect(await bootEmbeddedStore(opts)).toBeUndefined();
    localEnv(d);
    vi.stubEnv("MEMBRAL_STORE", "");
    expect(await bootEmbeddedStore(opts)).toBeUndefined();
    localEnv(d);
    vi.stubEnv("VERCEL", "1");
    expect(await bootEmbeddedStore(opts)).toBeUndefined();
    expect(getStore()).toBeUndefined();
    expect(storeState()).toBeUndefined();
    expect(fs.readdirSync(d)).toEqual([]);
  });

  it("applies prelude and all migrations on a fresh dir, applies 0 on reboot, reclaims lock, casts vectors, analyzes", async () => {
    const d = tmp();
    localEnv(d);
    const total = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).length;

    const querySpy = vi.spyOn(PGlite.prototype, "query");
    const first = await bootEmbeddedStore(opts);
    expect(first).toBeDefined();
    closers.push(() => first?.close() ?? Promise.resolve());
    expect(storeState()).toBe("ready");
    expect(getStore()).toBe(first?.handle);
    expect(querySpy.mock.calls.some((c) => c[0] === "analyze")).toBe(true); // ANALYZE at boot, via the handle queue

    // a second boot in the same process never opens a second store
    expect(await bootEmbeddedStore(opts)).toBeUndefined();

    const h = first?.handle;
    if (!h) throw new Error("no handle");
    const rows = (await h.query("select version, name from supabase_migrations.schema_migrations order by version"))
      .rows;
    expect(rows).toHaveLength(total);
    const files = fs
      .readdirSync(MIG)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(rows[0]).toEqual(migrationVersion(files[0] as string));
    expect((await h.query("select 1 from pg_roles where rolname = 'service_role'")).rows).toHaveLength(1);
    expect(fs.existsSync(path.join(d, LOCK_FILE))).toBe(true);

    // the lock refuses a second owner while open (not reachable through boot: same process), so release by close
    await first?.close();
    expect(fs.existsSync(path.join(d, LOCK_FILE))).toBe(false);
    expect(getStore()).toBeUndefined();

    // reopen the same dir: nothing to apply, and ::vector works
    const second = await bootEmbeddedStore(opts);
    closers.push(() => second?.close() ?? Promise.resolve());
    const n = (await second?.handle.query("select count(*)::int as n from supabase_migrations.schema_migrations"))
      ?.rows[0]?.n;
    expect(n).toBe(total);
    const v = await second?.handle.query("select '[1,2]'::vector(2)::text as v");
    expect(v?.rows[0]?.v).toBe("[1,2]");
  }, 240_000);

  it("applies a newly added migration file on the next boot, and names the file when one fails", async () => {
    const d = tmp();
    const migs = tmp();
    fs.writeFileSync(path.join(migs, "001_a.sql"), "create table public.t_a (id int);");
    localEnv(d);
    const o = { ...opts, migrationsDir: migs };
    const a = await bootEmbeddedStore(o);
    await a?.close();

    fs.writeFileSync(path.join(migs, "002_b.sql"), "create table public.t_b (id int);");
    const b = await bootEmbeddedStore(o);
    closers.push(() => b?.close() ?? Promise.resolve());
    const v = (await b?.handle.query("select version, name from supabase_migrations.schema_migrations order by 1"))
      ?.rows;
    expect(v).toEqual([
      { version: "001", name: "a" },
      { version: "002", name: "b" },
    ]);
    await b?.close();

    fs.writeFileSync(path.join(migs, "003_bad.sql"), "select * from public.no_such_table;");
    await expect(bootEmbeddedStore(o)).rejects.toThrow(/003_bad\.sql/);
    expect(storeState()).toBe("error");
    expect(fs.existsSync(path.join(d, LOCK_FILE))).toBe(false); // failed boot releases the lock
    expect(getStore()).toBeUndefined();
  }, 120_000);

  it("refuses a data dir held by a live pid", async () => {
    const d = tmp();
    localEnv(d);
    const holder = await acquireLock(d); // this test process stands in for another owner
    try {
      await expect(bootEmbeddedStore(opts)).rejects.toThrow(/in use by pid |already open/);
    } finally {
      holder();
    }
  });

  it("closes and releases the lock on SIGTERM", async () => {
    const d = tmp();
    const migs = tmp();
    fs.writeFileSync(path.join(migs, "001_a.sql"), "create table public.t_a (id int);");
    localEnv(d);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const s = await bootEmbeddedStore({ ...opts, migrationsDir: migs, signals: true });
    closers.push(() => s?.close() ?? Promise.resolve());
    expect(fs.existsSync(path.join(d, LOCK_FILE))).toBe(true);
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(fs.existsSync(path.join(d, LOCK_FILE))).toBe(false);
    expect(getStore()).toBeUndefined();
  }, 120_000);

  it("calls the write hook on noteWrite and counts toward ANALYZE", async () => {
    const d = tmp();
    const migs = tmp();
    fs.writeFileSync(path.join(migs, "001_a.sql"), "create table public.t_a (id int);");
    localEnv(d);
    const s = await bootEmbeddedStore({ ...opts, migrationsDir: migs, analyzeIntervalMs: 50 });
    closers.push(() => s?.close() ?? Promise.resolve());
    const querySpy = vi.spyOn(PGlite.prototype, "query");
    s?.handle.noteWrite();
    await vi.waitFor(() => expect(querySpy.mock.calls.some((c) => c[0] === "analyze")).toBe(true), { timeout: 3000 });
  }, 60_000);
});

describe("createPgliteHandle", () => {
  it("serializes transactions, rolls back on throw, and sets search_path inside", async () => {
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const db = new PGlite({ extensions: { vector } });
    await db.waitReady;
    await db.exec(
      "create schema if not exists extensions; create extension if not exists vector with schema extensions;",
    );
    await db.exec("create table public.t (n int)");
    const writes = vi.fn();
    const h = createPgliteHandle(db, { onWrite: writes });

    await expect(
      h.transaction(async (tx) => {
        await tx.query("insert into public.t values (1)");
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect((await h.query("select count(*)::int as n from public.t")).rows[0]?.n).toBe(0);

    const order: number[] = [];
    await Promise.all([
      h.transaction(async (tx) => {
        await tx.query("select pg_sleep(0.05)");
        order.push(1);
      }),
      h.transaction(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);

    const v = await h.transaction((tx) => tx.query("select '[1,2]'::vector(2)::text as v"));
    expect(v.rows[0]?.v).toBe("[1,2]");
    h.noteWrite();
    expect(writes).toHaveBeenCalledTimes(1);
    await db.close();
  });
});

describe("session state and maintenance", () => {
  function smallMigs(): string {
    const migs = tmp();
    fs.writeFileSync(path.join(migs, "001_a.sql"), "create table public.t_a (id int, at timestamptz);");
    return migs;
  }

  it("runs maintenance ANALYZE through the queue, after an open request transaction, as the owner", async () => {
    const d = tmp();
    localEnv(d);
    const booted = await bootEmbeddedStore({ ...opts, migrationsDir: smallMigs() });
    closers.push(() => booted?.close() ?? Promise.resolve());
    if (!booted) throw new Error("no store");
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inTx: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      inTx = r;
    });
    const spy = vi.spyOn(PGlite.prototype, "query");
    const tx = booted.handle.transaction(async (t) => {
      await t.query("set local role anon");
      inTx();
      await gate;
      events.push("tx-end");
    });
    await started;
    const analyzed = booted.analyzeNow().then(() => events.push("analyze-done"));
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]); // queued behind the open transaction, not run inside it
    release();
    await tx;
    await analyzed;
    expect(events).toEqual(["tx-end", "analyze-done"]);
    expect(spy.mock.calls.some((c) => c[0] === "analyze")).toBe(true);
    // the session role was restored by the commit: ANALYZE ran as the owner, not anon
    const who = await booted.handle.query("select current_user as u");
    expect(who.rows[0]?.u).not.toBe("anon");
  }, 120_000);

  it("pins the session timezone to UTC, so timestamptz round-trips as +00:00 whatever TZ the process has", async () => {
    const d = tmp();
    localEnv(d);
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      const booted = await bootEmbeddedStore({ ...opts, migrationsDir: smallMigs() });
      closers.push(() => booted?.close() ?? Promise.resolve());
      if (!booted) throw new Error("no store");
      const q = (await booted.handle.query("show timezone")).rows[0];
      expect(Object.values(q ?? {})[0]).toBe("UTC");
      await booted.handle.query("insert into public.t_a (id, at) values (1, '2026-01-02T03:04:05Z')");
      const viaTx = await booted.handle.transaction((t) =>
        t.query("select to_jsonb(t_a) as j from public.t_a where id = 1"),
      );
      expect((viaTx.rows[0]?.j as { at: string }).at).toBe("2026-01-02T03:04:05+00:00");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  }, 120_000);
});

describe("re-entrancy guard", () => {
  const within = <T>(p: Promise<T>, ms = 1000): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out: queue deadlocked")), ms))]);

  it("throws a clear error for handle.query/transaction inside a transaction, and the queue survives", async () => {
    const db = new PGlite("memory://");
    const h = createPgliteHandle(db);
    await expect(within(h.transaction(async () => h.query("select 1")))).rejects.toThrow(
      "store.query called inside a transaction; use the tx argument",
    );
    await expect(within(h.transaction(async () => h.transaction(async () => 1)))).rejects.toThrow(
      /inside a transaction/,
    );
    expect((await within(h.query("select 1 as n"))).rows[0]?.n).toBe(1);
    await db.close();
  });

  it("rejects (does not throw synchronously) so the re-entrant call can be caught", async () => {
    const db = new PGlite("memory://");
    const h = createPgliteHandle(db);
    let sync = false;
    let msg = "";
    await within(
      h.transaction(async () => {
        try {
          await h.query("select 1").catch((e: Error) => {
            msg = e.message;
          });
        } catch {
          sync = true;
        }
      }),
    );
    expect(sync).toBe(false);
    expect(msg).toMatch(/inside a transaction/);
    await db.close();
  });

  it("analyzeNow inside a transaction is deferred until after it and does not deadlock", async () => {
    const d = tmp();
    localEnv(d);
    const migs = tmp();
    fs.writeFileSync(path.join(migs, "001_a.sql"), "create table public.t_a (id int);");
    const store = await bootEmbeddedStore({ ...opts, migrationsDir: migs });
    if (!store) throw new Error("no store");
    closers.push(() => store.close());
    const spy = vi.spyOn(PGlite.prototype, "query");
    spy.mockClear();
    await within(
      store.handle.transaction(async (tx) => {
        await store.analyzeNow(); // would wait on the queue slot this transaction holds
        await tx.query("select 1");
      }),
    );
    expect((await within(store.handle.query("select 1 as n"))).rows[0]?.n).toBe(1);
    await within(store.analyzeNow());
    expect(spy.mock.calls.filter((c) => c[0] === "analyze").length).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
