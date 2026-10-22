// Route contracts: POST /api/auth/device/approve, POST /api/auth/device/deny, and
// GET /api/auth/device/status — the cookie-session "page actions" on a device-auth request,
// distinct from auth-device.test.ts's unauthenticated CLI poll loop (start/poll). All three share
// the existing rate-limit RPC fake (rate_limit_check, already in boundary.reset's default set).
// approve mints a real api key via node crypto.randomBytes (lib/api-keys.ts's mintApiKey), so this
// file needs the same deterministic `crypto` mock as auth-device.test.ts. Each pending row is
// seeded with a fixed device_id so approveDeviceAuth never falls through to crypto.randomUUID()
// for a NEW device id — that call is unmocked in this file and would otherwise make the oplog
// snapshot nondeterministic across runs.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));
vi.mock("crypto", async (orig) =>
  (await import("./crypto-mock")).deterministicCrypto(await orig<Record<string, unknown>>()),
);

import { hashApiKey } from "@membral/test-kit";
import { POST as approvePOST } from "@/app/api/auth/device/approve/route";
import { POST as denyPOST } from "@/app/api/auth/device/deny/route";
import { GET as statusGET } from "@/app/api/auth/device/status/route";
import {
  callRoute,
  db,
  expectContract,
  expectOplog,
  forceError,
  setRateLimitAllowed,
  setupRouteGolden,
} from "./harness";

setupRouteGolden();

const seedPending = (userCode: string, overrides: Record<string, unknown> = {}) =>
  db().seed("device_auth_requests", [
    {
      id: "5eed0000-0000-4000-8000-000000000501",
      device_code_hash: hashApiKey("dvc_golden_actions"),
      user_code: userCode,
      status: "pending",
      expires_at: "2026-01-01T00:10:00.000Z",
      device_id: "5eed0000-0000-4000-8000-000000000502",
      device_name: null,
      device_platform: "darwin",
      approved_at: null,
      consumed_at: null,
      ...overrides,
    },
  ]);

describe("POST /api/auth/device/approve", () => {
  it("401 without a session", async () => {
    await expectContract(
      "auth-device-actions.approve-no-auth",
      await callRoute(approvePOST, {
        method: "POST",
        path: "/api/auth/device/approve",
        body: { userCode: "AAAA-BBBB" },
      }),
    );
  });
  it("400 without userCode", async () => {
    await expectContract(
      "auth-device-actions.approve-invalid-body",
      await callRoute(approvePOST, { method: "POST", path: "/api/auth/device/approve", as: "cookie", body: {} }),
    );
  });
  it("mints a device key for a pending code", async () => {
    seedPending("APPR-OVED");
    await expectContract(
      "auth-device-actions.approve-happy",
      await callRoute(approvePOST, {
        method: "POST",
        path: "/api/auth/device/approve",
        as: "cookie",
        body: { userCode: "appr-oved", deviceName: "golden-phone" },
      }),
    );
    await expectOplog("auth-device-actions.approve-happy");
  });
});

describe("POST /api/auth/device/deny", () => {
  it("401 without a session", async () => {
    await expectContract(
      "auth-device-actions.deny-no-auth",
      await callRoute(denyPOST, { method: "POST", path: "/api/auth/device/deny", body: { userCode: "AAAA-BBBB" } }),
    );
  });
  it("400 without userCode", async () => {
    await expectContract(
      "auth-device-actions.deny-invalid-body",
      await callRoute(denyPOST, { method: "POST", path: "/api/auth/device/deny", as: "cookie", body: {} }),
    );
  });
  it("denies a pending code", async () => {
    seedPending("DENY-CODE");
    await expectContract(
      "auth-device-actions.deny-happy",
      await callRoute(denyPOST, {
        method: "POST",
        path: "/api/auth/device/deny",
        as: "cookie",
        body: { userCode: "deny-code" },
      }),
    );
  });
});

describe("GET /api/auth/device/status", () => {
  it("401 without a session", async () => {
    await expectContract(
      "auth-device-actions.status-no-auth",
      await callRoute(statusGET, { path: "/api/auth/device/status?code=AAAA-BBBB" }),
    );
  });
  it("400 without a code", async () => {
    await expectContract(
      "auth-device-actions.status-missing-code",
      await callRoute(statusGET, { path: "/api/auth/device/status", as: "cookie" }),
    );
  });
  it("looks up a pending code's display fields", async () => {
    seedPending("STAT-USOK");
    await expectContract(
      "auth-device-actions.status-happy",
      await callRoute(statusGET, { path: "/api/auth/device/status?code=stat-usok", as: "cookie" }),
    );
  });
});

// 3A-4 lock-extend 2b: behaviours the group 2-4 adversarial reviews confirmed
// preserved but left unpinned — recorded as the code does them today.
describe("device page actions lock-extend 2b", () => {
  const approve = (body: unknown) =>
    callRoute(approvePOST, { method: "POST", path: "/api/auth/device/approve", as: "cookie", body });
  const deny = (body: unknown) =>
    callRoute(denyPOST, { method: "POST", path: "/api/auth/device/deny", as: "cookie", body });

  it("approve 429 when the caller's bucket is exhausted", async () => {
    setRateLimitAllowed(false);
    await expectContract("auth-device-actions.approve-rate-limited", await approve({ userCode: "AAAA-BBBB" }));
  });
  it("status 429 when the caller's bucket is exhausted", async () => {
    setRateLimitAllowed(false);
    await expectContract(
      "auth-device-actions.status-rate-limited",
      await callRoute(statusGET, { path: "/api/auth/device/status?code=AAAA-BBBB", as: "cookie" }),
    );
  });
  it("approve 400 for unparseable JSON", async () => {
    await expectContract("auth-device-actions.approve-malformed-json", await approve("{"));
  });
  it("deny 400 for unparseable JSON", async () => {
    await expectContract("auth-device-actions.deny-malformed-json", await deny("{"));
  });
  it("approve 400 for an unknown code", async () => {
    await expectContract("auth-device-actions.approve-unknown-code", await approve({ userCode: "NOPE-NOPE" }));
  });
  it("deny 400 for an unknown code", async () => {
    await expectContract("auth-device-actions.deny-unknown-code", await deny({ userCode: "NOPE-NOPE" }));
  });
  it("status 404 for an unknown code", async () => {
    await expectContract(
      "auth-device-actions.status-not-found",
      await callRoute(statusGET, { path: "/api/auth/device/status?code=NOPE-NOPE", as: "cookie" }),
    );
  });
  it("approve 409 when the request's device belongs to another user", async () => {
    seedPending("CONF-LICT");
    db().seed("devices", [
      {
        id: "5eed0000-0000-4000-8000-000000000502",
        user_id: "00000000-0000-4000-8000-00000000fee1",
        name: "someone else's laptop",
        platform: "linux",
        last_seen_at: "2025-12-01T00:00:00.000Z",
      },
    ]);
    await expectContract("auth-device-actions.approve-device-conflict", await approve({ userCode: "conf-lict" }));
    await expectOplog("auth-device-actions.approve-device-conflict");
  });
  it("approve 500 when the device lookup fails", async () => {
    seedPending("FAIL-DEVS");
    forceError("devices", "boundary: devices read failed");
    await expectContract("auth-device-actions.approve-db-error", await approve({ userCode: "fail-devs" }));
  });
});
