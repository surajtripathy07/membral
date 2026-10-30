// POST /api/code-sessions — ADR 0021 Q1/Q8: the single ingestion route for
// code-agent session transcripts (Claude Code first). Two callers hit this:
// the `membral import-session` post-hook (one session) and
// `membral sessions` backfill (batches), both in @membral/cli.
//
// AUTH mirrors /api/sync: Bearer Supabase JWT OR a Bearer `lls_` API key
// (validateApiKey, lib/api-keys.ts) — the headless CLI/hook path uses an
// `lls_` key.
//
// SECURITY (non-negotiable): a SCOPED key — area-scoped (#83,
// api_key_scope_node_id) or code-project-scoped (ADR Q7,
// api_key_scope_code_project_id) — is REJECTED with 403 for imports. A scope
// is a narrowed READ lens (see /api/mcp), never a write grant; only an
// unscoped key or a JWT (the dashboard's own session) may import.
//
// ISOLATION (ADR Q2): this route calls ONLY lib/code-sessions/import.ts,
// which writes exclusively to code_projects/code_sessions/code_session_turns.
// It never imports GraphWriter and never touches kg_nodes/kg_edges — see
// code-isolation.test.ts.
//
// P1c (ADR Q5): a successful import batch (imported > 0) fires the
// code-dimension synthesis pass (summaries -> rollups -> cross-links)
// fire-and-forget, mirroring how POST /api/sync triggers processKgPass1 —
// see the bottom of this handler.
import { after, NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { CODE_SESSIONS_WRITE_AUTH, getCodeSessionsServiceClient } from "@/lib/code-sessions/auth";
import { importCodeSession } from "@/lib/code-sessions/import";
import { mirrorCodeSessionsToConversations } from "@/lib/code-sessions/mirror-conversations";
import { CodeSessionsRequestSchema, MAX_BATCH_SIZE } from "@/lib/code-sessions/payload";
import { listSessionIdsBySourceSessionIds } from "@/lib/code-sessions/queries";
import { synthesizeCodeDimensionForUser } from "@/lib/code-sessions/synthesize";
import { readTextBodyWithLimit } from "@/lib/http-body";
import { chatConfigured } from "@/lib/llm/config";
import { log, requestId } from "@/lib/log";
import { logMemoryExtraction } from "@/lib/memory/extraction-log";
import { enqueueMemoryExtraction, MEMORY_QUEUE_TABLE } from "@/lib/memory/extraction-queue";
import { resolveInternalBaseUrl, triggerMemoryExtraction } from "@/lib/memory/extraction-trigger";
import { enqueueRawUnitTask } from "@/lib/memory/raw-units/queue";
import { userBucket } from "@/lib/rate-limit";
import { recordCodeHeartbeat } from "@/lib/sync-heartbeat";

// Sanity cap on the raw request body (ADR: "4MB-ish"). The CLI parser
// compacts tool_result payloads before upload (ADR Q3), so a well-formed
// batch of <=20 sessions is well under this.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** code_sessions ids of the parents named by `source\u0000parent_source_session_id` keys; best effort — a failed read requeues none. */
async function parentSessionIds(
  supabase: ReturnType<typeof getCodeSessionsServiceClient>,
  userId: string,
  keys: ReadonlySet<string>,
): Promise<string[]> {
  if (keys.size === 0) return [];
  try {
    const bySource = new Map<string, string[]>();
    for (const k of keys) {
      const [source, sid] = k.split("\u0000");
      bySource.set(source, [...(bySource.get(source) ?? []), sid]);
    }
    const out: string[] = [];
    for (const [source, sids] of bySource) {
      out.push(...(await listSessionIdsBySourceSessionIds(supabase, userId, source, sids)));
    }
    if (out.length === 0) return out;
    // N4: a parent whose extraction ended `failed` stays failed — a child import
    // never resets it to pending (that would re-spend on its held-back tail).
    const { data: failed, error: qErr } = await supabase
      .from(MEMORY_QUEUE_TABLE)
      .select("session_id")
      .eq("user_id", userId)
      .eq("status", "failed")
      .in("session_id", out);
    if (qErr) throw new Error(qErr.message);
    const stuck = new Set(((failed ?? []) as Array<{ session_id: string }>).map((r) => r.session_id));
    return out.filter((id) => !stuck.has(id));
  } catch (err) {
    log.warn("parent requeue lookup failed", { err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// Issue #127 abuse-hardening audit (B1/B2): this route already had a 4MB
// body cap + MAX_BATCH_SIZE schema cap, but no per-user rate limit at all.
export const POST = withRoute(
  {
    auth: CODE_SESSIONS_WRITE_AUTH,
    rateLimit: { name: "codeSessions", bucket: ({ userId }) => userBucket("codeSessions", userId) },
  },
  async ({ req, userId }) => {
    const rlog = log.withContext({ request_id: requestId(req), route: "/api/code-sessions", user_id: userId });

    // Round-2 review MED 7: readTextBodyWithLimit counts bytes across stream
    // chunks as they arrive rather than trusting Content-Length or buffering
    // the whole body before checking — see @/lib/http-body's header comment.
    let rawText: string;
    try {
      const result = await readTextBodyWithLimit(req.body, MAX_BODY_BYTES);
      if ("tooLarge" in result) {
        return NextResponse.json({ error: "Request body too large" }, { status: 413 });
      }
      rawText = result.text;
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = CodeSessionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: `Invalid request body — expected { sessions: RawCodeSession[] } (max ${MAX_BATCH_SIZE} per batch)`,
          detail: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        { status: 400 },
      );
    }

    const { sessions, force, open } = parsed.data;

    const supabase = getCodeSessionsServiceClient();
    let imported = 0;
    let skipped = 0;
    // Subset of `skipped`: Membral's own headless runs, which are never imported (lib/code-sessions/import.ts).
    let skippedHeadless = 0;
    const errors: { sourceSessionId: string; error: string }[] = [];
    // ADR 0039 (W6/D7): every session actually written this batch (imported OR
    // skipped-unchanged both already have a code_sessions row/turns to mirror
    // from — only a hard `error` result has nothing to mirror) feeds the
    // conversations mirror below, so a re-run that hits the import
    // short-circuit still keeps its `conversations` row in sync on the rare
    // case the mirror itself previously failed after a successful import.
    const mirrorSessionIds: string[] = [];
    // step2d finding 3 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
    // #151; driver follow-up 2026-09-13): every session actually IMPORTED
    // this batch (never "skipped" — nothing changed there — or "error") feeds
    // ONE shared-cost-guard tail-capture batch below, fired once for the
    // whole request instead of once per session inside importCodeSession.
    const tailCaptureSessionIds: string[] = [];
    // A re-imported sub-agent changes what its parent's issue rows fold in
    // (D-051 B16): the parent is re-queued too, so its rows are re-derived
    // (a parent with no new turns re-derives without an LLM call).
    const importedChildParents = new Set<string>();

    for (const session of sessions) {
      const result = await importCodeSession(supabase, userId, session, force, {
        open,
        // Embedding runs after the response is sent, never inside the request.
        deferRawUnits: (task, sid) => after(enqueueRawUnitTask(sid, task)),
      });
      if (result.status === "imported") {
        imported++;
        if (result.sessionId) {
          mirrorSessionIds.push(result.sessionId);
          tailCaptureSessionIds.push(result.sessionId);
        }
        if (session.parentSessionId) importedChildParents.add(`${session.source}\u0000${session.parentSessionId}`);
      } else if (result.status === "skipped") {
        skipped++;
        if (result.reason === "membral_headless_run") skippedHeadless++;
        if (result.sessionId) mirrorSessionIds.push(result.sessionId);
      } else {
        errors.push({ sourceSessionId: session.sourceSessionId, error: result.error ?? "unknown error" });
        rlog.error("code session import failed", {
          source: session.source,
          source_session_id: session.sourceSessionId,
          err: result.error,
        });
      }
    }

    // Memory v1 §8.2/§8.7 tail capture (docs/design/memory-v1.md §3 "C — the
    // server's answer to a check-in that never fired"). Goal 2026-09-24
    // review B1/m6: extraction no longer runs here. Every imported session is
    // re-queued in memory_extraction_queue (awaited — one RPC), then after()
    // POSTs ONE /api/memory/extract-next call for this user, which extracts
    // sessions one after another inside that one invocation while time
    // remains, never calling itself (issue #339); what is left waits for the
    // next upload, kick or cron trigger (lib/memory/extraction-trigger.ts).
    // This kick is a user action: the cron's per-user failure backoff does
    // not apply to it.
    // P10 round 3 R3-M1: an enqueue failure never fails the upload — the
    // sessions are stored, and the mirror, heartbeat, synthesis and alias
    // reseed below still run. The daily cron
    // (api/internal/cron/memory-extraction) reconciles: it queues recent
    // sessions with no queue row, and finished ones whose turns grew since
    // their last extraction.
    // Open-session upload (Stop hook): turns and raw units are stored above, but no paid extraction is queued or
    // triggered; the session's closing upload (SessionEnd or sweep) re-imports once and queues it as usual.
    if (!open) {
      for (const id of await parentSessionIds(supabase, userId, importedChildParents)) {
        if (!tailCaptureSessionIds.includes(id)) tailCaptureSessionIds.push(id);
      }
    }
    if (!open && tailCaptureSessionIds.length > 0) {
      let queued = 0;
      try {
        queued = await enqueueMemoryExtraction(supabase, userId, { requeue: tailCaptureSessionIds });
      } catch (err) {
        logMemoryExtraction({
          event: "fail",
          reason: "enqueue_failed",
          userId,
          sessionCount: tailCaptureSessionIds.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (queued > 0) {
        const baseUrl = resolveInternalBaseUrl();
        after(async () => {
          await triggerMemoryExtraction(userId, baseUrl);
        });
      }
    }

    // ADR 0039 (W6/D7 review M7): fire-and-forget, same shape as the P1c
    // synthesis trigger below — a full-walk sweep (packages/cli's
    // SWEEP_FULL_WALK_EVERY) re-posts EVERY session, not just new ones, so
    // `mirrorSessionIds` can be the whole corpus on that cycle; blocking the
    // HTTP response on it (as this used to) meant one such request held the
    // connection open for O(sessions × turns) work. mirror-conversations.ts's
    // own per-session content-hash fast path (fetchExistingMirroredConversations)
    // keeps a full-walk mirror cheap once it runs — the response no longer
    // waits for it either way. Never let a mirror failure surface here: same
    // "log, don't 500" posture as recordCodeHeartbeat/synthesis/alias-seed.
    if (mirrorSessionIds.length > 0) {
      mirrorCodeSessionsToConversations(supabase, userId, { sessionIds: mirrorSessionIds })
        .then((mirrorResult) => {
          if (mirrorResult.errors.length > 0) {
            rlog.error("code session mirror had per-session errors", { errors: mirrorResult.errors });
          }
          // Round-2 review HIGH 4: conversation_limit rejections are expected,
          // correct behavior (mirrored code sessions now share the chat quota
          // — see lib/billing.ts) — logged at warn, never error, and never
          // surfaced as a failure to the CLI caller (this whole call is
          // fire-and-forget, see the comment above).
          if (mirrorResult.skippedQuota > 0) {
            rlog.warn("code session mirror skipped session(s) at conversation_limit", {
              skippedQuota: mirrorResult.skippedQuota,
            });
          }
        })
        .catch((err) => {
          rlog.error("code session mirror failed", { err: err instanceof Error ? err.message : String(err) });
        });
    }

    // Freshness heartbeat (goal 2026-07-26 step 2, #63/#58) — source='code'.
    // UNCONDITIONAL on any authenticated, schema-valid POST — including an
    // empty `sessions: []` heartbeat ping from a delta sweep that found
    // nothing new (B1, 2026-07-26 adversarial review), and batches where
    // every session was skipped/errored. Gating this on `imported > 0` made a
    // perfectly healthy, idle delta sweep look "code stale" on /pulse, since
    // such a sweep can go for hours without a single imported session even
    // though it's running exactly as intended every cycle. Never let this
    // fail the import response: recordCodeHeartbeat catches and logs
    // internally.
    await recordCodeHeartbeat(supabase, userId);

    // Fire-and-forget P1c synthesis (ADR Q5) — same shape as /api/sync's
    // processKgPass1 trigger: only when this batch actually landed new/changed
    // sessions, and only when the server has an LLM key configured (summarize/
    // rollup fall back gracefully with no key, but there's no point starting a
    // run that will only ever hit the heuristic path).
    // Not for open uploads (Stop hook): summaries are LLM spend and the session is unfinished.
    if (imported > 0 && !open && chatConfigured()) {
      synthesizeCodeDimensionForUser(userId).catch((err) => {
        rlog.error("code dimension synthesis failed", { err: err instanceof Error ? err.message : String(err) });
      });
    }

    // Fire-and-forget project_aliases reseed (migration 060/063, W7/D8, goal
    // 2026-08-26 e2e demo) — no LLM key needed, so unlike synthesis above this
    // only gates on `imported > 0`. `supabase` here is the service-role client
    // (getCodeSessionsServiceClient), so project_alias_seed's relaxed guard
    // (auth.role() = 'service_role', migration 063 finding #2) is what makes
    // this call legal — a real service-role RPC, not a spoofed/impersonated
    // end-user session. This is one of the two real call sites that make the
    // alias table's demo state reproducible from the repo (the other is GET
    // /api/memory/projects/merge); idempotent, cheap, never lets a failure
    // fail the import response.
    if (imported > 0) {
      (async () => {
        try {
          const { error } = await supabase.rpc("project_alias_seed", { p_user: userId });
          if (error) rlog.error("project_alias_seed failed", { err: error.message });
        } catch (err) {
          rlog.error("project_alias_seed failed", { err: err instanceof Error ? err.message : String(err) });
        }
      })();
    }

    return NextResponse.json({
      imported,
      skipped,
      skipped_headless: skippedHeadless,
      total: sessions.length,
      errors,
      // Ack for the Stop hook: a server that predates `open` strips the flag and would queue paid extraction.
      open_supported: true,
    });
  },
);
