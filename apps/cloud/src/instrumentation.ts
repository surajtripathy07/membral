// Next.js instrumentation hook (stable since Next 14.1, no config flag
// needed) — `register()` runs once when the server process starts, in every
// runtime the app uses. This is issue #12's boot-time fail-fast: a
// production deploy missing a required env var refuses to start and names
// every missing var, instead of throwing lazily the first time some
// unrelated request happens to touch it.
//
// NOT invoked during `next build` (only `next start` / a serverless cold
// start) — so this never blocks or slows down the build itself, only a
// misconfigured *running* deployment.
export async function register() {
  const { validateEnvAtBootOnNode } = await import("@/lib/env");
  validateEnvAtBootOnNode();
}
