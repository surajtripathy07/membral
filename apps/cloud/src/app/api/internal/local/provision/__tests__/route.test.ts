import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- In-memory Supabase fake: just the query shapes this route's path uses. ---
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const users: { id: string; email: string; password: string }[] = [];
const adminCalls: string[] = [];
let nextId = 0;
const newId = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

function query(table: string) {
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | null = null;
  const preds: ((r: Row) => boolean)[] = [];
  const rows = () => (tables[table] ??= []);
  const run = () => {
    const match = (r: Row) => preds.every((p) => p(r));
    if (op === "insert") {
      rows().push({ id: newId(), revoked_at: null, ...payload });
      return { data: null, error: null };
    }
    if (op === "update") {
      for (const r of rows().filter(match)) Object.assign(r, payload);
      return { data: null, error: null };
    }
    if (op === "delete") {
      tables[table] = rows().filter((r) => !match(r));
      return { data: null, error: null };
    }
    return { data: rows().filter(match), error: null };
  };
  const filter = (p: (r: Row) => boolean) => {
    preds.push(p);
    return b;
  };
  const write = (o: typeof op, p: Row | null) => {
    op = o;
    payload = p;
    return b;
  };
  const b = {
    select: () => b,
    insert: (p: Row) => write("insert", p),
    update: (p: Row) => write("update", p),
    delete: () => write("delete", null),
    eq: (c: string, v: unknown) => filter((r) => r[c] === v),
    neq: (c: string, v: unknown) => filter((r) => r[c] !== v),
    in: (c: string, v: unknown[]) => filter((r) => v.includes(r[c])),
    is: (c: string, v: unknown) => filter((r) => (r[c] ?? null) === v),
    maybeSingle: async () => {
      const { data } = run() as { data: Row[] };
      return { data: data[0] ?? null, error: null };
    },
    // biome-ignore lint/suspicious/noThenProperty: thenable query builder, like supabase-js.
    then: (resolve: (v: unknown) => unknown) => resolve(run()),
  };
  return b;
}

const fakeDb = {
  from: (t: string) => query(t),
  auth: {
    admin: {
      listUsers: async () => {
        adminCalls.push("listUsers");
        return { data: { users: users.map(({ id, email }) => ({ id, email })) }, error: null };
      },
      createUser: async (a: { email: string; password: string }) => {
        adminCalls.push("createUser");
        const u = { id: newId(), email: a.email, password: a.password };
        users.push(u);
        tables.profiles = [...(tables.profiles ?? []), { id: u.id, email: u.email }]; // migration 004 trigger
        return { data: { user: { id: u.id, email: u.email } }, error: null };
      },
      updateUserById: async (id: string, a: { password: string }) => {
        adminCalls.push("updateUserById");
        const u = users.find((x) => x.id === id);
        if (u) u.password = a.password;
        return { data: { user: u }, error: null };
      },
    },
  },
};

vi.mock("@/lib/db/clients", () => ({ getServiceClient: () => fakeDb }));
const SERVICE_KEY = "local-service-role-key-for-tests";
vi.mock("@/lib/env", () => ({ getEnv: () => ({ supabaseServiceRoleKey: SERVICE_KEY }) }));

import { POST } from "../route";

const PASSWORD = "correct-horse-battery-staple";
const body = (over: Partial<Record<string, unknown>> = {}) => ({
  email: "ada@membral.local",
  password: PASSWORD,
  deviceName: "local stack",
  mintKey: false,
  ...over,
});
const call = (b: unknown, auth: string | null = `Bearer ${SERVICE_KEY}`) =>
  POST(
    new NextRequest("http://localhost:3000/api/internal/local/provision", {
      method: "POST",
      headers: auth ? { authorization: auth, "content-type": "application/json" } : {},
      body: JSON.stringify(b),
    }),
  );
const snapshot = () => JSON.stringify({ tables, users });

describe("POST /api/internal/local/provision", () => {
  beforeEach(() => {
    for (const k of Object.keys(tables)) delete tables[k];
    users.length = 0;
    adminCalls.length = 0;
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is 404 when MEMBRAL_LOCAL is not 1, before any auth or DB work", async () => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
    const res = await call(body());
    expect(res.status).toBe(404);
    expect(adminCalls).toEqual([]);
  });

  it("is 404 when VERCEL is set, even with MEMBRAL_LOCAL=1", async () => {
    vi.stubEnv("VERCEL", "1");
    const res = await call(body());
    expect(res.status).toBe(404);
    expect(adminCalls).toEqual([]);
  });

  it("is 401 on a wrong, shorter, or missing bearer", async () => {
    for (const auth of ["Bearer nope", `Bearer ${SERVICE_KEY}x`, SERVICE_KEY, null]) {
      const res = await call(body(), auth);
      expect(res.status).toBe(401);
    }
    expect(adminCalls).toEqual([]);
  });

  it("is 400 on a short password and never echoes it", async () => {
    const res = await call(body({ password: "short-secret" }));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("short-secret");
  });

  it("creates the user confirmed, with a profile, and mints nothing when mintKey is false", async () => {
    const res = await call(body());
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toEqual({ userId: users[0].id, email: "ada@membral.local", created: true, apiKey: null });
    expect(users[0].password).toBe(PASSWORD);
    expect(tables.profiles).toHaveLength(1);
    expect(tables.api_keys ?? []).toHaveLength(0);
  });

  it("reuses an existing user: password NOT updated, created false", async () => {
    users.push({
      id: "11111111-1111-4111-8111-111111111111",
      email: "ada@membral.local",
      password: "old-password-0000000",
    });
    tables.profiles = [{ id: "11111111-1111-4111-8111-111111111111", email: "ada@membral.local" }];
    const res = await call(body());
    const out = await res.json();
    expect(out.created).toBe(false);
    expect(out.userId).toBe("11111111-1111-4111-8111-111111111111");
    expect(users[0].password).toBe("old-password-0000000");
    expect(adminCalls).not.toContain("updateUserById");
    expect(adminCalls).not.toContain("createUser");
  });

  it("is idempotent with mintKey false: a second call changes no rows", async () => {
    await call(body());
    const before = snapshot();
    const res = await call(body());
    expect((await res.json()).created).toBe(false);
    expect(snapshot()).toBe(before);
  });

  it("mintKey returns a hashed lls_ key and revokes the previous local key and device", async () => {
    tables.devices = [{ id: "dev-login", user_id: "x", name: "laptop", platform: "darwin" }];
    const first = await (await call(body({ mintKey: true }))).json();
    expect(first.apiKey).toMatch(/^lls_[A-Za-z0-9_-]{32}$/);
    const hash1 = createHash("sha256").update(first.apiKey).digest("hex");
    expect(tables.api_keys).toHaveLength(1);
    expect(tables.api_keys[0]).toMatchObject({ key_hash: hash1, revoked_at: null, user_id: first.userId });
    expect(JSON.stringify(tables)).not.toContain(first.apiKey);

    const second = await (await call(body({ mintKey: true }))).json();
    expect(second.apiKey).not.toBe(first.apiKey);
    const old = tables.api_keys.find((k) => k.key_hash === hash1);
    const fresh = tables.api_keys.find((k) => k.key_hash !== hash1);
    expect(old?.revoked_at).toEqual(expect.any(String));
    expect(fresh?.revoked_at).toBeNull();
    const localDevices = tables.devices.filter((d) => d.platform === "membral-local");
    expect(localDevices).toHaveLength(1);
    expect(localDevices[0].id).toBe(fresh?.device_id);
    // A device-login device of another platform is untouched.
    expect(tables.devices.find((d) => d.id === "dev-login")).toBeDefined();
  });
});
