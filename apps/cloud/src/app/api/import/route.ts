import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { getServiceClient } from "@/lib/db/clients";
import { readTextBodyWithLimit } from "@/lib/http-body";
import { ingestConversations } from "@/lib/import/ingest";
import { log, requestId } from "@/lib/log";
import { userBucket } from "@/lib/rate-limit";
import { CHAT_SOURCES, conversationCountCapMessage } from "@/lib/sync-validator";

// Issue #127 abuse-hardening audit (B3): a body-size ceiling on the CLI's
// bulk-import path, same rationale/value as /api/sync — comfortably above
// one real batch (the extension/CLI never sends more than
// MAX_CONVERSATIONS_PER_REQUEST conversations per request; 25MB covers even
// a batch of long conversations with room to spare) while bounding an
// authenticated caller from posting an unbounded payload.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

// AUTH (#182, ruling D-067): Bearer Supabase JWT (extension) OR an UNSCOPED
// Bearer lls_ key (the CLI's `membral import`). A SCOPED key is a narrowed read
// lens, never a write grant: 403, same rule as the code-sessions write surface.
// A failed key counts against the per-IP keyValidationFail throttle (withRoute
// "dual" always threads clientIp). Every auth failure carries x-request-id.
export const POST = withRoute(
  {
    auth: {
      kind: "dual",
      missing: "Missing authorization",
      invalidToken: "Invalid token",
      invalidKey: "Invalid API key",
      scoped: { reject: "Scoped API keys cannot import conversations" },
    },
    requestId: true,
    rateLimit: { name: "importBulk", bucket: ({ userId }) => userBucket("importBulk", userId) },
  },
  async ({ req, userId, rid: routeRid }) => {
    const rid = routeRid ?? requestId(req);
    const rlog = log.withContext({ request_id: rid, route: "/api/import", user_id: userId });
    const hdrs = { "x-request-id": rid };
    const supabase = getServiceClient();

    // Round-2 review MED 7: readTextBodyWithLimit counts bytes across stream
    // chunks as they arrive rather than trusting Content-Length or buffering
    // the whole body before checking — see @/lib/http-body's header comment.
    let rawText: string;
    try {
      const result = await readTextBodyWithLimit(req.body, MAX_BODY_BYTES);
      if ("tooLarge" in result) {
        return NextResponse.json({ error: "Request body too large" }, { status: 413, headers: hdrs });
      }
      rawText = result.text;
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: hdrs });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: hdrs });
    }

    const raw = body as Record<string, unknown>;
    const conversations = raw?.conversations;

    if (!Array.isArray(conversations)) {
      return NextResponse.json(
        { error: "Expected { conversations: [...] } or { metadata: ..., conversations: [...] }" },
        { status: 400, headers: hdrs },
      );
    }

    const countCapMessage = conversationCountCapMessage(conversations.length);
    if (countCapMessage) {
      return NextResponse.json({ error: countCapMessage }, { status: 400, headers: hdrs });
    }

    // Optional `sources` field (goal 2026-07-26 step 2, #63/#58) — symmetric
    // with /api/sync: a source declared here still heartbeats even if this
    // particular batch happened to contain zero valid rows for it. VALIDATED
    // against the canonical CHAT_SOURCES set (round-2 adversarial review,
    // MAJOR 2 — see /api/sync's matching comment for why this can't be
    // trusted unvalidated). Filtered + deduped inside ingestConversations.
    const declaredSources = Array.isArray(raw?.sources)
      ? (raw.sources as unknown[]).filter((s): s is string => typeof s === "string" && CHAT_SOURCES.has(s))
      : [];

    const { imported, errors, skipped, quota } = await ingestConversations(supabase, userId, conversations, {
      declaredSources,
      rlog,
      enforceQuota: true,
    });

    // Issue #127: the batch contained ONLY new (not-already-stored)
    // conversations and NONE of them fit under the remaining
    // conversation_limit headroom — a full rejection, not a partial one.
    // `quota` is only ever set when enforceQuota ran (always true here).
    if (imported === 0 && (skipped ?? 0) > 0 && quota) {
      return NextResponse.json(
        { error: "conversation_limit", limit: quota.limit, count: quota.count },
        { status: 402, headers: hdrs },
      );
    }

    return NextResponse.json(
      {
        imported,
        total: conversations.length,
        errors,
        skipped: skipped ?? 0,
        atLimit: (skipped ?? 0) > 0,
      },
      { headers: hdrs },
    );
  },
);
