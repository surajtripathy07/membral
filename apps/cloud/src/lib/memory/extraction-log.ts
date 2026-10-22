// Goal 2026-09-24 memory-on-prod P7: the ONE structured log line for memory
// extraction on upload — queued sessions, runs, skips (flag, budget, global
// ceiling), failures, and completion (with cost and duration). Emitted through the
// app's single logging sink (lib/log.ts) as one JSON line whose `msg` is
// "[memory-extraction]", so hosted logs can be filtered on that string.
//
// NO RECORD CONTENT, EVER: the output is built from an explicit allowlist of
// fields below — anything else a caller passes (transcript text, memory
// text, prompts) is dropped, even if a cast smuggles it past the type.
// `error` is truncated so a long error message cannot carry a transcript.
import { log } from "@/lib/log";
import type { FirstCharClass } from "./truncated-reply";

export const MEMORY_EXTRACTION_LOG_MSG = "[memory-extraction]";

export type MemoryExtractionEvent =
  | "queued"
  | "run"
  | "skip"
  | "fail"
  | "done"
  | "kick"
  | "invocation"
  | "salvage"
  | "cutoff_shape";

export interface MemoryExtractionLogFields {
  event: MemoryExtractionEvent;
  /** Why a run was skipped or failed — a short code, e.g. "budget_exhausted", "global_daily_ceiling". */
  reason?: string;
  userId: string;
  sessionId?: string;
  sessionCount?: number;
  runId?: string;
  costUsd?: number;
  durationMs?: number;
  recordsWritten?: number;
  /** P10 round 3 R3-m2: records written with no embedding (their embed batch failed after retries). */
  embeddingMissing?: number;
  spentUsd?: number;
  limitUsd?: number | null;
  /** Error message, truncated to ERROR_MAX_CHARS. */
  error?: string;
  /** Issue #339 (windows_failed): main- plus user-pass windows whose LLM call failed. */
  failedWindows?: number;
  /** Issue #339: main-pass windows the session was cut into. */
  windowsTotal?: number;
  /** Issue #339: the first failed window's provider HTTP status (e.g. 429), null when the error carried none. */
  firstFailureStatus?: number | null;
  /** Issue #339: the first failed window's error class (llm-failure.ts, content-free). */
  firstFailureClass?: string;
  /** Issue #339: the first failed window hit the request timeout or was aborted. */
  firstFailureIsTimeout?: boolean;
  /** Issue #339: the queue attempt (1-based) this run was. */
  attempt?: number;
  /** Issue #339 (salvage): the window whose cut-off reply was salvaged. */
  windowIndex?: number;
  /** Issue #339 (salvage): records kept from that cut-off reply. */
  recordsRecovered?: number;
  /** Issue #339 (salvage): the cut-off call's output tokens. */
  tokensOut?: number;
  /** Issue #339 (cutoff_shape): which pass the cut-off window belonged to. */
  pass?: "main" | "user";
  /** Issue #339 (cutoff_shape): structural facts about the cut-off reply. Numbers, booleans and a fixed enum: never text. */
  chars?: number;
  firstCharClass?: FirstCharClass;
  hasRecordsKey?: boolean;
  recordsClosed?: boolean;
  completeElements?: number;
  depthAtCut?: number;
  inStringAtCut?: boolean;
  lastElementChars?: number;
}

const ERROR_MAX_CHARS = 200;

/** Maps each allowed input key to its output key. Nothing outside this map is ever emitted. */
const ALLOWED_FIELDS: Record<Exclude<keyof MemoryExtractionLogFields, "event">, string> = {
  reason: "reason",
  userId: "user_id",
  sessionId: "session_id",
  sessionCount: "session_count",
  runId: "run_id",
  costUsd: "cost_usd",
  durationMs: "duration_ms",
  recordsWritten: "records_written",
  embeddingMissing: "embedding_missing",
  spentUsd: "spent_usd",
  limitUsd: "limit_usd",
  error: "error",
  failedWindows: "failed_windows",
  windowsTotal: "windows_total",
  firstFailureStatus: "first_failure_status",
  firstFailureClass: "first_failure_class",
  firstFailureIsTimeout: "first_failure_is_timeout",
  attempt: "attempt",
  windowIndex: "window_index",
  recordsRecovered: "records_recovered",
  tokensOut: "tokens_out",
  pass: "pass",
  chars: "chars",
  firstCharClass: "first_char_class",
  hasRecordsKey: "has_records_key",
  recordsClosed: "records_closed",
  completeElements: "complete_elements",
  depthAtCut: "depth_at_cut",
  inStringAtCut: "in_string_at_cut",
  lastElementChars: "last_element_chars",
};

/** Builds the logged payload from the allowlist only. Exported for tests. */
export function buildMemoryExtractionLogPayload(fields: MemoryExtractionLogFields): Record<string, unknown> {
  const out: Record<string, unknown> = { event: fields.event };
  for (const [key, outKey] of Object.entries(ALLOWED_FIELDS)) {
    const value = (fields as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "error") {
      out[outKey] = String(value).slice(0, ERROR_MAX_CHARS);
    } else if (typeof value === "number" || typeof value === "string" || typeof value === "boolean" || value === null) {
      out[outKey] = value;
    }
  }
  return out;
}

export function logMemoryExtraction(fields: MemoryExtractionLogFields): void {
  const payload = buildMemoryExtractionLogPayload(fields);
  if (fields.event === "fail") log.error(MEMORY_EXTRACTION_LOG_MSG, payload);
  else log.info(MEMORY_EXTRACTION_LOG_MSG, payload);
}

// "invocation" (issue #339) is the one summary line per extract-next
// invocation: sessionCount = sessions it processed, reason = why it stopped,
// durationMs = elapsed since it started. Never an error message.
//
// "salvage" (issue #339) is one line per window whose reply was cut off at the
// output token limit but kept its complete records: reason "output_truncated",
// the window index, records recovered and tokens out. Never any reply text.
//
// "kick" always carries sessionCount as the pending count at kick time (not
// "how many extracted" — kick never extracts inline), and `reason` only when
// the feature/budget gate refused to fire the trigger.

// "cutoff_shape" (issue #339) is one line per cut-off reply, salvaged or not:
// counts, booleans and a fixed class name describing the reply's structure.
// Never any reply text.
