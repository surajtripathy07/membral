import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Fake Postgrest-shaped supabase client ---
//
// device-auth.ts's calls are simple enough (select/insert/update/upsert with
// .eq()/.is() filters, sometimes .single()) that a small in-memory fake
// backed by real filter semantics is both more robust AND more readable than
// mocking each exact chain call-by-call — it exercises the real WHERE-clause
// interaction between pollDeviceAuth's claim-guard UPDATE and a concurrent
// second call, which is the behavior most worth pinning down here.
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is" | "lt"; val: unknown };

function rowMatches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "lt") {
      const rowVal = row[f.col];
      return typeof rowVal === "string" && typeof f.val === "string" && rowVal < f.val;
    }
    return row[f.col] === f.val;
  });
}

interface ForcedError {
  code?: string;
  message: string;
}

function makeFakeSupabase() {
  const tables: Record<string, Row[]> = {
    device_auth_requests: [],
    api_keys: [],
    devices: [],
    profiles: [],
  };
  // Unique columns per table (mirrors migration 052's UNIQUE constraints) —
  // a real duplicate insert comes back as a 23505 error, exactly like Postgres.
  const uniqueCols: Record<string, string[]> = {
    device_auth_requests: ["device_code_hash", "user_code"],
    api_keys: ["key_hash"],
  };
  const forcedInsertErrors: Record<string, ForcedError[]> = {};

  function forceNextInsertError(table: string, err: ForcedError) {
    if (!forcedInsertErrors[table]) forcedInsertErrors[table] = [];
    forcedInsertErrors[table].push(err);
  }

  function builder(table: string) {
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "upsert" = "select";
    let selectCols: string | null = null;
    let insertObj: Row | null = null;
    let updateObj: Row | null = null;
    let upsertKey = "id";

    async function exec(
      single: "no" | "single" | "maybeSingle",
    ): Promise<{ data: unknown; error: ForcedError | null }> {
      if (mode === "insert") {
        const forced = forcedInsertErrors[table]?.shift();
        if (forced) return { data: null, error: forced };
        const dup = uniqueCols[table]?.some((col) => rows.some((r) => r[col] === insertObj![col]));
        if (dup) return { data: null, error: { code: "23505", message: "duplicate key value" } };
        const row = { id: `id-${rows.length + 1}-${Math.random().toString(36).slice(2, 8)}`, ...insertObj };
        rows.push(row);
        if (selectCols) return { data: single !== "no" ? row : [row], error: null };
        return { data: null, error: null };
      }
      if (mode === "upsert") {
        const idx = rows.findIndex((r) => r[upsertKey] === insertObj![upsertKey]);
        if (idx >= 0) rows[idx] = { ...rows[idx], ...insertObj };
        else rows.push({ ...insertObj });
        return { data: null, error: null };
      }
      if (mode === "update") {
        const matched = rows.filter((r) => rowMatches(r, filters));
        matched.forEach((r) => Object.assign(r, updateObj));
        if (selectCols) return { data: matched, error: null };
        return { data: null, error: null };
      }
      // select
      const matched = rows.filter((r) => rowMatches(r, filters));
      if (single === "single") {
        if (matched.length === 0) return { data: null, error: { message: "No rows" } };
        return { data: matched[0], error: null };
      }
      if (single === "maybeSingle") {
        if (matched.length === 0) return { data: null, error: null };
        return { data: matched[0], error: null };
      }
      return { data: matched, error: null };
    }

    const api = {
      select(cols: string) {
        selectCols = cols;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, op: "eq", val });
        return api;
      },
      is(col: string, val: unknown) {
        filters.push({ col, op: "is", val });
        return api;
      },
      lt(col: string, val: unknown) {
        filters.push({ col, op: "lt", val });
        return api;
      },
      insert(obj: Row) {
        mode = "insert";
        insertObj = obj;
        return api;
      },
      update(obj: Row) {
        mode = "update";
        updateObj = obj;
        return api;
      },
      upsert(obj: Row, opts?: { onConflict?: string }) {
        mode = "upsert";
        insertObj = obj;
        upsertKey = opts?.onConflict ?? "id";
        return api;
      },
      single() {
        return exec("single");
      },
      maybeSingle() {
        return exec("maybeSingle");
      },
      // Deliberate thenable: mocks the Postgrest builder pattern where
      // `await supabase.from(...)...` (no .single()) resolves via the
      // builder's own .then() — exactly what device-auth.ts's fire-and-forget
      // `.update(...).then(() => {}, () => {})` relies on.
      // biome-ignore lint/suspicious/noThenProperty: see comment above
      then(resolve: (v: { data: unknown; error: ForcedError | null }) => unknown, reject?: (e: unknown) => unknown) {
        return exec("no").then(resolve, reject);
      },
    };
    return api;
  }

  return {
    client: { from: (table: string) => builder(table) },
    tables,
    forceNextInsertError,
  };
}

let fake: ReturnType<typeof makeFakeSupabase>;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => fake.client),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import {
  APPROVED_GRACE_SECONDS,
  approveDeviceAuth,
  DEVICE_AUTH_TTL_SECONDS,
  DeviceConflictError,
  denyDeviceAuth,
  isUuid,
  normalizeUserCode,
  pollDeviceAuth,
  startDeviceAuth,
  upsertOwnedDevice,
} from "../device-auth";

function seedRequest(overrides: Partial<Row> = {}): Row {
  const deviceCode = "dvc_test-secret";
  const row: Row = {
    id: `req-${Math.random().toString(36).slice(2, 8)}`,
    device_code_hash: createHash("sha256").update(deviceCode).digest("hex"),
    user_code: "WM7K-4F2Q",
    device_id: null,
    device_name: "Kabir's MacBook",
    device_platform: "darwin",
    status: "pending",
    user_id: null,
    api_key_id: null,
    pending_api_key: null,
    expires_at: new Date(Date.now() + DEVICE_AUTH_TTL_SECONDS * 1000).toISOString(),
    approved_at: null,
    consumed_at: null,
    ...overrides,
  };
  fake.tables.device_auth_requests.push(row);
  return row;
}

beforeEach(() => {
  fake = makeFakeSupabase();
});

describe("normalizeUserCode", () => {
  it("uppercases and inserts the dash", () => {
    expect(normalizeUserCode("wm7k4f2q")).toBe("WM7K-4F2Q");
  });

  it("strips a stray dash/space and re-inserts it in the right place", () => {
    expect(normalizeUserCode(" wm7k - 4f2q ")).toBe("WM7K-4F2Q");
  });

  it("already-formatted input passes through unchanged (modulo case)", () => {
    expect(normalizeUserCode("WM7K-4F2Q")).toBe("WM7K-4F2Q");
  });

  it("a malformed length is returned un-dashed, never crashes", () => {
    expect(normalizeUserCode("ABC")).toBe("ABC");
  });
});

describe("isUuid", () => {
  it("accepts a real uuid", () => {
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});

describe("startDeviceAuth", () => {
  it("creates a device_auth_requests row with a HASHED device code, never the raw value", async () => {
    const result = await startDeviceAuth({ deviceName: "Laptop", devicePlatform: "darwin", deviceId: null });

    expect(fake.tables.device_auth_requests).toHaveLength(1);
    const row = fake.tables.device_auth_requests[0];
    expect(row.device_code_hash).toBe(createHash("sha256").update(result.deviceCode).digest("hex"));
    expect(row.device_code_hash).not.toBe(result.deviceCode);
    expect(JSON.stringify(fake.tables.device_auth_requests)).not.toContain(result.deviceCode);
  });

  it("userCode format: 8 chars from the unambiguous alphabet, dashed XXXX-XXXX", async () => {
    const result = await startDeviceAuth({});
    expect(result.userCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    // No ambiguous characters ever appear (0/1/I/L/O — U is fine, it's in the alphabet).
    expect(result.userCode).not.toMatch(/[01OIL]/);
  });

  it("returns the TTL/interval contract", async () => {
    const result = await startDeviceAuth({});
    expect(result.expiresIn).toBe(600);
    expect(result.interval).toBe(3);
  });

  it("persists the optional deviceId/deviceName/devicePlatform through to the row", async () => {
    await startDeviceAuth({
      deviceName: "Laptop",
      devicePlatform: "darwin",
      deviceId: "123e4567-e89b-12d3-a456-426614174000",
    });
    const row = fake.tables.device_auth_requests[0];
    // `status` is left to the DB's own default ('pending', migration 052) —
    // the insert object here deliberately doesn't set it, same as real Postgres.
    expect(row).toMatchObject({
      device_name: "Laptop",
      device_platform: "darwin",
      device_id: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("retries on a user_code collision (23505) rather than failing", async () => {
    // Pre-seed so the very first randomly generated code MIGHT collide; force
    // one guaranteed collision via the insert-error hook to prove the retry path.
    fake.forceNextInsertError("device_auth_requests", { code: "23505", message: "duplicate key value" });
    const result = await startDeviceAuth({});
    expect(result.userCode).toBeTruthy();
    expect(fake.tables.device_auth_requests).toHaveLength(1);
  });

  it("throws immediately (no retry) on a non-collision insert error", async () => {
    fake.forceNextInsertError("device_auth_requests", { message: "db is down" });
    await expect(startDeviceAuth({})).rejects.toThrow(/Failed to create device auth request/);
    expect(fake.tables.device_auth_requests).toHaveLength(0);
  });

  it("M2: opportunistically scrubs an approved-but-grace-expired row's pending_api_key on every start call", async () => {
    seedRequest({
      status: "approved",
      user_id: "user-1",
      pending_api_key: "lls_stale",
      approved_at: new Date(Date.now() - (APPROVED_GRACE_SECONDS + 30) * 1000).toISOString(),
    });
    // A recently-approved row (still within grace) must be left untouched.
    seedRequest({
      user_code: "AAAA-BBBB",
      device_code_hash: "unrelated-hash",
      status: "approved",
      user_id: "user-1",
      pending_api_key: "lls_fresh",
      approved_at: new Date().toISOString(),
    });

    await startDeviceAuth({});

    const [stale, fresh] = fake.tables.device_auth_requests;
    expect(stale.status).toBe("expired");
    expect(stale.pending_api_key).toBeNull();
    expect(fresh.status).toBe("approved");
    expect(fresh.pending_api_key).toBe("lls_fresh");
  });
});

describe("pollDeviceAuth", () => {
  it("pending stays pending", async () => {
    seedRequest({ status: "pending" });
    const result = await pollDeviceAuth("dvc_test-secret");
    expect(result).toEqual({ status: "pending" });
  });

  it("unknown/garbage deviceCode -> expired (never distinguishes from a real expiry)", async () => {
    const result = await pollDeviceAuth("dvc_no-such-code");
    expect(result).toEqual({ status: "expired" });
  });

  it("a pending row past expires_at reports expired and is flipped in storage", async () => {
    seedRequest({ status: "pending", expires_at: new Date(Date.now() - 1000).toISOString() });
    const result = await pollDeviceAuth("dvc_test-secret");
    expect(result).toEqual({ status: "expired" });
    expect(fake.tables.device_auth_requests[0].status).toBe("expired");
  });

  it("denied reports denied", async () => {
    seedRequest({ status: "denied" });
    const result = await pollDeviceAuth("dvc_test-secret");
    expect(result).toEqual({ status: "denied" });
  });

  it("approved delivers the raw api key EXACTLY ONCE, then reports consumed on every subsequent poll", async () => {
    seedRequest({
      status: "approved",
      user_id: "user-1",
      pending_api_key: "lls_the_real_raw_key",
      consumed_at: null,
      approved_at: new Date().toISOString(),
    });
    fake.tables.profiles.push({ id: "user-1", email: "founder@example.com" });

    const first = await pollDeviceAuth("dvc_test-secret");
    expect(first).toEqual({
      status: "approved",
      apiKey: "lls_the_real_raw_key",
      email: "founder@example.com",
      userId: "user-1",
    });

    const second = await pollDeviceAuth("dvc_test-secret");
    expect(second).toEqual({ status: "consumed" });

    const third = await pollDeviceAuth("dvc_test-secret");
    expect(third).toEqual({ status: "consumed" });
  });

  it("scrubs pending_api_key back to null after delivery — never left sitting in storage", async () => {
    seedRequest({
      status: "approved",
      user_id: "user-1",
      pending_api_key: "lls_secret",
      approved_at: new Date().toISOString(),
    });
    fake.tables.profiles.push({ id: "user-1", email: "a@b.com" });

    await pollDeviceAuth("dvc_test-secret");
    expect(fake.tables.device_auth_requests[0].pending_api_key).toBeNull();
  });

  it("M2: an approved row past expires_at but WITHIN the approved_at grace window still delivers the key", async () => {
    // expires_at (the original 10-minute minting window) has already
    // ticked past — before the M2 fix this alone made pollDeviceAuth
    // report 'expired' forever, even though the request WAS approved and
    // is well within its post-approval grace window.
    seedRequest({
      status: "approved",
      user_id: "user-1",
      pending_api_key: "lls_grace_key",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      approved_at: new Date(Date.now() - (APPROVED_GRACE_SECONDS - 30) * 1000).toISOString(),
    });
    fake.tables.profiles.push({ id: "user-1", email: "a@b.com" });

    const result = await pollDeviceAuth("dvc_test-secret");
    expect(result).toEqual({
      status: "approved",
      apiKey: "lls_grace_key",
      email: "a@b.com",
      userId: "user-1",
    });
  });

  it("M2: an approved row PAST the approved_at grace window reports expired and scrubs pending_api_key", async () => {
    seedRequest({
      status: "approved",
      user_id: "user-1",
      pending_api_key: "lls_stale_key",
      approved_at: new Date(Date.now() - (APPROVED_GRACE_SECONDS + 30) * 1000).toISOString(),
    });

    const result = await pollDeviceAuth("dvc_test-secret");
    expect(result).toEqual({ status: "expired" });
    expect(fake.tables.device_auth_requests[0].status).toBe("expired");
    expect(fake.tables.device_auth_requests[0].pending_api_key).toBeNull();
  });

  it("M2: an approved row with no approved_at at all (legacy/bugged data) is treated as expired, not delivered", async () => {
    seedRequest({
      status: "approved",
      user_id: "user-1",
      pending_api_key: "lls_no_approved_at",
      approved_at: null,
    });

    const result = await pollDeviceAuth("dvc_test-secret");
    expect(result).toEqual({ status: "expired" });
  });

  it("already-consumed row reports consumed immediately, no re-delivery", async () => {
    seedRequest({
      status: "approved",
      user_id: "user-1",
      pending_api_key: null,
      consumed_at: new Date().toISOString(),
    });
    const result = await pollDeviceAuth("dvc_test-secret");
    expect(result).toEqual({ status: "consumed" });
  });
});

describe("approveDeviceAuth", () => {
  it("mints an api_keys row, upserts the device, and marks the request approved", async () => {
    seedRequest({ user_code: "WM7K-4F2Q", status: "pending" });

    const result = await approveDeviceAuth({ userCode: "wm7k-4f2q", userId: "user-1", deviceName: null });

    expect(result).not.toBeNull();
    expect(result?.keyPrefix).toMatch(/^lls_/);
    expect(result?.deviceName).toBe("Kabir's MacBook");

    expect(fake.tables.api_keys).toHaveLength(1);
    const keyRow = fake.tables.api_keys[0];
    expect(keyRow.user_id).toBe("user-1");
    expect(keyRow.key_hash).toHaveLength(64); // sha256 hex

    expect(fake.tables.devices).toHaveLength(1);
    expect(fake.tables.devices[0].user_id).toBe("user-1");

    const reqRow = fake.tables.device_auth_requests[0];
    expect(reqRow.status).toBe("approved");
    expect(reqRow.user_id).toBe("user-1");
    expect(reqRow.api_key_id).toBe(keyRow.id);
    expect(typeof reqRow.pending_api_key).toBe("string");
  });

  it("normalizes a lowercase/undashed userCode before lookup", async () => {
    seedRequest({ user_code: "WM7K-4F2Q" });
    const result = await approveDeviceAuth({ userCode: "wm7k4f2q", userId: "user-1" });
    expect(result).not.toBeNull();
  });

  it("binds the api_keys row + devices row to the request's OWN deviceId when present", async () => {
    seedRequest({ device_id: "123e4567-e89b-12d3-a456-426614174000" });
    await approveDeviceAuth({ userCode: "WM7K-4F2Q", userId: "user-1" });
    expect(fake.tables.api_keys[0].device_id).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(fake.tables.devices[0].id).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("generates a fresh device id when the request carries none", async () => {
    seedRequest({ device_id: null });
    await approveDeviceAuth({ userCode: "WM7K-4F2Q", userId: "user-1" });
    expect(fake.tables.devices[0].id).toBeTruthy();
    expect(fake.tables.api_keys[0].device_id).toBe(fake.tables.devices[0].id);
  });

  it("an approve-time deviceName override wins over the stored device_name", async () => {
    seedRequest({ device_name: "Old Name" });
    const result = await approveDeviceAuth({ userCode: "WM7K-4F2Q", userId: "user-1", deviceName: "New Name" });
    expect(result?.deviceName).toBe("New Name");
    expect(fake.tables.devices[0].name).toBe("New Name");
  });

  it("H1 ATTACK: a device_id already owned by a DIFFERENT user throws DeviceConflictError — no reassignment, no key minted", async () => {
    const victimDeviceId = "123e4567-e89b-12d3-a456-426614174000";
    fake.tables.devices.push({ id: victimDeviceId, user_id: "victim-user", name: "Victim's Laptop" });
    seedRequest({ user_code: "WM7K-4F2Q", status: "pending", device_id: victimDeviceId });

    await expect(approveDeviceAuth({ userCode: "WM7K-4F2Q", userId: "attacker-user" })).rejects.toThrow(
      DeviceConflictError,
    );

    // The victim's device row must be untouched — never reassigned.
    expect(fake.tables.devices).toHaveLength(1);
    expect(fake.tables.devices[0].user_id).toBe("victim-user");
    // No key minted, and the request never flipped to approved.
    expect(fake.tables.api_keys).toHaveLength(0);
    expect(fake.tables.device_auth_requests[0].status).toBe("pending");
  });

  it("ATTACK: an unknown userCode is rejected — no key minted", async () => {
    const result = await approveDeviceAuth({ userCode: "ZZZZ-ZZZZ", userId: "user-1" });
    expect(result).toBeNull();
    expect(fake.tables.api_keys).toHaveLength(0);
  });

  it("ATTACK: an EXPIRED code is rejected — no key minted", async () => {
    seedRequest({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const result = await approveDeviceAuth({ userCode: "WM7K-4F2Q", userId: "user-1" });
    expect(result).toBeNull();
    expect(fake.tables.api_keys).toHaveLength(0);
  });

  it("ATTACK: an ALREADY-APPROVED (used) code is rejected — no second key minted", async () => {
    seedRequest({ status: "approved", user_id: "someone-else" });
    const result = await approveDeviceAuth({ userCode: "WM7K-4F2Q", userId: "user-1" });
    expect(result).toBeNull();
    expect(fake.tables.api_keys).toHaveLength(0);
  });

  it("ATTACK: a DENIED code is rejected — no key minted", async () => {
    seedRequest({ status: "denied" });
    const result = await approveDeviceAuth({ userCode: "WM7K-4F2Q", userId: "user-1" });
    expect(result).toBeNull();
    expect(fake.tables.api_keys).toHaveLength(0);
  });
});

describe("denyDeviceAuth", () => {
  it("flips a pending request to denied", async () => {
    seedRequest({ user_code: "WM7K-4F2Q", status: "pending" });
    const denied = await denyDeviceAuth({ userCode: "wm7k-4f2q" });
    expect(denied).toBe(true);
    expect(fake.tables.device_auth_requests[0].status).toBe("denied");
  });

  it("returns false for an unknown code", async () => {
    const denied = await denyDeviceAuth({ userCode: "ZZZZ-ZZZZ" });
    expect(denied).toBe(false);
  });

  it("returns false for an already-approved code (can't deny after the fact)", async () => {
    seedRequest({ user_code: "WM7K-4F2Q", status: "approved" });
    const denied = await denyDeviceAuth({ userCode: "WM7K-4F2Q" });
    expect(denied).toBe(false);
    expect(fake.tables.device_auth_requests[0].status).toBe("approved");
  });
});

// H1 (adversarial review): direct unit coverage for the shared helper both
// approveDeviceAuth and GET /api/bridge/agent/next rely on.
describe("upsertOwnedDevice", () => {
  // The fake supabase client is deliberately duck-typed (see makeFakeSupabase's
  // header comment) rather than a full SupabaseClient — cast at the call site
  // for these direct unit tests only.
  function client(): SupabaseClient {
    return fake.client as unknown as SupabaseClient;
  }

  it("inserts a fresh row when the id is unused", async () => {
    await upsertOwnedDevice(client(), { id: "dev-1", userId: "user-1", name: "Laptop", platform: "darwin" });
    expect(fake.tables.devices).toHaveLength(1);
    expect(fake.tables.devices[0]).toMatchObject({ id: "dev-1", user_id: "user-1", name: "Laptop" });
  });

  it("updates name/platform/last_seen_at when the caller already owns the row", async () => {
    fake.tables.devices.push({ id: "dev-1", user_id: "user-1", name: "Old Name", platform: "darwin" });
    await upsertOwnedDevice(client(), { id: "dev-1", userId: "user-1", name: "New Name", platform: "linux" });
    expect(fake.tables.devices).toHaveLength(1);
    expect(fake.tables.devices[0]).toMatchObject({
      id: "dev-1",
      user_id: "user-1",
      name: "New Name",
      platform: "linux",
    });
  });

  it("ATTACK: throws DeviceConflictError and leaves the row untouched when it belongs to a different user", async () => {
    fake.tables.devices.push({ id: "dev-1", user_id: "victim", name: "Victim's Laptop", platform: "darwin" });
    await expect(
      upsertOwnedDevice(client(), { id: "dev-1", userId: "attacker", name: "Hijacked Name" }),
    ).rejects.toThrow(DeviceConflictError);
    expect(fake.tables.devices).toHaveLength(1);
    expect(fake.tables.devices[0]).toMatchObject({ user_id: "victim", name: "Victim's Laptop" });
  });
});
