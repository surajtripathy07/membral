// Which Supabase URL server-side code talks to (W7 7.1).
//
// NEXT_PUBLIC_SUPABASE_URL is the browser-facing URL. Inside the self-hosted
// container that is e.g. http://localhost:54321, which the container itself
// cannot reach. SUPABASE_INTERNAL_URL (server-only, never inlined into the
// browser bundle) is the container-network URL, e.g. http://gateway:8000.
// Unset (the hosted path), server code uses NEXT_PUBLIC_SUPABASE_URL as before.
import { embeddedStoreEnabled, postgrestDirect, supabaseInternalUrl, supabaseJwtSecret } from "@/lib/env";
import { isLocalMode } from "@/lib/local/mode";

/** URL for server-side Supabase clients: SUPABASE_INTERNAL_URL when set, else NEXT_PUBLIC_SUPABASE_URL. */
export function serverSupabaseUrl(): string | undefined {
  const internal = supabaseInternalUrl();
  return internal || process.env.NEXT_PUBLIC_SUPABASE_URL;
}

/**
 * Cookie options for cookie-session clients built on the internal URL.
 *
 * supabase-js names the auth cookie after the client URL's first hostname
 * label (`sb-<label>-auth-token`). The browser client uses the public URL, so a
 * server client on the internal URL must pin the public name or it would not
 * see the browser's session. Returns undefined when no internal URL is set, so
 * the hosted path passes no extra option.
 */
export function sessionCookieOptions(): { name: string } | undefined {
  const internal = supabaseInternalUrl();
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!internal || !publicUrl) return undefined;
  return { name: `sb-${new URL(publicUrl).hostname.split(".")[0]}-auth-token` };
}

/**
 * A `fetch` for server-side Supabase clients on the Docker-free local stack, or undefined everywhere else (hosted, or
 * a stack with a gateway), so those clients are built exactly as before.
 *
 * Two local shapes, both local-mode only. supabase-js always appends `/rest/v1` or `/auth/v1`:
 *  - bare PostgREST (SUPABASE_INTERNAL_URL + MEMBRAL_POSTGREST_DIRECT=1, rung one): `/rest/v1/x` goes to PostgREST as
 *    `/x`; `/auth/v1/x` goes to the app's own origin (NEXT_PUBLIC_SUPABASE_URL), where the GoTrue-protocol stub lives.
 *  - the embedded store (MEMBRAL_STORE=pglite, rung two): `/rest/v1/*` is answered in process by the shim over the
 *    registered store handle. The handle is looked up when a request is made (it does not exist yet when the client is
 *    built), and with none registered the request takes the rung-one path above if that is configured, else the
 *    network. `/auth/v1/*` keeps going to the app's origin. The shim is never served over HTTP.
 *
 * Edge-safe: the Node-only modules are imported dynamically behind a NEXT_RUNTIME check that Next replaces at build
 * time, so the middleware bundle never sees PGlite, the shim or node:crypto.
 */
export function serverSupabaseFetch(): typeof fetch | undefined {
  if (!isLocalMode()) return undefined;
  const internal = supabaseInternalUrl();
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const direct = !!internal && !!publicUrl && postgrestDirect();
  const embedded = embeddedStoreEnabled();
  if (!direct && !embedded) return undefined;
  const rest = direct ? new URL(internal as string) : undefined;
  const app = publicUrl ? new URL(publicUrl) : undefined;
  return async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const from = new URL(req ? req.url : String(input));
    const isRest = from.pathname === "/rest/v1" || from.pathname.startsWith("/rest/v1/");
    const isAuth = from.pathname === "/auth/v1" || from.pathname.startsWith("/auth/v1/");
    if (isRest && embedded) {
      // Nested constant guards, so Next drops the dynamic imports (node:crypto, PGlite) from the browser and edge bundles.
      if (typeof window === "undefined") {
        if (process.env.NEXT_RUNTIME !== "edge") {
          const { getStore } = await import("@/lib/local/store/registry");
          const store = getStore();
          const secret = supabaseJwtSecret();
          if (store && secret) {
            const { handleRestRequest } = await import("@/lib/local/store/shim/handler");
            return handleRestRequest(new Request(req ? req : from.toString(), req ? undefined : init), store, {
              jwtSecret: secret,
            });
          }
        }
      }
    }
    let target: string | undefined;
    if (isRest && rest) {
      const path = from.pathname.slice("/rest/v1".length) || "/";
      target = `${rest.origin}${rest.pathname.replace(/\/+$/, "")}${path}${from.search}`;
    } else if (isAuth && app) {
      target = `${app.origin}${from.pathname}${from.search}`;
    }
    if (!target) return fetch(input, init);
    return fetch(req ? new Request(target, req) : target, init);
  };
}

/** `{ global: { fetch } }` for createClient / createServerClient, or nothing when no rewrite applies. */
export function serverSupabaseClientOptions(): { global: { fetch: typeof fetch } } | Record<string, never> {
  const f = serverSupabaseFetch();
  return f ? { global: { fetch: f } } : {};
}
