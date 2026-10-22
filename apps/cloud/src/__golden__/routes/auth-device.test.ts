// Route contracts: POST /api/auth/device/start and /poll (NONE; IP / deviceCode buckets).
// Codes come from a deterministic node crypto (randomBytes / randomInt).
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
import { POST as pollPOST } from "@/app/api/auth/device/poll/route";
import { POST as startPOST } from "@/app/api/auth/device/start/route";
import { callRoute, db, expectContract, expectOplog, setRateLimitAllowed, setupRouteGolden } from "./harness";

setupRouteGolden();

const IP = { "x-forwarded-for": "203.0.113.7" };

describe("/api/auth/device", () => {
  it("start issues a device + user code", async () => {
    const body = {
      deviceName: "golden-laptop",
      devicePlatform: "darwin",
      deviceId: "5eed0000-0000-4000-8000-000000000400",
    };
    await expectContract(
      "auth-device.start-happy",
      await callRoute(startPOST, { method: "POST", path: "/api/auth/device/start", headers: IP, body }),
    );
    await expectOplog("auth-device.start-happy");
  });
  it("start tolerates a malformed body", async () => {
    await expectContract(
      "auth-device.start-malformed",
      await callRoute(startPOST, { method: "POST", path: "/api/auth/device/start", headers: IP, body: "{" }),
    );
  });
  it("start 429 when rate limited", async () => {
    setRateLimitAllowed(false);
    await expectContract(
      "auth-device.start-rate-limited",
      await callRoute(startPOST, { method: "POST", path: "/api/auth/device/start", headers: IP, body: {} }),
    );
  });
  it("poll a seeded pending request", async () => {
    const deviceCode = "dvc_golden_pending";
    db().seed("device_auth_requests", [
      {
        id: "5eed0000-0000-4000-8000-000000000500",
        device_code_hash: hashApiKey(deviceCode), // same sha256 hex as device-auth.ts:36 hash()
        user_code: "GOLDPEND",
        status: "pending",
        expires_at: "2026-01-01T00:10:00.000Z",
        approved_at: null,
        consumed_at: null,
      },
    ]);
    await expectContract(
      "auth-device.poll-pending",
      await callRoute(pollPOST, { method: "POST", path: "/api/auth/device/poll", headers: IP, body: { deviceCode } }),
    );
  });
  it("poll an unknown code", async () => {
    await expectContract(
      "auth-device.poll-unknown",
      await callRoute(pollPOST, {
        method: "POST",
        path: "/api/auth/device/poll",
        headers: IP,
        body: { deviceCode: "dvc_unknown" },
      }),
    );
  });
  it("poll 400 without deviceCode", async () => {
    await expectContract(
      "auth-device.poll-missing-code",
      await callRoute(pollPOST, { method: "POST", path: "/api/auth/device/poll", headers: IP, body: {} }),
    );
  });
  it("poll 400 for malformed JSON", async () => {
    await expectContract(
      "auth-device.poll-malformed",
      await callRoute(pollPOST, { method: "POST", path: "/api/auth/device/poll", headers: IP, body: "{" }),
    );
  });
});
