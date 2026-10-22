// Which server `npm run smoke` starts when nothing answers on :3001.
//   start — `next start` on the production build turbo already made (CI
//           default: `next dev` compiled the session page cold in 15-20 s
//           and exceeded Playwright's 30 s budget on every red main run).
//   dev   — `next dev` (local default; the maintainer's .next is often a
//           dev build, and building cloud while dev runs corrupts it).
export function resolveSmokeMode(env) {
  const explicit = env.SMOKE_MODE?.trim().toLowerCase();
  if (explicit === "start" || explicit === "dev") return explicit;
  if (explicit) throw new Error(`SMOKE_MODE must be "start" or "dev", got "${env.SMOKE_MODE}"`);
  return env.CI ? "start" : "dev";
}
