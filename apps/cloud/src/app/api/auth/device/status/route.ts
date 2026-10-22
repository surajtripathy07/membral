// GET /api/auth/device/status?code=XXXX-XXXX — cookie session required.
// NOT part of the CLI's device-auth contract (that's start/poll/approve/
// deny) — this exists only for the /device page, to show which device a
// code belongs to BEFORE the user clicks Approve. Returns only display
// fields, never a secret.
//
// NEW-10 (round-2 review): this route previously had neither a try/catch
// around its DB call nor a rate limit — every other device-auth route does
// both. Rate limit reuses the "deviceAuthPoll" rule (same 40/min default)
// bucketed by user_id (this route IS authenticated, unlike poll/start) —
// it's the same kind of low-cost, repeatedly-polled lookup, just from an
// authenticated caller instead of by deviceCode/IP.
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { lookupDeviceAuthStatus } from "@/lib/device-auth";
import { userBucket } from "@/lib/rate-limit";

export const GET = withRoute(
  {
    auth: { kind: "session", unauthorized: "Unauthorized" },
    rateLimit: { name: "deviceAuthPoll", bucket: ({ user }) => userBucket("deviceAuthPoll", user.id) },
  },
  async ({ req }) => {
    const code = req.nextUrl.searchParams.get("code");
    if (!code) {
      return NextResponse.json({ error: "code is required" }, { status: 400 });
    }

    try {
      const result = await lookupDeviceAuthStatus(code);
      if (!result) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      return NextResponse.json(result);
    } catch {
      // Same posture as poll's L4 fix — lookupDeviceAuthStatus talks to
      // Postgres via the service-role client; never let an unhandled DB error
      // surface as a non-JSON 500 to the caller.
      return NextResponse.json({ error: "Failed to look up device authorization status" }, { status: 500 });
    }
  },
);
