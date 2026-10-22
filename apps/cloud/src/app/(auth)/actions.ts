"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isSignupsDisabledDbError } from "@/lib/auth-errors";
import { getAppUrl, isLocalRuntime, signupsDisabled, supabaseInternalUrl } from "@/lib/env";
import { clientIp, enforceRateLimit, ipBucket } from "@/lib/rate-limit";
import { safeNext } from "@/lib/safe-next";
import { ensureSignupsDisabledMarker } from "@/lib/signups-disabled-marker";
import { createClient } from "@/lib/supabase/server";
import { loginErrorKey, signupErrorQuery } from "../auth/messages";

// Per-IP app-level throttle (issue #127 abuse-hardening audit) — a backstop
// ahead of whatever Supabase Auth's own (unconfigured-here) limits are.
// Server actions don't get a NextRequest, so the IP comes from next/headers'
// own request-scoped headers() instead — same x-forwarded-for/x-real-ip
// precedence as rate-limit.ts's clientIp() (which this reuses directly).
/** Swaps SUPABASE_INTERNAL_URL's origin for NEXT_PUBLIC_SUPABASE_URL's in a browser-bound URL. No-op when no internal URL is set. */
function toPublicSupabaseUrl(url: string): string {
  const internal = supabaseInternalUrl();
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!internal || !publicUrl) return url;
  try {
    const from = new URL(internal);
    const target = new URL(url);
    if (target.origin !== from.origin) return url;
    const to = new URL(publicUrl);
    target.protocol = to.protocol;
    target.host = to.host;
    return target.toString();
  } catch {
    return url;
  }
}

async function requestIp(): Promise<string> {
  const hdrs = await headers();
  return clientIp({ headers: hdrs });
}

// safeNext() — same-origin `next` validation — now lives in
// @/lib/safe-next (issue #134: /auth/callback/route.ts needs it too, and a
// "use server" file like this one can only export async functions, so a
// plain sync helper can no longer live/be exported here). See that module
// for the full history/comment.

// Issue #133 adversarial review round 1 — signup()'s error branch used to
// classify a Supabase error with a bare `status === 429` clause, which
// matched EVERY 429 GoTrue can return, not just the one this issue is
// about. GoTrue's `POST /auth/v1/signup` returns (at least) three distinct
// error shapes worth telling apart here, not just "email cooldown vs.
// everything else":
//   - `over_email_send_rate_limit` WITH a "...you can only request this
//     after N seconds" message — the per-address post-signup cooldown.
//     The account from the FIRST submit already exists and its email
//     already went out; this is not a failure (the case #133 is about).
//   - `over_email_send_rate_limit` WITHOUT that message shape — GoTrue's
//     PROJECT-wide hourly email quota is exhausted (this repo's own
//     config.toml sets that quota to 2/hour locally, matching hosted's
//     built-in-mailer default). GoTrue rolls the signup back inside one DB
//     transaction in this case: no account was created, no email was
//     sent — the opposite of the cooldown case above, even though the
//     `code` field alone can't tell them apart.
//   - `over_request_rate_limit` — the per-IP endpoint limiter
//     (config.toml's `[auth.rate_limit] sign_in_sign_ups`). Fires BEFORE
//     any user is created. The removed `status === 429` clause used to
//     catch this one too and send it to the "already sent" page — a false
//     success for a request that created nothing.
// Every other error message is passed through as-is (`"other"`), except the
// DB-level signups-disabled trigger (migration 079), which gets the same
// friendly copy signup()'s top-of-function kill-switch check already shows
// — see isSignupsDisabledDbError()'s own comment for why that check lives
// in a shared module now (auth/callback/route.ts needs it too, for the
// Google sign-in path).
//
// R2-m3 (adversarial review round 2): the commit this replaced explicitly
// kept a message-shape fallback "for SDK versions or proxies that don't
// surface `code`" — dropped when this was rewritten to key off `code`
// alone. Restored as a last-resort check: a cooldown error arriving with
// no `code` at all would otherwise classify as `"other"` and put the raw
// "...you can only request this after N seconds." back on the signup error
// banner, i.e. the original #133 bug.
function classifySignupError(error: {
  code?: string;
  message: string;
}): "cooldown" | "quota" | "ip-rate-limit" | "signups-disabled" | "other" {
  if (error.code === "over_email_send_rate_limit") {
    return /only request this after/i.test(error.message) ? "cooldown" : "quota";
  }
  if (error.code === "over_request_rate_limit") {
    return "ip-rate-limit";
  }
  if (isSignupsDisabledDbError(error.message)) {
    return "signups-disabled";
  }
  if (!error.code && /only request this after/i.test(error.message)) {
    return "cooldown";
  }
  return "other";
}

export async function login(formData: FormData) {
  const next = safeNext(formData.get("next"));
  const suffix = next !== "/" ? `&next=${encodeURIComponent(next)}` : "";

  // Issue #127: per-IP throttle ahead of Supabase Auth's own (unconfigured
  // here) limits — a friendly form error, not a crash, on a limiter hit.
  const rl = await enforceRateLimit("loginIp", ipBucket("loginIp", await requestIp()));
  if (!rl.allowed) {
    redirect(`/login?error=rate_limited${suffix}`);
  }

  const supabase = await createClient();
  const data = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  };

  const { error } = await supabase.auth.signInWithPassword(data);

  if (error) {
    // Raw GoTrue text never reaches the URL; it stays in the server log.
    console.error("[auth] signInWithPassword failed:", { code: error.code, message: error.message });
    redirect(`/login?error=${loginErrorKey(error)}${suffix}`);
  }

  revalidatePath("/", "layout");
  redirect(next);
}

export async function signup(formData: FormData) {
  const next = safeNext(formData.get("next"));
  const suffix = next !== "/" ? `&next=${encodeURIComponent(next)}` : "";

  // MEMBRAL_SIGNUPS_DISABLED emergency kill-switch (issue #127) — checked
  // before the rate limiter so a closed-signups deployment doesn't even
  // spend a rate-limit-bucket write on a request it's going to refuse
  // anyway.
  //
  // #134 adversarial review round 3/4 (R3-B1/R3-M1/R4-M2): this is one of
  // the places that OBSERVES the switch reading ON and eagerly stamps the
  // durable marker — see lib/signups-disabled-marker.ts's module comment
  // for the full lifecycle this is part of (also: signInWithGoogle()
  // below, and auth/callback/route.ts). Never clears it — only
  // scripts/flags.ts's `signups on` does that (R4-M2: an app-side clear
  // would be deployment-local env state deciding shared DB state's fate).
  // Awaited so a slow DB write can't race the redirect() throw immediately
  // after it.
  const closed = signupsDisabled();
  if (closed) {
    await ensureSignupsDisabledMarker();
    redirect(`/signup?error=signups_closed${suffix}`);
  }
  // D-081: hosted never creates accounts, whatever the env says. Defence in
  // depth behind the page; login() and signInWithGoogle() are untouched.
  if (!isLocalRuntime()) {
    redirect(`/signup?error=signups_closed${suffix}`);
  }

  // Issue #127: per-IP throttle — see login()'s matching comment.
  const rl = await enforceRateLimit("signupIp", ipBucket("signupIp", await requestIp()));
  if (!rl.allowed) {
    redirect(`/signup?error=rate_limited${suffix}`);
  }

  const supabase = await createClient();
  const data = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  };

  // emailRedirectTo: only matters when the project has email confirmations
  // enabled (hosted deploys — see docs/DEPLOY.md; local dev leaves
  // enable_confirmations=false so this option is a no-op there and the
  // signed-up user is logged in immediately, unchanged from before). Passed
  // explicitly rather than relying on the project's dashboard-configured
  // Site URL alone, so the confirmation link lands back on whichever origin
  // actually served this request.
  const { data: signUpData, error } = await supabase.auth.signUp({
    ...data,
    options: { emailRedirectTo: `${getAppUrl()}/login` },
  });

  if (error) {
    // Issue #133 adversarial review round 1: see classifySignupError()'s
    // comment above for the full reasoning behind each branch.
    const classification = classifySignupError(error);

    if (classification === "cooldown") {
      // The FIRST signUp() already succeeded — the account was created and
      // a confirmation email sent — so this resubmit is not a failure at
      // all. Send the user to the same check-email page a fresh
      // no-session signup lands on (see below), with a param so that page
      // can say "already sent" instead of the generic first-time copy.
      redirect(`/signup/check-email?resent=1`);
    }

    if (classification === "quota") {
      // GoTrue rolled the signup back — no account exists, no email was
      // sent — so this must NOT land on the "already sent" check-email
      // page (that would tell the user to check an inbox that's getting
      // nothing).
      redirect(`/signup?error=email_quota${suffix}`);
    }

    if (classification === "ip-rate-limit") {
      // Nothing was created — this is the per-IP endpoint limiter, not the
      // per-address email cooldown above.
      redirect(`/signup?error=rate_limited${suffix}`);
    }

    if (classification !== "signups-disabled") {
      console.error("[auth] signUp failed:", { code: error.code, message: error.message });
    }
    const query = classification === "signups-disabled" ? "signups_closed" : signupErrorQuery(error);
    redirect(`/signup?error=${query}${suffix}`);
  }

  // Issue #127 (D9): email confirmation is ON (hosted — see config.toml's
  // comment) => signUp() succeeds but returns no session. The old behaviour
  // silently redirected to `next` anyway, landing a not-actually-logged-in
  // user on a page that immediately bounces them to /login with zero
  // explanation. Local dev (confirmations off) is unchanged: a session IS
  // returned, so this branch never triggers there.
  if (!signUpData.session) {
    redirect("/signup/check-email");
  }

  revalidatePath("/", "layout");
  redirect(next);
}

// Issue #133 adversarial review round 1, minor m1: the check-email page
// used to promise "you can request another link about a minute after the
// first one" with no way to actually do that — its only interactive
// element was a "Back to sign in" link. This is that mechanism.
// supabase.auth.resend() hits the same GoTrue endpoint/cooldown a signUp()
// resubmit does, so it reuses classifySignupError()'s exact same
// classification and copy. No email address is known server-side at this
// point (check-email/page.tsx deliberately never carries one through the
// URL — see its own comment on why), so the visitor re-enters it in the
// form this renders next to.
export async function resendConfirmation(formData: FormData) {
  const email = (formData.get("email") as string | null)?.trim();
  if (!email) {
    redirect(`/signup/check-email?error=email_required`);
  }

  // Same per-IP backstop as signup() — an unauthenticated resend endpoint
  // that accepts an arbitrary address is otherwise a free email-bombing
  // primitive. Reuses signupIp's bucket/limit rather than adding a new
  // named rule: both are unauthenticated, low-frequency, signup-adjacent
  // writes.
  const rl = await enforceRateLimit("signupIp", ipBucket("signupIp", await requestIp()));
  if (!rl.allowed) {
    redirect(`/signup/check-email?error=rate_limited`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({ type: "signup", email });

  if (error) {
    const classification = classifySignupError(error);
    if (classification === "cooldown") {
      redirect(`/signup/check-email?resent=1`);
    }
    if (classification === "quota") {
      redirect(`/signup/check-email?error=email_quota`);
    }
    if (classification === "ip-rate-limit") {
      redirect(`/signup/check-email?error=rate_limited`);
    }
    // R2-m1 (adversarial review round 2): this fallthrough used to forward
    // error.message verbatim (already-confirmed address, malformed input,
    // GoTrue internal errors) — the exact raw-provider-text leak M4 closed
    // for the callback route one file over, reopened here. Log it
    // server-side only, same pattern as route.ts's friendlyCallbackError()
    // call sites.
    console.error("[resendConfirmation] resend failed:", error.message);
    redirect(`/signup/check-email?error=resend_failed`);
  }

  redirect(`/signup/check-email?resent=1`);
}

// Issue #134: "Continue with Google" on both /login and /signup. Both pages
// submit the same server action — signInWithOAuth() doesn't distinguish a
// sign-in from a sign-up (Google/GoTrue handle "does this identity already
// exist" on their side), so one action covers both entry points.
//
// Account linking (documented here since there's no UI surface for it):
// Supabase auto-links a new Google identity onto an existing row in
// auth.users only when the email is already CONFIRMED there (i.e. an
// existing user who finished email/password confirmation, or an earlier
// Google sign-in with the same address). If the existing row is an
// email/password signup that never confirmed, GoTrue does NOT silently
// link — it returns an error from exchangeCodeForSession() in the callback
// route. Adversarial review round 1 (M4) changed that route to map GoTrue's
// raw error text to short plain copy instead of forwarding it verbatim —
// see route.ts's friendlyCallbackError() — so an identity-conflict here now
// reads as the same generic "Google sign-in failed. Try again." a caller
// sees; this comment exists so a report of "signed in with Google, got
// bounced to /login with an error" starts here (and route.ts's own
// console.error) instead of a fresh investigation.
//
// Signups-disabled kill-switch (adversarial review round 1, M3): this
// function deliberately does NOT call signupsDisabled() up front the way
// signup() does. signInWithOAuth() only starts the round trip — it can't
// yet tell whether Google will hand back an EXISTING user (a login, which
// the issue explicitly wants to keep working while signups are closed) or
// mint a NEW one (a signup, which should be blocked). That distinction is
// only knowable once the code comes back, so the actual enforcement lives
// in /auth/callback/route.ts's isNewlyCreatedUser() check, run AFTER
// exchangeCodeForSession(). The DB-level kill-switch (migration 079's
// trigger) needs no equivalent special-casing here: it blocks the
// auth.users insert itself, inside GoTrue, before this function ever sees
// a response — route.ts's friendlyCallbackError() gives that case the same
// copy signup() shows.
export async function signInWithGoogle(formData: FormData) {
  const next = safeNext(formData.get("next"));
  const suffix = next !== "/" ? `&next=${encodeURIComponent(next)}` : "";

  // Adversarial review round 1, minor m5: this was the one unthrottled
  // auth entry point in this file — login()/signup() both call
  // enforceRateLimit() first. Reuses loginIp's bucket/limit: this action
  // covers both /login's and /signup's "Continue with Google" button (see
  // the comment above), and its abuse surface (minting a Google OAuth
  // redirect URL) sits closer to login's than to signup's tighter default.
  const rl = await enforceRateLimit("loginIp", ipBucket("loginIp", await requestIp()));
  if (!rl.allowed) {
    redirect(`/login?error=rate_limited${suffix}`);
  }

  // #134 adversarial review round 3/4 (R3-M1/R4-M2): eagerly ensure the
  // signups_disabled_at marker BEFORE redirecting to Google — this is what
  // closes the race where GoTrue creates the auth.users row (during ITS
  // OWN callback hop with Google, before this app ever sees a `code`)
  // faster than our own /auth/callback route could stamp the marker after
  // the fact. This does NOT block anyone here — an existing user must
  // still be able to start the OAuth round trip while signups are closed
  // (see the big comment above) — it only ensures the durable marker
  // exists so THAT route's later comparison is correct no matter which
  // observation point sees the switch on first. Never clears it when
  // signups are open — see lib/signups-disabled-marker.ts's module comment
  // (R4-M2) for why an app-side clear was removed.
  if (signupsDisabled()) {
    await ensureSignupsDisabledMarker();
  }

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${getAppUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error || !data.url) {
    // Adversarial review round 1, minor m5: preserve `next` on the error
    // redirect, matching login()/signup() — previously dropped, so a user
    // bounced off e.g. /device?code=XXXX-XXXX lost their destination if
    // Google sign-in failed to even start.
    if (error) console.error("[auth] signInWithOAuth failed:", { code: error.code, message: error.message });
    redirect(`/login?error=generic${suffix}`);
  }

  // The server client may talk to SUPABASE_INTERNAL_URL (self-hosted container), so the
  // authorize URL it returns can carry that host. The browser needs the public one.
  redirect(toPublicSupabaseUrl(data.url));
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
