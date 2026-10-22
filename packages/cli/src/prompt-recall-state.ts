// Per-session memory of which records `membral prompt-hook` already injected, so the next prompt of the same Claude
// Code session asks the server for different ones (`exclude_record_ids`) instead of re-injecting what already sits in
// the transcript. One JSON file per session under <dir of hook.log>/hook-state/prompt-recall/. Written only after the
// hook printed; `membral preamble --hook` deletes it when SessionStart's `source` is `compact` or `clear` (the context
// the records lived in is gone).
//
// NON-NEGOTIABLE: best effort. Every read, write, parse and delete error is swallowed and reads as "no state" (the
// behaviour before this file existed); nothing here throws or waits on anything but local disk.
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The server accepts at most this many `exclude_record_ids` (route.ts); a longer history keeps its newest ids. */
export const MAX_EXCLUDE_IDS = 100;
/** A state file untouched this long belongs to a finished session and is deleted on the next write. */
export const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The state directory, beside hook.log (the same `~/.membral` convention as hook-state/agy). */
export function promptRecallStateDir(hookLogPath: string): string {
  return join(dirname(hookLogPath), "hook-state", "prompt-recall");
}

// The session id names a file: anything outside [A-Za-z0-9._-] becomes "_", and a leading dot is replaced so the name
// can be neither hidden nor a path component.
function stateFile(hookLogPath: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return join(promptRecallStateDir(hookLogPath), `${safe}.json`);
}

/** The ids already injected in this session, newest last, at most MAX_EXCLUDE_IDS; [] on any problem. */
export function readInjectedIds(hookLogPath: string, sessionId: string): string[] {
  try {
    const data: unknown = JSON.parse(readFileSync(stateFile(hookLogPath, sessionId), "utf8"));
    if (!data || typeof data !== "object" || !Array.isArray((data as { ids?: unknown }).ids)) return [];
    const ids = (data as { ids: unknown[] }).ids.filter((i): i is string => typeof i === "string" && UUID_RE.test(i));
    return ids.slice(-MAX_EXCLUDE_IDS);
  } catch {
    return [];
  }
}

/** Adds `ids` to the session's file (deduplicated, capped to the newest MAX_EXCLUDE_IDS) and prunes old files. */
export function appendInjectedIds(hookLogPath: string, sessionId: string, ids: readonly string[]): void {
  try {
    const fresh = ids.filter((i) => typeof i === "string" && UUID_RE.test(i));
    if (fresh.length === 0) return;
    const merged = [...new Set([...readInjectedIds(hookLogPath, sessionId), ...fresh])].slice(-MAX_EXCLUDE_IDS);
    mkdirSync(promptRecallStateDir(hookLogPath), { recursive: true });
    writeFileSync(stateFile(hookLogPath, sessionId), JSON.stringify({ ids: merged }), "utf8");
    pruneStateFiles(hookLogPath);
  } catch {
    // never the reason the hook fails
  }
}

/** Deletes the session's file (SessionStart `compact` / `clear`); a missing file is fine. */
export function resetInjectedIds(hookLogPath: string, sessionId: string): void {
  try {
    unlinkSync(stateFile(hookLogPath, sessionId));
  } catch {
    // nothing to reset
  }
}

function pruneStateFiles(hookLogPath: string): void {
  const dir = promptRecallStateDir(hookLogPath);
  try {
    const cutoff = Date.now() - STATE_MAX_AGE_MS;
    for (const name of readdirSync(dir)) {
      try {
        if (statSync(join(dir, name)).mtimeMs < cutoff) unlinkSync(join(dir, name));
      } catch {
        // ignore this entry
      }
    }
  } catch {
    // ignore
  }
}
