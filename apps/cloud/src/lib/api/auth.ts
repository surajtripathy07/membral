import type { User } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";
import { validateApiKey } from "@/lib/api-keys";
import { getServiceClient } from "@/lib/db/clients";
import type { Db } from "@/lib/db/types";
import { cronSecret } from "@/lib/env";
import { log } from "@/lib/log";
import { clientIp, rateLimited } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "./errors";

// Authentication adapters for app/api route handlers (G3 step 3A-2).
// Each one is the inline block its routes used to repeat, verbatim, with the
// varying strings (and extra ResponseInit such as `x-request-id` headers)
// lifted into parameters so every route keeps its exact status and body.
// A failed check returns the response the route should return as-is; the
// caller narrows with `instanceof NextResponse`.

/** Cookie-session client, as `@/lib/supabase/server`'s `createClient()` returns it. */
export type SessionClient = Awaited<ReturnType<typeof createClient>>;

export interface BearerUserMessages {
  /** 401 body when the header is absent or not `Bearer ` (case-sensitive). */
  missing: string;
  /** 401 body when `auth.getUser(token)` errors or returns no user. */
  invalid: string;
  /** Extra ResponseInit for both 401s (e.g. `{ headers: { "x-request-id": rid } }`). */
  init?: ResponseInit;
}

/**
 * `Authorization: Bearer <Supabase JWT>` resolved through the service-role
 * client. The service client is created only after the header check passes.
 */
export async function requireBearerUser(
  req: Request,
  messages: BearerUserMessages,
): Promise<{ user: User; supabase: Db } | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return apiError(401, messages.missing, messages.init);
  }
  const token = authHeader.slice(7);
  const supabase = getServiceClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user) return apiError(401, messages.invalid, messages.init);
  return { user, supabase };
}

export interface SessionUserMessages {
  /** 401 body when the cookie session has no user. */
  unauthorized: string;
  /** Extra ResponseInit for the 401 (e.g. `{ headers: { "x-request-id": rid } }`). */
  init?: ResponseInit;
}

/**
 * The signed-in dashboard's cookie session (`@/lib/supabase/server`). Only a
 * missing user fails the check; an `error` from `getUser()` is not consulted,
 * matching every inline copy this replaces.
 */
export async function requireSessionUser(
  messages: SessionUserMessages,
): Promise<{ user: User; supabase: SessionClient } | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return apiError(401, messages.unauthorized, messages.init);
  return { user, supabase };
}

export interface CronSecretMessages {
  /** Log prefix, e.g. "cron/advance". */
  logPrefix: string;
  /** 503 body when CRON_SECRET is unset. */
  notConfigured: string;
  /** 403 body when the header is not exactly `Bearer ${CRON_SECRET}`. */
  forbidden: string;
}

/**
 * Vercel Cron's `Authorization: Bearer $CRON_SECRET`. Fails closed: 503 when
 * CRON_SECRET is unset (nothing to compare against, so accepting would let ANY
 * caller trigger a fan-out of paid LLM cycles), 403 on any mismatch. Returns
 * null when authorized.
 */
export function requireCronSecret(req: Request, messages: CronSecretMessages): NextResponse | null {
  const secret = cronSecret();
  if (!secret) {
    log.error(`${messages.logPrefix}: CRON_SECRET is not configured — refusing (503)`);
    return apiError(503, messages.notConfigured);
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    log.warn(`${messages.logPrefix}: rejected — missing or mismatched Authorization header`);
    return apiError(403, messages.forbidden);
  }
  return null;
}

/** The validated `lls_` key behind a dual/key-authenticated request; null for a JWT caller. */
export interface ApiKeyPrincipal {
  /** First 8 characters of the presented key (== the stored display prefix), the per-key bucket id. */
  prefix: string;
  /** Area bound (#83); null unless the key carries it. Only ever set from the validated key. */
  scopeNodeId: string | null;
  /** Code-project bound (ADR 0021 Q7); null unless the key carries it. Only ever set from the validated key. */
  scopeCodeProjectId: string | null;
  /** api_keys row id (device-minted keys); null for the legacy profile key. */
  apiKeyId: string | null;
}

export interface DualUserMessages {
  /** 401 body when the header is absent or not `Bearer ` (case-sensitive). */
  missing: string;
  /** 401 body when a non-`lls_` token resolves to no user via `auth.getUser(token)`. */
  invalidToken: string;
  /** 401 body when an `lls_` key matches no live key. */
  invalidKey: string;
  /**
   * What a SCOPED key (area or code-project bound) gets. `"allow"` passes it through with its scope on
   * the principal (read lenses such as /api/mcp); `{ reject }` answers 403 with that body (every write
   * route: a scoped key is a narrowed read lens, never a write grant).
   */
  scoped: "allow" | { reject: string };
  /** Extra ResponseInit for every auth failure (401, 403, and the failed-key 429). */
  init?: ResponseInit;
}

export interface KeyUserMessages extends Omit<DualUserMessages, "invalidToken"> {
  /** 401 body when the bearer token is not an `lls_` key (key-only surfaces take no JWT). */
  notKey: string;
}

function stampInit(res: NextResponse, init: ResponseInit | undefined): NextResponse {
  if (init?.headers) new Headers(init.headers).forEach((v, k) => res.headers.set(k, v));
  return res;
}

/**
 * `Authorization: Bearer <token>` where the token is a Supabase JWT or an `lls_` API key (`mode: "dual"`),
 * or an `lls_` key only (`mode: "key"`). A key is validated with the caller's IP ALWAYS threaded through,
 * so failed lookups count against the per-IP brute-force throttle (keyValidationFail, issue #67); that
 * throttle's 429 is answered ahead of the 401, as every hand-written copy did. Scoped keys are allowed or
 * rejected per `messages.scoped`. The JWT path creates the service client only after the header check.
 */
export async function requireBearerOrKeyUser(
  req: Request,
  messages: DualUserMessages | KeyUserMessages,
  mode: "dual" | "key",
): Promise<{ userId: string; key: ApiKeyPrincipal | null } | NextResponse> {
  const fail = (status: number, message: string) => apiError(status, message, messages.init);
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return fail(401, messages.missing);
  const token = authHeader.slice(7);

  if (token.startsWith("lls_")) {
    const result = await validateApiKey(token, clientIp(req));
    if (result.rateLimited) return stampInit(rateLimited(result.retryAfter ?? 60), messages.init);
    if (!result.valid || !result.userId) return fail(401, messages.invalidKey);
    const scopeNodeId = result.scopeNodeId ?? null;
    const scopeCodeProjectId = result.scopeCodeProjectId ?? null;
    if (messages.scoped !== "allow" && (scopeNodeId != null || scopeCodeProjectId != null)) {
      return fail(403, messages.scoped.reject);
    }
    return {
      userId: result.userId,
      key: { prefix: token.slice(0, 8), scopeNodeId, scopeCodeProjectId, apiKeyId: result.apiKeyId ?? null },
    };
  }

  if (mode === "key") return fail(401, (messages as KeyUserMessages).notKey);

  const supabase = getServiceClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user) return fail(401, (messages as DualUserMessages).invalidToken);
  return { userId: user.id, key: null };
}
