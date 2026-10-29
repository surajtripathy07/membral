// Gap diff for a synthesized handoff note (docs/design/2026-10-25_agent-authored-handoff.md section 6, box 2.4).
//
// After the note is stored, mark each verified, live, non-handoff record of the session: `covered_by_handoff` true when
// the note carries it, false when it does not, null when that cannot be told. For a synthesized note this measures the
// summariser's compression loss ("not in the handoff note"), not an agent's omissions.
//
// Method: a record whose text the note renders verbatim (the no-model fallback lists record text) is covered with no
// embedding. Every other record is covered when its stored embedding has cosine >= the family's `semantic_dedup` cut to
// some note segment (a structural split on newline and bullet). No calibrated cut for the store's embedding family, a
// failed or missing embeddings backend: no diff at all, every mark cleared to null (never "everything uncovered").
// At most HANDOFF_GAP_MAX_SEGMENTS segment embeddings, one call, no chat call. Never throws.

import type { Db } from "@/lib/db/types";
import { cosineSimilarityReadonly } from "@/lib/domain/similarity";
import type { LlmClient } from "@/lib/llm/client";
import { canonicalEmbeddingFamily, currentEmbeddingFamily, DEFAULT_EMBEDDING_FAMILY } from "@/lib/llm/embedding-client";
import { vectorThreshold } from "@/lib/llm/embedding-family";
import { log } from "@/lib/log";
import { selectAllRows } from "@/lib/util/pagination";

/** Segment embeddings per note. Hosted embeddings sit outside the LLM ceilings (#363), so this is the cost bound. */
export const HANDOFF_GAP_MAX_SEGMENTS = 40;
/** Ids per `.in()` filter, so a long session does not overrun the request URL. */
const UPDATE_CHUNK = 100;

export type HandoffGapStatus =
  /** Marks written. */
  | "marked"
  /** No diff: the reason is in `reason`; every mark was cleared to null. */
  | "skipped";

export interface HandoffGapResult {
  status: HandoffGapStatus;
  reason?:
    | "uncalibrated_family"
    | "embeddings_unavailable"
    | "no_records"
    | "run_stopped"
    | "budget_exhausted"
    | "failed";
  covered: number;
  uncovered: number;
  /** Records left null: no stored embedding of the current family. */
  unknown: number;
  segments: number;
  segmentsTruncated: boolean;
  /** Embedding spend, from the embed call's cost record. */
  costUsd: number;
}

export interface HandoffGapDeps {
  supabase: Db;
  llm: Partial<Pick<LlmClient, "embedMany" | "embedFamily">>;
  /** The run's stop callback: once it fires, no embedding call is made. */
  shouldStop?: () => boolean;
  /** What is left of the session budget, in USD: no embedding call at or below 0. */
  remainingBudgetUsd?: number;
}

export interface HandoffGapNote {
  text: string;
  /** Records the note renders verbatim (plain fallback). Covered without an embedding. */
  renderedRecordIds: ReadonlySet<string>;
}

/** The note's segments: one per non-blank line, bullet marker stripped, section headings (`Heading:` alone) dropped. */
export function handoffSegments(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[-*•]\s+/.test(line);
    const body = line.replace(/^[-*•]\s+/, "").trim();
    if (!bullet && body.endsWith(":")) continue;
    if (body) out.push(body);
  }
  return out;
}

interface GapRecord {
  id: string;
  embedding: string | number[] | null;
  embedding_model: string | null;
}

function parseVector(raw: GapRecord["embedding"]): number[] | null {
  try {
    const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    return Array.isArray(v) && v.every((n) => typeof n === "number") ? (v as number[]) : null;
  } catch {
    return null;
  }
}

async function writeMarks(db: Db, userId: string, sessionId: string, ids: string[], value: boolean | null) {
  for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
    const { error } = await db
      .from("session_memories")
      .update({ covered_by_handoff: value })
      .eq("user_id", userId)
      .eq("code_session_id", sessionId)
      .neq("kind", "handoff")
      .in("id", ids.slice(i, i + UPDATE_CHUNK));
    if (error) throw new Error(`gap marks failed: ${error.message}`);
  }
}

async function clearMarks(db: Db, userId: string, sessionId: string): Promise<void> {
  const { error } = await db
    .from("session_memories")
    .update({ covered_by_handoff: null })
    .eq("user_id", userId)
    .eq("code_session_id", sessionId)
    .neq("kind", "handoff");
  if (error) throw new Error(`gap clear failed: ${error.message}`);
}

const empty = (over: Partial<HandoffGapResult>): HandoffGapResult => ({
  status: "skipped",
  covered: 0,
  uncovered: 0,
  unknown: 0,
  segments: 0,
  segmentsTruncated: false,
  costUsd: 0,
  ...over,
});

/**
 * Computes and stores `covered_by_handoff` for the session's records against the just-stored `note`. Never throws.
 * The caller gates it on handoffSynthesisEnabled().
 */
export async function markHandoffGaps(
  deps: HandoffGapDeps,
  userId: string,
  sessionId: string,
  note: HandoffGapNote,
): Promise<HandoffGapResult> {
  const db = deps.supabase;
  let costUsd = 0;
  try {
    const family = deps.llm.embedFamily ?? currentEmbeddingFamily();
    const cut = vectorThreshold("semantic_dedup", family);
    const skip = async (reason: NonNullable<HandoffGapResult["reason"]>) => {
      await clearMarks(db, userId, sessionId);
      log.info("memory: handoff gap diff skipped", { session_id: sessionId, reason, family });
      return empty({ reason, costUsd });
    };
    if (cut === null) return await skip("uncalibrated_family");

    const records = await selectAllRows<GapRecord>((from, to) =>
      db
        .from("session_memories")
        .select("id, embedding, embedding_model")
        .eq("user_id", userId)
        .eq("code_session_id", sessionId)
        .neq("kind", "handoff")
        .eq("verified", true)
        .is("retired_at", null)
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (records.length === 0) return await skip("no_records");

    const covered = new Set<string>();
    const uncovered: string[] = [];
    const unknown: string[] = [];
    // Records the note does not carry verbatim, with a vector of the current family: the only ones that can be compared.
    const want = canonicalEmbeddingFamily(family);
    const usable: Array<{ id: string; v: number[] }> = [];
    for (const r of records) {
      if (note.renderedRecordIds.has(r.id)) {
        covered.add(r.id);
        continue;
      }
      const rowFamily = r.embedding_model ? canonicalEmbeddingFamily(r.embedding_model) : DEFAULT_EMBEDDING_FAMILY;
      const v = rowFamily === want && r.embedding ? parseVector(r.embedding) : null;
      if (v) usable.push({ id: r.id, v });
      else unknown.push(r.id);
    }

    const all = handoffSegments(note.text);
    const segmentsTruncated = all.length > HANDOFF_GAP_MAX_SEGMENTS;
    const segments = all.slice(0, HANDOFF_GAP_MAX_SEGMENTS);

    if (usable.length > 0) {
      if (!deps.llm.embedMany || segments.length === 0) return await skip("embeddings_unavailable");
      if (deps.shouldStop?.()) return await skip("run_stopped");
      if (deps.remainingBudgetUsd !== undefined && deps.remainingBudgetUsd <= 0) return await skip("budget_exhausted");
      let vectors: number[][];
      try {
        const res = await deps.llm.embedMany({
          texts: segments,
          pass: "memory_embedding",
          conversationId: `handoff-gap:${sessionId}`,
        });
        vectors = res.vectors;
        costUsd += Number.isFinite(res.record?.cost_usd) ? res.record.cost_usd : 0;
      } catch (err) {
        log.warn("memory: handoff gap embeddings failed", {
          session_id: sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
        return await skip("embeddings_unavailable");
      }
      for (const { id, v } of usable) {
        if (vectors.some((s) => cosineSimilarityReadonly(v, s) >= cut)) covered.add(id);
        else uncovered.push(id);
      }
    }

    // No clear-first, so there is never an all-null window. One group per write: uncovered (false) first, then covered
    // (true), then unknown (null). A failure after a write leaves earlier marks in place and later groups at their
    // previous values; no write ever marks a covered record false.
    await writeMarks(db, userId, sessionId, uncovered, false);
    await writeMarks(db, userId, sessionId, [...covered], true);
    await writeMarks(db, userId, sessionId, unknown, null);
    return {
      status: "marked",
      covered: covered.size,
      uncovered: uncovered.length,
      unknown: unknown.length,
      segments: segments.length,
      segmentsTruncated,
      costUsd,
    };
  } catch (err) {
    log.warn("memory: handoff gap diff failed", {
      session_id: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return empty({ reason: "failed", costUsd });
  }
}
