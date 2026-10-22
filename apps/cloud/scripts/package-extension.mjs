#!/usr/bin/env node
// apps/cloud/scripts/package-extension.mjs — issue #127.
//
// Round-2 adversarial review, BLOCKER 1: this script used to zip whatever
// packages/extension/dist happened to already contain — a dev build made
// on the maintainer's machine, carrying the maintainer's untracked
// packages/extension/.env.local (local Supabase config: 127.0.0.1:54321 +
// the well-known local supabase-demo anon JWT), Vite-inlined at BUILD time
// into the extension's JS bundle. Every downloader's extension pointed its
// auth at their own loopback and could never sign in. On a Vercel build
// with no .env.local at all, VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY were
// simply unset, so the extension's auth client threw on first use instead.
//
// FIX: this script now builds the extension ITSELF, with an explicit,
// deployment-derived env contract, into a scratch directory it fully
// controls — packages/extension/dist (the maintainer's own dev build) is
// NEVER read or written by this script.
//
//   - VITE_SUPABASE_URL      <- NEXT_PUBLIC_SUPABASE_URL
//   - VITE_SUPABASE_ANON_KEY <- NEXT_PUBLIC_SUPABASE_ANON_KEY
//   - VITE_CLOUD_URL         <- NEXT_PUBLIC_APP_URL
//   (see packages/extension/src/auth/auth.ts and sync/cloud-push.ts for
//   where these three VITE_ vars are read)
//
// passed as real child-process env vars to `vite build --mode production`,
// run with `envDir` pointed at a fresh, EMPTY temp directory (via
// MEMBRAL_PACKAGE_ENV_DIR — see vite.config.ts) so packages/extension's own
// .env/.env.local/.env.production(.local) — Vite loads these in every
// mode, production included — can never seed or override the values this
// script passed in, regardless of what the maintainer's local checkout
// happens to carry. Immunity is asserted, not just intended: after the
// build, TWO independent checks run and the build HARD-FAILS (throws,
// non-zero exit) if either finds anything:
//   1. assertNoLocalEnvLeak — diffs packages/extension's own local .env*
//      files against what THIS run explicitly passed in, and greps built
//      assets for anything that differs (catches envDir isolation itself
//      breaking).
//   2. assertNoLocalMarkers — round-3 review MED 12: the literal grep this
//      header used to just CLAIM without implementing ("every produced
//      asset is grepped for 127.0.0.1/localhost/supabase-demo") now
//      actually runs, unconditionally, against the three literal strings —
//      the check that works even with NO local .env* files present (e.g.
//      on Vercel, where none exist and assertNoLocalEnvLeak's diff has
//      nothing to compare against and always no-ops). Skipped only when
//      the PASSED-IN NEXT_PUBLIC_SUPABASE_URL is itself local (a
//      deliberate local-only distribution build, not a leak).
// Both are grep-detectable in CI, and a process that can produce a broken
// zip must never produce one silently.
//
// If the three NEXT_PUBLIC_* vars are absent (a plain `next dev`/`next
// build` run locally with no Supabase env configured, or a Vercel project
// that genuinely hasn't set them), there's no deployment to derive the
// extension's config FROM — this is the one case where skipping is
// correct, not a bug: warn clearly and produce no zip at all (never a
// stale or partially-configured one).
//
// MANIFEST (round-3 review HIGH 11): apps/cloud/src/app/setup/page.tsx used
// to `existsSync` the zip at REQUEST time, which the page's own comment
// called "checked at request/render time, not assumed" — true only because
// Next happens to prerender that static page at BUILD time (right after
// this script runs in `prebuild`). If anything ever forced the page
// dynamic, `existsSync` would run inside a Vercel serverless function,
// whose filesystem does NOT include `public/` (that's served by the CDN) —
// the check would always say "unavailable" even on a deploy that shipped a
// working zip. Instead, this script writes `public/downloads/manifest.json`
// — `{ available, builtAt, cloudUrl }` — as the one build-time fact the
// page imports/reads; the page itself is pinned `force-static` so it's
// never at risk of becoming dynamic in the first place.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOUD_ROOT = resolve(__dirname, "..");
const EXTENSION_DIR = resolve(CLOUD_ROOT, "../../packages/extension");
const OUT_DIR = resolve(CLOUD_ROOT, "public/downloads");
const OUT_FILE = resolve(OUT_DIR, "membral-extension.zip");
const MANIFEST_FILE = resolve(OUT_DIR, "manifest.json");

/** Written on every run (available or not) — the one build-time fact apps/cloud/src/app/setup/page.tsx reads instead of an `existsSync` at render. */
function writeManifest({ available, cloudUrl }) {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = {
    available,
    builtAt: available ? new Date().toISOString() : null,
    cloudUrl: available ? cloudUrl : null,
  };
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** round-3 review MED 12 — the literal grep this file's header promises. Skipped only when the caller is deliberately packaging for a local target (the passed-in Supabase URL is itself local). */
const LOCAL_MARKERS = ["127.0.0.1", "localhost:3000", "supabase-demo"];

function assertNoLocalMarkers(files, passedSupabaseUrl) {
  if (LOCAL_MARKERS.some((marker) => passedSupabaseUrl.includes(marker))) return;
  for (const [rel, bytes] of Object.entries(files)) {
    const text = Buffer.from(bytes).toString("utf8");
    for (const marker of LOCAL_MARKERS) {
      if (text.includes(marker)) {
        throw new Error(
          `[package-extension] built asset "${rel}" contains "${marker}" while the passed-in ` +
            `NEXT_PUBLIC_SUPABASE_URL ("${passedSupabaseUrl}") is not itself local — refusing to ship ` +
            "a zip that could point a real user's extension at a local/dev backend.",
        );
      }
    }
  }
}

// The exact VITE_ vars auth.ts / cloud-push.ts read (see the header comment).
const ENV_KEYS = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_CLOUD_URL"];
// Every file Vite would load into `envDir` (packages/extension's own root,
// in EVERY mode) if envDir isolation were absent or broken. Order matches
// Vite's own precedence (later files win) — irrelevant here since we only
// need the set of candidate leaked values, not which one would "win".
const LOCAL_ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];

function collectFiles(dir, base = dir) {
  const out = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(base, full);
    if (statSync(full).isDirectory()) {
      Object.assign(out, collectFiles(full, base));
    } else {
      out[rel] = new Uint8Array(readFileSync(full));
    }
  }
  return out;
}

/** Minimal KEY=value .env line parser — good enough for this narrow, read-only diagnostic use. */
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Round-2 review BLOCKER 1: proves the envDir isolation actually worked,
 * rather than just trusting the config. Reads packages/extension's own
 * local env files (.env, .env.local, etc — see LOCAL_ENV_FILES) DIRECTLY
 * here (never fed into the vite build above — envDir already prevents
 * that) purely to find candidate leaked
 * values: for every VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY/VITE_CLOUD_URL
 * a local file defines that DIFFERS from what this run explicitly passed
 * in, assert it does NOT appear anywhere in the built output. (A local
 * value that happens to be IDENTICAL to what was explicitly passed — e.g.
 * deliberately packaging with the same local Supabase project — isn't a
 * leak; there'd be no way to tell leaked-vs-intentional apart in that case,
 * and no need to.) Hard-fails (throws) on any match — this exact
 * regression is grep-detectable in CI.
 */
function assertNoLocalEnvLeak(files, passedValues) {
  const leakCandidates = {};
  for (const filename of LOCAL_ENV_FILES) {
    const path = join(EXTENSION_DIR, filename);
    if (!existsSync(path)) continue;
    const parsed = parseEnvFile(readFileSync(path, "utf8"));
    for (const key of ENV_KEYS) {
      const value = parsed[key];
      if (value && value !== passedValues[key]) {
        leakCandidates[`${filename}:${key}`] = value;
      }
    }
  }

  if (Object.keys(leakCandidates).length === 0) return;

  for (const [rel, bytes] of Object.entries(files)) {
    const text = Buffer.from(bytes).toString("utf8");
    for (const [source, value] of Object.entries(leakCandidates)) {
      if (text.includes(value)) {
        throw new Error(
          `[package-extension] built asset "${rel}" contains "${value}" from packages/extension/${source} — ` +
            "envDir isolation failed (see this script's header comment). Refusing to ship a zip that " +
            "could point a real user's extension at the maintainer's local/dev backend instead of " +
            "the value this build actually passed in.",
        );
      }
    }
  }
}

function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const cloudUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();

  const missing = [
    !supabaseUrl && "NEXT_PUBLIC_SUPABASE_URL",
    !supabaseAnonKey && "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    !cloudUrl && "NEXT_PUBLIC_APP_URL",
  ].filter(Boolean);

  if (missing.length > 0) {
    console.warn(
      `[package-extension] ${missing.join(", ")} unset — skipping the extension zip ` +
        "(nothing to derive its Supabase/cloud-URL config from). This is expected for a plain " +
        "`next dev`/`next build` with no Supabase env configured; /setup will show " +
        '"download not available on this deployment" instead of a dead link. Set all three to ' +
        "produce a real, working zip.",
    );
    writeManifest({ available: false, cloudUrl: null });
    return;
  }

  let envDir;
  let vitOutDir;
  try {
    // A fresh, EMPTY temp dir — packages/extension's own .env* files are
    // never read for this build (see vite.config.ts's MEMBRAL_PACKAGE_ENV_DIR).
    envDir = mkdtempSync(join(tmpdir(), "membral-ext-envdir-"));
    // A fresh temp outDir — packages/extension/dist (the maintainer's dev
    // build) is never touched by this script.
    vitOutDir = mkdtempSync(join(tmpdir(), "membral-ext-build-"));

    console.log("[package-extension] building the extension for packaging (mode: production)...");
    execFileSync(
      "npx",
      ["vite", "build", "--mode", "production", "--outDir", vitOutDir, "--emptyOutDir"],
      {
        cwd: EXTENSION_DIR,
        stdio: "inherit",
        env: {
          ...process.env,
          VITE_SUPABASE_URL: supabaseUrl,
          VITE_SUPABASE_ANON_KEY: supabaseAnonKey,
          VITE_CLOUD_URL: cloudUrl,
          MEMBRAL_PACKAGE_ENV_DIR: envDir,
        },
      },
    );

    const files = collectFiles(vitOutDir);
    if (Object.keys(files).length === 0) {
      throw new Error(`[package-extension] vite build produced no files in ${vitOutDir}`);
    }

    assertNoLocalEnvLeak(files, {
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_ANON_KEY: supabaseAnonKey,
      VITE_CLOUD_URL: cloudUrl,
    });
    assertNoLocalMarkers(files, supabaseUrl);

    mkdirSync(OUT_DIR, { recursive: true });
    const zipped = zipSync(files, { level: 6 });
    writeFileSync(OUT_FILE, zipped);
    console.log(
      `[package-extension] wrote ${relative(CLOUD_ROOT, OUT_FILE)} (${Object.keys(files).length} files, ${zipped.length} bytes)`,
    );
    writeManifest({ available: true, cloudUrl });
  } finally {
    for (const dir of [envDir, vitOutDir]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }
}

main();
