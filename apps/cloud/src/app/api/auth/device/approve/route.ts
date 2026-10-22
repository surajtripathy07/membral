// POST /api/auth/device/approve — cookie session required. Body:
// { userCode, deviceName? } -> { ok: true, deviceName, keyPrefix }.
//
// Called from the /device page once the signed-in user confirms the code
// shown on their CLI. Mints a real api_keys row bound to the request's
// device (see lib/device-auth.ts's approveDeviceAuth) and stages the raw
// key for the CLI's next poll to pick up.
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { approveDeviceAuth, DeviceConflictError } from "@/lib/device-auth";
import { userBucket } from "@/lib/rate-limit";

const MAX_NAME_LEN = 200;

// Shares the "keys" rule/bucket with /api/keys generate+revoke — approving
// a device is the same class of low-volume, security-sensitive action.
export const POST = withRoute(
  {
    auth: { kind: "session", unauthorized: "Unauthorized" },
    rateLimit: { name: "keys", bucket: ({ user }) => userBucket("keys", user.id) },
  },
  async ({ req, user }) => {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (typeof body.userCode !== "string" || body.userCode.trim().length === 0) {
      return NextResponse.json({ error: "userCode is required" }, { status: 400 });
    }
    const deviceName =
      typeof body.deviceName === "string" && body.deviceName.trim()
        ? body.deviceName.trim().slice(0, MAX_NAME_LEN)
        : null;

    try {
      const result = await approveDeviceAuth({ userCode: body.userCode, userId: user.id, deviceName });
      if (!result) {
        return NextResponse.json({ error: "Code not found, already used, or expired" }, { status: 400 });
      }
      return NextResponse.json({ ok: true, deviceName: result.deviceName, keyPrefix: result.keyPrefix });
    } catch (err) {
      // H1 (adversarial review): a device id that already belongs to a
      // different user is a reject, not an infra failure — 409, no key
      // minted, nothing reassigned.
      if (err instanceof DeviceConflictError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      return NextResponse.json({ error: "Failed to approve device" }, { status: 500 });
    }
  },
);
