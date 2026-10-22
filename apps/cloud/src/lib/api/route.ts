import type { User } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import type { Db } from "@/lib/db/types";
import { requestId } from "@/lib/log";
import { enforceRateLimit, type RateLimitName, rateLimited } from "@/lib/rate-limit";
import {
  type ApiKeyPrincipal,
  type BearerUserMessages,
  type CronSecretMessages,
  type DualUserMessages,
  type KeyUserMessages,
  requireBearerOrKeyUser,
  requireBearerUser,
  requireCronSecret,
  requireSessionUser,
  type SessionClient,
  type SessionUserMessages,
} from "./auth";
import { corsHeaders } from "./cors";

// withRoute (G3 step 3A-3): the shell every app/api handler repeats, composed
// once. Order is fixed: auth -> rate limit -> handler.
//
//   opts.auth       { kind: "bearer", missing, invalid, init? }  -> requireBearerUser
//                   { kind: "session", unauthorized, init? }     -> requireSessionUser
//                   { kind: "cron", logPrefix, notConfigured, forbidden } -> requireCronSecret
//                   { kind: "dual", missing, invalidToken, invalidKey, scoped, init? }
//                                                                -> requireBearerOrKeyUser(.., "dual"):
//                                                                   Supabase JWT or lls_ key (R4 4.11)
//                   { kind: "key", missing, notKey, invalidKey, scoped, init? }
//                                                                -> requireBearerOrKeyUser(.., "key"): lls_ only
//                   { kind: "none" }                             -> no check
//                   any other kind throws (fail closed; the handler never runs).
//                   dual/key always thread clientIp(req) into validateApiKey (failed-key throttle),
//                   and `scoped: "allow" | { reject }` decides whether a scoped key passes or gets 403.
//   opts.rateLimit  { name, bucket(input) } -> enforceRateLimit(name, bucket); input is
//                   `{ req, user }` for bearer/session, `{ req, userId, key }` for dual/key
//                   (`key` null for a JWT caller), `{ req }` for none/cron.
//                   a hit returns rateLimited(retryAfter). Runs only after auth passed.
//   opts.requestId  true -> rid = requestId(req) is computed ONCE before auth, stamped as
//                   x-request-id on every auth failure, and handed to the handler as `rid`
//                   (routes that log and echo one id per request: import, import/upload).
//   opts.cors       { methods } -> every exit (auth failure, 429, handler response)
//                   gets corsHeaders(Origin, methods) set on it, exactly what
//                   withCors(res, origin, methods) does in app/api/sync/route.ts.
//                   Unset: no header is added anywhere. OPTIONS stays the route's
//                   own `corsPreflight` export; withRoute does not answer it.
//   handler         ({ req, ctx, user, supabase, userId, key, rid, origin }) => Promise<Response>;
//                   user/supabase are present for bearer/session; userId/key for dual/key.
//
// Invariants (each covered in __tests__/route.test.ts):
// - an auth failure never reaches the rate limiter or the handler; a 429 never
//   reaches the handler;
// - `ctx` (Next 15: `{ params: Promise<...> }`) is forwarded as received, same
//   object, never awaited here;
// - the wrapper never reads the body, never caches, and constructs no Supabase
//   client itself (the auth adapters create theirs only after the header check;
//   the rate limiter uses its own service client, as routes do today);
// - errors thrown by the handler are NOT caught: routes today do not share a
//   catch, and a shared one would change their 500 bodies. It propagates to Next.
//
// Not expressible here (these stay hand-written or unwrapped; the list with one
// reason per route is UNWRAPPED_BY_DESIGN in __tests__/unwrapped-routes.test.ts):
// rate limits that run before auth on a non-IP key (device poll), auth schemes
// other than the adapters (none today),
// cookie-or-key auth with an origin check.

export type RouteAuth =
  | ({ kind: "bearer" } & BearerUserMessages)
  | ({ kind: "session" } & SessionUserMessages)
  | ({ kind: "dual" } & DualUserMessages)
  | ({ kind: "key" } & KeyUserMessages)
  | ({ kind: "cron" } & CronSecretMessages)
  | { kind: "none" };

type Principal<A extends RouteAuth> = A extends { kind: "bearer" }
  ? { user: User; supabase: Db }
  : A extends { kind: "session" }
    ? { user: User; supabase: SessionClient }
    : A extends { kind: "dual" }
      ? { userId: string; key: ApiKeyPrincipal | null; user?: undefined; supabase?: undefined }
      : A extends { kind: "key" }
        ? { userId: string; key: ApiKeyPrincipal; user?: undefined; supabase?: undefined }
        : { user?: undefined; supabase?: undefined };

/** bearer/session buckets get the authenticated user; dual/key the user id and the key (null for a JWT);
 * none/cron get only the request (no user to key on). */
export type BucketInput<A extends RouteAuth> = A extends { kind: "bearer" } | { kind: "session" }
  ? { req: Request; user: User }
  : A extends { kind: "dual" }
    ? { req: Request; userId: string; key: ApiKeyPrincipal | null }
    : A extends { kind: "key" }
      ? { req: Request; userId: string; key: ApiKeyPrincipal }
      : { req: Request };

export interface RouteRateLimit<A extends RouteAuth> {
  name: RateLimitName;
  bucket: (input: BucketInput<A>) => string;
}

export interface RouteOptions<A extends RouteAuth> {
  auth: A;
  rateLimit?: RouteRateLimit<A>;
  cors?: { methods: string };
  requestId?: boolean;
}

export type RouteInput<A extends RouteAuth, C> = Principal<A> & {
  req: NextRequest;
  ctx: C;
  origin: string | null;
  /** Set only when opts.requestId is true. */
  rid?: string;
};

export function withRoute<A extends RouteAuth, C = undefined>(
  opts: RouteOptions<A>,
  handler: (input: RouteInput<A, C>) => Promise<Response>,
): (req: NextRequest, ...rest: undefined extends C ? [] : [ctx: C]) => Promise<Response> {
  return async (req, ...rest) => {
    const ctx = rest[0] as C;
    const origin = req.headers.get("origin");
    const exit = (res: Response): Response => {
      if (opts.cors) for (const [k, v] of Object.entries(corsHeaders(origin, opts.cors.methods))) res.headers.set(k, v);
      return res;
    };

    const rid = opts.requestId ? requestId(req) : undefined;
    const authFail = (res: Response): Response => {
      if (rid !== undefined) res.headers.set("x-request-id", rid);
      return exit(res);
    };

    let principal: {
      user?: User;
      supabase?: Db | SessionClient;
      userId?: string;
      key?: ApiKeyPrincipal | null;
    } = {};
    const auth = opts.auth;
    switch (auth.kind) {
      case "bearer": {
        const r = await requireBearerUser(req, auth);
        if (r instanceof NextResponse) return authFail(r);
        principal = r;
        break;
      }
      case "session": {
        const r = await requireSessionUser(auth);
        if (r instanceof NextResponse) return authFail(r);
        principal = r;
        break;
      }
      case "dual":
      case "key": {
        const r = await requireBearerOrKeyUser(req, auth, auth.kind);
        if (r instanceof NextResponse) return authFail(r);
        principal = r;
        break;
      }
      case "cron": {
        const r = requireCronSecret(req, auth);
        if (r) return authFail(r);
        break;
      }
      case "none":
        break;
      default: {
        // Fail closed: an unknown kind (e.g. smuggled in through a cast) must never skip auth.
        const unknownKind: never = auth;
        void unknownKind;
        throw new Error("withRoute: unknown auth kind");
      }
    }

    if (opts.rateLimit) {
      const input: { req: Request; user?: User; userId?: string; key?: ApiKeyPrincipal | null } = principal.user
        ? { req, user: principal.user }
        : principal.userId !== undefined
          ? { req, userId: principal.userId, key: principal.key ?? null }
          : { req };
      const rl = await enforceRateLimit(opts.rateLimit.name, opts.rateLimit.bucket(input as BucketInput<A>));
      if (!rl.allowed) return exit(rateLimited(rl.retryAfter));
    }

    return exit(await handler({ ...principal, req, ctx: ctx as C, origin, rid } as RouteInput<A, C>));
  };
}
