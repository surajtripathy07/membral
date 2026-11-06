// The npx stable copy (stable-install.ts) and what the resolver, the launchd plist and the cron line do with it.
// Everything runs in temp dirs: HOME is a temp dir, launchctl/crontab are injected fakes, nothing touches the real ones.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCliInvocation } from "../configure.js";
import { installStableCopy, stableEntryPath } from "../stable-install.js";
import { buildSweepPlist, installSweepAgent, sweepPlistPath } from "../sweep-command.js";
import { buildCronEntry, type CommandResult, CRON_MARKER } from "../sweep-linux.js";

// What the published package needs at runtime: package.json ("type":"module" so dist/index.js loads as ESM, and the
// version index.ts reads from ../package.json) and dist/index.js. README.md ships too, but nothing reads it.
const ENTRY = (tag: string) =>
  `import { createRequire } from "node:module";\n` +
  `const v = createRequire(import.meta.url)("../package.json").version;\n` +
  `console.log("membral-fake ${tag} " + v + " " + process.argv.slice(2).join(" "));\n`;

function makeNpxLayout(root: string, version: string, tag = "a"): { entry: string; bin: string; pkgRoot: string } {
  const pkgRoot = join(root, "_npx", "abc123", "node_modules", "membral");
  mkdirSync(join(pkgRoot, "dist"), { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "membral", version, type: "module" }));
  writeFileSync(join(pkgRoot, "dist", "index.js"), ENTRY(tag));
  writeFileSync(join(pkgRoot, "README.md"), "docs");
  const binDir = join(root, "_npx", "abc123", "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "membral");
  rmSync(bin, { force: true });
  symlinkSync("../membral/dist/index.js", bin); // npx runs this symlink: process.argv[1] is its path
  return { entry: join(pkgRoot, "dist", "index.js"), bin, pkgRoot };
}

describe("stable copy under npx", () => {
  let root: string;
  let home: string;
  // An absolute node outside any Homebrew Cellar (this machine's real node may be one), so aliasing does not rewrite it.
  let node: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "membral-npx-"));
    home = mkdtempSync(join(tmpdir(), "membral-home-"));
    mkdirSync(join(root, "nodebin"));
    node = join(root, "nodebin", "node");
    symlinkSync(process.execPath, node);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("the resolver returns [execPath, stable entry] for an npx run, and the copy runs after the npx cache is gone", () => {
    const { bin } = makeNpxLayout(root, "9.9.1");
    const inv = resolveCliInvocation({ execPath: node, entryPath: bin, home });
    expect(inv.argv).toEqual([node, stableEntryPath(home)]);
    expect(inv.stableInstallError).toBeUndefined();
    expect(inv.argv[1]).toBe(join(home, ".membral", "bin", "current", "dist", "index.js"));

    rmSync(join(root, "_npx"), { recursive: true, force: true }); // rm -rf ~/.npm/_npx
    const out = execFileSync(inv.argv[0], [inv.argv[1], "--help"], { env: {}, encoding: "utf8" });
    expect(out).toBe("membral-fake a 9.9.1 --help\n");
  });

  it("copies only package.json and dist/index.js", () => {
    const { entry } = makeNpxLayout(root, "1.0.0");
    const r = installStableCopy({ entryPath: entry, home });
    expect(r.ok).toBe(true);
    const release = join(home, ".membral", "bin", "current");
    expect(readdirSync(release).sort()).toEqual(["dist", "package.json"]);
    expect(readdirSync(join(release, "dist"))).toEqual(["index.js"]);
  });

  it("refresh is atomic: a new run adds a release and swaps the `current` symlink, never editing one in place", () => {
    const { entry, bin } = makeNpxLayout(root, "1.0.0", "old");
    const first = resolveCliInvocation({ execPath: node, entryPath: bin, home });
    const current = join(home, ".membral", "bin", "current");
    const oldTarget = readlinkSync(current);
    const oldBytes = readFileSync(join(home, ".membral", "bin", oldTarget, "dist", "index.js"), "utf8");

    // same bytes again: nothing changes
    resolveCliInvocation({ execPath: node, entryPath: bin, home });
    expect(readlinkSync(current)).toBe(oldTarget);
    expect(readdirSync(join(home, ".membral", "bin", "releases"))).toHaveLength(1);

    // a newer npx run
    writeFileSync(entry, ENTRY("new"));
    writeFileSync(
      join(entry, "..", "..", "package.json"),
      JSON.stringify({ name: "membral", version: "1.0.1", type: "module" }),
    );
    const second = resolveCliInvocation({ execPath: node, entryPath: bin, home });
    expect(second.argv).toEqual(first.argv); // callers' stored path never changes
    expect(lstatSync(current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(current)).not.toBe(oldTarget);
    expect(execFileSync(second.argv[0], [second.argv[1]], { env: {}, encoding: "utf8" })).toContain(
      "membral-fake new 1.0.1",
    );
    // the release a running hook may still be starting from is untouched
    expect(readFileSync(join(home, ".membral", "bin", oldTarget, "dist", "index.js"), "utf8")).toBe(oldBytes);
    // no temp leftovers
    expect(readdirSync(join(home, ".membral", "bin")).sort()).toEqual(["current", "releases"]);

    // a third version prunes the oldest, keeps the previous
    writeFileSync(entry, ENTRY("newer"));
    writeFileSync(
      join(entry, "..", "..", "package.json"),
      JSON.stringify({ name: "membral", version: "1.0.2", type: "module" }),
    );
    resolveCliInvocation({ execPath: node, entryPath: bin, home });
    expect(readdirSync(join(home, ".membral", "bin", "releases"))).toHaveLength(2);
  });

  it("--dry-run returns the stable path without writing anything", () => {
    const { bin } = makeNpxLayout(root, "1.0.0");
    const inv = resolveCliInvocation({ execPath: node, entryPath: bin, home, dryRun: true });
    expect(inv.argv).toEqual([node, stableEntryPath(home)]);
    expect(existsSync(join(home, ".membral"))).toBe(false);
  });

  it("global-install and dev-checkout paths are returned unchanged and nothing is copied", () => {
    const installStable = vi.fn();
    const g = resolveCliInvocation({
      execPath: "/usr/bin/node",
      entryPath: "/opt/homebrew/lib/node_modules/membral/dist/index.js",
      home,
      installStable,
    });
    expect(g.argv).toEqual(["/usr/bin/node", "/opt/homebrew/lib/node_modules/membral/dist/index.js"]);
    expect(installStable).not.toHaveBeenCalled();
    expect(existsSync(join(home, ".membral"))).toBe(false);
  });

  it("the Homebrew Cellar node alias still applies on top of the stable entry", () => {
    const cellarNode = "/opt/homebrew/Cellar/node/26.8.1/bin/node";
    const inv = resolveCliInvocation({
      execPath: cellarNode,
      entryPath: "/Users/x/.npm/_npx/h/node_modules/.bin/membral",
      home,
      existsSync: () => true,
      installStable: () => ({ ok: true, entry: stableEntryPath(home) }),
      realpathSync: (p: string) => {
        if (p === "/opt/homebrew/bin/node") return cellarNode;
        throw new Error("ENOENT");
      },
    });
    expect(inv.argv).toEqual(["/opt/homebrew/bin/node", stableEntryPath(home)]);
  });

  it("an npx node that no longer exists is a failure, not a path written into a job", () => {
    const inv = resolveCliInvocation({
      execPath: "/gone/node",
      entryPath: "/Users/x/.npm/_npx/h/node_modules/.bin/membral",
      home,
      existsSync: () => false,
      installStable: () => ({ ok: true, entry: stableEntryPath(home) }),
    });
    expect(inv.argv).toEqual(["membral"]);
    expect(inv.stableInstallError).toContain("/gone/node");
  });

  describe("when the copy cannot be made", () => {
    // HOME is a regular file, so ~/.membral/bin cannot be created.
    let badHome: string;
    beforeEach(() => {
      badHome = join(root, "home-is-a-file");
      writeFileSync(badHome, "x");
    });

    it("the resolver reports the reason and falls back to `membral`", () => {
      const { bin } = makeNpxLayout(root, "1.0.0");
      const inv = resolveCliInvocation({ execPath: node, entryPath: bin, home: badHome });
      expect(inv.argv).toEqual(["membral"]);
      expect(inv.stableInstallError).toContain("could not copy membral into");
      expect(inv.fallbackWarning).toContain("npm install -g membral");
    });

    it("launchd: no plist is written, launchctl is not called, the result says what failed and how to fix it", async () => {
      const { bin } = makeNpxLayout(root, "1.0.0");
      const launchctl = vi.fn(async (_a: string[]) => ({ ok: true, output: "" }));
      const cliInvocation = resolveCliInvocation({ execPath: node, entryPath: bin, home: badHome });
      const r = await installSweepAgent({ home, platform: "darwin", uid: 501, cliInvocation, launchctl });
      expect(r).toMatchObject({ success: false, scheduler: "none" });
      expect(r.message).toContain("NOT scheduled");
      expect(r.message).toContain("could not copy membral into");
      expect(r.message).toContain("npm install -g membral");
      expect(existsSync(sweepPlistPath(home))).toBe(false);
      expect(launchctl).not.toHaveBeenCalled();
    });

    it("linux: nothing is scheduled when `membral` is not on PATH either, and the reason names the copy failure", async () => {
      const { bin } = makeNpxLayout(root, "1.0.0");
      const calls: string[] = [];
      const run = async (cmd: string, args: string[]): Promise<CommandResult> => {
        calls.push([cmd, ...args].join(" "));
        return { ok: false, output: "", stdout: "" };
      };
      const cliInvocation = resolveCliInvocation({ execPath: node, entryPath: bin, home: badHome });
      const r = await installSweepAgent({ home, platform: "linux", cliInvocation, run });
      expect(r).toMatchObject({ success: false, scheduler: "none" });
      expect(r.reason).toContain("could not copy membral into");
      expect(calls.some((c) => c.startsWith("crontab"))).toBe(false);
    });
  });
});

describe("the scheduler files carry the stable path", () => {
  const home = "/h";
  const argv = ["/opt/homebrew/bin/node", stableEntryPath(home)];

  it("plist: ProgramArguments are node + stable entry + sweep; label, interval and PATH are unchanged", () => {
    const plist = buildSweepPlist({ argv }, "/h/.membral/logs/sweep.log");
    expect(plist).toContain(
      "<string>/opt/homebrew/bin/node</string>\n    <string>/h/.membral/bin/current/dist/index.js</string>\n    <string>sweep</string>",
    );
    expect(plist).toContain("<string>me.membral.sweep</string>");
    expect(plist).toContain("<integer>1200</integer>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>");
    expect(plist).not.toContain("_npx");
  });

  it("cron: `*/20 * * * *` runs node + stable entry + sweep", () => {
    const entry = buildCronEntry({ argv }, "/h/.membral/logs/sweep.log");
    expect(entry.startsWith("*/20 * * * * PATH='/opt/homebrew/bin:")).toBe(true);
    expect(entry).toContain("'/opt/homebrew/bin/node' '/h/.membral/bin/current/dist/index.js' 'sweep'");
    expect(entry).not.toContain("_npx");
    expect(CRON_MARKER.length).toBeGreaterThan(0);
  });
});
