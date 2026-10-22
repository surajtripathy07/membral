// Truthful sign-in / sign-up copy for every auth failure path (#133, #336).
// URLs carry a short KEY (`/login?error=invalid_credentials`), never prose:
// the pages resolve the key through the fixed table below, so a crafted link
// cannot put attacker-written text on our domain. Unknown key -> generic.
// Pure functions only: this file is imported by edge middleware.
import { isSignupsDisabledDbError } from "@/lib/auth-errors";

export const AUTH_ERROR_COPY = {
  invalid_credentials: "Wrong email or password.",
  email_not_confirmed: "Your email isn't confirmed yet. Check your inbox for the confirmation link.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  signups_closed: "Sign-ups are closed.",
  oauth_expired: "Sign-in expired or was started in another browser. Try again.",
  otp_expired: "The sign-in link expired. Try again.",
  cancelled: "Sign-in was cancelled.",
  weak_password: "Choose a stronger password.",
  email_invalid: "Enter a valid email address.",
  user_exists: "If you already have an account, sign in.",
  email_quota: "We couldn't send the confirmation email right now. Try again in an hour.",
  email_required: "Enter the email address you signed up with.",
  resend_failed: "We couldn't resend the confirmation link. Try again in a moment.",
  missing_code: "Sign-in could not finish. Try again.",
  signup_failed: "We couldn't create your account. Try again.",
  generic: "Sign-in failed. Try again.",
} as const;

export type AuthErrorKey = keyof typeof AUTH_ERROR_COPY;

// `min` (from `&min=8`) is only honoured as a bounded integer.
export function authErrorCopy(
  key: string | null | undefined,
  min?: string | null,
  fallback: AuthErrorKey = "generic",
): string {
  if (!key || !Object.hasOwn(AUTH_ERROR_COPY, key)) return AUTH_ERROR_COPY[fallback];
  if (key === "weak_password") {
    const n = Number(min);
    if (Number.isInteger(n) && n >= 1 && n <= 128) {
      return `Choose a stronger password (at least ${n} characters).`;
    }
  }
  return AUTH_ERROR_COPY[key as AuthErrorKey];
}

type AuthErrorLike = { code?: string; status?: number; message?: string };

export function loginErrorKey(error: AuthErrorLike): AuthErrorKey {
  const code = error.code ?? "";
  const raw = error.message ?? "";
  if (code === "invalid_credentials" || (!code && /invalid login credentials/i.test(raw))) return "invalid_credentials";
  if (code === "email_not_confirmed" || (!code && /email not confirmed/i.test(raw))) return "email_not_confirmed";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || error.status === 429) {
    return "rate_limited";
  }
  return "generic";
}

// Sign-up errors not already classified as cooldown / quota / ip limit.
// Returns the query string tail (key plus optional min) after `error=`.
export function signupErrorQuery(error: AuthErrorLike & { reasons?: string[] }): string {
  const code = error.code ?? "";
  if (code === "weak_password") {
    const m = /at least (\d{1,3})/i.exec(error.message ?? "");
    return m ? `weak_password&min=${m[1]}` : "weak_password";
  }
  if (code === "email_address_invalid" || code === "validation_failed") return "email_invalid";
  if (code === "user_already_exists" || code === "email_exists") return "user_exists";
  return "signup_failed";
}

type ProviderErrorParams = {
  error?: string | null;
  error_code?: string | null;
  error_description?: string | null;
};

// Maps the `error` / `error_code` / `error_description` triple GoTrue appends
// to a redirect, and exchangeCodeForSession messages, to a key.
export function providerErrorKey(p: ProviderErrorParams): AuthErrorKey {
  const combined = [p.error, p.error_code, p.error_description].filter(Boolean).join(" ");
  const code = p.error_code ?? "";
  if (code === "signup_disabled" || isSignupsDisabledDbError(combined) || /signup_disabled/i.test(combined)) {
    return "signups_closed";
  }
  if (code === "otp_expired") return "otp_expired";
  if (
    code === "bad_oauth_state" ||
    code === "bad_oauth_callback" ||
    code.startsWith("flow_state_") ||
    /bad_oauth_state|flow state|pkce code verifier/i.test(combined)
  ) {
    return "oauth_expired";
  }
  if (p.error === "access_denied" || code === "access_denied") return "cancelled";
  return "generic";
}
