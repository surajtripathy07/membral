// Postgres memory sizing and post-start prewarm for `membral local up`.
// The stock db container runs with 128 MB shared_buffers, which makes scoped
// raw-unit search time out on stores with tens of GB of sessions. `up` reads
// the Docker VM's memory and appends sizing flags to the db command; after a
// successful start it fires a detached pg_prewarm of the excerpts table.
import type { DockerRunner } from "./docker-runner.js";

const MB = 1024 * 1024;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** `docker info --format '{{.MemTotal}}'` output -> bytes; null on anything but a positive integer. */
export function parseMemTotal(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Extra `postgres -c` flags for a Docker VM of `memTotalBytes`; empty when the size is unknown. */
export function pgTuneArgs(memTotalBytes: number | null | undefined): string[] {
  if (memTotalBytes == null || !Number.isFinite(memTotalBytes) || memTotalBytes <= 0) return [];
  const mb = memTotalBytes / MB;
  const shared = Math.floor(clamp(mb * 0.25, 128, 4096));
  const cache = Math.floor(clamp(mb * 0.65, 512, 12288));
  return ["-c", `shared_buffers=${shared}MB`, "-c", `effective_cache_size=${cache}MB`, "-c", "random_page_cost=1.1"];
}

/** Docker's total memory in bytes (same endpoint as every other runner call); null when unreadable. */
export async function readDockerMemTotal(runner: DockerRunner): Promise<number | null> {
  try {
    const r = await runner.run(["info", "--format", "{{.MemTotal}}"]);
    return r.code === 0 ? parseMemTotal(r.stdout) : null;
  } catch {
    return null;
  }
}

export const PREWARM_SQL =
  "create extension if not exists pg_prewarm; " +
  "select pg_prewarm('public.session_raw_units','buffer'); " +
  "select pg_prewarm(i.indexrelid::regclass, " +
  "case when i.indexrelid='public.idx_session_raw_units_embedding'::regclass then 'read' else 'buffer' end) " +
  "from pg_index i where i.indrelid='public.session_raw_units'::regclass;";

/**
 * Fire a detached prewarm in the db container (`exec -d`, so it returns at once and
 * keeps running). `composeExecPrefix` is the compose args up to and including `exec`
 * (e.g. composeArgs(paths, "exec")). Never throws; returns a dim line to print on
 * failure, else null.
 */
export async function prewarmExcerpts(
  runner: DockerRunner,
  composeArgv: (...a: string[]) => string[],
): Promise<string | null> {
  const script = 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h localhost -U postgres -d postgres -q -At -c "$1"';
  try {
    const r = await runner.run(composeArgv("exec", "-d", "-T", "db", "sh", "-c", script, "psql", PREWARM_SQL));
    return r.code === 0 ? null : "  Prewarm skipped (could not start pg_prewarm in the db container)";
  } catch {
    return "  Prewarm skipped (could not start pg_prewarm in the db container)";
  }
}
