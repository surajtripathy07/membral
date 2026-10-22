// GET /auth/callback — issue #134, OAuth (Google) sign-in landing spot.
//
// signInWithGoogle() in ../../(auth)/actions.ts sends the browser to Google
// with `redirectTo` set to `${appUrl}/auth/callback?next=<validated path>`.
// Supabase's own auth server owns the actual Google round trip and, once
// Google redirects back to *it*, forwards the browser here with a `code`
// query param appended to that same redirectTo URL — so `next` survives
// unchanged and `code` is new. exchangeCodeForSession() trades that code for
// a session and (via the cookie-based server client) sets the session
// cookies on this response.
//
// Deliberately outside the (auth) route group: that group's URL space is
// /login and /signup only (see its layout.tsx) and existing paths there
// don't include /auth/*, so this lives at a real `app/auth/callback`
// segment to land exactly on `/auth/callback` — matching what
// signInWithGoogle() and Supabase's redirect literally build.
import { type NextRequest, NextResponse } from "next/server";
import { signupsDisabled } from "@/lib/env";
import { safeNext } from "@/lib/safe-next";
import { wasCreatedWhileSignupsDisabled } from "@/lib/signups-disabled-marker";
import { createClient } from "@/lib/supabase/server";
import { providerErrorKey } from "../messages";

// #134 adversarial review round 1, MAJOR M3 (raw GoTrue/SDK error text
// shown to end users): map the handful of error shapes this route actually
// sees to one short plain sentence each; every other message collapses to
// a generic one. GoTrue's raw messages run ~300 characters, name unrelated
// frameworks (SvelteKit, @supabase/ssr) and read as a crash to an end user,
// not an auth failure — and the PKCE "verifier not found" case is the MOST
// LIKELY real-world error here (any stale/bookmarked callback link, or an
// OAuth flow started in one browser and finished in another), not an
// exotic one, so it earns its own actionable copy. The raw message is
// still logged server-side via console.error below so a real report can be
// diagnosed from the server logs instead of the URL bar.
// (#336: the mapping now lives in ../messages so the middleware shares it.)
function friendlyCallbackError(rawMessage: string): string {
  return providerErrorKey({ error_description: rawMessage });
}

// #134 adversarial review round 1, MAJOR M3 (signups kill-switch parity):
// supabase.auth.signInWithOAuth() can't tell "is this a login or a signup"
// at initiation time — signInWithGoogle() in ../../(auth)/actions.ts
// deliberately does NOT check signupsDisabled() up front (see its own
// comment) because doing so would also block an EXISTING user's Google
// login while signups are closed, which the issue explicitly wants to keep
// working. Google/GoTrue only reveal "was this identity just created" once
// the code comes back — so that's enforced HERE, after the exchange. Round
// 2 (R2-B1) found the original "created_at within a few seconds of
// last_sign_in_at" heuristic was NOT retry-proof — see
// wasCreatedWhileSignupsDisabled()'s own module comment (lib/
// signups-disabled-marker.ts) for the durable, monotonic replacement.

// #134 adversarial review round 1, MINOR m3 (redirect targeted getAppUrl(),
// not the origin that actually served the request — bounced Vercel preview
// deploys, and any other non-canonical origin, to production membral.me)
// and m4 (an unvalidated NEXT_PUBLIC_APP_URL turned this into an
// unrecoverable 500, since `NextResponse.redirect()` on a schemeless
// string throws). `request.url` is always a valid absolute URL for an
// incoming request, so resolving `path` against it can't throw, and it
// naturally lands back on whichever host actually served this request —
// matching how every other redirect in this app (next/navigation's
// `redirect()`, used by (auth)/actions.ts) already behaves.
function redirectTo(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  // safeNext() rejects anything but a same-origin root-relative path
  // (absolute URLs, protocol-relative `//evil.com`, backslash tricks,
  // control chars — see its own module comment) and falls back to "/".
  //
  // #134 adversarial review round 1, BLOCKER B1: this route used to
  // override that "/" fallback to "/dashboard" — a route that has never
  // existed in this app (see lib/app-routes.ts's comment). Every default
  // Google sign-in landed on a 404. Fixed by using safeNext()'s bare "/"
  // directly: that's the EXACT SAME default (auth)/actions.ts's login() and
  // signup() already use for a successful sign-in with no explicit `next`
  // — `redirect("/")`, which middleware.ts's own "/" handling then bounces
  // an authenticated visitor to /pulse. Reusing it here (rather than
  // inventing a second "the app's real home" constant) keeps every sign-in
  // path — password or Google — landing in exactly the same place.
  const next = safeNext(searchParams.get("next"));

  // #134 adversarial review round 2, MAJOR R2-M1: GoTrue reports every
  // POST-CONSENT failure — the user cancelling on Google's consent screen,
  // migration 079's DB kill-switch tripping during GoTrue's OWN internal
  // auth.users insert, a misconfigured provider — via `error`/`error_code`/
  // `error_description` query params on THIS redirect, WITHOUT a `code`.
  // That's because GoTrue creates the auth.users row and links the
  // identity during its own /auth/v1/callback hop with Google, before this
  // app is ever handed a code to exchange — so a post-consent failure never
  // reaches exchangeCodeForSession() at all. Previously only `code`/`next`
  // were read here, so every one of these cases fell through to the
  // generic "Missing sign-in code." — including the single most common
  // non-success outcome (clicking "Cancel" on Google's consent screen) and
  // the one error that's supposed to explain the DB kill-switch. Reusing
  // friendlyCallbackError() below (rather than a second copy of its
  // mapping) is what makes its isSignupsDisabledDbError() branch actually
  // reachable: migration 079's `signups_disabled` message arrives on THIS
  // channel, not as an exchangeCodeForSession error.
  const providerError = searchParams.get("error");
  const providerErrorCode = searchParams.get("error_code");
  const providerErrorDescription = searchParams.get("error_description");

  if (providerError || providerErrorCode || providerErrorDescription) {
    console.error("[auth/callback] provider error channel:", {
      error: providerError,
      error_code: providerErrorCode,
      error_description: providerErrorDescription,
    });
    const message = providerErrorKey({
      error: providerError,
      error_code: providerErrorCode,
      error_description: providerErrorDescription,
    });
    return redirectTo(request, `/login?error=${message}`);
  }

  if (!code) {
    return redirectTo(request, `/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // See friendlyCallbackError()'s comment above: the raw message never
    // reaches the URL/UI, only this server-side log.
    console.error("[auth/callback] exchangeCodeForSession failed:", error.message);
    return redirectTo(request, `/login?error=${friendlyCallbackError(error.message)}`);
  }

  // #134 adversarial review round 1, MAJOR M3 continued (round 2's R2-B1
  // fix, and round 3's R3-B1/R3-M1 fixes to THAT fix — see
  // wasCreatedWhileSignupsDisabled's module comment, lib/
  // signups-disabled-marker.ts, for the full lifecycle): the
  // MEMBRAL_SIGNUPS_DISABLED env kill-switch (checked up front by
  // signup()) never touches the DB, so it's otherwise invisible to Google
  // OAuth, which auto-creates auth.users rows on its own.
  // R4-M2 (round 4): this route never CLEARS the marker — only
  // scripts/flags.ts's `signups on` does that now. See lib/
  // signups-disabled-marker.ts's module comment for why an app-side clear
  // was removed (deployment-local env state deciding shared DB state's
  // fate).
  if (data.user && signupsDisabled()) {
    // R3-B1/R3-M1 belt-and-braces (round 3): a user with ANY non-Google
    // identity already linked (email/password, or a prior confirmed
    // Google sign-in from before this incident) is never blocked here,
    // regardless of what the marker says — linking a new identity onto
    // an existing auth.users row does not change that row's created_at,
    // so this is redundant with the marker comparison in the common
    // case, but it's a cheap extra guard against ever refusing someone
    // who plainly isn't a fresh Google-only signup.
    const hasNonGoogleIdentity = (data.user.identities ?? []).some((identity) => identity.provider !== "google");
    if (!hasNonGoogleIdentity && (await wasCreatedWhileSignupsDisabled(data.user.created_at))) {
      // Reversible: sign the session out (a maintainer flipping the
      // switch back on can just let the person log in again) rather than
      // deleting the auth.users row, which isn't this app's call to make
      // automatically. The row is left in place; the console.error below
      // is the only record of it for a maintainer to review. This check
      // is MONOTONIC per row and its window is scoped to THIS incident
      // (see the marker module) — unlike round 1's timing heuristic,
      // retrying cannot flip the answer, and unlike round 2's marker,
      // a LATER incident does not reuse this one's window.
      await supabase.auth.signOut();
      console.error(
        `[auth/callback] Google sign-in auto-created user ${data.user.id} while signups are disabled ` +
          "(MEMBRAL_SIGNUPS_DISABLED); session revoked, auth.users row left in place for a maintainer to review.",
      );
      return redirectTo(request, `/login?error=signups_closed`);
    }
  }

  return redirectTo(request, next);
}
