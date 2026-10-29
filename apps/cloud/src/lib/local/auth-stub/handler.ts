// A local GoTrue-protocol stub (docs/design/2026-10-25_docker-free-store.md, "Shared by both rungs: a GoTrue
// stub"). Local mode has one user who signs in with email and password; supabase-js talks to this handler instead
// of a GoTrue container, so no call site changes. Endpoints: password and refresh_token grants, GET /user,
// POST /logout, and the admin calls local provisioning and feature flags make (listUsers, createUser, getUserById).
// Everything else answers 404 naming the path: OTP, OAuth and the /auth/callback exchange are hosted-only.
//
// Dependencies are injected (the lib/llm convention) so tests pass a fake store, clock and secret.
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { log } from "@/lib/log";
import { ACCESS_TOKEN_TTL_S, type JwtClaims, signJwt, verifyJwt } from "./jwt";
import { createWindowLimiter, type WindowLimiter } from "./rate-limit";
import type { AuthStore, AuthUserRow, RevokeScope } from "./store";

export interface AuthStubDeps {
  store: AuthStore;
  /** HS256 secret `membral local up` generated; undefined answers 500 (misconfigured), never "open". */
  jwtSecret: string | undefined;
  /** The port the app listens on; when set the Host header must carry it. */
  port?: string;
  nowMs?: () => number;
  /** Per-email and overall password-grant limiters. */
  emailLimiter?: WindowLimiter;
  globalLimiter?: WindowLimiter;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BCRYPT_COST = 10; // GoTrue's default, so hashes written here and by GoTrue verify either way.
// A real hash of a throwaway string at the SAME cost as real hashes: unknown emails pay an equal bcrypt compare.
const DUMMY_HASH = bcrypt.hashSync("membral-local-no-such-user", BCRYPT_COST);

const defaultEmailLimiter = createWindowLimiter(10, 60_000);
const defaultGlobalLimiter = createWindowLimiter(30, 60_000);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** GoTrue's error body: auth-js reads `msg`/`error_description` for the message and `error_code`/`code` for the code. */
function fail(status: number, errorCode: string, msg: string, headers: Record<string, string> = {}): Response {
  return json({ code: status, error_code: errorCode, msg }, status, headers);
}

function newRefreshToken(): string {
  return randomBytes(12).toString("base64url");
}

function hostAllowed(req: Request, port: string | undefined): boolean {
  const host = (req.headers.get("host") ?? new URL(req.url).host).toLowerCase();
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!m || !LOOPBACK_HOSTS.has(m[1] as string)) return false;
  return port === undefined || m[2] === port;
}

export function userJson(u: AuthUserRow) {
  const app = (u.raw_app_meta_data ?? {}) as { provider?: string; providers?: string[] };
  return {
    id: u.id,
    aud: u.aud || "authenticated",
    role: u.role || "authenticated",
    email: u.email ?? "",
    email_confirmed_at: u.email_confirmed_at,
    phone: u.phone ?? "",
    confirmed_at: u.email_confirmed_at,
    last_sign_in_at: u.last_sign_in_at,
    app_metadata: { provider: app.provider ?? "email", providers: app.providers ?? ["email"], ...app },
    user_metadata: u.raw_user_meta_data ?? {},
    identities: [],
    created_at: u.created_at,
    updated_at: u.updated_at,
    is_anonymous: false,
  };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? (m[1] as string).trim() : null;
}

/** Store failures (a constraint, the signups kill-switch, PostgREST down) answer GoTrue-shaped JSON, never a bare 500. */
export async function handleAuthRequest(req: Request, path: string[], deps: AuthStubDeps): Promise<Response> {
  try {
    return await handleAuthRequestInner(req, path, deps);
  } catch (err) {
    log.error("local auth stub: request failed", { err: err instanceof Error ? err.message : String(err) });
    return fail(500, "unexpected_failure", "Local auth failed unexpectedly; see the app log");
  }
}

function isBanned(user: AuthUserRow, nowMs: number): boolean {
  return !!user.banned_until && new Date(user.banned_until).getTime() > nowMs;
}

async function handleAuthRequestInner(req: Request, path: string[], deps: AuthStubDeps): Promise<Response> {
  const route = `/${path.join("/")}`;
  const notFound = () => fail(404, "not_found", `The local auth stub does not support ${req.method} /auth/v1${route}`);

  if (!hostAllowed(req, deps.port)) return fail(403, "bad_host", "Requests must use a loopback Host header");
  if (req.method !== "GET" && req.method !== "HEAD") {
    // supabase-js sets this on every non-GET; a browser form post from another origin cannot, and a JSON
    // content type forces a CORS preflight that this handler never answers.
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      return fail(415, "bad_content_type", "Content-Type must be application/json");
    }
  }
  if (!deps.jwtSecret) return fail(500, "unexpected_failure", "Local auth is not configured (no JWT secret)");

  const secret = deps.jwtSecret;
  const nowMs = (deps.nowMs ?? Date.now)();
  const nowS = Math.floor(nowMs / 1000);
  const url = new URL(req.url);
  const { store } = deps;

  // supabase-js always sends the anon or service_role key as `apikey`; require a validly signed one.
  const apikey = req.headers.get("apikey");
  const key = apikey ? verifyJwt(apikey, secret, nowS) : null;
  if (!key || (key.role !== "anon" && key.role !== "service_role")) {
    return fail(401, "no_authorization", "Missing or invalid apikey");
  }

  /** `refresh` is already stored (password grant inserts it first; a refresh grant got it from rotateRefresh). */
  function issueSession(user: AuthUserRow, sessionId: string, refresh: string): Response {
    const exp = nowS + ACCESS_TOKEN_TTL_S;
    const claims: JwtClaims = {
      iss: `${url.origin}/auth/v1`,
      aud: "authenticated",
      sub: user.id,
      iat: nowS,
      exp,
      email: user.email ?? "",
      phone: user.phone ?? "",
      app_metadata: user.raw_app_meta_data ?? {},
      user_metadata: user.raw_user_meta_data ?? {},
      role: "authenticated",
      aal: "aal1",
      amr: [{ method: "password", timestamp: nowS }],
      session_id: sessionId,
      is_anonymous: false,
    };
    return json({
      access_token: signJwt(claims, secret),
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      expires_at: exp,
      refresh_token: refresh,
      user: userJson(user),
    });
  }

  // --- POST /token -----------------------------------------------------------------------------------------------
  if (route === "/token" && req.method === "POST") {
    const grant = url.searchParams.get("grant_type");
    const body = await readJson(req);
    if (!body) return fail(400, "bad_json", "Could not read request body as JSON");

    if (grant === "password") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const emailLimiter = deps.emailLimiter ?? defaultEmailLimiter;
      const globalLimiter = deps.globalLimiter ?? defaultGlobalLimiter;
      if (!globalLimiter.hit("all", nowMs) || !emailLimiter.hit(email, nowMs)) {
        return fail(429, "over_request_rate_limit", "Too many sign-in attempts; wait a minute", {
          "retry-after": "60",
        });
      }
      const user = email ? await store.findByEmail(email) : null;
      // Compare even when the user is missing or has no password, so the timing is the same.
      const ok = await bcrypt.compare(password, user?.encrypted_password || DUMMY_HASH);
      if (!user || !user.encrypted_password || !ok) {
        return fail(400, "invalid_credentials", "Invalid login credentials");
      }
      if (!user.email_confirmed_at) return fail(400, "email_not_confirmed", "Email not confirmed");
      if (isBanned(user, nowMs)) return fail(400, "user_banned", "User is banned");
      await store.recordSignIn(user.id);
      const sessionId = randomUUID();
      const refresh = newRefreshToken();
      await store.insertRefresh({ token: refresh, userId: user.id, sessionId, parent: null });
      return issueSession({ ...user, last_sign_in_at: new Date(nowMs).toISOString() }, sessionId, refresh);
    }

    if (grant === "refresh_token") {
      const token = typeof body.refresh_token === "string" ? body.refresh_token : "";
      const used = token ? await store.rotateRefresh(token, newRefreshToken()) : null;
      if (!used) return fail(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      const user = await store.findById(used.userId);
      if (!user) return fail(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      if (isBanned(user, nowMs)) return fail(400, "user_banned", "User is banned");
      return issueSession(user, used.sessionId ?? randomUUID(), used.token);
    }

    return fail(400, "validation_failed", `Unsupported grant_type: ${grant ?? "(none)"}`);
  }

  // --- GET /user ---------------------------------------------------------------------------------------------------
  if (route === "/user" && req.method === "GET") {
    const token = bearer(req);
    const claims = token ? verifyJwt(token, secret, nowS) : null;
    if (!claims?.sub || claims.role !== "authenticated") return fail(401, "bad_jwt", "Invalid or expired JWT");
    const user = await store.findById(claims.sub);
    if (!user) return fail(403, "user_not_found", "User from sub claim in JWT does not exist");
    if (isBanned(user, nowMs)) return fail(403, "user_banned", "User is banned");
    return json(userJson(user));
  }

  // --- POST /logout ------------------------------------------------------------------------------------------------
  if (route === "/logout" && req.method === "POST") {
    const token = bearer(req);
    const claims = token ? verifyJwt(token, secret, nowS) : null;
    if (!claims?.sub || claims.role !== "authenticated") return fail(401, "bad_jwt", "Invalid or expired JWT");
    const scope = (url.searchParams.get("scope") ?? "global") as RevokeScope;
    if (scope !== "global" && scope !== "local" && scope !== "others") {
      return fail(400, "validation_failed", "scope must be global, local or others");
    }
    await store.revoke(claims.sub, scope, claims.session_id ?? null);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  // --- /admin/users*: service-role JWT only --------------------------------------------------------------------
  if (path[0] === "admin" && path[1] === "users") {
    const token = bearer(req);
    const claims = token ? verifyJwt(token, secret, nowS) : null;
    if (!claims || claims.role !== "service_role") {
      return fail(403, "not_admin", "User not allowed: a service_role JWT is required");
    }

    if (path.length === 2 && req.method === "GET") {
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "", 10) || 1);
      const perPage = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("per_page") ?? "", 10) || 50));
      const { users, total } = await store.list(page, perPage);
      const last = Math.max(1, Math.ceil(total / perPage));
      const links = [];
      if (page < last)
        links.push(`<${url.origin}/auth/v1/admin/users?page=${page + 1}&per_page=${perPage}>; rel="next"`);
      if (last > 1) links.push(`<${url.origin}/auth/v1/admin/users?page=${last}&per_page=${perPage}>; rel="last"`);
      return json({ users: users.map(userJson), aud: "authenticated" }, 200, {
        "x-total-count": String(total),
        ...(links.length > 0 ? { link: links.join(",") } : {}),
      });
    }

    if (path.length === 2 && req.method === "POST") {
      const body = await readJson(req);
      const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!body || !email || !password) return fail(422, "validation_failed", "email and password are required");
      const created = await store.create({
        email,
        passwordHash: await bcrypt.hash(password, BCRYPT_COST),
        userMetadata: (body.user_metadata as Record<string, unknown> | undefined) ?? {},
        confirmed: body.email_confirm === true,
      });
      if (created === "email_exists") return fail(422, "email_exists", "A user with this email address already exists");
      return json(userJson(created));
    }

    if (path.length === 3 && req.method === "GET") {
      const id = path[2] as string;
      if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(404, "user_not_found", "User not found");
      const user = await store.findById(id);
      return user ? json(userJson(user)) : fail(404, "user_not_found", "User not found");
    }
  }

  return notFound();
}
