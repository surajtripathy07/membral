import { crx } from "@crxjs/vite-plugin";
import { resolve } from "path";
import { defineConfig, loadEnv } from "vite";
import { buildManifest } from "./build-manifest";
import baseManifest from "./manifest.json";

// Which Membral the build talks to is decided in build-manifest.ts (VITE_MEMBRAL_PROD=1 -> hosted,
// anything else -> a local Membral on :3000, VITE_CLOUD_URL overrides). manifest.json carries only the
// ChatGPT and Claude.ai origins; the target origins are added below, so a hosted build never requests
// localhost access and a local build never requests membral.me (Issue #126 finding 16). The default
// build also keeps the original port-rewrite behaviour: VITE_CLOUD_URL on a different port (for
// example `next dev -p 3005`, issue #130) yields a host permission for that port.

export default defineConfig(({ mode }) => {
  // The packaging script's isolated envDir (see below) must also isolate the manifest's view of
  // VITE_* values, so both read through loadEnv with the same directory.
  const envDirOverride = process.env.MEMBRAL_PACKAGE_ENV_DIR ? resolve(process.env.MEMBRAL_PACKAGE_ENV_DIR) : undefined;
  const fileEnv = loadEnv(mode, envDirOverride ?? __dirname, "VITE_");
  const buildEnv = {
    VITE_MEMBRAL_PROD: process.env.VITE_MEMBRAL_PROD ?? fileEnv.VITE_MEMBRAL_PROD,
    VITE_CLOUD_URL: process.env.VITE_CLOUD_URL ?? fileEnv.VITE_CLOUD_URL,
  };
  const manifest = buildManifest(baseManifest, buildEnv);

  // Issue #127 round-2 review, BLOCKER 1: apps/cloud/scripts/package-extension.mjs
  // builds this extension for the public /setup download with an explicit,
  // deployment-derived env contract (VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY/
  // VITE_CLOUD_URL passed as real child-process env vars, mirroring
  // NEXT_PUBLIC_*). Vite loads `.env`/`.env.local`/`.env.<mode>(.local)` from
  // `envDir` in EVERY mode, production included — so a developer's own
  // untracked packages/extension/.env.local (local Supabase config) would
  // otherwise silently seed or override those values in the packaged zip,
  // regardless of what the packaging script passed in. When
  // MEMBRAL_PACKAGE_ENV_DIR is set (ONLY the packaging script sets it —
  // never `npm run dev`/`npm run build` run by hand), point envDir at that
  // directory instead — a fresh, empty temp dir the script creates and
  // deletes per run — so no .env* file in this package's own root is ever
  // read for that build.
  const envDir = envDirOverride;

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
