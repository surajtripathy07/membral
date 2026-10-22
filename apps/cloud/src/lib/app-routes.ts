// Canonical top-level page routes in apps/cloud's App Router (issue #134
// adversarial review round 1, BLOCKER B1: the OAuth callback used to
// hardcode a default landing path of "/dashboard", a route that has never
// existed — `app/(dashboard)/page.tsx` was deleted, and the `(dashboard)`
// route GROUP's parentheses contribute no URL segment on their own; see
// middleware.ts's comment on why that page was removed). Used by
// app/auth/callback/__tests__/route.test.ts to assert that whatever the
// callback's default `next` resolves to is an actual page in this app, not
// a hand-typed guess that happens to look plausible.
//
// Keep in sync with `find src/app -name page.tsx` (top-level only — dynamic
// `[param]` segments are omitted since a default landing route is never
// parameterized, and route-group parentheses are dropped since they don't
// appear in the URL).
export const APP_ROUTES = [
  "/",
  "/login",
  "/signup",
  "/signup/check-email",
  "/privacy",
  "/proof",
  "/setup",
  "/terms",
  "/code",
  "/conversations",
  "/device",
  "/import",
  "/memories",
  "/pulse",
  "/search",
  "/settings",
] as const;
