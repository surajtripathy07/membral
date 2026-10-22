// Single source of truth for the "email us" address shown across the public
// pages and the API's own feature-disabled bodies (round-5 verification F2:
// the address used to be hardcoded separately in privacy/page.tsx,
// terms/page.tsx, and lib/feature-flags.ts — three literals that could (and
// did) drift). Every one of those now imports `getContactEmail`/
// `CONTACT_EMAIL` from here instead of hardcoding the string.
//
// MEMBRAL_CONTACT_EMAIL / DNS for the fallback domain are the maintainer's
// task (see docs/DEPLOY.md) — this module does not change or validate the
// address, only centralizes where every page reads it from.

/**
 * Hardcoded fallback so a missing `MEMBRAL_CONTACT_EMAIL` env var never
 * produces a dead-end "email nobody" message. Exported (not just used
 * internally) so a component that renders statically at build time
 * (e.g. `/setup`, which has `export const dynamic = "force-static"`) can
 * still reference the same literal without a duplicate copy.
 */
export const CONTACT_EMAIL_FALLBACK = "support@membral.me";

/** Reads `MEMBRAL_CONTACT_EMAIL`, falling back to {@link CONTACT_EMAIL_FALLBACK} when unset/blank. */
export function getContactEmail(env: Record<string, string | undefined> = process.env): string {
  const raw = env.MEMBRAL_CONTACT_EMAIL?.trim();
  return raw && raw.length > 0 ? raw : CONTACT_EMAIL_FALLBACK;
}
