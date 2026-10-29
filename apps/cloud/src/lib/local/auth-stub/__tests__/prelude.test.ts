// Runs supabase/local/auth-prelude.sql against a real Postgres (PGlite, no Docker): idempotence, the grants on the
// local_auth_* RPCs, GoTrue-migrated volumes, and the refresh-rotation SQL (reuse interval, family revoke, expiry).
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PRELUDE = fs.readFileSync(new URL("../../../../../supabase/local/auth-prelude.sql", import.meta.url), "utf8");
const UID = "00000000-0000-4000-8000-000000000001";

async function open(): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  return db;
}

async function asRole<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

async function rotate(db: PGlite, token: string, next: string) {
  const r = await asRole(db, "service_role", () =>
    db.query<{ r: { user_id: string; session_id: string | null; token: string } | null }>(
      "select public.local_auth_rotate_refresh($1, $2) as r",
      [token, next],
    ),
  );
  return r.rows[0]?.r ?? null;
}

async function insertRefresh(db: PGlite, token: string, session: string, parent: string | null = null) {
  await asRole(db, "service_role", () =>
    db.query("select public.local_auth_insert_refresh($1, $2, $3, $4)", [token, UID, session, parent]),
  );
}

describe("auth-prelude.sql on a stub-created volume", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await open();
    await db.exec(PRELUDE);
    await db.exec(PRELUDE); // idempotent: the second run changes nothing and raises nothing
    await db.query("insert into auth.users (id, email) values ($1, 'me@codehub.test')", [UID]);
  });
  afterAll(() => db.close());

  it("runs twice without error and leaves one copy of each function and table", async () => {
    const fns = await db.query<{ n: number }>(
      "select count(*)::int n from pg_proc where proname like 'local_auth_%' and proname <> 'local_auth_user_json'",
    );
    expect(fns.rows[0]?.n).toBe(7);
    const sessions = await db.query("select to_regclass('auth.sessions') as t");
    expect(sessions.rows[0]).toEqual({ t: "auth.sessions" });
  });

  it("denies anon and authenticated, allows service_role", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(
        asRole(db, role, () => db.query("select public.local_auth_find_user(null, 'me@codehub.test', true)")),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asRole(db, role, () => db.query("select public.local_auth_rotate_refresh('a', 'b')")),
      ).rejects.toThrow(/permission denied/);
    }
    const ok = await asRole(db, "service_role", () =>
      db.query<{ u: { email: string; encrypted_password?: string } }>(
        "select public.local_auth_find_user(null, 'me@codehub.test', false) as u",
      ),
    );
    expect(ok.rows[0]?.u.email).toBe("me@codehub.test");
  });

  it("insert_refresh creates the session row, and rotation inserts the child under it", async () => {
    const session = "11111111-1111-4111-8111-111111111111";
    await insertRefresh(db, "t1", session);
    expect((await db.query("select 1 from auth.sessions where id = $1", [session])).rows).toHaveLength(1);
    const out = await rotate(db, "t1", "t2");
    expect(out).toEqual({ user_id: UID, session_id: session, token: "t2" });
    const child = await db.query<{ parent: string; revoked: boolean }>(
      "select parent, revoked from auth.refresh_tokens where token = 't2'",
    );
    expect(child.rows[0]).toEqual({ parent: "t1", revoked: false });
  });

  it("concurrent rotations of one token get the same child (reuse interval, no logout)", async () => {
    const session = "22222222-2222-4222-8222-222222222222";
    await insertRefresh(db, "c1", session);
    const results = await Promise.all([rotate(db, "c1", "c-a"), rotate(db, "c1", "c-b"), rotate(db, "c1", "c-c")]);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(new Set(results.map((r) => r?.token)).size).toBe(1);
    const children = await db.query("select 1 from auth.refresh_tokens where parent = 'c1'");
    expect(children.rows).toHaveLength(1);
  });

  it("reuse after 10 s is rejected and revokes the whole family", async () => {
    const session = "33333333-3333-4333-8333-333333333333";
    await insertRefresh(db, "r1", session);
    const child = await rotate(db, "r1", "r2");
    expect(child?.token).toBe("r2");
    await db.exec("update auth.refresh_tokens set updated_at = now() - interval '11 seconds' where token = 'r1'");
    expect(await rotate(db, "r1", "r3")).toBeNull();
    const live = await db.query("select 1 from auth.refresh_tokens where session_id = $1 and not revoked", [session]);
    expect(live.rows).toHaveLength(0);
    expect(await rotate(db, "r2", "r4")).toBeNull();
  });

  it("refuses unknown tokens, tokens older than 30 days, and sessions past not_after", async () => {
    expect(await rotate(db, "nope", "x")).toBeNull();
    const old = "44444444-4444-4444-8444-444444444444";
    await insertRefresh(db, "o1", old);
    await db.exec("update auth.refresh_tokens set created_at = now() - interval '31 days' where token = 'o1'");
    expect(await rotate(db, "o1", "o2")).toBeNull();
    const done = "55555555-5555-4555-8555-555555555555";
    await insertRefresh(db, "e1", done);
    await db.exec(`update auth.sessions set not_after = now() - interval '1 minute' where id = '${done}'`);
    expect(await rotate(db, "e1", "e2")).toBeNull();
  });

  it("hides soft-deleted users and reports banned_until", async () => {
    await db.query(
      "insert into auth.users (id, email, banned_until) values ($1, 'gone@codehub.test', now() + interval '1 day')",
      ["00000000-0000-4000-8000-000000000002"],
    );
    const banned = await asRole(db, "service_role", () =>
      db.query<{ u: { banned_until: string | null } }>(
        "select public.local_auth_find_user(null, 'gone@codehub.test') as u",
      ),
    );
    expect(banned.rows[0]?.u.banned_until).toBeTruthy();
    await db.exec("update auth.users set deleted_at = now() where email = 'gone@codehub.test'");
    const gone = await asRole(db, "service_role", () =>
      db.query<{ u: unknown }>("select public.local_auth_find_user(null, 'gone@codehub.test') as u"),
    );
    expect(gone.rows[0]?.u).toBeNull();
  });
});

describe("auth-prelude.sql on a GoTrue-migrated volume", () => {
  it("keeps GoTrue's sessions table and foreign key, and sign-in plus rotation still work", async () => {
    const db = await open();
    try {
      // The shape GoTrue's migrations leave: a sessions table with more columns, and a FK from refresh_tokens.
      await db.exec(`
        create schema auth;
        create table auth.users (instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255),
          email varchar(255) unique, encrypted_password varchar(255), email_confirmed_at timestamptz, phone text unique,
          last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
          created_at timestamptz, updated_at timestamptz, banned_until timestamptz, deleted_at timestamptz);
        create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
          created_at timestamptz, updated_at timestamptz, factor_id uuid, aal text, not_after timestamptz,
          user_agent text, ip inet, tag text);
        create table auth.refresh_tokens (id bigserial primary key, instance_id uuid, token varchar(255) unique,
          user_id varchar(255), revoked boolean, created_at timestamptz default now(), updated_at timestamptz default now(),
          parent varchar(255), session_id uuid references auth.sessions(id) on delete cascade);
        insert into auth.users (id, email) values ('${UID}', 'me@codehub.test');
      `);
      await db.exec(PRELUDE);
      await db.exec(PRELUDE);
      const session = "66666666-6666-4666-8666-666666666666";
      await insertRefresh(db, "g1", session);
      expect(await rotate(db, "g1", "g2")).toEqual({ user_id: UID, session_id: session, token: "g2" });
      const cols = await db.query(
        "select 1 from information_schema.columns where table_schema='auth' and table_name='sessions' and column_name='factor_id'",
      );
      expect(cols.rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});

describe("auth-prelude.sql on the stock image's stripped auth tables", () => {
  it("adds the missing columns and defaults, and every stub query works", async () => {
    const db = await open();
    try {
      await db.exec(`
        create schema auth;
        create table auth.users (id uuid primary key, email text);
        create table auth.refresh_tokens (id bigserial, token text, user_id text);
      `);
      await db.exec(PRELUDE);
      await db.exec(PRELUDE);
      const created = await asRole(db, "service_role", () =>
        db.query<{ u: { id: string; email: string } }>(
          "select public.local_auth_create_user($1, $2, '{}'::jsonb, true) as u",
          ["me@codehub.test", "hash"],
        ),
      );
      const id = created.rows[0]?.u.id;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const found = await asRole(db, "service_role", () =>
        db.query<{ u: { email: string } | null }>("select public.local_auth_find_user(null, $1) as u", [
          "me@codehub.test",
        ]),
      );
      expect(found.rows[0]?.u?.email).toBe("me@codehub.test");
      const session = "77777777-7777-4777-8777-777777777777";
      await asRole(db, "service_role", () =>
        db.query("select public.local_auth_insert_refresh($1, $2, $3, null)", ["s1", id, session]),
      );
      const next = await asRole(db, "service_role", () =>
        db.query<{ r: { token: string } | null }>("select public.local_auth_rotate_refresh($1, $2) as r", ["s1", "s2"]),
      );
      expect(next.rows[0]?.r?.token).toBe("s2");
      const list = await asRole(db, "service_role", () =>
        db.query<{ r: { total: number } }>("select public.local_auth_list_users(1, 10) as r"),
      );
      expect(list.rows[0]?.r.total).toBe(1);
    } finally {
      await db.close();
    }
  });
});
