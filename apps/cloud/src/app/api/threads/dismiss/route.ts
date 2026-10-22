// POST /api/threads/dismiss — goal 2026-09-26 W7 / P5: the Open threads row's
// "Resolved elsewhere" / "Not a delivery item" actions. Body `{ref, kind,
// reason}` (Zod), `content-type: application/json` required (F13). Writes a
// `thread_dismissals` row (migration 106; lib/threads/queries.ts's
// writeThreadDismissal) keyed by (kind, ref), so dismissing MR !17 never
// hides issue #17 (F1). One row per (kind, ref): a second call is `already: true`
// and refreshes created_at + reason, so a thread re-opened by a later commit
// can be dismissed again (review B1).
//
// Cookie-session auth (same idiom as /api/pulse): the cookie-bound client
// writes as the user, and the table's insert-own RLS is the second check.
import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute } from "@/lib/api/route";
import { log } from "@/lib/log";
import { DISMISS_REASONS } from "@/lib/threads/open-threads";
import { writeThreadDismissal } from "@/lib/threads/queries";

const DismissBodySchema = z.object({
  ref: z.string().trim().min(1).max(500),
  kind: z.enum(["issue", "merge_request"]),
  reason: z.enum(DISMISS_REASONS),
});

function isJson(req: Request): boolean {
  const type = req.headers.get("content-type") ?? "";
  return /^application\/json\s*(;|$)/i.test(type.trim());
}

export const POST = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ req, user, supabase }) => {
    if (!isJson(req)) return NextResponse.json({ error: "content-type must be application/json" }, { status: 415 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const parsed = DismissBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "ref (non-empty string), kind ('issue' | 'merge_request') and reason ('resolved_elsewhere' | 'not_delivery_item') are required",
        },
        { status: 400 },
      );
    }

    try {
      const { ref, kind, reason } = parsed.data;
      const outcome = await writeThreadDismissal(supabase, user.id, { ref, kind }, reason);
      if (!outcome.ok) return NextResponse.json({ error: "no session of yours acted on that ref" }, { status: 404 });
      return NextResponse.json({
        ok: true,
        ref,
        kind,
        reason,
        already: outcome.already,
        dismissal_id: outcome.dismissal_id,
      });
    } catch (err) {
      log.error("threads/dismiss: write failed", { err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Couldn't dismiss the thread." }, { status: 500 });
    }
  },
);
