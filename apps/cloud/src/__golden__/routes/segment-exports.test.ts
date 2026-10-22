// Segment-config + handler-export pin (G3 step 3A-3, test-first part). Guards the later
// `withRoute` wrapper (3A-3b) and per-route wrapping (3A-4): neither may silently drop or
// change a route's Next.js segment-config exports (`runtime`/`dynamic`/`maxDuration`/
// `revalidate` — name AND value) or its set of exported HTTP handlers.
//
// Complements scripts/check-vercel-functions.mjs rather than duplicating it: that script only
// asserts every apps/cloud/vercel.json `functions` glob matches at least one file (so a route
// move can't silently orphan a glob); it never checks that a route's own `maxDuration` value
// agrees with what vercel.json promises for it. The second assertion below closes that gap for
// `app/api/account/**`, whose one `maxDuration` export carries an inline comment pointing at the
// vercel.json mirror (see apps/cloud/src/app/api/account/export/route.ts).
//
// Per file this derives {segment, handlers} by IMPORTING the built module (dynamic `import()`
// through the "@" alias, real values — e.g. `maxDuration: 300`, not a string) under the same
// four external mocks every other route golden uses (@supabase/supabase-js, @supabase/ssr,
// next/headers, next/server's `after`). A file whose top-level imports still fail under those mocks falls back to a
// static regex scan of the file text; `method` on each entry records which path ran.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GOLDEN_ENV } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "../../app/api");
const VERCEL_JSON = resolve(HERE, "../../../vercel.json");

const SEGMENT_KEYS = ["runtime", "dynamic", "maxDuration", "revalidate"] as const;
const HANDLER_NAMES = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

interface RouteEntry {
  file: string;
  method: "import" | "regex";
  segment: Partial<Record<(typeof SEGMENT_KEYS)[number], unknown>>;
  handlers: string[];
}

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) out.push(...findRouteFiles(full));
    else if (ent.name === "route.ts") out.push(full);
  }
  return out;
}

/** `.../src/app/api/foo/bar/route.ts` -> `foo/bar/route.ts`, forward-slashed, for the snapshot key. */
function toApiRelative(absPath: string): string {
  return relative(API_DIR, absPath).split("\\").join("/");
}

/** `.../src/app/api/foo/bar/route.ts` -> `@/app/api/foo/bar/route` for the dynamic-import specifier. */
function toImportSpecifier(absPath: string): string {
  return `@/app/api/${toApiRelative(absPath).replace(/\.ts$/, "")}`;
}

function regexScan(absPath: string): { segment: RouteEntry["segment"]; handlers: string[] } {
  const text = readFileSync(absPath, "utf8");
  const segment: RouteEntry["segment"] = {};
  for (const key of SEGMENT_KEYS) {
    const m = text.match(new RegExp(`^export const ${key}\\s*=\\s*([^;\\n]+);`, "m"));
    if (m)
      segment[key] = JSON.parse(
        m[1]
          .trim()
          .replace(/^"(.*)"$/, '"$1"')
          .replace(/'/g, '"'),
      );
  }
  const handlers = HANDLER_NAMES.filter((h) =>
    new RegExp(`^export (async function|function|const) ${h}\\b`, "m").test(text),
  );
  return { segment, handlers };
}

async function loadEntry(absPath: string): Promise<RouteEntry> {
  const file = toApiRelative(absPath);
  try {
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ toImportSpecifier(absPath));
    const segment: RouteEntry["segment"] = {};
    for (const key of SEGMENT_KEYS) if (key in mod) segment[key] = mod[key];
    const handlers = HANDLER_NAMES.filter((h) => typeof mod[h] === "function");
    return { file, method: "import", segment, handlers };
  } catch {
    const { segment, handlers } = regexScan(absPath);
    return { file, method: "regex", segment, handlers };
  }
}

describe("route segment-config + handler exports (pin)", () => {
  for (const [k, v] of Object.entries(GOLDEN_ENV)) vi.stubEnv(k, v);

  // 30s: ~47 dynamic route imports can outrun vitest's 5s default under the coverage run (#320).
  it("matches the committed snapshot for every app/api/**/route.ts file", async () => {
    const files = findRouteFiles(API_DIR).sort((a, b) => toApiRelative(a).localeCompare(toApiRelative(b)));
    const entries = await Promise.all(files.map(loadEntry));
    await expect(`${JSON.stringify(entries, null, 2)}\n`).toMatchFileSnapshot("./segment-exports.json");
  }, 30_000);

  it("account/** maxDuration exports match apps/cloud/vercel.json's functions entry for them", async () => {
    // scripts/check-vercel-functions.mjs only asserts the glob matches >=1 file; it never checks
    // the maxDuration VALUE agrees, so this closes that gap (see the file-level comment above).
    const vercelConfig = JSON.parse(readFileSync(VERCEL_JSON, "utf8"));
    const expected = vercelConfig.functions?.["src/app/api/account/**/route.ts"]?.maxDuration;
    expect(expected).toBeTypeOf("number");

    const accountFiles = findRouteFiles(resolve(API_DIR, "account"));
    const withMaxDuration = accountFiles.filter((f) => {
      const text = readFileSync(f, "utf8");
      return /^export const maxDuration\s*=/m.test(text);
    });
    expect(withMaxDuration.length).toBeGreaterThan(0);
    for (const f of withMaxDuration) {
      const text = readFileSync(f, "utf8");
      const m = text.match(/^export const maxDuration\s*=\s*(\d+)/m);
      expect(Number(m?.[1]), toApiRelative(f)).toBe(expected);
    }
  });
});
