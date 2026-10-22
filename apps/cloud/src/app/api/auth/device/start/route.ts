// POST /api/auth/device/start — no auth (this is how a signed-out CLI
// begins `membral setup`). Body: { deviceName?, devicePlatform?, deviceId? }
// -> { deviceCode, userCode, verificationUri, verificationUriComplete,
//      expiresIn, interval }.
//
// IP rate-limited under its OWN rule (M1, adversarial review): used to
// borrow RATE_LIMIT_KEY_VALIDATION_FAIL's 5/min limit/window, which is
// tuned for throttling brute-force GUESSES against an existing secret, not
// the normal `membral setup` rate a legitimate CLI hits. Now
// RATE_LIMIT_DEVICE_AUTH_START (default 30/min) — still its own bucket
// namespace ("deviceAuthStart"), and see ipOrFallbackBucket for why a
// no-proxy "unknown" IP doesn't put every caller in one shared bucket here.
import { type NextRequest, NextResponse } from "next/server";
import { isUuid, startDeviceAuth } from "@/lib/device-auth";
import { enforceRateLimit, ipOrFallbackBucket, rateLimited } from "@/lib/rate-limit";

const MAX_NAME_LEN = 200;
const MAX_PLATFORM_LEN = 100;

export async function POST(req: NextRequest) {
  const bucket = ipOrFallbackBucket("deviceAuthStart", req);
  const rl = await enforceRateLimit("deviceAuthStart", bucket);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfter);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // No/invalid JSON body -> proceed with defaults (deviceName/devicePlatform/deviceId all null).
  }

  const deviceName =
    typeof body.deviceName === "string" && body.deviceName.trim()
      ? body.deviceName.trim().slice(0, MAX_NAME_LEN)
      : null;
  const devicePlatform =
    typeof body.devicePlatform === "string" && body.devicePlatform.trim()
      ? body.devicePlatform.trim().slice(0, MAX_PLATFORM_LEN)
      : null;
  const deviceId = typeof body.deviceId === "string" && isUuid(body.deviceId) ? body.deviceId : null;

  try {
    const result = await startDeviceAuth({ deviceName, devicePlatform, deviceId });
    const origin = req.nextUrl.origin;
    return NextResponse.json({
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      verificationUri: `${origin}/device`,
      verificationUriComplete: `${origin}/device?code=${encodeURIComponent(result.userCode)}`,
      expiresIn: result.expiresIn,
      interval: result.interval,
    });
  } catch {
    return NextResponse.json({ error: "Failed to start device authorization" }, { status: 500 });
  }
}
