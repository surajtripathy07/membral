// POST /api/memory/extraction/kick — a user-triggered nudge for memory
// extraction. Each extract-next invocation drains sessions in a loop until
// its time runs out and never calls itself (issue #339,
// lib/memory/extraction-trigger.ts); the next batch comes from the next
// upload or, hosted, /api/internal/cron/memory-extraction. As a user action
// this kick ignores the cron's per-user failure backoff. A self-hosted/local server has
// neither Vercel cron nor guaranteed uptime, so `membral sweep` and
// `membral sessions` call this once at the end of every run to keep a
// backlog draining between uploads.
//
// AUTH mirrors POST /api/code-sessions exactly (authenticateCodeSessionsWrite):
// Bearer Supabase JWT or an UNSCOPED Bearer lls_ key — a scoped key is a
// narrowed read lens, never a write/trigger grant.
//
// Never extracts inline: this only counts the user's claimable rows
// (pending, or running with an expired lease — same claimability the daily
// cron lists) and, if any, fires the same internal HMAC-authed trigger an
// upload does (triggerMemoryExtraction), fire-and-forget via after().
import { after, NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { CODE_SESSIONS_WRITE_AUTH, getCodeSessionsServiceClient } from "@/lib/code-sessions/auth";
import { checkFeature } from "@/lib/feature-flags";
import { log, requestId } from "@/lib/log";
import { logMemoryExtraction } from "@/lib/memory/extraction-log";
import { countClaimableMemoryExtraction } from "@/lib/memory/extraction-queue";
import { resolveInternalBaseUrl, triggerMemoryExtraction } from "@/lib/memory/extraction-trigger";
import { userBucket } from "@/lib/rate-limit";

export const POST = withRoute(
  {
    auth: CODE_SESSIONS_WRITE_AUTH,
    rateLimit: { name: "memoryExtractionKick", bucket: ({ userId }) => userBucket("memoryExtractionKick", userId) },
  },
  async ({ req, userId }) => {
    const rlog = log.withContext({ request_id: requestId(req), route: "/api/memory/extraction/kick", user_id: userId });

    const supabase = getCodeSessionsServiceClient();
    let pending: number;
    try {
      pending = await countClaimableMemoryExtraction(supabase, userId);
    } catch (err) {
      rlog.error("memory/extraction/kick: queue count failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ kicked: false, pending: 0, error: "queue check failed" }, { status: 500 });
    }

    if (pending === 0) {
      return NextResponse.json({ kicked: false, pending: 0 });
    }

    // Same gate the extraction chain itself checks per-session
    // (processNextMemoryExtraction) — checked here too so a disabled/exhausted
    // user gets a reason back instead of a trigger POST that will only skip.
    const feature = await checkFeature(userId, "memory");
    if (!feature.allowed) {
      logMemoryExtraction({ event: "kick", reason: feature.reason, userId: userId, sessionCount: pending });
      return NextResponse.json({ kicked: false, pending, reason: feature.reason });
    }

    const baseUrl = resolveInternalBaseUrl();
    after(async () => {
      await triggerMemoryExtraction(userId, baseUrl);
    });
    logMemoryExtraction({ event: "kick", userId: userId, sessionCount: pending });
    return NextResponse.json({ kicked: true, pending });
  },
);
