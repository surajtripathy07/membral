// POST /api/memory/extract-next — runs the user's memory extraction queue
// (goal 2026-09-24 review B1; lib/memory/extraction-trigger.ts). Server-only:
// authenticated with the derived internal bearer token, never a user JWT or
// API key. Answers 202 at once; the work (claim a pending session, extract
// it, flush spend, mark it finished, and repeat while time remains) runs in
// after(), inside this route's own maxDuration. Issue #339: it never POSTs
// itself; the next upload, kick or cron call picks up what is left.
import { after, type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SERVICE_ROLE_KEY_ENV } from "@/lib/env";
import { log } from "@/lib/log";
import { checkMemoryWorkerAuth, runMemoryExtractionStep } from "@/lib/memory/extraction-trigger";

// One session takes ~60s (up to 8 windows plus the blocker re-ask); the loop
// stops starting sessions by MEMORY_RUN_DEADLINE_MS and the queue lease
// (MEMORY_LEASE_SECONDS, 16 min) outlives this.
export const maxDuration = 300;

const BodySchema = z.object({ userId: z.string().uuid() });

export async function POST(req: NextRequest) {
  const auth = checkMemoryWorkerAuth(req.headers.get("authorization"));
  if (auth === "not_configured") {
    log.error(`memory/extract-next: ${SERVICE_ROLE_KEY_ENV} is not configured — refusing (503)`);
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  if (auth !== "ok") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Expected { userId: uuid }" }, { status: 400 });

  const { userId } = parsed.data;
  after(async () => {
    try {
      await runMemoryExtractionStep(userId);
    } catch (err) {
      log.error("memory/extract-next: step failed", {
        user_id: userId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
