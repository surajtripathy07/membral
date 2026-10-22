// Keep-one log rotation for the logs Membral appends to on its own
// (~/.membral/logs/sweep.log, opencode-plugin.log): past 1 MB the file is
// renamed to `<name>.1`, replacing any older `.1`. The opencode plugin
// inlines the same logic (it runs inside opencode and can't import this).
import { renameSync, statSync } from "node:fs";

export const LOG_MAX_BYTES = 1024 * 1024;

/** Returns true when the log was rotated. Never throws. */
export function rotateLogIfLarge(path: string, maxBytes: number = LOG_MAX_BYTES): boolean {
  try {
    if (statSync(path).size <= maxBytes) return false;
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}
