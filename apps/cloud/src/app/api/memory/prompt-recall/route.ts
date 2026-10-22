// POST /api/memory/prompt-recall (docs/design/prompt-time-recall.md): the
// UserPromptSubmit push. Body {prompt, repo, session?, budget_ms?,
// exclude_record_ids?, continuation?: {source_session_id, harness}}; answers {lines, record_ids,
// skipped, duration_ms, mode?}, where lines is [] when nothing
// cleared the relevance floor, the prompt was skipped, or the search ran past
// its 1.5 s budget (lib/memory/prompt-recall.ts); `skipped` then names why
// (null when lines were served) and the CLI hook writes it to hook.log.
// `exclude_record_ids` are the records the hook already injected in this session: the cap applies first, then
// those drop out WITHOUT a refill (the freed slots stay empty), and one pointer line names them; skipped
// 'already_sent' when nothing fresh is left. Only the hook sends it, never an MCP pull.
// Only a malformed request is an error; the hook treats every non-2xx as
// "inject nothing".
//
// AUTH and RATE LIMIT: exactly the preamble route's (Bearer lls_ key only,
// code-scoped keys pass bound to their project, area-scoped keys get an empty
// answer, the "mcp" bucket) -- the same CLI
// hook surface, about the same cost per call.
//
// LOGGING: one structured `prompt recall served` line per answered request (duration_ms, skipped, records, stages_ms:
// ms per stage reached, stage_at_timeout: the stage in flight when the 1.5 s cap fired; neither is in the response), and
// one memory_recall_events row per served answer (surface
// 'prompt_hook', tool 'memory_search', the harness session id), only when
// records were served. `record_ids` holds the served records only; follow-up
// outcome ids are not logged (the event row has no slot for them). The prompt text is NOT stored: `query` stays null.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute } from "@/lib/api/route";
import { getServiceClient } from "@/lib/db/clients";
import { readTextBodyWithLimit } from "@/lib/http-body";
import { resolveEmbeddingConfig } from "@/lib/llm/embedding-client";
import { log } from "@/lib/log";
import { buildPromptRecall } from "@/lib/memory/prompt-recall";
import { recordRecallEvent } from "@/lib/memory/search";
import { SELF_RECALL_HARNESSES } from "@/lib/memory/self-recall";
import { keyBucket } from "@/lib/rate-limit";

/** A prompt larger than this is cut by the CLI; the route refuses anything bigger. */
const MAX_BODY_BYTES = 64 * 1024;

// The same id shape the preamble route accepts for `?session=`.
const HARNESS_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

const PromptRecallBodySchema = z.object({
  prompt: z.string().max(20_000),
  repo: z.string().min(1).max(1_000),
  session: z.string().max(200).optional().nullable(),
  // The client's own wait. Absent (an old CLI): the legacy answer, at most 5 lines (lib/memory/prompt-recall.ts).
  budget_ms: z.number().int().min(500).max(10_000).optional(),
  // The longest line the client shows whole (a new CLI sends its cut, 720). Absent (an old CLI cuts at 420, mid-URL):
  // lines are fitted to 420. An out-of-range integer is clamped to 300..720 and anything else falls back to 420
  // (lib/memory/prompt-recall.ts resolveLineMax), never a 400.
  line_max: z.number().int().optional().catch(undefined),
  // Records the client already injected in this session: dropped before the slots are filled. Absent (an old CLI): none.
  // An older server strips this unknown field. Malformed ids fail the request like any bad field.
  exclude_record_ids: z.array(z.string().uuid()).max(100).optional(),
  // The prompt continues this harness session (Claude Code's compaction summary): its own records come first.
  continuation: z
    .object({
      source_session_id: z.string().regex(HARNESS_SESSION_ID_RE),
      harness: z.enum(SELF_RECALL_HARNESSES),
    })
    .optional(),
});

/** Which embedding provider and model served the query vector (no key, no URL), for the timing log line. */
function embeddingForLog(): { provider: string; model: string } {
  const { apiKey, baseURL, model } = resolveEmbeddingConfig();
  if (!apiKey) return { provider: "none", model };
  if (!baseURL) return { provider: "openai", model };
  return { provider: baseURL.includes("openrouter.ai") ? "openrouter" : "custom", model };
}

export const POST = withRoute(
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
    const routeStart = Date.now();
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
    const parsed = PromptRecallBodySchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "prompt and repo are required" }, { status: 400 });

    // An area-scoped key (#83) sees chat tools only on MCP, never code-session
    // memories: it gets the empty answer, as if nothing matched.
    if (key.scopeNodeId) {
      return NextResponse.json({ lines: [], record_ids: [], skipped: "area_scoped_key", duration_ms: 0 });
    }

    const session = parsed.data.session && HARNESS_SESSION_ID_RE.test(parsed.data.session) ? parsed.data.session : null;
    const db = getServiceClient();
    const started = Date.now();
    const bodyReadMs = started - routeStart;
    const result = await buildPromptRecall(db, userId, key.scopeCodeProjectId, {
      prompt: parsed.data.prompt,
      repo: parsed.data.repo,
      session,
      clientBudgetMs: parsed.data.budget_ms,
      lineMax: parsed.data.line_max,
      ...(parsed.data.exclude_record_ids?.length ? { excludeRecordIds: parsed.data.exclude_record_ids } : {}),
      ...(parsed.data.continuation
        ? {
            continuation: {
              sourceSessionId: parsed.data.continuation.source_session_id,
              harness: parsed.data.continuation.harness,
            },
          }
        : {}),
    });
    const durationMs = Date.now() - started;

    let eventMs: number | undefined;
    if (result.record_ids.length > 0) {
      const eventStart = Date.now();
      try {
        await recordRecallEvent(db, userId, "memory_search", {
          recordIds: result.record_ids,
          surface: "prompt_hook",
          harnessSessionId: session,
        });
        eventMs = Date.now() - eventStart;
      } catch (err) {
        log.warn("prompt recall event write threw", {
          user_id: userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const skipped = result.lines.length > 0 ? null : (result.skipped ?? "no_match");
    log.info("prompt recall served", {
      user_id: userId,
      duration_ms: durationMs,
      skipped,
      records: result.record_ids.length,
      stages_ms: {
        body_read: bodyReadMs,
        ...result.stages_ms,
        ...(eventMs !== undefined ? { recall_event: eventMs } : {}),
      },
      embedding: embeddingForLog(),
      embedding_skipped: result.embedding_skipped ?? false,
      ...(result.embed_deadline_ms !== undefined ? { embed_deadline_ms: result.embed_deadline_ms } : {}),
      ...(result.embedding_breaker ? { embedding_breaker: result.embedding_breaker } : {}),
      ...(result.stage_at_timeout ? { stage_at_timeout: result.stage_at_timeout } : {}),
    });

    return NextResponse.json({
      lines: result.lines,
      record_ids: result.record_ids,
      skipped,
      duration_ms: durationMs,
      ...(result.mode
        ? { mode: result.mode, self_records: result.self_records ?? 0, self_skipped: result.self_skipped ?? null }
        : {}),
    });
  },
);
