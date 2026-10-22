// Membral on Membral — persistence (migration 125; lib/memory/feedback.ts).
// Reads the records served into a session from memory_recall_events, and
// writes session_feedback and served_record_verdicts. Every query is scoped by
// user_id. A failed read or write logs and degrades (no served records, 0
// written): this is a side table, and it must never fail an extraction run,
// e.g. on a database where migration 125 is not applied yet.

import type { Db } from "@/lib/db/types";
import { log } from "@/lib/log";
import { type GroundedFeedback, SERVE_SURFACES, type ServedRecord, type ServedRecordVerdict } from "../feedback";

/** At most this many recall events are read per session (served_at ascending). */
export const SERVED_EVENTS_SCAN_LIMIT = 500;
/** PostgREST 414s on long `.in()` lists past ~200 uuids (#277). */
const IN_CHUNK_SIZE = 100;

type EventRow = { id: string; tool: string; surface: string | null; record_ids: string[] | null; served_at: string };
type MemoryRow = { id: string; kind: string; text: string; quote: string | null; code_session_id: string };

function isSurface(s: string | null): s is ServedRecord["surface"] {
  return (SERVE_SURFACES as readonly string[]).includes(s ?? "");
}

/**
 * The distinct records served into this session, first served first: recall
 * events of this user whose code_session_id is the session or whose
 * harness_session_id is its source_session_id (influence.ts links MCP events
 * to the session at import, before extraction runs). session_summary events
 * are skipped (their code_session_id is the summarised session, not where the
 * summary was served), and so are records this session itself extracted
 * (continuation self-recall serves those; judging them adds nothing).
 */
export async function fetchServedRecords(
  supabase: Db,
  userId: string,
  sessionId: string,
  sourceSessionId: string | null,
): Promise<ServedRecord[]> {
  try {
    const cols = "id, tool, surface, record_ids, served_at";
    const reads = [
      supabase
        .from("memory_recall_events")
        .select(cols)
        .eq("user_id", userId)
        .eq("code_session_id", sessionId)
        .order("served_at", { ascending: true })
        .limit(SERVED_EVENTS_SCAN_LIMIT),
    ];
    if (sourceSessionId) {
      reads.push(
        supabase
          .from("memory_recall_events")
          .select(cols)
          .eq("user_id", userId)
          .eq("harness_session_id", sourceSessionId)
          .order("served_at", { ascending: true })
          .limit(SERVED_EVENTS_SCAN_LIMIT),
      );
    }
    const byId = new Map<string, EventRow>();
    for (const { data, error } of await Promise.all(reads)) {
      if (error) throw new Error(error.message);
      for (const e of (data ?? []) as EventRow[]) byId.set(e.id, e);
    }
    const events = [...byId.values()]
      .filter((e) => e.tool !== "session_summary" && isSurface(e.surface))
      .sort((a, b) => (a.served_at === b.served_at ? (a.id < b.id ? -1 : 1) : a.served_at < b.served_at ? -1 : 1));
    const firstServe = new Map<string, { eventId: string; surface: ServedRecord["surface"] }>();
    for (const e of events) {
      for (const rid of e.record_ids ?? []) {
        if (!firstServe.has(rid)) firstServe.set(rid, { eventId: e.id, surface: e.surface as ServedRecord["surface"] });
      }
    }
    if (firstServe.size === 0) return [];
    const ids = [...firstServe.keys()];
    const rows = new Map<string, MemoryRow>();
    for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
      const { data, error } = await supabase
        .from("session_memories")
        .select("id, kind, text, quote, code_session_id")
        .eq("user_id", userId)
        .in("id", ids.slice(i, i + IN_CHUNK_SIZE));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as MemoryRow[]) rows.set(r.id, r);
    }
    const out: ServedRecord[] = [];
    for (const [rid, serve] of firstServe) {
      const r = rows.get(rid);
      if (!r || r.code_session_id === sessionId) continue;
      out.push({
        memoryId: r.id,
        recallEventId: serve.eventId,
        surface: serve.surface,
        kind: r.kind,
        text: r.text,
        quote: r.quote,
      });
    }
    return out;
  } catch (err) {
    log.warn("memory: served-record lookup failed — no verdicts this run", {
      user_id: userId,
      session_id: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Stores this run's grounded feedback (idempotent on content_hash). Returns rows offered, 0 on failure. */
export async function insertSessionFeedback(
  supabase: Db,
  userId: string,
  codeProjectId: string,
  sessionId: string,
  items: readonly GroundedFeedback[],
  promptVersion: string,
): Promise<number> {
  if (items.length === 0) return 0;
  const rows = items.map((f) => ({
    user_id: userId,
    code_session_id: sessionId,
    code_project_id: codeProjectId,
    about: "membral",
    sentiment: f.sentiment,
    surface: f.surface,
    text: f.text,
    quote: f.quote,
    turn_idx: f.turn_idx,
    turn_role: f.turn_role,
    prompt_version: promptVersion,
    content_hash: f.contentHash,
  }));
  const { error } = await supabase
    .from("session_feedback")
    .upsert(rows, { onConflict: "user_id,code_session_id,content_hash", ignoreDuplicates: true });
  if (error) {
    log.warn("memory: session_feedback write failed — skipped", {
      user_id: userId,
      session_id: sessionId,
      err: error.message,
    });
    return 0;
  }
  return rows.length;
}

/**
 * Upserts one verdict per served record for this session: a later run's
 * verdict replaces the earlier one (the session has grown since). Returns
 * rows written, 0 on failure.
 */
export async function upsertServedVerdicts(
  supabase: Db,
  userId: string,
  sessionId: string,
  verdicts: readonly ServedRecordVerdict[],
  promptVersion: string,
  nowIso: string,
): Promise<number> {
  if (verdicts.length === 0) return 0;
  const rows = verdicts.map((v) => ({
    user_id: userId,
    code_session_id: sessionId,
    memory_id: v.memoryId,
    recall_event_id: v.recallEventId,
    surface: v.surface,
    verdict: v.verdict,
    quote: v.quote,
    turn_idx: v.turn_idx,
    prompt_version: promptVersion,
    updated_at: nowIso,
  }));
  const { error } = await supabase
    .from("served_record_verdicts")
    .upsert(rows, { onConflict: "user_id,code_session_id,memory_id" });
  if (error) {
    log.warn("memory: served_record_verdicts write failed — skipped", {
      user_id: userId,
      session_id: sessionId,
      err: error.message,
    });
    return 0;
  }
  return rows.length;
}
