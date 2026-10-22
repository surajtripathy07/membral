// GET /api/memory/preamble (docs/design/memory-v1.md §4, #152): the
// SessionStart push -- header, routing line, what sessions did on this branch
// and elsewhere in the repo, and the recall_token (lib/memory/preamble.ts).
//
// AUTH: Bearer `lls_` API key only (withRoute kind "key"; scoped keys pass
// with their code-project bound, like /api/mcp). Unlike /api/mcp itself this route has no JWT fallback -- it
// is a harness (CLI hook) surface, never called from the dashboard's own
// browser session.
//
// RATE LIMIT: reuses the existing "mcp" rule/bucket rather than adding a new
// RATE_LIMIT_DEFAULTS entry -- this route sits on the exact same
// lls_-key-authenticated surface as /api/mcp and costs about the same per
// call (a handful of session_memories/code_sessions reads), so sharing the
// budget is both simpler and avoids editing lib/rate-limit.ts (owned by
// another concurrent build step per the goal's file-ownership split).

import { type NextRequest, NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { getServiceClient } from "@/lib/db/clients";
import { log } from "@/lib/log";
import { buildPreamble } from "@/lib/memory/preamble";
import { buildSessionStartSelfRecall } from "@/lib/memory/prompt-recall";
import { recordRecallEvent } from "@/lib/memory/search";
import { keyBucket } from "@/lib/rate-limit";

// #361: the harness's own session id (Claude Code's SessionStart
// `session_id`), passed by the CLI hook as `?session=`. Opaque to us; anything
// that is not a short id-shaped string is ignored, never rejected.
const HARNESS_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

function harnessSessionParam(req: NextRequest): string | null {
  const raw = req.nextUrl.searchParams.get("session");
  return raw && HARNESS_SESSION_ID_RE.test(raw) ? raw : null;
}

export const GET = withRoute(
  {
    auth: {
      kind: "key",
      missing: "Missing authorization",
      notKey: "Provide an lls_ API key",
      invalidKey: "Invalid API key",
      scoped: "allow",
    },
    rateLimit: { name: "mcp", bucket: ({ key }) => keyBucket("mcp", key.prefix) },
  },
  async ({ req, userId, key }) => {
    const repo = req.nextUrl.searchParams.get("repo");
    if (!repo) return NextResponse.json({ error: "repo is required" }, { status: 400 });
    const branch = req.nextUrl.searchParams.get("branch") ?? undefined;
    const head_sha = req.nextUrl.searchParams.get("head_sha") ?? undefined;

    const harnessSessionId = harnessSessionParam(req);

    // `?self=compact|resume` (Claude Code's SessionStart source): the session was continued, so its own records,
    // when the store already has them, come back as `self_lines` beside the preamble (lib/memory/self-recall.ts).
    // Claude Code only: the CLI sends it for its default hook format.
    const selfSource = req.nextUrl.searchParams.get("self");
    // `?line_max=` (300..720): the longest self line the CLI shows whole; absent (an old CLI) means 420.
    const lineMaxRaw = Number(req.nextUrl.searchParams.get("line_max"));
    const lineMaxParam =
      Number.isInteger(lineMaxRaw) && lineMaxRaw >= 300 && lineMaxRaw <= 720 ? lineMaxRaw : undefined;
    const wantSelf = (selfSource === "compact" || selfSource === "resume") && harnessSessionId !== null;

    const db = getServiceClient();
    const [result, self] = await Promise.all([
      buildPreamble(db, userId, { repo, branch, head_sha, session: harnessSessionId }, key.scopeCodeProjectId),
      wantSelf && harnessSessionId && !key.scopeNodeId
        ? buildSessionStartSelfRecall(
            db,
            userId,
            key.scopeCodeProjectId,
            {
              sourceSessionId: harnessSessionId,
              harness: "claude-code",
            },
            { lineMax: lineMaxParam },
          )
        : Promise.resolve(null),
    ]);

    // #361: log what was served (one surface='preamble' event, the record ids
    // actually rendered into lines) so import-time reconciliation can mark
    // influence. A logging failure never changes the response.
    try {
      await recordRecallEvent(db, userId, "preamble", {
        recordIds: [...(result.record_ids ?? []), ...(self?.record_ids ?? [])],
        recallToken: result.recall_token,
        surface: "preamble",
        harnessSessionId,
      });
    } catch (err) {
      log.warn("preamble recall event write threw", {
        user_id: userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("application/json")) {
      return NextResponse.json({
        lines: result.lines,
        recall_token: result.recall_token,
        open_blockers: result.open_blockers,
        ...(wantSelf ? { self_lines: self?.lines ?? [], self_skipped: self?.skipped ?? null } : {}),
      });
    }
    return new NextResponse(result.lines.join("\n"), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
);
