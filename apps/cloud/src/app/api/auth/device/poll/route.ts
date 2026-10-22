// POST /api/auth/device/poll — no auth. Body: { deviceCode }. The CLI calls
// this every `interval` seconds (from the /start response) until it gets
// back a terminal status.
//
// -> { status: 'pending' }
//  | { status: 'approved', apiKey, email, userId }  -- apiKey is the RAW
//    key, returned exactly once; every poll after that (for this
//    deviceCode) returns { status: 'consumed' } instead.
//  | { status: 'denied' }
//  | { status: 'expired' }
//  | { status: 'consumed' }
//
// Rate-limited by BOTH a per-code bucket AND a per-IP bucket (NEW-7,
// round-2 review). The per-code bucket (deviceCodeBucket, M1) scopes the
// common-case throttle to the ONE code being polled — but bucketing by
// deviceCode ALONE meant a caller could dodge every limit just by minting a
// fresh device code each time (a fresh code -> a fresh, empty bucket). The
// per-IP bucket (deviceAuthPollIp) closes that: it's checked on EVERY
// request regardless of whether a deviceCode is present, so it bounds how
// many different codes any one caller can burn through. An unresolvable IP
// degrades to a stable, shared "unknown" bucket with a generous limit
// (RATE_LIMIT_DEVICE_AUTH_POLL_IP, default 600/min) rather than
// ipOrFallbackBucket's per-request-random fallback — that fallback exists
// specifically so an unidentifiable caller never shares a budget with every
// OTHER unidentifiable caller behind the same missing proxy, which is
// exactly the behavior we do NOT want here (it would make this bucket a
// no-op for an attacker with no resolvable IP).
import { type NextRequest, NextResponse } from "next/server";
import { pollDeviceAuth } from "@/lib/device-auth";
import { clientIp, deviceCodeBucket, enforceRateLimit, ipBucket, rateLimited } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const deviceCode = typeof body.deviceCode === "string" && body.deviceCode.length > 0 ? body.deviceCode : null;

  const ipRl = await enforceRateLimit("deviceAuthPollIp", ipBucket("deviceAuthPollIp", clientIp(req)));
  if (!ipRl.allowed) return rateLimited(ipRl.retryAfter);

  if (deviceCode) {
    const codeRl = await enforceRateLimit("deviceAuthPoll", deviceCodeBucket("deviceAuthPoll", deviceCode));
    if (!codeRl.allowed) return rateLimited(codeRl.retryAfter);
  }

  if (!deviceCode) {
    return NextResponse.json({ error: "deviceCode is required" }, { status: 400 });
  }

  try {
    const result = await pollDeviceAuth(deviceCode);
    return NextResponse.json(result);
  } catch {
    // L4 (adversarial review): pollDeviceAuth talks to Postgres via the
    // service-role client — never let an unhandled DB error surface as a
    // non-JSON 500 to an unauthenticated caller.
    return NextResponse.json({ error: "Failed to check device authorization status" }, { status: 500 });
  }
}
