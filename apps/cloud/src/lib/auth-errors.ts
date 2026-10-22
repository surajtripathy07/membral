// Shared Supabase Auth error-message classification (issue #134
// adversarial review round 1, M3). Migration 079's `enforce_signups_enabled`
// trigger on auth.users is the DB-level backstop for the
// MEMBRAL_SIGNUPS_DISABLED env kill-switch — it blocks ANY new auth.users
// insert while the DB's app_settings.signups_disabled row is on, regardless
// of which code path triggered the insert: password signup() in
// app/(auth)/actions.ts, OR Google OAuth auto-provisioning a brand-new
// identity via app/auth/callback/route.ts. Local GoTrue (Supabase CLI,
// verified live) passes the raised message through verbatim as
// "signups_disabled"; some hosted GoTrue versions instead wrap ANY failed
// auth.users insert trigger into a generic "Database error saving new
// user" — this trigger's only failure mode is the kill-switch, so that
// generic message is safe to treat the same way here.
//
// Previously this regex lived only inline inside signup(); pulled out here
// so route.ts's Google sign-in path shows the exact same friendly copy
// instead of leaking the raw DB error string (which is what M4 flagged).
export function isSignupsDisabledDbError(message: string): boolean {
  return /signups_disabled|database error saving new user/i.test(message);
}

export const SIGNUPS_CLOSED_MESSAGE = "Signups are currently closed.";
