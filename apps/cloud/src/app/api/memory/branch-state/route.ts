// /api/memory/branch-state — the two halves of the ref-keyed sweep check
// (goal 2026-09-26 W6 / P4; lib/memory/branch-state.ts has the design).
//
//   GET  ?repo=<identity or local path> &days=<1..90>
//        -> { checked_window_days, repos: RepoRefsToCheck[] }: per repo the
//           shas, branches and still-open MR refs the caller's own sessions
//           named in the window. `membral sweep` turns these into read-only,
//           ref-keyed git commands on the developer's machine.
//   POST { checked_at, results: BranchCheckResult[] }
//        -> upserts memory_branch_state (migration 084) for the caller's own
//           projects; results for a project the caller does not own are
//           counted as `rejected` and never written.
//
// AUTH mirrors POST /api/code-sessions and /api/memory/extraction/kick
// (authenticateCodeSessionsWrite): Bearer Supabase JWT or an UNSCOPED Bearer
// lls_ key — a scoped key is a narrowed read lens, never a write grant, and
// GET here is the write's planning half, so both verbs use the same gate.
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { CODE_SESSIONS_WRITE_AUTH, getCodeSessionsServiceClient } from "@/lib/code-sessions/auth";
import { readTextBodyWithLimit } from "@/lib/http-body";
import { log, requestId } from "@/lib/log";
import {
  BranchStatePostSchema,
  loadRefsToCheck,
  resolveBranchStateDays,
  upsertBranchState,
} from "@/lib/memory/branch-state";
import { userBucket } from "@/lib/rate-limit";

const ROUTE = "/api/memory/branch-state";
// 500 results x a few hundred bytes each stays far under this.
const MAX_BODY_BYTES = 1024 * 1024;

export const GET = withRoute(
  {
    auth: CODE_SESSIONS_WRITE_AUTH,
    rateLimit: { name: "codeSessions", bucket: ({ userId }) => userBucket("memoryBranchState", userId) },
  },
  async ({ req, userId }) => {
    const rlog = log.withContext({ request_id: requestId(req), route: ROUTE });

    const days = resolveBranchStateDays(req.nextUrl.searchParams.get("days"));
    const repo = req.nextUrl.searchParams.get("repo");
    try {
      const repos = await loadRefsToCheck(getCodeSessionsServiceClient(), userId, { days, repo });
      return NextResponse.json({ checked_window_days: days, repos });
    } catch (err) {
      rlog.error("branch-state: refs-to-check read failed", {
        user_id: userId,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "refs-to-check read failed" }, { status: 500 });
    }
  },
);

export const POST = withRoute(
  {
    auth: CODE_SESSIONS_WRITE_AUTH,
    rateLimit: { name: "codeSessions", bucket: ({ userId }) => userBucket("memoryBranchState", userId) },
  },
  async ({ req, userId }) => {
    const rlog = log.withContext({ request_id: requestId(req), route: ROUTE });

    let raw: string;
    try {
      const result = await readTextBodyWithLimit(req.body, MAX_BODY_BYTES);
      if ("tooLarge" in result) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
      raw = result.text;
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = BranchStatePostSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
    }

    try {
      const outcome = await upsertBranchState(getCodeSessionsServiceClient(), userId, parsed.data);
      return NextResponse.json({ ok: true, ...outcome });
    } catch (err) {
      rlog.error("branch-state: upsert failed", {
        user_id: userId,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "branch-state write failed" }, { status: 500 });
    }
  },
);
