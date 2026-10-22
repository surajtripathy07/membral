import { createHash, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db/clients";
import type { Db } from "@/lib/db/types";
import { log } from "./log";

// Postgres-backed sliding-window rate limiter (issue #67). Backed by the
// rate_limit_check RPC + rate_limit_hits table (migration 028). No Redis/Upstash
// — the check is a single round-trip to the Postgres the app already talks to.
//
// The limiter ALWAYS runs server-side under the service-role key: the RPC and
// its table are service_role-only (see migration 028 RLS notes).

// ------------------------------------------------------------
// Default limits — env-tunable. Each rule reads `<envKey>` for the count and
// `<envKey>_WINDOW` for the window (seconds); if unset it falls back to the
// default below. Defaults come straight from issue #67.
// ------------------------------------------------------------
export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_DEFAULTS = {
  // /api/search — embeds every query.
  search: { limit: 60, windowSeconds: 60, envKey: "RATE_LIMIT_SEARCH" },
  // /api/embed — 100 convs/batch. 2 batches / 10 min.
  embed: { limit: 2, windowSeconds: 600, envKey: "RATE_LIMIT_EMBED" },
  // /api/memories — cheap DB read/write; a generous default.
  memories: { limit: 120, windowSeconds: 60, envKey: "RATE_LIMIT_MEMORIES" },
  // /api/mcp — per-key, stateless. 300 / min / key.
  mcp: { limit: 300, windowSeconds: 60, envKey: "RATE_LIMIT_MCP" },
  // /api/stats — one aggregate query; reasonable default.
  stats: { limit: 60, windowSeconds: 60, envKey: "RATE_LIMIT_STATS" },
  // /api/keys — mint/revoke; 10 / min.
  keys: { limit: 10, windowSeconds: 60, envKey: "RATE_LIMIT_KEYS" },
  // POST /api/mcp/test (#172) — anonymous "test this key" action; per IP on
  // EVERY call (valid keys too: each one costs a loopback /api/mcp tools/list).
  // The dashboard button is manual; 10/min is far above a human clicking it.
  mcpTest: { limit: 10, windowSeconds: 60, envKey: "RATE_LIMIT_MCP_TEST" },
  // FAILED lls_ key validation — 5 / min / IP (brute-force throttle).
  keyValidationFail: { limit: 5, windowSeconds: 60, envKey: "RATE_LIMIT_KEY_VALIDATION_FAIL" },
  // POST /api/auth/device/poll — unauthenticated, but the CLI polls this on
  // its own `interval` (3s default -> ~20/min); generous per-IP ceiling
  // catches a runaway/misbehaving client without punishing normal use.
  // Bucketed by deviceCode hash, not IP, when a deviceCode is present (M1,
  // adversarial review) — see deviceCodeBucket below.
  deviceAuthPoll: { limit: 40, windowSeconds: 60, envKey: "RATE_LIMIT_DEVICE_AUTH_POLL" },
  // POST /api/auth/device/start — unauthenticated (a signed-out CLI mints a
  // new code). Own rule (M1, adversarial review): it used to borrow
  // keyValidationFail's 5/min limit/window, which is tuned for throttling
  // brute-force GUESSES against an existing secret, not for the normal
  // "run `membral setup`" rate a legitimate CLI user hits. 30/min is
  // generous enough for retries/multiple devices while still bounding
  // device_auth_requests row creation per caller.
  deviceAuthStart: { limit: 30, windowSeconds: 60, envKey: "RATE_LIMIT_DEVICE_AUTH_START" },
  // POST /api/auth/device/poll's PER-IP ceiling (NEW-7, round-2 review) —
  // separate from deviceAuthPoll above (which buckets by deviceCode alone).
  // A fresh deviceCode gets a fresh (empty) code-bucket, so bucketing by
  // deviceCode ALONE meant a caller could dodge every throttle just by
  // minting new codes. This rule is always checked in ADDITION to the
  // per-code one, keyed by IP (or, when unresolvable, a stable shared
  // "unknown" bucket — never the per-request-random fallback
  // ipOrFallbackBucket uses elsewhere, which would make this a no-op).
  // Deliberately generous: several legitimate concurrent `membral setup`
  // runs (CI, multiple terminals/devices) can share one IP/NAT.
  deviceAuthPollIp: { limit: 600, windowSeconds: 60, envKey: "RATE_LIMIT_DEVICE_AUTH_POLL_IP" },
  // POST /api/import/upload (NEW-10, round-2 review) — per-user, since the
  // route is cookie-session auth'd. Bulk imports are inherently infrequent
  // (drag-and-drop a data export); 30/min comfortably covers the batch
  // loop's own re-POSTs for a `partial: true` resume without opening the
  // door to using this endpoint as an unbounded write amplifier.
  importUpload: { limit: 30, windowSeconds: 60, envKey: "RATE_LIMIT_IMPORT_UPLOAD" },
  // POST /api/sync (issue #127) — the extension's own steady-state polling
  // cadence is one push per SYNC_INTERVAL_MINUTES (default well under
  // 60/hour); the extension also chunks a large first-time/backfill push
  // into MAX_SYNC_BATCH_SIZE-sized batches (cloud-push.ts), so a real
  // client legitimately issuing several requests in a burst is expected.
  // 60/min/user is generous for that while still bounding an authenticated
  // caller (leaked lls_ key/JWT) from hammering the two fire-and-forget
  // cost paths (embedding, KG pass-1) this route triggers on every call.
  sync: { limit: 60, windowSeconds: 60, envKey: "RATE_LIMIT_SYNC" },
  // POST /api/import (issue #127) — the CLI's bulk backfill path. Far less
  // frequent than /api/sync (a one-off `membral setup`/backfill run, not a
  // recurring poll); 10/min still comfortably covers a multi-batch backfill
  // while bounding the same cost-triggering surface as /api/sync.
  importBulk: { limit: 10, windowSeconds: 60, envKey: "RATE_LIMIT_IMPORT_BULK" },
  // POST /api/code-sessions (issue #127) — the CLI's code-session ingest
  // (post-hook + backfill sweep). Has its own 4MB body cap + MAX_BATCH_SIZE
  // schema cap already; this bounds request FREQUENCY the same way sync/
  // import now do. 30/min covers a normal sweep's per-batch re-POSTs.
  codeSessions: { limit: 30, windowSeconds: 60, envKey: "RATE_LIMIT_CODE_SESSIONS" },
  // POST /api/code-sessions/known — the CLI asks which sessions the server
  // already has before uploading (one call per 500 sessions). Its own bucket
  // so the check never eats the ingest's 30/min.
  codeSessionsKnown: { limit: 60, windowSeconds: 60, envKey: "RATE_LIMIT_CODE_SESSIONS_KNOWN" },
  // Signup server action (issue #127) — per-IP, app-level backstop ahead of
  // whatever Supabase Auth's own (unconfigured-here) limits are. 5/10min is
  // generous for a real person retrying a typo'd password, tight enough to
  // blunt scripted account-creation spam from one source.
  signupIp: { limit: 5, windowSeconds: 600, envKey: "RATE_LIMIT_SIGNUP_IP" },
  // Login server action (issue #127) — per-IP. Looser than signupIp (a
  // shared-NAT office full of people typo'ing passwords is normal); still a
  // real backstop against password-spray from one source.
  loginIp: { limit: 20, windowSeconds: 600, envKey: "RATE_LIMIT_LOGIN_IP" },
  // POST /api/kg/claims/advance (issue #132) — was uncalled from any
  // browser-reachable surface before this issue (only the CLI sweep, on its
  // own ~20-min cadence, and now the daily cron); the dashboard
  // self-advance kick (components/self-advance.tsx) calls it once per
  // /memories or /pulse page load over the caller's own cookie session.
  // 6/min/user is generous for that (a person reloading/switching tabs a
  // few times a minute) while bounding a scripted caller from forcing
  // repeated advance cycles — each one takes the per-user advance lock and,
  // even refused (already_running/ceiling), is not free (a lock RPC round
  // trip at minimum).
  claimsAdvance: { limit: 6, windowSeconds: 60, envKey: "RATE_LIMIT_CLAIMS_ADVANCE" },
  // GET /api/account/export (round-5 verification MED 10) — own rule, split
  // out from the "stats" bucket it used to reuse. The reuse comment called
  // this "a bounded read, same order of cost as /api/stats"; measured, a
  // full export is ~24MB/1000 conversations — nowhere near that. 3/hour is
  // generous for a human clicking "Export my data" a few times while
  // re-checking a download, and bounds the egress/DB-scan cost of a scripted
  // caller hammering the one route that streams an entire account.
  accountExport: { limit: 3, windowSeconds: 3600, envKey: "RATE_LIMIT_ACCOUNT_EXPORT" },
  // POST /api/memory/extraction/kick — a self-hosted install's
  // `membral sweep`/`membral sessions` nudge for a stalled memory extraction
  // chain (no Vercel cron there). Once per run on a ~20-min sweep cadence is
  // 3/hour. e2e B11: 6/hour 429'd three sweeps run by hand minutes apart, on
  // top of `membral sessions` runs. 30/hour covers the sweep plus a manual run
  // every ~2 minutes; a kick costs one count query and, only with a backlog,
  // one trigger POST, so this still bounds a scripted caller.
  memoryExtractionKick: { limit: 30, windowSeconds: 3600, envKey: "RATE_LIMIT_MEMORY_EXTRACTION_KICK" },
} as const satisfies Record<string, RateLimitRule & { envKey: string }>;

export type RateLimitName = keyof typeof RATE_LIMIT_DEFAULTS;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Resolve a named rule against env at CALL time (not import time) so overrides
// set after module load — and in tests — take effect.
export function resolveRule(name: RateLimitName): RateLimitRule {
  const def = RATE_LIMIT_DEFAULTS[name];
  return {
    limit: envInt(def.envKey, def.limit),
    windowSeconds: envInt(`${def.envKey}_WINDOW`, def.windowSeconds),
  };
}

// ------------------------------------------------------------
// Bucket-key builders. A bucket is an opaque string; keeping the shape here
// keeps keys consistent across routes. Keyed by user_id, api_key_prefix, or IP.
// ------------------------------------------------------------
export function userBucket(name: string, userId: string): string {
  return `${name}:user:${userId}`;
}

export function keyBucket(name: string, apiKeyPrefix: string): string {
  return `${name}:key:${apiKeyPrefix}`;
}

export function ipBucket(name: string, ip: string): string {
  return `${name}:ip:${ip}`;
}

// Buckets by a hash of a caller-supplied secret/resource id rather than IP —
// used by /api/auth/device/poll (M1, adversarial review) so throttling is
// scoped to the ONE deviceCode being polled, not the caller's IP. This means
// two different device-auth flows behind the same "unknown" IP (see
// ipOrFallbackBucket below) never share a budget, AND it sidesteps the
// no-proxy "unknown" IP problem entirely whenever a deviceCode is present
// (deviceCode is always present on a well-formed poll). Hashed (not the raw
// deviceCode) so the bucket key — which gets persisted into rate_limit_hits
// and logged via logRateLimitHit — never carries the secret itself.
export function deviceCodeBucket(name: string, deviceCode: string): string {
  const digest = createHash("sha256").update(deviceCode).digest("hex").slice(0, 32);
  return `${name}:code:${digest}`;
}

// Client IP from the standard forwarded headers.
//
// Round-2 review MED 10: the CAVEAT below used to say a spoofed IP "can at
// most dodge its own brute-force throttle" — TRUE when this was written
// (issue #67, key-validation-fail only), FALSE now that issue #127 added
// signupIp/loginIp throttles: dodging your own throttle IS the whole attack
// there (unlimited signup/password-spray attempts, each in a fresh bucket).
// Fixed by preferring `x-vercel-forwarded-for` — the header Vercel's edge
// sets itself from the actual TCP connection and OVERWRITES on the way in
// (a client-supplied value is discarded, not appended-to), so it can't be
// spoofed the way a raw `x-forwarded-for` can. Falls back to
// `x-forwarded-for`, taking the RIGHT-most entry — the hop the nearest
// (least-spoofable) proxy added — rather than the left-most (client-supplied,
// trivially spoofed by sending your own `X-Forwarded-For: <random>` per
// request, which a proxy that APPENDS to an existing header — the common,
// and RFC-recommended, behavior — never strips). On a bare `x-real-ip` (no
// list to pick from) or no headers at all, falls back further, ending in a
// shared "unknown" bucket (deliberately NOT unique-per-request — see
// ipOrFallbackBucket below for the one place that's actually wanted).
//
// CAVEAT: still spoofable if the app is ever reachable without a
// forwarded-header-setting proxy in front of it (bare `next start`, no
// Vercel/CDN) — there's no header to trust at all in that shape, and every
// caller collapses into the "unknown" bucket. On Vercel this function's
// headers are trustworthy. IP buckets now back BOTH the original
// unauthenticated failed-key-validation throttle AND the signupIp/loginIp
// throttles (issue #127) — a spoofed/absent IP degrades either to a
// dodgeable throttle (same as before) or (self-hosted, no proxy) a
// shared-bucket throttle that punishes every caller together; it never
// exposes another user's cost budget (those routes key by the authenticated
// user/key, never by IP).
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const vercelIp = req.headers.get("x-vercel-forwarded-for")?.trim();
  if (vercelIp) return normalizeIp(vercelIp);

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return normalizeIp(last);
  }
  const real = req.headers.get("x-real-ip");
  if (real?.trim()) return normalizeIp(real.trim());
  return "unknown";
}

/** IPv6 gets bucketed on its /64 prefix (round-2 review MED 10) — a caller with a
 * routed /64 (common for residential/mobile IPv6 allocations) would otherwise get
 * 2^64 free buckets by varying the host portion of one address, without spoofing
 * anything. IPv4 passes through unchanged. */
function normalizeIp(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4, or already not IPv6-shaped
  const groups = ip.split(":");
  // A /64 is the first 4 groups of a full 8-group IPv6 address. A
  // compressed form ("::" collapsing zero groups) still yields >= 4 groups
  // for any address with a non-zero first half; shorter inputs (a
  // malformed/partial header value) are used as-is rather than guessed at.
  if (groups.length < 4) return ip;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

// clientIp()-backed bucket that degrades safely when there's no proxy in
// front of the app (clientIp() -> "unknown" for every caller in that
// deployment shape). A plain ipBucket(name, "unknown") would put every such
// caller in ONE shared bucket, so a single runaway/misbehaving client could
// exhaust the budget for every other legitimate caller behind the same
// missing proxy. ONLY use this for /api/auth/device/start and
// /api/auth/device/poll's IP fallback (M1, adversarial review) — never for
// keyValidationFail or any other brute-force throttle: those exist
// specifically to bound a SINGLE caller's repeated guesses, and handing out
// a fresh random bucket per request there would make the throttle a no-op
// for exactly the attacker it's meant to slow down. For start/poll the
// tradeoff is acceptable: an unidentifiable caller effectively goes
// unthrottled on this one rule (same as today's "unknown" bucket already
// does once it fills — no worse), while identifiable (resolvable-IP)
// callers keep a real, shared-nothing limit.
export function ipOrFallbackBucket(name: string, req: { headers: { get(name: string): string | null } }): string {
  const ip = clientIp(req);
  if (ip !== "unknown") return ipBucket(name, ip);
  return ipBucket(name, `unknown:${randomUUID()}`);
}

// ------------------------------------------------------------
// Core check + response helpers.
// ------------------------------------------------------------
export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
  remaining: number;
}

export async function checkRateLimit(
  args: { bucket: string; limit: number; windowSeconds: number },
  client?: Db,
): Promise<RateLimitResult> {
  const supabase = client ?? getServiceClient();
  const { data, error } = await supabase.rpc("rate_limit_check", {
    p_key: args.bucket,
    p_limit: args.limit,
    p_window_seconds: args.windowSeconds,
  });

  if (error || !data) {
    // FAIL OPEN: a limiter outage must not take the whole API down. Log it so
    // the observability work (issue #72) can alert on limiter unavailability.
    log.warn("rate_limit_rpc_error", {
      event: "rate_limit_rpc_error",
      bucket: args.bucket,
      detail: error?.message ?? "no data",
    });
    return { allowed: true, retryAfter: 0, remaining: args.limit };
  }

  const d = data as { allowed: boolean; retry_after: number; remaining: number };
  return { allowed: d.allowed, retryAfter: d.retry_after, remaining: d.remaining };
}

// Structured log line per limit hit (issue #72).
export function logRateLimitHit(bucket: string, result: RateLimitResult): void {
  log.warn("rate_limit_exceeded", {
    event: "rate_limit_exceeded",
    bucket,
    retry_after: result.retryAfter,
    remaining: result.remaining,
  });
}

// Resolve a named rule, check it, and log on a hit. The single call routes use.
export async function enforceRateLimit(name: RateLimitName, bucket: string, client?: Db): Promise<RateLimitResult> {
  const rule = resolveRule(name);
  const result = await checkRateLimit({ bucket, limit: rule.limit, windowSeconds: rule.windowSeconds }, client);
  if (!result.allowed) logRateLimitHit(bucket, result);
  return result;
}

// 429 with a Retry-After header + structured JSON. Returns a NextResponse,
// which is a Response subclass — safe to return from the web-standard /api/mcp
// handlers too.
export function rateLimited(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: "Rate limit exceeded", retry_after: retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}
