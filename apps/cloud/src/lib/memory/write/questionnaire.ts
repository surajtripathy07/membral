// Session-end questionnaire — persistence (migration 127;
// lib/memory/questionnaire.ts). Every query is scoped by user_id. A failed
// read or write logs and degrades (false / 0): this is a side table and must
// never fail an upload or an extraction run, e.g. before 127 is applied.

import type { Db } from "@/lib/db/types";
import { log } from "@/lib/log";
import { QUESTION_IDS, type QuestionId, type QuestionnaireAnswers } from "../questionnaire";

export interface QuestionnaireWrite {
  sourceSessionId: string;
  codeSessionId: string | null;
  source: "self" | "judge";
  order: readonly QuestionId[];
  answers: QuestionnaireAnswers;
}

/** Upserts one (session, source) row; a later answer replaces the earlier one. True when written. */
export async function upsertQuestionnaire(supabase: Db, userId: string, w: QuestionnaireWrite): Promise<boolean> {
  const { error } = await supabase.from("session_questionnaires").upsert(
    {
      user_id: userId,
      harness: "claude-code",
      source_session_id: w.sourceSessionId,
      code_session_id: w.codeSessionId,
      source: w.source,
      question_order: [...w.order],
      answers: w.answers,
      created_at: new Date().toISOString(),
    },
    { onConflict: "user_id,harness,source_session_id,source" },
  );
  if (error) {
    log.warn("memory: session_questionnaires write failed — skipped", {
      user_id: userId,
      source: w.source,
      err: error.message,
    });
    return false;
  }
  return true;
}

/**
 * Whether a self-report exists for the session. Reads the row's id only, never
 * its answers: the judge must not see them. False on any failure.
 */
export async function hasSelfReport(supabase: Db, userId: string, sourceSessionId: string | null): Promise<boolean> {
  if (!sourceSessionId) return false;
  const { data, error } = await supabase
    .from("session_questionnaires")
    .select("id")
    .eq("user_id", userId)
    .eq("source_session_id", sourceSessionId)
    .eq("source", "self")
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

/** The judge asks the questions in their fixed order. */
export const JUDGE_ORDER: readonly QuestionId[] = QUESTION_IDS;
