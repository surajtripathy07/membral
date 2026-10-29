#!/usr/bin/env node
// Build the standalone server the `membral up` CLI runs without Docker (rung two, B5).
//
//   node scripts/local/build-server.mjs [--out DIR | --out-dir DIR] [--skip-build] [--pack [--pack-dest DIR]]
//
// Output layout (OUT defaults to apps/cloud/.next/standalone):
//   OUT/apps/cloud/server.js                      node server.js (MEMBRAL_LOCAL=1 MEMBRAL_STORE=pglite ...)
//   OUT/apps/cloud/.next/static, public           static assets
//   OUT/apps/cloud/supabase/migrations            MEMBRAL_MIGRATIONS_DIR
//   OUT/apps/cloud/supabase/local/auth-prelude.sql resolves at <migrationsDir>/../local/auth-prelude.sql
//   OUT/docker/substitute-env.mjs                 the rung-one sentinel swap; run it before server.js with
//                                                 MEMBRAL_NEXT_DIR=OUT/apps/cloud/.next and the NEXT_PUBLIC_* values
//   OUT/membral-server.json                       manifest (buildId, gitSha, node, platform, builtAt)
//   --pack: write package.json (@membral/server, the CLI's version) and `npm pack` to
//           PACK_DEST/membral-server-<version>-<platform>-<arch>.tgz (PACK_DEST defaults to <repo>/dist, which
//           .gitignore covers by its `dist/` rule). Without --out-dir the packing runs on a temporary copy of
//           apps/cloud/.next/standalone, so the checkout's own build is never modified. The traced node_modules ride
//           along as bundleDependencies. os/cpu (and libc on Linux) are pinned to the build platform because the
//           output holds platform-native binaries. Publishing it is a human gate; nothing here runs `npm publish`.
// A globally installed CLI (`npm run cli:install`) no longer finds a checkout's server from the current folder: pass
// `--server-dir apps/cloud/.next/standalone` (or MEMBRAL_SERVER_DIR), or run `node packages/cli/dist/index.js up` from the checkout.
// The build bakes NEXT_PUBLIC_* sentinels (same as apps/cloud/Dockerfile); the swap is the caller's job.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServerPackageJson, detectLibc, isNativeFile, stripInstallScripts } from "./pack-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cloud = join(root, "apps/cloud");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const outIdx = Math.max(args.indexOf("--out"), args.indexOf("--out-dir"));
const standaloneDir = join(cloud, ".next/standalone");
const out = outIdx >= 0 ? resolve(args[outIdx + 1] ?? "") : standaloneDir;
if (outIdx >= 0 && !args[outIdx + 1]) {
  console.error("--out needs a directory");
  process.exit(2);
}

function run(cmd, cmdArgs, cwd, env = {}, attempts = 1) {
  let r;
  for (let i = 0; i < attempts; i++) {
    r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
    if (r.status === 0) break;
  }
  if (r.status !== 0) {
    console.error(`build-server: \`${cmd} ${cmdArgs.join(" ")}\` failed (${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

if (!flag("--skip-build")) {
  // next dev and next build share .next; refuse when a dev server holds it.
  const dev = spawnSync("pgrep", ["-f", `${cloud}.*next dev|next dev.*${cloud}`], { encoding: "utf8" });
  if (dev.status === 0 && dev.stdout.trim()) {
    console.error("build-server: a `next dev` is running for this worktree; stop it first (shared .next).");
    process.exit(1);
  }
  // next build type-checks the whole app, which imports the dist types of these workspaces.
  for (const ws of ["@membral/core", "@membral/test-kit", "@membral/cli"]) {
    run("npm", ["run", "build", `--workspace=${ws}`], root);
  }
  run("npx", ["next", "build"], cloud, {
    MEMBRAL_STANDALONE: "1",
    MEMBRAL_STANDALONE_NATIVE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=3072",
    NEXT_PUBLIC_SUPABASE_URL: "http://membral-sentinel-supabase-url.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "membral-sentinel-anon-key",
    NEXT_PUBLIC_APP_URL: "http://membral-sentinel-app-url.invalid",
  }, 2); // next/font fetches Google Fonts at build time; one retry covers a flaky fetch
}

if (!existsSync(join(standaloneDir, "apps/cloud/server.js"))) {
  console.error(`build-server: ${standaloneDir}/apps/cloud/server.js is missing; run without --skip-build.`);
  process.exit(1);
}

if (out !== standaloneDir) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(standaloneDir, out, { recursive: true, verbatimSymlinks: true });
}
const app = join(out, "apps/cloud");
cpSync(join(cloud, ".next/static"), join(app, ".next/static"), { recursive: true });
cpSync(join(cloud, "public"), join(app, "public"), { recursive: true });
cpSync(join(cloud, "supabase/migrations"), join(app, "supabase/migrations"), { recursive: true });
mkdirSync(join(app, "supabase/local"), { recursive: true });
cpSync(join(cloud, "supabase/local/auth-prelude.sql"), join(app, "supabase/local/auth-prelude.sql"));
mkdirSync(join(out, "docker"), { recursive: true });
cpSync(join(cloud, "docker/substitute-env.mjs"), join(out, "docker/substitute-env.mjs"));
rmSync(join(app, ".next/cache"), { recursive: true, force: true });

const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const manifest = {
  version: JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version,
  buildId: readFileSync(join(cloud, ".next/BUILD_ID"), "utf8").trim(),
  gitSha: git.status === 0 ? git.stdout.trim() : null,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  builtAt: new Date().toISOString(),
};
writeFileSync(join(out, "membral-server.json"), `${JSON.stringify(manifest, null, 2)}\n`);

function size(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += size(p);
    else if (e.isFile()) total += statSync(p).size;
  }
  return total;
}
console.log(`build-server: ${out}`);
console.log(`build-server: ${(size(out) / 1024 / 1024).toFixed(1)} MB, buildId ${manifest.buildId}`);

if (flag("--pack")) packServer();

// ---- --pack -------------------------------------------------------------------------------------------------

function walk(dir, visit) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, visit);
    else visit(p, e);
  }
}

function packServer() {
  const cliPkg = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
  // The stripped scripts and the generated package.json must not land in the checkout's own standalone output.
  let pkgRoot = out;
  let tmp;
  if (out === standaloneDir) {
    tmp = mkdtempSync(join(tmpdir(), "membral-server-pack-"));
    pkgRoot = join(tmp, "package");
    cpSync(out, pkgRoot, { recursive: true, verbatimSymlinks: true });
  }
  try {
    packFrom(pkgRoot, cliPkg);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

function packFrom(out, cliPkg) {
  const nm = join(out, "node_modules");
  // Top-level packages of the traced node_modules (scoped ones one level down), with their versions.
  const deps = {};
  for (const e of readdirSync(nm, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const names = e.name.startsWith("@")
      ? readdirSync(join(nm, e.name)).map((n) => `${e.name}/${n}`)
      : [e.name];
    for (const n of names) {
      const pj = JSON.parse(readFileSync(join(nm, n, "package.json"), "utf8"));
      deps[n] = pj.version;
    }
  }
  // The traced packages are already built, but traced copies drop files such as sharp/install/check.js, so a
  // bundled dependency's own install lifecycle would fail on the user's machine. Strip those scripts from the copy.
  const stripped = [];
  walk(out, (p) => {
    if (!p.endsWith("/package.json") || !p.includes("/node_modules/")) return;
    const pj = JSON.parse(readFileSync(p, "utf8"));
    const hit = stripInstallScripts(pj);
    if (!hit.length) return;
    writeFileSync(p, `${JSON.stringify(pj, null, 2)}\n`);
    stripped.push(`${pj.name}:${hit.join("+")}`);
  });
  if (stripped.length) console.log(`build-server: removed install scripts from bundled packages: ${stripped.join(", ")}`);
  // Platform-native files anywhere in the output decide whether os/cpu are pinned.
  const native = [];
  walk(out, (p) => {
    if (isNativeFile(p)) native.push(p.slice(out.length + 1));
  });
  const libc = detectLibc(process.platform, process.report?.getReport?.());
  const pkg = buildServerPackageJson({ cliPkg, deps, native, platform: process.platform, arch: process.arch, libc });
  writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  copyLicense(out);
  const destIdx = args.indexOf("--pack-dest");
  const dest = destIdx >= 0 ? resolve(args[destIdx + 1] ?? "") : join(root, "dist");
  mkdirSync(dest, { recursive: true });
  const r = spawnSync("npm", ["pack", "--json", "--pack-destination", dest], { cwd: out, encoding: "utf8" });
  if (r.status !== 0) {
    // Throw rather than exit so the caller's finally removes the temp copy.
    throw new Error(`build-server: npm pack failed (${r.status})\n${r.stderr}`);
  }
  const info = JSON.parse(r.stdout)[0];
  const named = join(dest, `membral-server-${pkg.version}-${process.platform}-${process.arch}.tgz`);
  renameSync(join(dest, info.filename), named);
  const nativeTop = [
    ...new Set(
      native.map((f) => {
        const rest = f.slice(f.lastIndexOf("node_modules/") + "node_modules/".length).split("/");
        return rest.slice(0, rest[0].startsWith("@") ? 2 : 1).join("/");
      }),
    ),
  ];
  console.log(`build-server: packed ${named}`);
  console.log(
    `build-server: packed ${(info.size / 1024 / 1024).toFixed(1)} MB, unpacked ${(info.unpackedSize / 1024 / 1024).toFixed(1)} MB, ${info.entryCount} files, ${info.bundled.length} bundled deps`,
  );
  console.log(
    native.length
      ? `build-server: ${native.length} native files (${nativeTop.join(", ")}); os/cpu pinned to ${process.platform}/${process.arch}${libc ? `/${libc}` : ""}`
      : "build-server: no native files; os/cpu left unset",
  );
}

function copyLicense(out) {
  const lic = join(root, "LICENSE");
  if (existsSync(lic)) cpSync(lic, join(out, "LICENSE"));
}
