import { crx } from "@crxjs/vite-plugin";
import { resolve } from "path";
import { defineConfig } from "vite";
import baseManifest from "./manifest.json";

// Issue #126 verification finding 16: the single committed manifest.json
// lists BOTH `https://membral.me/*` and `http://localhost:3000/*` in
// host_permissions, so a published production build used to request
// localhost access it never uses (an unnecessary permission, and a routine
// Chrome Web Store review question). `manifest.json` stays the dev-complete
// source of truth (local dev — `npm run dev`, mode "development" — needs
// localhost so the options page / background worker can reach a local
// `next dev` cloud instance); a normal `npm run build` (mode "production",
// vite's default with no --mode flag) strips the localhost origin here,
// before crx ever sees it — never in the checked-in JSON itself.
// Fresh-clone report gotcha (issue #128 self-hosting audit, #130): a
// self-hoster running `apps/cloud`'s dev server on a non-default port (their
// own 3000 already taken, `next dev -p <other>`, etc.) needs the dev
// manifest's localhost host_permission to match — the checked-in
// manifest.json hardcodes `http://localhost:3000/*`, which silently fails
// (no host permission for their actual origin, no console error either —
// chrome.runtime.sendMessage just never reaches a background page that
// never registered the right origin) if their cloud app isn't ALSO on 3000.
// Derives the port from VITE_CLOUD_URL when set (the same var
// package-extension.mjs already threads through for a packaged build's
// manifest — see that script), defaulting to 3000 (this repo's own
// documented default, CLAUDE.md) when unset or unparseable.
function localhostOriginFromCloudUrl(): string {
  const DEFAULT_PORT = "3000";
  const raw = process.env.VITE_CLOUD_URL;
  if (!raw) return `http://localhost:${DEFAULT_PORT}/*`;
  try {
    const port = new URL(raw).port || DEFAULT_PORT;
    return `http://localhost:${port}/*`;
  } catch {
    return `http://localhost:${DEFAULT_PORT}/*`;
  }
}

export default defineConfig(({ mode }) => {
  const manifest =
    mode === "development"
      ? {
          ...baseManifest,
          host_permissions: baseManifest.host_permissions.map((origin) =>
            origin === "http://localhost:3000/*" ? localhostOriginFromCloudUrl() : origin,
          ),
        }
      : {
          ...baseManifest,
          host_permissions: baseManifest.host_permissions.filter((origin) => origin !== "http://localhost:3000/*"),
        };

  // Issue #127 round-2 review, BLOCKER 1: apps/cloud/scripts/package-extension.mjs
  // builds this extension for the public /setup download with an explicit,
  // deployment-derived env contract (VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY/
  // VITE_CLOUD_URL passed as real child-process env vars, mirroring
  // NEXT_PUBLIC_*). Vite loads `.env`/`.env.local`/`.env.<mode>(.local)` from
  // `envDir` in EVERY mode, production included — so the maintainer's own
  // untracked packages/extension/.env.local (local Supabase config) would
  // otherwise silently seed or override those values in the packaged zip,
  // regardless of what the packaging script passed in. When
  // MEMBRAL_PACKAGE_ENV_DIR is set (ONLY the packaging script sets it —
  // never `npm run dev`/`npm run build` run by hand), point envDir at that
  // directory instead — a fresh, empty temp dir the script creates and
  // deletes per run — so no .env* file in this package's own root is ever
  // read for that build.
  const envDir = process.env.MEMBRAL_PACKAGE_ENV_DIR ? resolve(process.env.MEMBRAL_PACKAGE_ENV_DIR) : undefined;

  return {
    envDir,
    plugins: [crx({ manifest })],
    resolve: {
      alias: {
        "@membral/core": resolve(__dirname, "../core/src/index.ts"),
      },
    },
    build: {
      // Packaging script overrides this via the `vite build --outDir <tmp>`
      // CLI flag (Vite's own precedence: CLI > config) — so a package
      // build never touches this package's own dist/ (the dev build stays
      // untouched, see the packaging script's header comment).
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
