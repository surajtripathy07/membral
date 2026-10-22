// GET /api/memory/dogfood?days=<1..90, default 7>[&view=candidates] — the
// "Membral on Membral" signals for the caller (lib/memory/dogfood-signals.ts
// defines every count). `view=candidates` returns the served records the
// extraction pass judged contradicted instead. Read by `membral status` and
// `membral dogfood digest|candidates`.
//
// AUTH: Bearer Supabase JWT or an UNSCOPED Bearer lls_ key, same as
// /api/memory/served-used (CODE_SESSIONS_READ_AUTH).
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { CODE_SESSIONS_READ_AUTH, getCodeSessionsServiceClient } from "@/lib/code-sessions/auth";
import { log, requestId } from "@/lib/log";
import { getContradictedCandidates, getDogfoodSignals } from "@/lib/memory/dogfood-signals";
import { resolveServedUsedDays } from "@/lib/memory/served-used";
import { userBucket } from "@/lib/rate-limit";

const ROUTE = "/api/memory/dogfood";

export const GET = withRoute(
  {
    auth: CODE_SESSIONS_READ_AUTH,
    rateLimit: { name: "stats", bucket: ({ userId }) => userBucket("memoryDogfood", userId) },
  },
  async ({ req, userId }) => {
    const days = resolveServedUsedDays(req.nextUrl.searchParams.get("days"));
    const view = req.nextUrl.searchParams.get("view");
    try {
      const db = getCodeSessionsServiceClient();
      if (view === "candidates") {
        return NextResponse.json({ days, candidates: await getContradictedCandidates(db, userId, days) });
      }
      return NextResponse.json(await getDogfoodSignals(db, userId, days));
    } catch (err) {
      log.withContext({ request_id: requestId(req), route: ROUTE }).error("dogfood read failed", {
        user_id: userId,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "dogfood read failed" }, { status: 500 });
    }
  },
);
