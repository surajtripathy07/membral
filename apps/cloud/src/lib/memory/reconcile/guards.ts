// L1: the refusals the backfill tool applies before it reads, calls a model or writes. Pure; each returns a reason to
// refuse with, or null when the check passes.

type Env = Record<string, string | undefined>;

export const DUMP_MAX_AGE_MS = 2 * 60 * 60_000;

/** Local claude-code provider only, never hosted, never an API key; the model defaults to (and must be) sonnet. */
export function providerProblem(env: Env, noLlm: boolean): string | null {
  if (env.VERCEL) return "reconciliation never runs on hosted (D-072)";
  if (noLlm) return null;
  if (env.MEMBRAL_LLM_PROVIDER?.trim() !== "claude-code")
    return "MEMBRAL_LLM_PROVIDER must be exactly claude-code (an unset provider would fall through to a paid API key)";
  const model = env.MEMBRAL_MODEL?.trim() || "sonnet";
  if (model !== "sonnet") return `MEMBRAL_MODEL must be sonnet for this pass (got ${model})`;
  return null;
}

export function isLoopbackHostPort(hostPort: string | null | undefined): boolean {
  if (!hostPort) return false;
  const host = hostPort.startsWith("[") ? hostPort.slice(1, hostPort.indexOf("]")) : hostPort.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** The client's Supabase host:port must be the expected one AND loopback. */
export function storeProblem(envHostPort: string | null, expected: string | undefined): string | null {
  if (!envHostPort || !expected?.trim() || envHostPort !== expected.trim())
    return `the Supabase host:port (${envHostPort ?? "unset"}) is not MEMBRAL_BENCH_EXPECTED_SUPABASE_HOST (${expected ?? "unset"})`;
  if (!isLoopbackHostPort(envHostPort)) return `${envHostPort} is not a loopback address`;
  return null;
}

/** Compose names the stack's containers `<project>-db-1` / `<project>-kicker-1`. */
export function kickerContainerFor(dbContainer: string): string {
  return dbContainer.replace(/-db-1$/, "-kicker-1");
}

export function kickerProblem(runningNames: readonly string[], dbContainer: string): string | null {
  const kicker = kickerContainerFor(dbContainer);
  return runningNames.includes(kicker) ? `${kicker} is running; stop it before an apply` : null;
}

/** The two live-row counts (API vs the container's psql) must agree: the writer and the dump are one store. */
export function sameStoreProblem(apiLive: number | null, psqlLive: number): string | null {
  return apiLive === psqlLive ? null : `the API sees ${apiLive ?? "?"} live rows, the db container ${psqlLive}`;
}

export interface DumpFacts {
  mtimeMs: number;
  nowMs: number;
  /** Last bytes of the (decompressed) dump. */
  tail: string;
  /** The dump mentions the run's user id (it was taken from this store). */
  containsUser: boolean;
}

/**
 * A complete dump ends (ignoring trailing whitespace) with `RESET ALL;` (supabase dump) or with pg_dump's
 * `\unrestrict <token>` line (plain pg_dump 17.x). A cut-off dump ends mid-statement and matches neither.
 */
export function dumpEndsComplete(tail: string): boolean {
  const t = tail.trimEnd();
  if (t.endsWith("RESET ALL;")) return true;
  const lastLine = t.split("\n").pop() ?? "";
  return /^\\unrestrict [A-Za-z0-9]+$/.test(lastLine.trim());
}

export function dumpProblem(d: DumpFacts, maxAgeMs = DUMP_MAX_AGE_MS): string | null {
  if (d.nowMs - d.mtimeMs > maxAgeMs) return `the dump is older than ${Math.round(maxAgeMs / 60_000)} minutes`;
  if (!dumpEndsComplete(d.tail)) return "the dump does not end with RESET ALL; or a pg_dump \\unrestrict line";
  if (!d.containsUser) return "the dump does not contain this user (taken from another store?)";
  return null;
}
