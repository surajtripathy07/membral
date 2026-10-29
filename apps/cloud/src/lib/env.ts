// Environment validation (issue #12).
//
// Two layers, deliberately separate:
//  - `getEnv()` — per-call fail-fast for the three vars every server-side
//    Supabase client needs. Unchanged behaviour (throws immediately, names
//    the missing var) so every existing caller/test keeps working.
//  - `validateEnvAtBoot()` — a startup-time gate wired from
//    `instrumentation.ts`'s `register()` hook. It only enforces in
//    production (`NODE_ENV=production`, i.e. a real `next start` — Vercel's
//    build step does not invoke `register()`, only the running server does)
//    and reports EVERY missing required var in one error, not one at a time,
//    so a broken deploy fails at boot with a complete list instead of
//    surfacing them one crash at a time as each code path is first hit.
//
// Required in production: the three Supabase vars above, plus
// NEXT_PUBLIC_APP_URL (the canonical public URL — see getAppUrl() below).
//
// Everything else (OPENAI_API_KEY,
// NEXT_PUBLIC_MCP_URL, MEMBRAL_FEATURE_ALLOWLIST, CRON_SECRET) is
// optional — each has a documented degraded behaviour when absent (see
// apps/cloud/.env.example, which documents every one of these vars by name —
// round-5 verification HIGH 3: CRON_SECRET used to be the one exception,
// referenced here but genuinely absent from .env.example) rather than a hard
// requirement, because none of them block the app from booting or serving
// auth/sync, the product's floor.
// CRON_SECRET (issue #132, ADR 0049) is what GET /api/internal/cron/advance
// checks its Authorization header against; Vercel sends it automatically as
// `Authorization: Bearer $CRON_SECRET` on every cron-triggered request once
// the env var is set (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
// Left unset, that route degrades to refusing every request with 503 — a
// safe "the daily fan-out simply doesn't run" rather than an open endpoint
// (see cronSecret() below). See docs/DEPLOY.md's env table + cron paragraph
// for the operator-facing walkthrough, including the one-line curl check to
// confirm it's wired up before relying on the cron as a safety net.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getEnv() {
  return {
    supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseAnonKey: requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

// Vars a production boot cannot run without. NEXT_PUBLIC_APP_URL is new here
// (issue #12) — see getAppUrl().
const REQUIRED_IN_PRODUCTION = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_APP_URL",
] as const;

/** Names of required-in-production vars that are currently unset/blank. */
export function findMissingRequiredEnvVars(): string[] {
  return REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name]?.trim());
}

/**
 * #134 adversarial review round 1, minor m4: `findMissingRequiredEnvVars()`
 * only checks presence, not shape. A `NEXT_PUBLIC_APP_URL` set without a
 * scheme (e.g. "membral.me" instead of "https://membral.me") used to only
 * fail once something called `new URL()` on a value built from it — which,
 * before this review round, was `/auth/callback`'s redirect on every single
 * OAuth sign-in (the one route a user cannot retry past). That call site is
 * now `request.url`-relative instead (see route.ts's `redirectTo()`), but
 * this still validates the var's shape at boot so a misconfigured deploy
 * fails loudly at startup rather than quietly emitting broken links
 * elsewhere (e.g. `getAppUrl()`-built confirmation-email URLs).
 */
function findMalformedEnvVars(): string[] {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) return [];
  try {
    new URL(appUrl);
    return [];
  } catch {
    return [
      `NEXT_PUBLIC_APP_URL ("${appUrl}" is not a valid absolute URL — include the scheme, e.g. https://membral.me)`,
    ];
  }
}

/**
 * Boot-time gate — call once from instrumentation.ts's `register()`. No-op
 * outside production (local dev and CI/test commonly run with a subset of
 * vars set, or unset entirely; `getEnv()`'s per-call check already protects
 * those code paths when they're actually exercised).
 */
export function validateEnvAtBoot(): void {
  if (process.env.NODE_ENV !== "production") return;
  const missing = findMissingRequiredEnvVars();
  const malformed = findMalformedEnvVars();
  if (missing.length === 0 && malformed.length === 0) return;
  const problems = [...missing, ...malformed];
  throw new Error(
    `Membral cloud cannot start: missing/invalid required environment variable(s): ${problems.join(", ")}. ` +
      "See apps/cloud/.env.example and docs/DEPLOY.md.",
  );
}

/**
 * The app's own canonical public URL (issue #12) — replaces the scattered
 * `http://localhost:3000` fallbacks that used to be hand-rolled at each call
 * site. Required in production (see REQUIRED_IN_PRODUCTION above); falls
 * back to the local dev server outside production so `npm run dev` keeps
 * working with zero setup. Trailing slash stripped so callers can always do
 * `${getAppUrl()}/path` without a doubled slash.
 */
export function getAppUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  // Not required outside production — see REQUIRED_IN_PRODUCTION. In
  // production this fallback is a last-resort guard only (validateEnvAtBoot
  // should already have refused to boot); membral.me is the one production
  // domain this product has ever targeted (see docs/DEPLOY.md).
  return process.env.NODE_ENV === "production" ? "https://membral.me" : "http://localhost:3000";
}

/**
 * Emergency signup kill-switch (issue #127). Reads `MEMBRAL_SIGNUPS_DISABLED`
 * at call time (not cached) so an operator toggling it in the deployment
 * platform takes effect on the next request, no redeploy needed. Accepts
 * "1" or "true" (case-insensitive); anything else (including unset/blank)
 * means signups stay open — matches the rest of this file's fail-open
 * posture for optional vars.
 */
export function signupsDisabled(): boolean {
  const raw = process.env.MEMBRAL_SIGNUPS_DISABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * True on a local run (MEMBRAL_LOCAL=1 and not on Vercel). Same rule as
 * lib/llm/embedding-family.ts. Anything else is the hosted deployment, where
 * sign-up is closed whatever MEMBRAL_SIGNUPS_DISABLED says (D-081).
 */
export function isLocalRuntime(): boolean {
  return process.env.MEMBRAL_LOCAL?.trim() === "1" && !process.env.VERCEL;
}

/**
 * The daily cron fan-out's shared secret (issue #132, ADR 0049) — see the
 * header comment above. `undefined` (unset/blank) means GET
 * /api/internal/cron/advance refuses every request with 503; a trimmed
 * empty string never counts as "configured".
 */
export function cronSecret(): string | undefined {
  const raw = process.env.CRON_SECRET?.trim();
  return raw ? raw : undefined;
}

/**
 * Raw MEMBRAL_DEBUG_CUTOFF_REPLY_USER_IDS (issue #339), read at call time.
 * Parsed and explained in memory/cutoff-debug.ts: it logs model output for
 * the named users, so leave it unset except while debugging.
 */
export function cutoffReplyDebugUserIdsRaw(): string | undefined {
  return process.env.MEMBRAL_DEBUG_CUTOFF_REPLY_USER_IDS;
}

/**
 * Opt-in for the extended MCP tools (`get_code_project`, `get_code_context_for`,
 * `membral_correct`). Read at call time; "1" or "true" turns them on, anything
 * else (unset, blank) leaves the default, smaller tool surface.
 */
export function mcpExtendedToolsEnabled(): boolean {
  const raw = process.env.MEMBRAL_MCP_EXTENDED_TOOLS?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

// ---- Server env accessors (R5 G1/G4). Each reads process.env at CALL time so
// per-test env changes and runtime toggles keep working. Raw values, no
// trimming or defaulting beyond what each caller already did.

/** The name of the service-role key env var, for messages and prompt text that must name it byte-for-byte. */
export const SERVICE_ROLE_KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY";

/** Raw SUPABASE_SERVICE_ROLE_KEY (the service secret), or undefined. */
export function supabaseServiceRoleKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

/** SUPABASE_INTERNAL_URL trimmed (container-network Supabase URL), or undefined when unset. */
export function supabaseInternalUrl(): string | undefined {
  return process.env.SUPABASE_INTERNAL_URL?.trim();
}

/** True when MEMBRAL_POSTGREST_DIRECT=1: SUPABASE_INTERNAL_URL is bare PostgREST (local stack), not a Supabase gateway. */
export function postgrestDirect(): boolean {
  return process.env.MEMBRAL_POSTGREST_DIRECT?.trim() === "1";
}

/** SUPABASE_JWT_SECRET (local auth stub signing key), or undefined when unset or empty. */
export function supabaseJwtSecret(): string | undefined {
  return process.env.SUPABASE_JWT_SECRET || undefined;
}

/** PORT the app listens on, or undefined when unset or empty. */
export function appPort(): string | undefined {
  return process.env.PORT || undefined;
}

/** MEMBRAL_STORE trimmed ("pglite" selects the embedded store), or undefined when unset. */
export function storeKind(): string | undefined {
  return process.env.MEMBRAL_STORE?.trim() || undefined;
}

/** MEMBRAL_PGDATA: the embedded store's data directory ("memory://" for an in-memory store in tests), or undefined. */
export function pgDataDir(): string | undefined {
  return process.env.MEMBRAL_PGDATA?.trim() || undefined;
}

/** MEMBRAL_MIGRATIONS_DIR: where the embedded store reads migrations from, or undefined (boot falls back to ./supabase/migrations). */
export function migrationsDir(): string | undefined {
  return process.env.MEMBRAL_MIGRATIONS_DIR?.trim() || undefined;
}

/** MEMBRAL_PRELUDE_PATH: the auth-prelude.sql file, or undefined (boot looks beside the migrations dir at ../local). */
export function preludePath(): string | undefined {
  return process.env.MEMBRAL_PRELUDE_PATH?.trim() || undefined;
}

/** Raw MEMBRAL_FEATURE_ALLOWLIST, or undefined. */
export function featureAllowlistRaw(): string | undefined {
  return process.env.MEMBRAL_FEATURE_ALLOWLIST;
}

/** Raw MEMBRAL_LLM_DEFAULT_DAILY_USD, or undefined. */
export function llmDefaultDailyUsdRaw(): string | undefined {
  return process.env.MEMBRAL_LLM_DEFAULT_DAILY_USD;
}

/** Raw MEMBRAL_SESSION_ASSOC, or undefined. */
export function sessionAssocRaw(): string | undefined {
  return process.env.MEMBRAL_SESSION_ASSOC;
}

/** Raw MEMBRAL_INFER_REF, or undefined. */
export function inferRefRaw(): string | undefined {
  return process.env.MEMBRAL_INFER_REF;
}

/**
 * True when MEMBRAL_HANDOFF_SYNTHESIS is "1" or "true" (call-time read). OFF by default: the end-of-session handoff
 * note costs one extra stronger-model call per session on a hosted deploy (docs/design/2026-10-25_agent-authored-handoff.md).
 */
export function handoffSynthesisEnabled(): boolean {
  const raw = process.env.MEMBRAL_HANDOFF_SYNTHESIS?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * True when MEMBRAL_HANDOFF_SEARCH is "1" or "true" (call-time read). OFF by default: when ON, handoff notes are
 * embedded at write time and `memory_search`, `memory_recall` and prompt recall include `handoff` in their default kinds.
 */
export function handoffSearchEnabled(): boolean {
  const raw = process.env.MEMBRAL_HANDOFF_SEARCH?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * True when either handoff flag is on, i.e. `handoff` notes can be written or read. With both off the memory read paths
 * keep their pre-handoff shape (no kind filter) instead of an explicit kind list.
 */
export function handoffFeatureEnabled(): boolean {
  return handoffSynthesisEnabled() || handoffSearchEnabled();
}

/** Raw MEMBRAL_HANDOFF_MODEL (strong-tier chat model for the handoff summary on a hosted provider), or undefined. */
export function handoffModelRaw(): string | undefined {
  return process.env.MEMBRAL_HANDOFF_MODEL;
}

/** Boot hook for instrumentation.ts: runs validateEnvAtBoot() only on the Node.js runtime (NEXT_RUNTIME === "nodejs"). */
export function validateEnvAtBootOnNode(): void {
  if (process.env.NEXT_RUNTIME === "nodejs") validateEnvAtBoot();
}

/** True when MEMBRAL_STORE=pglite: the app runs on the embedded store (rung two) and serves its REST calls in process. */
export function embeddedStoreEnabled(): boolean {
  return process.env.MEMBRAL_STORE?.trim() === "pglite";
}
