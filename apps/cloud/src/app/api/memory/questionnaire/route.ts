// POST /api/memory/questionnaire — the session-end self-report (goal
// 2026-10-10 recall precision, §W3b; lib/memory/questionnaire.ts).
//   { session, harness?: "claude-code", order: ["q3","q1",…], answers: {q1:[…],…} }
//   -> { stored: true, items: N } (items without a turn pointer, or whose
//   pointer is not in the uploaded session, are dropped; kept text is redacted)
// An answers object that is not the expected shape stores nothing (422). The
// row is stored as source 'self'; only the agreement read uses it.
//
// AUTH: Bearer Supabase JWT or an UNSCOPED Bearer lls_ key, same as the
// code-sessions write surface (CODE_SESSIONS_WRITE_AUTH). An older server has
// no such route; the CLI treats its 404 as "not stored" and says nothing.
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { CODE_SESSIONS_WRITE_AUTH, getCodeSessionsServiceClient } from "@/lib/code-sessions/auth";
import { readTextBodyWithLimit } from "@/lib/http-body";
import { log, requestId } from "@/lib/log";
import { parseQuestionnaireAnswers, QuestionnairePostSchema } from "@/lib/memory/questionnaire";
import { groundSelfReport } from "@/lib/memory/questionnaire-ground";
import { upsertQuestionnaire } from "@/lib/memory/write";
import { userBucket } from "@/lib/rate-limit";

const ROUTE = "/api/memory/questionnaire";
const MAX_BODY_BYTES = 256 * 1024;

export const POST = withRoute(
  {
    auth: CODE_SESSIONS_WRITE_AUTH,
    rateLimit: { name: "codeSessions", bucket: ({ userId }) => userBucket("memoryQuestionnaire", userId) },
  },
  async ({ req, userId }) => {
    const rlog = log.withContext({ request_id: requestId(req), route: ROUTE });
    let json: unknown;
    try {
      const result = await readTextBodyWithLimit(req.body, MAX_BODY_BYTES);
      if ("tooLarge" in result) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
      json = JSON.parse(result.text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = QuestionnairePostSchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "Invalid questionnaire" }, { status: 400 });
    const answers = parseQuestionnaireAnswers(parsed.data.answers);
    if (!answers) return NextResponse.json({ error: "Malformed answers" }, { status: 422 });
    // Untrusted text: keep only items whose turn excerpt is in the uploaded session, and redact what is kept.
    const supabase = getCodeSessionsServiceClient();
    const grounded = await groundSelfReport(supabase, userId, parsed.data.session, answers);
    const items = grounded.kept;
    const stored = await upsertQuestionnaire(supabase, userId, {
      sourceSessionId: parsed.data.session,
      codeSessionId: null,
      source: "self",
      order: parsed.data.order,
      answers: grounded.answers,
    });
    if (!stored) {
      rlog.error("questionnaire write failed", { user_id: userId });
      return NextResponse.json({ error: "questionnaire write failed" }, { status: 500 });
    }
    return NextResponse.json({ stored: true, items });
  },
);
