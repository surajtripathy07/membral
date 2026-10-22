// POST /api/auth/device/deny — cookie session required. Body: { userCode }
// -> { ok: true }.
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { denyDeviceAuth } from "@/lib/device-auth";
import { userBucket } from "@/lib/rate-limit";

export const POST = withRoute(
  {
    auth: { kind: "session", unauthorized: "Unauthorized" },
    rateLimit: { name: "keys", bucket: ({ user }) => userBucket("keys", user.id) },
  },
  async ({ req }) => {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (typeof body.userCode !== "string" || body.userCode.trim().length === 0) {
      return NextResponse.json({ error: "userCode is required" }, { status: 400 });
    }

    try {
      const denied = await denyDeviceAuth({ userCode: body.userCode });
      if (!denied) {
        return NextResponse.json({ error: "Code not found, already used, or expired" }, { status: 400 });
      }
      return NextResponse.json({ ok: true });
    } catch {
      // L4 (adversarial review): never let an unhandled DB error surface as a
      // non-JSON 500.
      return NextResponse.json({ error: "Failed to deny device authorization" }, { status: 500 });
    }
  },
);
