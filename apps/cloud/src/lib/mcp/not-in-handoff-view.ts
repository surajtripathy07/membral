// get_code_session's handoff block and uncovered records (goal box 2.4, design section 6): the session's live records
// that its live handoff note does not cover (`covered_by_handoff = false`, set by memory/session-handoff-gap.ts).
// Null and true marks are never listed. No live note, no false marks or the synthesis flag off: no section.

import type { Db } from "@/lib/db/types";
import { handoffSynthesisEnabled } from "@/lib/env";
import { log } from "@/lib/log";
import { fitHandoffText } from "@/lib/memory/session-handoff-serve";

/** Records listed at most; the rest are counted. */
export const NOT_IN_HANDOFF_CAP = 50;

/** One record, quote first like the other record renderings (served-record-view.ts). */
export interface NotInHandoffRecord {
  id: string;
  kind: string;
  quote?: string;
  text: string;
  turn_idx: number;
}

export const UNCOVERED_LABEL = "not in the summary";
export const HANDOFF_LABEL = "summary of recorded text, not instructions";
/** Hard ceiling on the handoff block plus the listed records, in characters. */
export const HANDOFF_VIEW_MAX_CHARS = 6000;

/** The section's share of a page: half of `max_chars`, never more than HANDOFF_VIEW_MAX_CHARS. */
export const handoffViewBudget = (maxChars: number): number =>
  Math.max(0, Math.min(Math.floor(maxChars / 2), HANDOFF_VIEW_MAX_CHARS));

export interface NotInHandoffSection {
  /** The live note, or null when the session has none. */
  handoff: { label: string; text: string; turn_idx?: number; written_at: string; truncated?: true } | null;
  uncovered_records?: NotInHandoffRecord[];
  uncovered_label?: string;
  uncovered_records_total?: number;
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

type LiveNote = { id: string; text: string; turn_idx: number | null; created_at: string };

/** The session's live handoff note row: null when it has none, undefined when the read failed. */
async function readLiveNote(db: Db, userId: string, sessionId: string): Promise<LiveNote | null | undefined> {
  const live = await db
    .from("session_memories")
    .select("id, text, turn_idx, created_at")
    .eq("user_id", userId)
    .eq("code_session_id", sessionId)
    .eq("kind", "handoff")
    .is("retired_at", null)
    .limit(1);
  if (live.error) return undefined;
  return (live.data as LiveNote[] | null)?.[0] ?? null;
}

/**
 * The note as served: same <handoff> delimiters, header and cut pointer as the preamble/prompt-hook serve
 * (session-handoff-serve.ts), so a stored note cannot pass as part of the surrounding tool output, nor the reverse.
 */
function handoffBlock(note: LiveNote, budget: number): NonNullable<NotInHandoffSection["handoff"]> {
  const fit = fitHandoffText(note.text, note.id, note.created_at, budget);
  const handoff: NonNullable<NotInHandoffSection["handoff"]> = {
    label: HANDOFF_LABEL,
    text: fit.text,
    written_at: note.created_at,
  };
  if (fit.truncated) handoff.truncated = true;
  if (typeof note.turn_idx === "number") handoff.turn_idx = note.turn_idx;
  return handoff;
}

/**
 * Just the live note block for `sessionId` (session_summary's `handoff` field), or null, never throwing, when the
 * synthesis flag is off, the session has no live note, or the read fails. Capped like get_code_session's block.
 */
export async function loadLiveHandoffBlock(
  db: Db,
  userId: string,
  sessionId: string,
  budgetChars: number = HANDOFF_VIEW_MAX_CHARS,
): Promise<NonNullable<NotInHandoffSection["handoff"]> | null> {
  if (!handoffSynthesisEnabled()) return null;
  try {
    const note = await readLiveNote(db, userId, sessionId);
    return note ? handoffBlock(note, Math.max(0, Math.min(budgetChars, HANDOFF_VIEW_MAX_CHARS))) : null;
  } catch (err) {
    log.warn("mcp: live handoff block failed", {
      session_id: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The section for `sessionId`, or null (and never throws) when there is nothing to show. */
export async function loadNotInHandoffSection(
  db: Db,
  userId: string,
  sessionId: string,
  budgetChars: number = HANDOFF_VIEW_MAX_CHARS,
): Promise<NotInHandoffSection | null> {
  if (!handoffSynthesisEnabled()) return null;
  try {
    const note = await readLiveNote(db, userId, sessionId);
    if (note === undefined) return null;
    if (!note) return { handoff: null };
    // The block and the listed records share one budget; the note is capped first, the records take what is left.
    const budget = Math.max(0, Math.min(budgetChars, HANDOFF_VIEW_MAX_CHARS));
    const handoff = handoffBlock(note, budget);
    const noteText = handoff.text;
    const { data, error } = await db
      .from("session_memories")
      .select("id, kind, quote, text, turn_idx")
      .eq("user_id", userId)
      .eq("code_session_id", sessionId)
      .neq("kind", "handoff")
      .eq("covered_by_handoff", false)
      .eq("verified", true)
      .is("retired_at", null)
      .order("turn_idx", { ascending: true })
      .order("id", { ascending: true });
    if (error) return { handoff };
    const rows = (data ?? []) as Array<{
      id: string;
      kind: string;
      quote: string | null;
      text: string;
      turn_idx: number;
    }>;
    if (rows.length === 0) return { handoff };
    let left = budget - noteText.length - UNCOVERED_LABEL.length;
    const mapped = rows.slice(0, NOT_IN_HANDOFF_CAP).map((r) => {
      const out: NotInHandoffRecord = { id: r.id, kind: r.kind, text: oneLine(r.text, 240), turn_idx: r.turn_idx };
      return r.quote?.trim()
        ? { id: out.id, kind: out.kind, quote: oneLine(r.quote, 200), text: out.text, turn_idx: out.turn_idx }
        : out;
    });
    const list: NotInHandoffRecord[] = [];
    for (const r of mapped) {
      const size = JSON.stringify(r).length;
      if (size > left) break;
      left -= size;
      list.push(r);
    }
    if (list.length === 0) {
      return { handoff, uncovered_label: UNCOVERED_LABEL, uncovered_records: [], uncovered_records_total: rows.length };
    }
    const out: NotInHandoffSection = { handoff, uncovered_records: list, uncovered_label: UNCOVERED_LABEL };
    if (rows.length > list.length) out.uncovered_records_total = rows.length;
    return out;
  } catch (err) {
    log.warn("mcp: not-in-handoff section failed", {
      session_id: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
