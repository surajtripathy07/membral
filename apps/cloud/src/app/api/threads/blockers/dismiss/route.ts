// /api/threads/blockers/dismiss — Today's blocker row menu (UX pass 2).
//   POST   {id, reason: 'resolved' | 'ignored'} — retires the blocker and its
//          live recurrence chain (lib/memory/blocker-dismiss.ts); returns the
//          retired ids for Undo.
//   DELETE {ids: uuid[]} — Undo / Restore: lifts only rows a user dismissal
//          retired (and sightings carried onto them).
//   GET    — the caller's clicked dismissals, one per click, for the Blockers
//          "N dismissed" list (Restore after a reload).
// `content-type: application/json` required (as /api/threads/dismiss, F13).
//
// Cookie-session auth: the cookie-bound client writes as the user and the
// table's own_rows RLS (migration 084) is the second check — never another
// user's row, whatever id is sent.
import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute } from "@/lib/api/route";
import { log } from "@/lib/log";
import {
  BLOCKER_DISMISS_REASONS,
  dismissBlocker,
  listDismissedBlockers,
  undoBlockerDismissal,
} from "@/lib/memory/blocker-dismiss";

const DismissBodySchema = z.object({
  id: z.uuid(),
  reason: z.enum(BLOCKER_DISMISS_REASONS),
});

const UndoBodySchema = z.object({
  ids: z.array(z.uuid()).min(1).max(200),
});

function isJson(req: Request): boolean {
  const type = req.headers.get("content-type") ?? "";
  return /^application\/json\s*(;|$)/i.test(type.trim());
}

type ParsedBody<T> = { ok: true; data: T } | { ok: false; res: NextResponse };

async function parseBody<T>(req: Request, schema: z.ZodType<T>, hint: string): Promise<ParsedBody<T>> {
  if (!isJson(req)) {
    return { ok: false, res: NextResponse.json({ error: "content-type must be application/json" }, { status: 415 }) };
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, res: NextResponse.json({ error: "invalid JSON body" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, res: NextResponse.json({ error: hint }, { status: 400 }) };
  return { ok: true, data: parsed.data };
}

export const POST = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ req, user, supabase }) => {
    const p = await parseBody(req, DismissBodySchema, "id (uuid) and reason ('resolved' | 'ignored') are required");
    if (!p.ok) return p.res;
    try {
      const outcome = await dismissBlocker(supabase, user.id, p.data.id, p.data.reason);
      if (!outcome.ok) return NextResponse.json({ error: "no live blocker of yours with that id" }, { status: 404 });
      return NextResponse.json({ ok: true, id: p.data.id, reason: p.data.reason, ids: outcome.ids });
    } catch (err) {
      log.error("threads/blockers/dismiss: write failed", { err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Couldn't dismiss the blocker." }, { status: 500 });
    }
  },
);

export const DELETE = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ req, user, supabase }) => {
    const p = await parseBody(req, UndoBodySchema, "ids (non-empty array of uuids) is required");
    if (!p.ok) return p.res;
    try {
      const ids = await undoBlockerDismissal(supabase, user.id, p.data.ids);
      if (ids.length === 0) return NextResponse.json({ error: "nothing of yours to restore" }, { status: 404 });
      return NextResponse.json({ ok: true, ids });
    } catch (err) {
      log.error("threads/blockers/dismiss: undo failed", { err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Couldn't restore the blocker." }, { status: 500 });
    }
  },
);

export const GET = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ user, supabase }) => {
    try {
      return NextResponse.json({ dismissed: await listDismissedBlockers(supabase, user.id) });
    } catch (err) {
      log.error("threads/blockers/dismiss: list failed", { err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Couldn't load dismissed blockers." }, { status: 500 });
    }
  },
);
