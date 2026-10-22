// ~/.membral/import.lock — one bulk import at a time. `membral sessions` and
// `membral sweep` both walk every recent session; two of them at once (the
// opencode plugin's idle trigger racing the launchd sweep) upload the same
// sessions twice and double the server-side extraction queue. The lock is a
// file created with O_EXCL holding `{ pid, started_at }`; it is stale — and
// taken over — after 15 minutes or once its pid is gone. A second run finds
// the lock held and exits 0 ("another import is running"): the holder is
// importing the same window already.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const IMPORT_LOCK_STALE_MS = 15 * 60_000;

export function defaultImportLockPath(): string {
  return join(homedir(), ".membral", "import.lock");
}

interface LockBody {
  pid: number;
  started_at: string;
}

function readLock(path: string): LockBody | null {
  try {
    const body = JSON.parse(readFileSync(path, "utf8")) as Partial<LockBody>;
    if (typeof body.pid !== "number" || typeof body.started_at !== "string") return null;
    return { pid: body.pid, started_at: body.started_at };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(body: LockBody | null, now: number): boolean {
  if (!body) return true; // unreadable/corrupt lock — nobody can own it meaningfully
  const started = Date.parse(body.started_at);
  if (Number.isNaN(started) || now - started > IMPORT_LOCK_STALE_MS) return true;
  return !pidAlive(body.pid);
}

export interface ImportLock {
  release(): void;
}

export interface AcquireImportLockOptions {
  path?: string;
  now?: () => number;
}

/**
 * Takes the import lock, or returns null when another live run holds it.
 * Never throws: a lock that can't be written at all (read-only HOME) lets
 * the run proceed unlocked rather than blocking capture.
 */
export function acquireImportLock(opts: AcquireImportLockOptions = {}): ImportLock | null {
  const path = opts.path ?? defaultImportLockPath();
  const now = opts.now ?? Date.now;
  const body: LockBody = { pid: process.pid, started_at: new Date(now()).toISOString() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(body));
      } finally {
        closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.removeListener("exit", release);
        // Only remove the lock if it is still ours (a stale takeover may have replaced it).
        if (readLock(path)?.pid === process.pid) {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
        }
      };
      process.once("exit", release);
      return { release };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { release: () => {} };
      if (attempt > 0 || !isStale(readLock(path), now())) return null;
      try {
        unlinkSync(path);
      } catch {
        // someone else removed it first — retry the exclusive create
      }
    }
  }
  return null;
}
