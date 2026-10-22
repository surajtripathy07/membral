// GET /api/memory/served-used?days=<1..90, default 7> — per recall surface, how
// many served records were used / ignored / are still pending (lib/memory/
// served-used.ts has the definitions). Read by `membral status`.
//
// AUTH: Bearer Supabase JWT or an UNSCOPED Bearer lls_ key, same as the other
// CLI-facing memory routes (CODE_SESSIONS_READ_AUTH).
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { CODE_SESSIONS_READ_AUTH, getCodeSessionsServiceClient } from "@/lib/code-sessions/auth";
import { log, requestId } from "@/lib/log";
import { getServedAndUsed, resolveServedUsedDays } from "@/lib/memory/served-used";
import { userBucket } from "@/lib/rate-limit";

const ROUTE = "/api/memory/served-used";

export const GET = withRoute(
  {
    auth: CODE_SESSIONS_READ_AUTH,
    rateLimit: { name: "stats", bucket: ({ userId }) => userBucket("memoryServedUsed", userId) },
  },
  async ({ req, userId }) => {
    const days = resolveServedUsedDays(req.nextUrl.searchParams.get("days"));
    try {
      return NextResponse.json(await getServedAndUsed(getCodeSessionsServiceClient(), userId, days));
    } catch (err) {
      log.withContext({ request_id: requestId(req), route: ROUTE }).error("served-used read failed", {
        user_id: userId,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "served-used read failed" }, { status: 500 });
    }
  },
);
