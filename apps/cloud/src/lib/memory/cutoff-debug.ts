// Issue #339: debugging output for a model reply cut off at the output limit.
//
// Always on: one `cutoff_shape` line of structural facts (counts, booleans, a
// fixed class name), never reply text.
//
// Off by default: the full reply text, for named accounts only, through
// `emitCutoffReplyDebug` below, the only function that can log `debug_text`
// (it is not in extraction-log.ts's allowlist) and it checks the env list itself.

import { cutoffReplyDebugUserIdsRaw } from "@/lib/env";
import { log } from "@/lib/log";
import { logMemoryExtraction, MEMORY_EXTRACTION_LOG_MSG } from "./extraction-log";
import { describeTruncatedReply } from "./truncated-reply";

/** What a cut-off reply leaves behind for the caller to log. */
export interface CutoffReplyInfo {
  /** The raw model reply. Non-enumerable (see `makeCutoffReply`). Only ever logged by `recordCutoffReply`, and then only for opted-in users. */
  readonly rawText: string;
  tokensOut: number;
  /** Records kept from the reply after validation (0 when the window failed). */
  recordsRecovered: number;
}

/**
 * The ONE way to build a `CutoffReplyInfo`. `rawText` is non-enumerable, so
 * spreading, JSON.stringify, Object.keys or logging a window result that
 * carries it can never include the reply text.
 */
export function makeCutoffReply(
  err: { rawText: string; tokensOut: number },
  recordsRecovered: number,
): CutoffReplyInfo {
  const info = { tokensOut: err.tokensOut, recordsRecovered } as CutoffReplyInfo;
  Object.defineProperty(info, "rawText", { value: err.rawText, enumerable: false });
  return info;
}

export const CUTOFF_DEBUG_CHUNK_CHARS = 1500;
export const CUTOFF_DEBUG_MAX_CHARS = 40_000;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses MEMBRAL_DEBUG_CUTOFF_REPLY_USER_IDS: comma-separated user UUIDs, lowercased.
 * Unset, empty or malformed gives an empty set (OFF). There is no wildcard:
 * "*" and "all" are not UUIDs and are ignored, as is every other non-UUID entry.
 */
export function parseCutoffDebugUserIds(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (typeof raw !== "string") return out;
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (UUID_RE.test(id) && id !== NIL_UUID) out.add(id.toLowerCase());
  }
  return out;
}

/** Splits `text` into chunks of at most CUTOFF_DEBUG_CHUNK_CHARS, capped at CUTOFF_DEBUG_MAX_CHARS in total. */
export function chunkCutoffReply(text: string): { chunks: string[]; capped: boolean } {
  const capped = text.length > CUTOFF_DEBUG_MAX_CHARS;
  const body = capped ? text.slice(0, CUTOFF_DEBUG_MAX_CHARS) : text;
  const chunks: string[] = [];
  let i = 0;
  while (i < body.length) {
    let end = Math.min(i + CUTOFF_DEBUG_CHUNK_CHARS, body.length);
    // Do not split a surrogate pair (an emoji) across two log lines.
    const last = body.charCodeAt(end - 1);
    if (end < body.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(body.slice(i, end));
    i = end;
  }
  return { chunks, capped };
}

/**
 * Logs the raw text of a cut-off reply, chunked, for users in
 * MEMBRAL_DEBUG_CUTOFF_REPLY_USER_IDS only. Not exported: the user check lives
 * here, so no caller can log `debug_text` without it.
 */
function emitCutoffReplyDebug(
  ctx: { userId: string; sessionId: string },
  pass: "main" | "user",
  windowIndex: number,
  rawText: string,
): void {
  // MEMBRAL_DEBUG_CUTOFF_REPLY_USER_IDS: comma-separated user UUIDs (no wildcard).
  // What it does: for those users only, logs the FULL raw text of a model reply
  // that was cut off at the output limit, as `cutoff_reply_debug` lines.
  // Warning: that text is model output and can quote the user's transcript.
  // Use: the maintainer's own account, while debugging issue #339 only.
  // Unset it afterwards.
  const optedIn = parseCutoffDebugUserIds(cutoffReplyDebugUserIdsRaw());
  if (!optedIn.has(ctx.userId.toLowerCase())) return;
  const { chunks, capped } = chunkCutoffReply(rawText);
  chunks.forEach((debugText, chunkIndex) => {
    log.info(MEMORY_EXTRACTION_LOG_MSG, {
      event: "cutoff_reply_debug",
      user_id: ctx.userId,
      session_id: ctx.sessionId,
      window_index: windowIndex,
      pass,
      chunk_index: chunkIndex,
      chunk_total: chunks.length,
      chunk_chars: debugText.length,
      capped,
      debug_text: debugText,
    });
  });
}

/**
 * Logs the shape of a cut-off reply (always) and, for opted-in users, its text.
 * Never throws: debugging output must not fail a window.
 */
export function recordCutoffReply(
  ctx: { userId: string; sessionId: string; opts: { attempt?: number } },
  pass: "main" | "user",
  windowIndex: number,
  info: CutoffReplyInfo | undefined,
): void {
  if (!info) return;
  try {
    const shape = describeTruncatedReply(info.rawText, "records");
    logMemoryExtraction({
      event: "cutoff_shape",
      reason: "output_truncated",
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      windowIndex,
      pass,
      tokensOut: info.tokensOut,
      recordsRecovered: info.recordsRecovered,
      attempt: ctx.opts.attempt,
      chars: shape.chars,
      firstCharClass: shape.firstCharClass,
      hasRecordsKey: shape.hasRecordsKey,
      recordsClosed: shape.arrayClosed,
      completeElements: shape.completeElements,
      depthAtCut: shape.depthAtCut,
      inStringAtCut: shape.inStringAtCut,
      lastElementChars: shape.lastElementChars,
    });

    emitCutoffReplyDebug(ctx, pass, windowIndex, info.rawText);
  } catch {
    // Debug logging only.
  }
}
