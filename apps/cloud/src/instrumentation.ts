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
  // Local stack only (rung one): the in-process extraction loop replaces the kicker container. A no-op elsewhere.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { isLocalMode } = await import("@/lib/local/mode");
    if (!isLocalMode()) return;
    // Embedded store (rung two): open it BEFORE anything queries. Next waits for register() to finish.
    const { storeKind } = await import("@/lib/env");
    if (storeKind() === "pglite") {
      const { bootEmbeddedStore } = await import("@/lib/local/store/boot");
      await bootEmbeddedStore();
    }
    const { startExtractionLoop } = await import("@/lib/memory/extraction-loop");
    startExtractionLoop();
  }
}
