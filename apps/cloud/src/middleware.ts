import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { providerErrorKey } from "./app/auth/messages";
import { serverSupabaseClientOptions, serverSupabaseUrl, sessionCookieOptions } from "./lib/supabase/url";

// `publicPaths` ALSO bounces an authenticated user away (see the
// "Redirect authenticated users away from auth pages" check below) — only
// use it for pages that make no sense once signed in (login/signup).
const publicPaths = ["/login", "/signup"];
// `publicExactPaths`/`publicPrefixPaths` are public for an UNAUTHENTICATED
// visitor but never redirect an authenticated one away — /setup and
// /downloads/* are exactly as useful signed in as signed out (issue #127).
// /auth/callback (issue #134) MUST be reachable unauthenticated: it's the
// OAuth (Google) landing spot hit mid-flow, before a session exists — without
// this it would get bounced to /login?next=/auth/callback... and the code
// exchange in that route handler would never run.
// /membral-cli.tgz: the README's `npm i -g https://membral.me/membral-cli.tgz`
// runs before the user has any session, so the tarball must not redirect to /login.
// /proof: the recorded runs the signed-out landing links to.
const publicExactPaths = new Set(["/privacy", "/proof", "/terms", "/setup", "/auth/callback", "/membral-cli.tgz"]);
const publicPrefixPaths = ["/downloads/"];

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = serverSupabaseUrl();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return supabaseResponse;
  }

  const cookieOptions = sessionCookieOptions();
  const supabase = createServerClient(url, anonKey, {
    ...serverSupabaseClientOptions(),
    ...(cookieOptions ? { cookieOptions } : {}),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: {
          name: string;
          value: string;
          options?: Record<string, unknown>;
        }[],
      ) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options as Record<string, unknown>),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isAuthPath = publicPaths.some((p) => pathname.startsWith(p));
  const isPublicExact = publicExactPaths.has(pathname) || publicPrefixPaths.some((p) => pathname.startsWith(p));

  // #336: when the redirectTo isn't on Supabase's allow-list, or a flow
  // fails before it reaches /auth/callback, GoTrue sends the browser to the
  // Site URL (usually "/") with `?error=…&error_code=…&error_description=…`.
  // Without this the visitor landed on /pulse or the landing page with no
  // message. Route it to /login with the friendly copy. /login and
  // /auth/callback handle their own params.
  if (pathname !== "/login" && pathname !== "/auth/callback") {
    const sp = request.nextUrl.searchParams;
    const providerParams = {
      error: sp.get("error"),
      error_code: sp.get("error_code"),
      error_description: sp.get("error_description"),
    };
    if (providerParams.error_code || (providerParams.error && providerParams.error_description)) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = `?error=${providerErrorKey(providerParams)}`;
      return NextResponse.redirect(loginUrl);
    }
  }

  // Issue #127: "/" used to redirect unconditionally (even a logged-out
  // visitor never saw app/page.tsx's landing page) — the middleware's own
  // former comment attributed this to a Next 15.3 route-group
  // InvariantError, but the real cause was TWO page components resolving
  // to "/" at once: this one (app/page.tsx) and the now-deleted, unreachable
  // app/(dashboard)/page.tsx (no nav item ever linked to it; middleware
  // never let a request fall through to either). With only one "/" page
  // left, a logged-out visitor renders it directly; a logged-in one still
  // gets sent to /pulse (their actual home), matching every other
  // logged-in redirect in this file.
  if (pathname === "/") {
    if (user) {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = "/pulse";
      return NextResponse.redirect(homeUrl);
    }
    return supabaseResponse;
  }

  // Redirect unauthenticated users away from protected routes. Carries the
  // original path (+ query, e.g. /device?code=XXXX-XXXX for device-code
  // sign-in) through as ?next=... so login/signup can send the user back
  // where they were headed instead of always landing on the dashboard home.
  if (!user && !isAuthPath && !isPublicExact) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    const next = `${pathname}${request.nextUrl.search}`;
    if (next && next !== "/") {
      loginUrl.searchParams.set("next", next);
    }
    return NextResponse.redirect(loginUrl);
  }

  // Redirect authenticated users away from auth pages
  // A signed-in visitor sent here with ?error=<key> (e.g. from the root
  // catch-all above) still sees the message instead of being bounced.
  if (user && isAuthPath && !request.nextUrl.searchParams.get("error")) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/pulse"; // same landing as a fresh sign-in via "/" (#336)
    return NextResponse.redirect(homeUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - auth/v1/ (the local GoTrue stub: its own getUser() would call back into the app and loop)
     */
    "/((?!_next/static|_next/image|favicon.ico|api/|auth/v1/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4|webm)$).*)",
  ],
};
