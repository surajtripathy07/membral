// `membral up|down|status|logs` with an injected spawn, fetch, clock and pid table.
// Files go to a temp dir; nothing touches ~/.membral, Docker or the network.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProfiles } from "../credentials.js";
import { localPaths, parseEnv } from "../local-stack.js";
import { SERVER_RELATIVE, type SpawnedServer, type SpawnOptions } from "../server-launch.js";
import {
  downCommand,
  HEALTH_TIMEOUT_MS,
  logsCommand,
  statusCommand,
  type UpCommandDeps,
  upCommand,
} from "../up-command.js";

let dir: string; // the "~/.membral/local"
let serverDir: string;
let credsPath: string;
let alive: Set<number>;
let spawned: { command: string; args: string[]; opts: SpawnOptions }[];
let clock: number;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitCodeBefore: typeof process.exitCode;

const out = () => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
const err = () => errSpy.mock.calls.map((c) => c.join(" ")).join("\n");

function healthFetch(opts: { store?: string; ok?: boolean; provisionStatus?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/api/health")) {
      if (opts.ok === false) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ ok: true, store: opts.store ?? "ready" }), { status: 200 });
    }
    if (u.endsWith("/api/internal/local/provision")) {
      if (opts.provisionStatus) return new Response("no", { status: opts.provisionStatus });
      return new Response(
        JSON.stringify({ userId: "u1", email: "you@membral.local", created: true, apiKey: "mk_test_key" }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

function deps(over: Partial<UpCommandDeps> = {}): UpCommandDeps {
  return {
    paths: localPaths(dir),
    credentialsPath: credsPath,
    env: { PATH: "/bin" },
    cwd: dir,
    isTTY: true,
    isPortFree: async () => true,
    claudeOnPath: () => true,
    pidAlive: (p) => alive.has(p),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    hostname: () => "testhost",
    sweepCheck: async () => null,
    runSetup: vi.fn(async () => {}),
    spawn: (command, args, opts): SpawnedServer => {
      spawned.push({ command, args, opts });
      alive.add(4242);
      return { pid: 4242, unref: vi.fn(), onExit: vi.fn() };
    },
    kill: (pid) => {
      alive.delete(pid);
    },
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "membral-up-"));
  serverDir = join(dir, "srv");
  mkdirSync(join(serverDir, "apps", "cloud"), { recursive: true });
  writeFileSync(join(serverDir, SERVER_RELATIVE), "// fake server");
  mkdirSync(join(serverDir, "migrations"));
  credsPath = join(dir, "credentials.json");
  alive = new Set();
  spawned = [];
  clock = 1_000_000;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = exitCodeBefore;
  rmSync(dir, { recursive: true, force: true });
});

describe("up: server dir report and version check", () => {
  const said = () => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");

  it("prints the chosen server dir and how it was found", async () => {
    await upCommand({ port: "3557", serverDir }, deps({ fetchImpl: healthFetch().impl }));
    expect(said()).toContain(`Server dir: ${serverDir} (from --server-dir)`);
  });

  it("warns naming both versions when the server differs from the CLI, and still starts", async () => {
    writeFileSync(join(serverDir, "package.json"), JSON.stringify({ version: "0.3.0" }));
    await upCommand({ serverDir }, deps({ fetchImpl: healthFetch().impl, cliVersion: "0.2.1" }));
    expect(err()).toMatch(/0\.3\.0.*0\.2\.1/);
    expect(spawned).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("is quiet when the versions match", async () => {
    writeFileSync(join(serverDir, "package.json"), JSON.stringify({ version: "0.2.1" }));
    await upCommand({ serverDir }, deps({ fetchImpl: healthFetch().impl, cliVersion: "0.2.1" }));
    expect(err()).not.toContain("Warning");
  });
});

describe("up: packaged server substitute-env step", () => {
  const pkg = () => {
    mkdirSync(join(serverDir, "docker"), { recursive: true });
    writeFileSync(join(serverDir, "docker", "substitute-env.mjs"), "// fake");
  };

  it("runs it before the spawn with the server's NEXT_PUBLIC values and secrets", async () => {
    pkg();
    const order: string[] = [];
    const execCalls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const d = deps({
      fetchImpl: healthFetch().impl,
      exec: (_c, args, o) => {
        order.push("exec");
        execCalls.push({ args, env: o.env });
        return { status: 0, output: "" };
      },
    });
    const base = d.spawn!;
    d.spawn = (c, a, o) => {
      order.push("spawn");
      return base(c, a, o);
    };
    await upCommand({ port: "3556", serverDir }, d);
    expect(order).toEqual(["exec", "spawn"]);
    expect(execCalls[0].args).toEqual([join(serverDir, "docker", "substitute-env.mjs")]);
    expect(execCalls[0].env).toMatchObject({
      MEMBRAL_NEXT_DIR: join(serverDir, "apps", "cloud", ".next"),
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3556",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3556",
    });
    expect(execCalls[0].env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBeTruthy();
    // the server itself gets the service-role key and JWT secret
    expect(spawned[0].opts.env.SUPABASE_SERVICE_ROLE_KEY).toBeTruthy();
    expect(spawned[0].opts.env.SUPABASE_JWT_SECRET).toBeTruthy();
  });

  it("a non-zero exit stops before the spawn, shows its output and hints at a rebuild", async () => {
    pkg();
    await upCommand(
      { serverDir },
      deps({ fetchImpl: healthFetch().impl, exec: () => ({ status: 1, output: "NEXT_PUBLIC mismatch" }) }),
    );
    expect(process.exitCode).toBe(1);
    expect(spawned).toHaveLength(0);
    expect(err()).toContain("NEXT_PUBLIC mismatch");
    expect(err()).toContain("re-copy");
  });

  it("is skipped when the server dir has no substitute-env.mjs", async () => {
    const exec = vi.fn(() => ({ status: 0, output: "" }));
    await upCommand({ serverDir }, deps({ fetchImpl: healthFetch().impl, exec }));
    expect(exec).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
  });
});

describe("up", () => {
  it("starts the server, waits for a ready store, provisions and saves the profile", async () => {
    const f = healthFetch();
    const d = deps({ fetchImpl: f.impl });
    await upCommand({ port: "3555", serverDir }, d);

    expect(process.exitCode).toBeUndefined();
    expect(spawned).toHaveLength(1);
    const s = spawned[0];
    expect(s.args).toEqual([join(serverDir, SERVER_RELATIVE)]);
    expect(s.opts.logPath).toBe(join(dir, "logs", "server.log"));
    expect(s.opts.env).toMatchObject({
      MEMBRAL_LOCAL: "1",
      MEMBRAL_STORE: "pglite",
      MEMBRAL_PGDATA: join(dir, "pgdata"),
      MEMBRAL_MIGRATIONS_DIR: join(serverDir, "migrations"),
      PORT: "3555",
      HOSTNAME: "127.0.0.1",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3555",
      MEMBRAL_LLM_PROVIDER: "claude-code",
    });
    expect(readFileSync(join(dir, "server.pid"), "utf8").trim()).toBe("4242");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    expect(env.MEMBRAL_APP_PORT).toBe("3555");
    expect(env.JWT_SECRET).toBeTruthy();
    expect(existsSync(join(dir, "pgdata"))).toBe(true);
    expect(existsSync(join(dir, "logs"))).toBe(true);

    const prov = f.calls.find((c) => c.url.endsWith("/api/internal/local/provision"));
    expect(prov?.url).toBe("http://127.0.0.1:3555/api/internal/local/provision");
    expect((prov?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${env.SERVICE_ROLE_KEY}`);
    const profile = loadProfiles(credsPath);
    expect(profile?.activeProfile).toBe("local");
    expect(profile?.profiles.local).toMatchObject({ apiUrl: "http://127.0.0.1:3555", apiKey: "mk_test_key" });
    expect(d.runSetup).toHaveBeenCalledWith(expect.objectContaining({ apiUrl: "http://127.0.0.1:3555", yes: false }));
  });

  it("never probes Docker (no docker runner is consulted)", async () => {
    const runner = { run: vi.fn() };
    await upCommand({ serverDir }, deps({ fetchImpl: healthFetch().impl, runner }));
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("refuses when the port is taken", async () => {
    await upCommand(
      { port: "3555", serverDir },
      deps({ fetchImpl: healthFetch().impl, isPortFree: async () => false }),
    );
    expect(process.exitCode).toBe(1);
    expect(err()).toMatch(/Port 3555 is in use/);
    expect(spawned).toHaveLength(0);
  });

  it("refuses when the Docker stack's compose file is here and its port is busy", async () => {
    writeFileSync(join(dir, "docker-compose.yml"), "name: membral");
    writeFileSync(join(dir, ".env"), "MEMBRAL_APP_PORT=3000\n");
    await upCommand(
      { port: "3555", serverDir },
      deps({ fetchImpl: healthFetch().impl, isPortFree: async (p) => p !== 3000 }),
    );
    expect(process.exitCode).toBe(1);
    expect(err()).toMatch(/Docker stack.*running on port 3000.*membral local down/);
    expect(spawned).toHaveLength(0);
  });

  it("fails clearly when no server build is found", async () => {
    await upCommand(
      {},
      deps({ fetchImpl: healthFetch().impl, selfUrl: pathToFileURL(join(dir, "bare", "index.js")).href }),
    );
    expect(process.exitCode).toBe(1);
    expect(err()).toMatch(/build:local-server.*--server-dir.*MEMBRAL_SERVER_DIR/s);
    expect(spawned).toHaveLength(0);
  });

  it("does not take migrations from a checkout in the current folder", async () => {
    rmSync(join(serverDir, "migrations"), { recursive: true });
    const checkout = join(dir, "checkout");
    mkdirSync(join(checkout, "apps", "cloud", "supabase", "migrations"), { recursive: true });
    writeFileSync(join(checkout, "apps", "cloud", "package.json"), "{}");
    await upCommand(
      { serverDir },
      deps({
        fetchImpl: healthFetch().impl,
        cwd: checkout,
        selfUrl: pathToFileURL(join(dir, "bare", "index.js")).href,
      }),
    );
    expect(spawned).toHaveLength(1);
    const used = (spawned[0].opts as { env?: NodeJS.ProcessEnv }).env?.MEMBRAL_MIGRATIONS_DIR;
    expect(used).toBeUndefined();
  });

  it("times out after 120 s and prints the last 20 log lines", async () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(dir, "logs", "server.log"), `${lines}\n`);
    const d = deps({ fetchImpl: healthFetch({ ok: false }).impl });
    await upCommand({ serverDir }, d);
    expect(process.exitCode).toBe(1);
    expect(clock - 1_000_000).toBeGreaterThanOrEqual(HEALTH_TIMEOUT_MS);
    const e = err();
    expect(e).toMatch(/did not report a ready store within 120 s/);
    expect(e).toContain("line 30");
    expect(e).toContain("line 11");
    expect(e).not.toContain("line 10\n");
    expect(loadProfiles(credsPath)).toBeNull();
  });

  it("stops waiting when the server exits early", async () => {
    let exitCb: ((code: number | null) => void) | undefined;
    const d = deps({
      fetchImpl: healthFetch({ ok: false }).impl,
      spawn: (command, args, opts) => {
        spawned.push({ command, args, opts });
        return { pid: 77, unref: vi.fn(), onExit: (cb) => (exitCb = cb) };
      },
      sleep: async (ms) => {
        clock += ms;
        exitCb?.(1);
      },
    });
    await upCommand({ serverDir }, d);
    expect(err()).toMatch(/exited \(code 1\)/);
    expect(clock - 1_000_000).toBeLessThan(HEALTH_TIMEOUT_MS);
    expect(existsSync(join(dir, "server.pid"))).toBe(false);
  });

  it("is a no-op that prints status when the server is already running", async () => {
    writeFileSync(join(dir, "server.pid"), "4242\n");
    alive.add(4242);
    writeFileSync(join(dir, ".env"), "MEMBRAL_APP_PORT=3555\n");
    await upCommand({ serverDir }, deps({ fetchImpl: healthFetch().impl }));
    expect(spawned).toHaveLength(0);
    expect(out()).toMatch(/already running/);
    expect(out()).toMatch(/pid 4242/);
    expect(out()).toMatch(/Store:\s+ready/);
    expect(process.exitCode).toBeUndefined();
  });

  it("replaces a stale pid file", async () => {
    writeFileSync(join(dir, "server.pid"), "999\n");
    await upCommand({ serverDir }, deps({ fetchImpl: healthFetch().impl }));
    expect(spawned).toHaveLength(1);
    expect(readFileSync(join(dir, "server.pid"), "utf8").trim()).toBe("4242");
  });

  it("never prompts without a TTY: setup runs with the defaults", async () => {
    const confirm = vi.fn();
    const d = deps({ fetchImpl: healthFetch().impl, isTTY: false, confirm });
    await upCommand({ serverDir }, d);
    expect(d.runSetup).toHaveBeenCalledWith(expect.objectContaining({ yes: true }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("runs attached with --foreground (no log file) and cleans up when the server ends", async () => {
    const d = deps({
      fetchImpl: healthFetch().impl,
      spawn: (command, args, opts) => {
        spawned.push({ command, args, opts });
        return { pid: 4242, unref: vi.fn(), onExit: (cb) => setTimeout(() => cb(0), 0) };
      },
    });
    await upCommand({ serverDir, foreground: true }, d);
    expect(spawned[0].opts.logPath).toBeUndefined();
    expect(existsSync(join(dir, "server.pid"))).toBe(false);
  });
});

describe("down", () => {
  it("sends SIGTERM and waits for the process and the lock to go", async () => {
    writeFileSync(join(dir, "server.pid"), "4242\n");
    alive.add(4242);
    mkdirSync(join(dir, "pgdata"));
    writeFileSync(join(dir, "pgdata", ".membral.lock"), "4242");
    const kill = vi.fn((pid: number) => {
      alive.delete(pid);
    });
    const d = deps({
      kill,
      sleep: async (ms) => {
        clock += ms;
        rmSync(join(dir, "pgdata", ".membral.lock"), { force: true });
      },
    });
    await downCommand({}, d);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(existsSync(join(dir, "server.pid"))).toBe(false);
    expect(existsSync(join(dir, "pgdata"))).toBe(true);
    expect(out()).toMatch(/Stopped/);
  });

  it("does not wait for a stale informational lock file once the pid is gone", async () => {
    writeFileSync(join(dir, "server.pid"), "4242\n");
    alive.add(4242);
    mkdirSync(join(dir, "pgdata"));
    writeFileSync(join(dir, "pgdata", ".membral.lock"), "pid:4242");
    const d = deps({
      kill: (pid: number) => {
        alive.delete(pid);
      },
    });
    await downCommand({}, d);
    expect(process.exitCode).not.toBe(1);
    expect(out()).toMatch(/Stopped/);
    expect(clock).toBe(1_000_000);
  });

  it("fails after 30 s when the server will not stop", async () => {
    writeFileSync(join(dir, "server.pid"), "4242\n");
    alive.add(4242);
    await downCommand({}, deps({ kill: () => {} }));
    expect(process.exitCode).toBe(1);
    expect(err()).toMatch(/did not stop within 30 s/);
    expect(existsSync(join(dir, "server.pid"))).toBe(true);
  });

  it("says so when nothing runs", async () => {
    await downCommand({}, deps());
    expect(out()).toMatch(/not running/);
    expect(process.exitCode).toBeUndefined();
  });

  it("--wipe deletes pgdata after a yes", async () => {
    mkdirSync(join(dir, "pgdata"));
    writeFileSync(join(dir, "pgdata", "f"), "x");
    const confirm = vi.fn(async () => true);
    await downCommand({ wipe: true }, deps({ confirm }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "pgdata"))).toBe(false);
  });

  it("--wipe keeps the data on a no", async () => {
    mkdirSync(join(dir, "pgdata"));
    await downCommand({ wipe: true }, deps({ confirm: async () => false }));
    expect(existsSync(join(dir, "pgdata"))).toBe(true);
  });

  it("--wipe without a TTY refuses unless --yes, and stops nothing when it refuses", async () => {
    writeFileSync(join(dir, "server.pid"), "4242\n");
    alive.add(4242);
    mkdirSync(join(dir, "pgdata"));
    const confirm = vi.fn();
    const kill = vi.fn();
    await downCommand({ wipe: true }, deps({ isTTY: false, confirm, kill }));
    expect(process.exitCode).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "pgdata"))).toBe(true);

    process.exitCode = undefined;
    await downCommand({ wipe: true, yes: true }, deps({ isTTY: false, confirm }));
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "pgdata"))).toBe(false);
  });
});

describe("status", () => {
  it("reports pid, port, health, store and data size", async () => {
    writeFileSync(join(dir, "server.pid"), "4242\n");
    alive.add(4242);
    writeFileSync(join(dir, ".env"), "MEMBRAL_APP_PORT=3555\n");
    mkdirSync(join(dir, "pgdata"));
    writeFileSync(join(dir, "pgdata", "f"), "x".repeat(2048));
    await statusCommand({}, deps({ fetchImpl: healthFetch().impl }));
    const o = out();
    expect(o).toContain("http://127.0.0.1:3555");
    expect(o).toMatch(/pid 4242/);
    expect(o).toMatch(/Health:\s+ok/);
    expect(o).toMatch(/Store:\s+ready/);
    expect(o).toMatch(/2\.0 KB/);
    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 when the server is not running", async () => {
    await statusCommand({}, deps({ fetchImpl: healthFetch().impl }));
    expect(out()).toMatch(/not running/);
    expect(process.exitCode).toBe(1);
  });
});

describe("logs", () => {
  it("prints the last 50 lines and follows when asked", async () => {
    mkdirSync(join(dir, "logs"));
    const body = Array.from({ length: 60 }, (_, i) => `l${i + 1}`).join("\n");
    writeFileSync(join(dir, "logs", "server.log"), `${body}\n`);
    const follow = vi.fn(async () => {});
    await logsCommand({ follow: true }, deps({ follow }));
    expect(out()).toContain("l60");
    expect(out()).toContain("l11");
    expect(out()).not.toContain("l10\n");
    expect(follow).toHaveBeenCalledWith(join(dir, "logs", "server.log"));
  });

  it("fails when there is no log yet", async () => {
    await logsCommand({}, deps());
    expect(process.exitCode).toBe(1);
    expect(err()).toMatch(/No server log yet/);
  });
});
