// install.sh and entrypoint.sh, run by sh against a fake `npm` on PATH and temp
// dirs. The real download is checked in a container, not here.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = __dirname;
const INSTALL = join(HERE, "install.sh");
const ENTRYPOINT = join(HERE, "..", "entrypoint.sh");
const VERSION = JSON.parse(readFileSync(join(HERE, "package-lock.json"), "utf8")).packages[
  "node_modules/@anthropic-ai/claude-code"
].version as string;
const PKG = `@anthropic-ai/claude-code-linux-${process.arch}`;

let root: string;
let dir: string;
let fakeBin: string;

/**
 * A fake npm; the mode is read from <root>/mode: ok (full tree, a binary that dumps
 * its env to <root>/bin-env.txt), fail (exit 1 with a network error), partial (exit 1
 * after writing half a tree), broken (exit 0, binary that fails), slow (half a tree,
 * then sleeps). It always dumps its own environment to <root>/npm-env.txt.
 */
function writeFakeNpm(): void {
  const npm = `#!/bin/sh
env > "${root}/npm-env.txt"
prefix=""
while [ $# -gt 0 ]; do
  [ "$1" = "--prefix" ] && prefix="$2"
  shift
done
mode="$(cat "${root}/mode")"
mkdir -p "$prefix/node_modules/${PKG}"
case "$mode" in
  ok)
    printf '#!/bin/sh\\nenv > "${root}/bin-env.txt"\\necho "${VERSION} (Claude Code)"\\n' > "$prefix/node_modules/${PKG}/claude"
    chmod +x "$prefix/node_modules/${PKG}/claude"
    exit 0 ;;
  slow)
    printf '#!/bin/sh\\necho half\\n' > "$prefix/node_modules/${PKG}/claude"
    chmod +x "$prefix/node_modules/${PKG}/claude"
    : > "${root}/npm-started"
    sleep 30
    exit 0 ;;
  broken)
    printf '#!/bin/sh\\nexit 3\\n' > "$prefix/node_modules/${PKG}/claude"
    chmod +x "$prefix/node_modules/${PKG}/claude"
    exit 0 ;;
  partial)
    printf '#!/bin/sh\\necho half\\n' > "$prefix/node_modules/${PKG}/claude"
    chmod +x "$prefix/node_modules/${PKG}/claude"
    echo "npm error code ECONNRESET" >&2
    exit 1 ;;
  *)
    echo "npm error code EAI_AGAIN" >&2
    echo "npm error request to https://registry.npmjs.org/x.tgz failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org" >&2
    exit 1 ;;
esac
`;
  writeFileSync(join(fakeBin, "npm"), npm, { mode: 0o755 });
}

function setMode(mode: "ok" | "fail" | "partial" | "broken" | "slow"): void {
  writeFileSync(join(root, "mode"), mode);
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    MEMBRAL_CLAUDE_CLI_DIR: dir,
    MEMBRAL_CLAUDE_CLI_SRC: HERE,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

function runInstall(extra: Record<string, string> = {}) {
  const r = spawnSync("sh", [INSTALL], { env: baseEnv(extra), encoding: "utf8" });
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

const binPath = () => join(dir, "node_modules", PKG, "claude");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "membral-claude-cli-"));
  dir = join(root, "vol");
  fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  writeFakeNpm();
});

afterEach(() => {
  if (existsSync(dir)) chmodSync(dir, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("claude-cli install.sh", () => {
  it("reads the version from the lock and prints the binary path after a working install", () => {
    setMode("ok");
    const r = runInstall();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(binPath());
    expect(readFileSync(join(dir, ".installed"), "utf8").trim()).toBe(VERSION);
    expect(r.stderr).toContain(`downloading Claude Code ${VERSION} from npm`);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  });

  it("skips npm on a later start when the marker matches", () => {
    setMode("ok");
    runInstall();
    rmSync(join(root, "npm-env.txt"));
    setMode("fail");
    const r = runInstall();
    expect(r.stdout).toBe(binPath());
    expect(existsSync(join(root, "npm-env.txt"))).toBe(false);
  });

  it("npm failing prints nothing on stdout, the clear line on stderr, and exits 0", () => {
    setMode("fail");
    const r = runInstall();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      "Claude Code could not be downloaded from npm: getaddrinfo EAI_AGAIN registry.npmjs.org. Extraction with the claude-code provider is off",
    );
  });

  it("a partial tree left by a failed install is never used and is cleaned up", () => {
    setMode("partial");
    expect(runInstall().stdout).toBe("");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    // A tree from an install killed mid-way: binary present, no marker.
    mkdirSync(join(dir, "node_modules", PKG), { recursive: true });
    writeFileSync(binPath(), "#!/bin/sh\necho half\n", { mode: 0o755 });
    setMode("fail");
    const r = runInstall();
    expect(r.stdout).toBe("");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    setMode("ok");
    expect(runInstall().stdout).toBe(binPath());
  });

  it("a marker for another version triggers a reinstall", () => {
    setMode("ok");
    runInstall();
    writeFileSync(join(dir, ".installed"), "0.0.1\n");
    rmSync(join(root, "npm-env.txt"));
    expect(runInstall().stdout).toBe(binPath());
    expect(existsSync(join(root, "npm-env.txt"))).toBe(true);
  });

  it("a binary that does not run is not reported", () => {
    setMode("broken");
    const r = runInstall();
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("did not install a working binary");
    expect(existsSync(join(dir, ".installed"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("an unwritable dir gives a clear line and exits 0", () => {
    mkdirSync(dir);
    chmodSync(dir, 0o555);
    setMode("ok");
    const r = runInstall();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`Claude Code could not be downloaded from npm: ${dir} is not writable`);
  });

  it("a held lock stops a second installer", () => {
    mkdirSync(join(dir, ".lock"), { recursive: true });
    setMode("ok");
    const r = runInstall();
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("another install is running");
    expect(existsSync(join(dir, ".lock"))).toBe(true);
  });

  it("npm runs with a minimal environment: no app secret, no user or global npmrc", () => {
    setMode("ok");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".npmrc"), "registry=https://evil.invalid/\n");
    runInstall({ SUPABASE_SERVICE_ROLE_KEY: "canary-secret", CLAUDE_CODE_OAUTH_TOKEN: "canary-token" });
    expect(existsSync(join(dir, ".npmrc"))).toBe(false);
    const env = readFileSync(join(root, "npm-env.txt"), "utf8");
    expect(env).not.toContain("canary");
    expect(env).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(env).toContain(`HOME=${join(dir, ".npm-home")}`);
    // The post-install `claude --version` check runs with the same minimal env.
    const binEnv = readFileSync(join(root, "bin-env.txt"), "utf8");
    expect(binEnv).not.toContain("canary");
    expect(binEnv).toContain("DISABLE_AUTOUPDATER=1");
  });

  it("a lock left by a dead installer on this host is cleared; a live owner's lock is kept", () => {
    const host = spawnSync("hostname", { encoding: "utf8" }).stdout.trim();
    mkdirSync(join(dir, ".lock"), { recursive: true });
    writeFileSync(join(dir, ".lock", "owner"), `${process.pid} ${host}\n`);
    setMode("ok");
    expect(runInstall().stderr).toContain("another install is running");
    writeFileSync(join(dir, ".lock", "owner"), `999999 ${host}\n`);
    expect(runInstall().stdout).toBe(binPath());
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  });

  it("SIGTERM during the download stops npm, removes the lock and partial tree, exits 143; the next start proceeds", async () => {
    setMode("slow");
    const child = spawn("sh", [INSTALL], { env: baseEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 100 && !existsSync(join(root, "npm-started")); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(dir, ".lock"))).toBe(true);
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(stdout.trim()).toBe("");
    expect(existsSync(join(dir, ".lock"))).toBe(false);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    setMode("ok");
    expect(runInstall().stdout).toBe(binPath());
  }, 20_000);

  it("a download that outlasts the cap falls through to the failure line", () => {
    setMode("slow");
    const started = Date.now();
    const r = runInstall({ MEMBRAL_CLAUDE_CLI_TIMEOUT_S: "1" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("the download did not finish within 1 s");
    expect(existsSync(join(dir, ".lock"))).toBe(false);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  }, 20_000);
});

describe("entrypoint.sh", () => {
  let dockerDir: string;

  beforeEach(() => {
    // The entrypoint with a stub substitute-env.mjs and the real install.sh.
    dockerDir = join(root, "docker");
    mkdirSync(join(dockerDir, "claude-cli"), { recursive: true });
    writeFileSync(join(dockerDir, "substitute-env.mjs"), "");
    for (const f of ["install.sh", "package.json", "package-lock.json"]) {
      cpSync(join(HERE, f), join(dockerDir, "claude-cli", f));
    }
    chmodSync(join(dockerDir, "claude-cli", "install.sh"), 0o755);
  });

  function runEntrypoint(extra: Record<string, string>) {
    const r = spawnSync(
      "sh",
      [ENTRYPOINT, "sh", "-c", 'echo "BIN=[${MEMBRAL_CLAUDE_BIN:-}] AU=[${DISABLE_AUTOUPDATER:-}] UN=[${MEMBRAL_CLAUDE_UNAVAILABLE:-}]"'],
      { env: baseEnv({ MEMBRAL_DOCKER_DIR: dockerDir, MEMBRAL_CLAUDE_CLI_SRC: join(dockerDir, "claude-cli"), ...extra }), encoding: "utf8" },
    );
    return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
  }

  it("exports the binary and DISABLE_AUTOUPDATER after a working install", () => {
    setMode("ok");
    const r = runEntrypoint({ MEMBRAL_LLM_PROVIDER: "claude-code" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`BIN=[${binPath()}] AU=[1] UN=[]`);
  });

  it("leaves MEMBRAL_CLAUDE_BIN unset and marks Claude Code unavailable when the download fails", () => {
    setMode("fail");
    const r = runEntrypoint({ MEMBRAL_LLM_PROVIDER: "claude-code" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("BIN=[] AU=[] UN=[1]");
    expect(r.stderr).toContain("Claude Code could not be downloaded from npm");
  });

  it("does nothing for another provider or a preset MEMBRAL_CLAUDE_BIN", () => {
    setMode("ok");
    expect(runEntrypoint({}).stdout).toBe("BIN=[] AU=[] UN=[]");
    expect(runEntrypoint({ MEMBRAL_LLM_PROVIDER: "openai" }).stdout).toBe("BIN=[] AU=[] UN=[]");
    expect(runEntrypoint({ MEMBRAL_LLM_PROVIDER: "claude-code", MEMBRAL_CLAUDE_BIN: "/opt/claude" }).stdout).toBe(
      "BIN=[/opt/claude] AU=[] UN=[]",
    );
    expect(existsSync(join(root, "npm-env.txt"))).toBe(false);
  });
});
