// Shared constant for /code/stats' ?days= window (7/30/90, default 30 —
// matching GET /api/code-sessions/stats' own default).
//
// Deliberately NOT in days-control.tsx: that file is "use client", and
// Next's RSC boundary turns every export of a "use client" module into an
// opaque client reference when imported from a Server Component — even a
// plain constant array. page.tsx (a Server Component) importing
// STATS_WINDOW_OPTIONS from days-control.tsx produced
// "STATS_WINDOW_OPTIONS.includes is not a function" at runtime for exactly
// that reason. This file has no directive, so both the server page and the
// client control import the same array safely.
export const STATS_WINDOW_OPTIONS = [7, 30, 90] as const;
export type StatsWindowDays = (typeof STATS_WINDOW_OPTIONS)[number];
