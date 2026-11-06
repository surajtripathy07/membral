// A copy of the CLI that outlives npx's cache. `npx membral ...` unpacks the package under
// ~/.npm/_npx/<hash>/ and npm may delete that directory at any time, so a hook, a launchd plist
// or a cron line that names a path inside it eventually points at nothing. Instead of writing
// that path, the resolver (configure.ts's resolveCliInvocation) calls installStableCopy() and
// writes the copy's path.
//
// Layout under the membral home:
//   ~/.membral/bin/releases/<version>-<hash>/package.json   (carries "type":"module", and the
//   ~/.membral/bin/releases/<version>-<hash>/dist/index.js   version index.ts reads at start-up)
//   ~/.membral/bin/current -> releases/<version>-<hash>      (symlink; the path callers write)
//
// A release directory is content-addressed and never edited after it is renamed into place; a
// refresh builds a new one in a temp directory, renames it, then swaps the `current` symlink with
// a rename (atomic on POSIX). A hook or sweep starting at any moment sees the old release or the
// new one, never a half-written file. Only the previous release is kept.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type StableInstall = { ok: true; entry: string } | { ok: false; error: string };

export interface StableInstallOptions {
  /** process.argv[1] of the npx run; may be the `.bin/membral` symlink. */
  entryPath: string;
  /** Home that holds `.membral`; defaults to os.homedir(). */
  home?: string;
}

export function stableBinDir(home: string = homedir()): string {
  return join(home, ".membral", "bin");
}

/** The path hooks, plists and cron lines run: stable across upgrades because `current` is re-pointed. */
export function stableEntryPath(home: string = homedir()): string {
  return join(stableBinDir(home), "current", "dist", "index.js");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Copies the running package (dist/index.js + package.json, the only files it reads at runtime;
 * README.md is documentation) to the stable location and points `current` at it. Idempotent:
 * when the same bytes are already current nothing is written.
 */
export function installStableCopy(opts: StableInstallOptions): StableInstall {
  const home = opts.home ?? homedir();
  const bin = stableBinDir(home);
  try {
    // npx runs the `.bin/membral` symlink; the package root is found from the real file.
    const entry = realpathSync(opts.entryPath);
    const root = dirname(dirname(entry));
    if (basename(entry) !== "index.js" || basename(dirname(entry)) !== "dist") {
      return { ok: false, error: `unexpected CLI layout at ${entry} (wanted <package>/dist/index.js)` };
    }
    const entryBytes = readFileSync(entry);
    const pkgBytes = readFileSync(join(root, "package.json"));
    const version = (JSON.parse(pkgBytes.toString("utf-8")) as { version?: unknown }).version;
    if (typeof version !== "string" || !/^[0-9A-Za-z._-]+$/.test(version)) {
      return { ok: false, error: `${join(root, "package.json")} has no usable version` };
    }
    const id = `${version}-${createHash("sha256").update(entryBytes).update(pkgBytes).digest("hex").slice(0, 12)}`;
    const releases = join(bin, "releases");
    const release = join(releases, id);
    const current = join(bin, "current");
    const target = join("releases", id);
    mkdirSync(releases, { recursive: true });

    if (!existsSync(join(release, "dist", "index.js"))) {
      const tmp = mkdtempSync(join(bin, ".tmp-"));
      try {
        mkdirSync(join(tmp, "dist"));
        writeFileSync(join(tmp, "package.json"), pkgBytes);
        writeFileSync(join(tmp, "dist", "index.js"), entryBytes, { mode: 0o755 });
        renameSync(tmp, release);
      } catch (err) {
        rmSync(tmp, { recursive: true, force: true });
        // A concurrent run published the same release first: its copy is identical.
        if (!existsSync(join(release, "dist", "index.js"))) throw err;
      }
    }

    let previous: string | undefined;
    try {
      previous = readlinkSync(current);
    } catch {
      previous = undefined;
    }
    if (previous !== target) {
      const tmpLink = join(bin, `.current-${process.pid}-${Date.now()}`);
      symlinkSync(target, tmpLink, process.platform === "win32" ? "junction" : "dir");
      try {
        renameSync(tmpLink, current);
      } catch (err) {
        rmSync(tmpLink, { force: true });
        throw err;
      }
    }

    // Keep this release and the one just replaced (a process may still be starting from it).
    const keep = new Set([id, previous ? basename(previous) : id]);
    for (const name of readdirSync(releases)) {
      if (!keep.has(name)) rmSync(join(releases, name), { recursive: true, force: true });
    }

    const stable = stableEntryPath(home);
    if (!existsSync(stable)) return { ok: false, error: `${stable} is missing after the copy` };
    return { ok: true, entry: stable };
  } catch (err) {
    return { ok: false, error: `could not copy membral into ${bin}: ${message(err)}` };
  }
}
