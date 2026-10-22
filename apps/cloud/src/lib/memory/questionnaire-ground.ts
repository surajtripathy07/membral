// Server-side guard for the questionnaire self-report (review finding: the
// CLI's answers are untrusted text). Two steps before anything is stored:
//   1. an item whose `turn` excerpt is not found in a turn of that session as
//      UPLOADED (same user, same source session id) is discarded;
//   2. the surviving text (line, turn, worked_out) is redacted like the turn
//      text path (redactFileSecrets, then redactPii).
// A session that is not uploaded yet grounds nothing: every item is dropped
// (fail closed). Reads are scoped by user_id.

import { redactFileSecrets, redactPii } from "@membral/core";
import type { Db } from "@/lib/db/types";
import { log } from "@/lib/log";
import { selectAllRows } from "@/lib/util/pagination";
import { quoteMatchesTurnText } from "./normalize";
import { QUESTION_IDS, type QuestionnaireAnswers } from "./questionnaire";

const redact = (s: string): string => redactPii(redactFileSecrets(s));

export interface GroundedSelfReport {
  answers: QuestionnaireAnswers;
  kept: number;
  dropped: number;
}

/** Pure: keeps the items whose turn excerpt appears in one of `turnTexts`, redacted. */
export function groundAndRedact(answers: QuestionnaireAnswers, turnTexts: readonly string[]): GroundedSelfReport {
  const out: QuestionnaireAnswers = { q1: [], q2: [], q3: [], q4: [] };
  let kept = 0;
  let dropped = 0;
  for (const q of QUESTION_IDS) {
    for (const item of answers[q]) {
      if (!turnTexts.some((t) => quoteMatchesTurnText(redactPii(item.turn), t))) {
        dropped++;
        continue;
      }
      kept++;
      out[q].push({
        ...item,
        line: redact(item.line),
        turn: redact(item.turn),
        ...(item.worked_out ? { worked_out: redact(item.worked_out) } : {}),
      });
    }
  }
  return { answers: out, kept, dropped };
}

/** Reads the session's uploaded turn texts and grounds the answers. Read failure drops everything. */
export async function groundSelfReport(
  supabase: Db,
  userId: string,
  sourceSessionId: string,
  answers: QuestionnaireAnswers,
): Promise<GroundedSelfReport> {
  try {
    const { data, error } = await supabase
      .from("code_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("source", "claude-code")
      .eq("source_session_id", sourceSessionId)
      .limit(1);
    const id = !error && Array.isArray(data) ? (data[0] as { id?: string } | undefined)?.id : undefined;
    if (!id) return groundAndRedact(answers, []);
    const rows = (await selectAllRows((from, to) =>
      supabase
        .from("code_session_turns")
        .select("idx, text")
        .eq("session_id", id)
        .eq("user_id", userId)
        .order("idx", { ascending: true })
        .range(from, to),
    )) as Array<{ text: string | null }>;
    return groundAndRedact(answers, rows.map((r) => r.text ?? "").filter(Boolean));
  } catch (err) {
    log.warn("memory: questionnaire grounding read failed — answers dropped", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return groundAndRedact(answers, []);
  }
}
