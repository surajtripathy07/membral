// D10 guard (R4 4.12, docs/archive/goals/2026-09-28_r4-edges-hardening_goal.md V10): every
// app/api route.ts that does not use withRoute must be listed here with the reason it
// stays hand-written. Same test as the V10 command
// (`find apps/cloud/src/app/api -name route.ts | xargs grep -L 'withRoute'`): a file
// "uses withRoute" when its source mentions it. A new unwrapped route fails this test
// until it is wrapped or listed with a reason; a listed route that gets wrapped or
// deleted fails it until its entry is removed.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_DIR = fileURLToPath(new URL("../../../app/api", import.meta.url));

/** Path under app/api (no trailing /route.ts) -> why it is not wrapped. */
const UNWRAPPED_BY_DESIGN: Record<string, string> = {
  // M11 classes (G3 step 3A-4): auth or shape withRoute does not express.
  "internal/cron/memory-extraction":
    "cron class (M11): Vercel Cron caller, already on the shared requireCronSecret adapter; no user, no rate limit",
  "memory/extract-next":
    "worker class (M11): internal hop authenticated by checkMemoryWorkerAuth, not a user credential",
  health: "public liveness probe: no auth, no rate limit, its own degraded-status shape",
  "auth/device/poll": "device pre-auth: no credential yet; rate limit keyed on the device code before any user exists",
  "auth/device/start": "device pre-auth: no credential yet; per-IP limit on minting a device code",
};

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const unwrapped = routeFiles(API_DIR)
  .filter((f) => !readFileSync(f, "utf8").includes("withRoute"))
  .map((f) => relative(API_DIR, f).replace(/\/route\.ts$/, ""))
  .sort();

describe("unwrapped app/api routes (D10)", () => {
  it("every unwrapped route is listed with a reason", () => {
    const unlisted = unwrapped.filter((r) => !(r in UNWRAPPED_BY_DESIGN));
    expect(unlisted, "wrap these with withRoute, or add them to UNWRAPPED_BY_DESIGN with a reason").toEqual([]);
  });
  it("every listed route still exists and is still unwrapped", () => {
    const stale = Object.keys(UNWRAPPED_BY_DESIGN).filter((r) => !unwrapped.includes(r));
    expect(stale, "remove these entries from UNWRAPPED_BY_DESIGN").toEqual([]);
  });
  it("every reason is a real sentence", () => {
    for (const [route, reason] of Object.entries(UNWRAPPED_BY_DESIGN)) {
      expect(reason.trim().length, route).toBeGreaterThan(10);
    }
  });
  it("the list is the goal's by-design routes plus the recorded 4.12 exception", () => {
    expect(unwrapped).toHaveLength(Object.keys(UNWRAPPED_BY_DESIGN).length);
  });
});
