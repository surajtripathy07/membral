// `membral sweep` + its launchd agent. launchctl is injected; HOME is a temp dir.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARSERS } from "@membral/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSweepState, writeSweepState } from "../sweep.js";
import {
  buildSweepPlist,
  installSweepAgent,
  sweepCommand,
  sweepPlistPath,
  uninstallSweepAgent,
} from "../sweep-command.js";

// Expected `importFn` calls derive from the parser registry, in its order,
// rather than a hardcoded harness list (#288).
const EXPECTED_SOURCES = Object.keys(PARSERS);

const INVOCATION = { argv: ["/opt/homebrew/bin/node", "/opt/homebrew/lib/node_modules/membral/dist/index.js"] };

describe("sweep launchd agent", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "membral-sweep-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("plist runs `<node> <entry> sweep` every 20 min and logs to ~/.membral/logs/sweep.log", () => {
    const plist = buildSweepPlist(INVOCATION, "/h/.membral/logs/sweep.log");
    expect(plist).toContain("<string>me.membral.sweep</string>");
    expect(plist).toContain(
      "<string>/opt/homebrew/bin/node</string>\n    <string>/opt/homebrew/lib/node_modules/membral/dist/index.js</string>\n    <string>sweep</string>",
    );
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>1200</integer>");
    expect(plist.match(/\/h\/\.membral\/logs\/sweep\.log/g)).toHaveLength(2);
  });

  it("--dry-run prints only: no file, no launchctl", async () => {
    const launchctl = vi.fn();
    const r = await installSweepAgent({
      home,
      platform: "darwin",
      uid: 501,
      cliInvocation: INVOCATION,
      dryRun: true,
      launchctl,
    });
    expect(r.message).toContain("[dry-run]");
    expect(r.message).toContain("launchctl bootstrap gui/501");
    expect(existsSync(sweepPlistPath(home))).toBe(false);
    expect(launchctl).not.toHaveBeenCalled();
  });

  it("reports scheduler none (not a quiet success) on a platform with no scheduler", async () => {
    const launchctl = vi.fn();
    const r = await installSweepAgent({ home, platform: "win32", cliInvocation: INVOCATION, launchctl });
    expect(r.success).toBe(false);
    expect(r.scheduler).toBe("none");
    expect(r.message).toContain("NOT scheduled");
    expect(launchctl).not.toHaveBeenCalled();
  });

  it("macOS never touches systemctl/crontab", async () => {
    const launchctl = vi.fn(async (_args: string[]) => ({ ok: true, output: "" }));
    const run = vi.fn();
    const r = await installSweepAgent({
      home,
      platform: "darwin",
      uid: 501,
      cliInvocation: INVOCATION,
      launchctl,
      run,
    });
    expect(r.scheduler).toBe("launchd");
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
  });

  it("uninstall boots out and deletes the plist", async () => {
    const launchctl = vi.fn(async (_args: string[]) => ({ ok: true, output: "" }));
    await installSweepAgent({ home, platform: "darwin", uid: 501, cliInvocation: INVOCATION, launchctl });
    launchctl.mockClear();
    const r = await uninstallSweepAgent({ home, platform: "darwin", uid: 501, launchctl });
    expect(r.success).toBe(true);
    expect(r.message).toContain("Removed");
    expect(launchctl.mock.calls[0][0]).toEqual(["bootout", "gui/501/me.membral.sweep"]);
    expect(existsSync(sweepPlistPath(home))).toBe(false);
    const again = await uninstallSweepAgent({ home, platform: "darwin", uid: 501, launchctl });
    expect(again.message).toContain("not installed");
  });

  it("writes the plist and bootstraps it; an unchanged loaded agent is left alone", async () => {
    const launchctl = vi.fn(async (_args: string[]) => ({ ok: true, output: "" }));
    const r = await installSweepAgent({ home, platform: "darwin", uid: 501, cliInvocation: INVOCATION, launchctl });
    expect(r.success).toBe(true);
    expect(r.scheduler).toBe("launchd");
    expect(readFileSync(sweepPlistPath(home), "utf8")).toContain("<string>sweep</string>");
    expect(existsSync(join(home, ".membral", "logs"))).toBe(true);
    expect(launchctl.mock.calls.map((c) => c[0][0])).toEqual(["bootout", "bootstrap"]);
    expect(launchctl.mock.calls[1][0]).toEqual(["bootstrap", "gui/501", sweepPlistPath(home)]);

    launchctl.mockClear();
    const again = await installSweepAgent({ home, platform: "darwin", uid: 501, cliInvocation: INVOCATION, launchctl });
    expect(again.message).toContain("already installed");
    expect(launchctl.mock.calls.map((c) => c[0][0])).toEqual(["print"]);
  });

  it("tolerates an already-loaded bootstrap error", async () => {
    const launchctl = vi.fn(async (args: string[]) =>
      args[0] === "bootstrap"
        ? { ok: false, output: "Bootstrap failed: 5: service is already loaded" }
        : { ok: true, output: "" },
    );
    const r = await installSweepAgent({ home, platform: "darwin", uid: 501, cliInvocation: INVOCATION, launchctl });
    expect(r.success).toBe(true);
  });
});

describe("sweepCommand", () => {
  let dir: string;
  let statePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-sweep-state-"));
    statePath = join(dir, "sweep-state.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const now = () => new Date("2026-09-25T12:00:00.000Z");
  // The ref-keyed git check is a network + git step; every sweep here stubs it
  // (a "did not run" outcome), and the dedicated tests below cover its wiring.
  const noRefCheck = () => vi.fn(async () => ({ ok: true, ran: false, checked: 0, repos: 0, skippedRepos: 0 }));

  it("imports every source since last success minus 5 min, then advances the state", async () => {
    await writeSweepState(statePath, {
      last_success_at: "2026-09-25T11:40:00Z",
      run_count: 3,
      runs_since_full_walk: 3,
    });
    const importFn = vi.fn(async () => ({ ok: true, totalImported: 1, totalErrored: 0, totalSessions: 1 }));
    const heartbeatFn = vi.fn(async () => true);
    const kickFn = vi.fn(async () => ({ ok: true }));

    expect(await sweepCommand({ statePath, now, importFn, heartbeatFn, kickFn, branchStateFn: noRefCheck() })).toBe(
      true,
    );

    expect(importFn.mock.calls.map((c) => (c as unknown as [{ source: string; since: string }])[0])).toEqual(
      EXPECTED_SOURCES.map((source) =>
        expect.objectContaining({ source, since: "2026-09-25T11:35:00Z", heartbeat: false }),
      ),
    );
    expect(heartbeatFn).not.toHaveBeenCalled();
    expect(await readSweepState(statePath)).toEqual({
      last_success_at: "2026-09-25T12:00:00Z",
      run_count: 4,
      runs_since_full_walk: 4,
    });
  });

  it("every 12th run is a full walk (bounded to the 30-day window) so sessions a delta window can miss are retried; the counter resets", async () => {
    await writeSweepState(statePath, {
      last_success_at: "2026-09-25T11:40:00Z",
      run_count: 40,
      runs_since_full_walk: 11,
    });
    const importFn = vi.fn(async () => ({ ok: true, totalImported: 0, totalErrored: 0, totalSessions: 2 }));
    await sweepCommand({
      statePath,
      now,
      importFn,
      heartbeatFn: vi.fn(async () => true),
      kickFn: vi.fn(async () => ({ ok: true })),
      branchStateFn: noRefCheck(),
    });
    // Bounded to the 30-day import window (now = 2026-09-25T12:00Z), not unbounded history.
    for (const c of importFn.mock.calls) {
      expect((c as unknown as [{ since?: string }])[0].since).toBe("2026-08-26T12:00:00.000Z");
    }
    expect(await readSweepState(statePath)).toEqual({
      last_success_at: "2026-09-25T12:00:00Z",
      run_count: 41,
      runs_since_full_walk: 0,
    });

    // The next run is a delta again.
    importFn.mockClear();
    await sweepCommand({
      statePath,
      now: () => new Date("2026-09-25T12:20:00.000Z"),
      importFn,
      heartbeatFn: vi.fn(async () => true),
      kickFn: vi.fn(async () => ({ ok: true })),
      branchStateFn: noRefCheck(),
    });
    expect((importFn.mock.calls[0] as unknown as [{ since?: string }])[0].since).toBe("2026-09-25T11:55:00Z");
  });

  it("first run looks back 24h and sends one heartbeat when nothing was in the window", async () => {
    const importFn = vi.fn(async () => ({ ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0 }));
    const heartbeatFn = vi.fn(async () => true);
    await sweepCommand({
      statePath,
      now,
      importFn,
      heartbeatFn,
      kickFn: vi.fn(async () => ({ ok: true })),
      // Hermetic: the real ref check would read ~/.membral/credentials.json and call the network.
      branchStateFn: noRefCheck(),
    });
    expect((importFn.mock.calls[0] as unknown as [{ since: string }])[0].since).toBe("2026-09-24T12:00:00Z");
    expect(heartbeatFn).toHaveBeenCalledTimes(1);
  });

  it("a failed import leaves the state alone so the next run retries the window", async () => {
    await writeSweepState(statePath, {
      last_success_at: "2026-09-25T11:40:00Z",
      run_count: 3,
      runs_since_full_walk: 3,
    });
    const importFn = vi.fn(async () => ({ ok: false, totalImported: 0, totalErrored: 1, totalSessions: 1 }));
    const kickFn = vi.fn(async () => ({ ok: true }));
    expect(
      await sweepCommand({ statePath, now, importFn, heartbeatFn: vi.fn(), kickFn, branchStateFn: noRefCheck() }),
    ).toBe(false);
    expect((await readSweepState(statePath)).last_success_at).toBe("2026-09-25T11:40:00Z");
    expect(process.exitCode).toBe(1);
    // Kicked exactly once even though this run's own import failed — kicking
    // the memory-extraction queue is unrelated to the code-session import
    // outcome.
    expect(kickFn).toHaveBeenCalledTimes(1);
  });

  it("a rejected key stops at the first source and skips the kick (one message per run); exit code stays 1", async () => {
    await writeSweepState(statePath, {
      last_success_at: "2026-09-25T11:40:00Z",
      run_count: 3,
      runs_since_full_walk: 3,
    });
    const importFn = vi.fn(async () => ({
      ok: false,
      totalImported: 0,
      totalErrored: 0,
      totalSessions: 3,
      authRejected: true,
    }));
    const heartbeatFn = vi.fn();
    const kickFn = vi.fn(async () => ({ ok: true }));
    expect(await sweepCommand({ statePath, now, importFn, heartbeatFn, kickFn, branchStateFn: noRefCheck() })).toBe(
      false,
    );
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(heartbeatFn).not.toHaveBeenCalled();
    expect(kickFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect((await readSweepState(statePath)).last_success_at).toBe("2026-09-25T11:40:00Z");
  });

  it("a second concurrent run exits 0 with 'another import is running' and leaves the state alone", async () => {
    const lockPath = join(dir, "import.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    const importFn = vi.fn();
    const kickFn = vi.fn(async () => ({ ok: true }));
    expect(
      await sweepCommand({ statePath, now, importFn, heartbeatFn: vi.fn(), kickFn, branchStateFn: noRefCheck() }),
    ).toBe(true);
    expect(importFn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("another import is running");
    expect(existsSync(statePath)).toBe(false);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(lockPath)).toBe(true); // someone else's lock is never removed
    // Another run already owns this window — no point nudging the queue twice.
    expect(kickFn).not.toHaveBeenCalled();
  });

  it("releases the lock after a run, and rotates a > 1 MB sweep.log to sweep.log.1 at start", async () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    const logPath = join(dir, "logs", "sweep.log");
    writeFileSync(logPath, "x".repeat(1024 * 1024 + 1));
    const importFn = vi.fn(async () => ({ ok: true, totalImported: 1, totalErrored: 0, totalSessions: 1 }));
    expect(
      await sweepCommand({
        statePath,
        now,
        importFn,
        heartbeatFn: vi.fn(),
        kickFn: vi.fn(async () => ({ ok: true })),
        branchStateFn: noRefCheck(),
      }),
    ).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(join(dir, "import.lock"))).toBe(false);
    expect((importFn.mock.calls[0] as unknown as [{ missingHarnessOk: boolean }])[0].missingHarnessOk).toBe(true);
  });

  it("calls kickFn once at the end of a successful run", async () => {
    const importFn = vi.fn(async () => ({ ok: true, totalImported: 1, totalErrored: 0, totalSessions: 1 }));
    const kickFn = vi.fn(async () => ({ ok: true, kicked: true, pending: 2 }));
    expect(
      await sweepCommand({ statePath, now, importFn, heartbeatFn: vi.fn(), kickFn, branchStateFn: noRefCheck() }),
    ).toBe(true);
    expect(kickFn).toHaveBeenCalledTimes(1);
    expect(kickFn.mock.calls[0][0]).toEqual({});
  });

  it("a kick failure is logged but never fails the sweep", async () => {
    const importFn = vi.fn(async () => ({ ok: true, totalImported: 1, totalErrored: 0, totalSessions: 1 }));
    const kickFn = vi.fn(async (_opts: unknown, logWarn: (m: string) => void) => {
      logWarn("memory extraction kick failed: boom");
      return { ok: false };
    });
    expect(
      await sweepCommand({ statePath, now, importFn, heartbeatFn: vi.fn(), kickFn, branchStateFn: noRefCheck() }),
    ).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect(kickFn).toHaveBeenCalledTimes(1);
  });

  it("runs the ref-keyed git check after import + kick and records its count in the state file", async () => {
    const order: string[] = [];
    const importFn = vi.fn(async () => {
      order.push("import");
      return { ok: true, totalImported: 1, totalErrored: 0, totalSessions: 1 };
    });
    const kickFn = vi.fn(async () => {
      order.push("kick");
      return { ok: true };
    });
    const branchStateFn = vi.fn(async () => {
      order.push("refs");
      return { ok: true, ran: true, checked: 3, repos: 1, skippedRepos: 0 };
    });
    expect(await sweepCommand({ statePath, now, importFn, heartbeatFn: vi.fn(), kickFn, branchStateFn })).toBe(true);
    expect(order).toEqual([...EXPECTED_SOURCES.map(() => "import"), "kick", "refs"]);
    expect(branchStateFn).toHaveBeenCalledTimes(1);
    // One policy client per run, shared with the imports and the kick (R4 4.3), whenever a key resolves.
    const refsOpts = branchStateFn.mock.calls[0][0] as { client?: { call?: unknown } };
    expect(Object.keys(refsOpts).filter((k) => k !== "client")).toEqual([]);
    if (refsOpts.client) expect(typeof refsOpts.client.call).toBe("function");
    expect(await readSweepState(statePath)).toEqual({
      last_success_at: "2026-09-25T12:00:00Z",
      run_count: 1,
      runs_since_full_walk: 1,
      last_ref_checks: 3,
    });
  });

  it("a failed or skipped ref check never fails the sweep, and a check that did not run leaves the state untouched", async () => {
    const importFn = vi.fn(async () => ({ ok: true, totalImported: 1, totalErrored: 0, totalSessions: 1 }));
    const failing = vi.fn(async (_opts: unknown, logWarn: (m: string) => void) => {
      logWarn("sweep: refs-to-check request failed: server returned 503");
      return { ok: false, ran: false, checked: 0, repos: 0, skippedRepos: 0 };
    });
    expect(
      await sweepCommand({
        statePath,
        now,
        importFn,
        heartbeatFn: vi.fn(),
        kickFn: vi.fn(async () => ({ ok: true })),
        branchStateFn: failing,
      }),
    ).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect(await readSweepState(statePath)).toEqual({
      last_success_at: "2026-09-25T12:00:00Z",
      run_count: 1,
      runs_since_full_walk: 1,
    });
  });

  it("the ref check is skipped entirely when another import holds the lock", async () => {
    writeFileSync(join(dir, "import.lock"), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const branchStateFn = vi.fn();
    await sweepCommand({ statePath, now, importFn: vi.fn(), heartbeatFn: vi.fn(), kickFn: vi.fn(), branchStateFn });
    expect(branchStateFn).not.toHaveBeenCalled();
  });
});
