// Linux backstop sweep scheduler: systemd --user timer, crontab fallback.
// systemctl/crontab go through a fake CommandRunner; HOME is a temp dir.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSweepAgent, uninstallSweepAgent } from "../sweep-command.js";
import {
  buildCronEntry,
  buildSweepService,
  buildSweepTimer,
  type CommandResult,
  CRON_DAEMON_WARNING,
  CRON_MARKER,
  LINGER_NOTE,
  stripCronEntry,
  systemdUnitDir,
  withCronEntry,
} from "../sweep-linux.js";

const INVOCATION = { argv: ["/usr/bin/node", "/usr/lib/node_modules/membral/dist/index.js"] };

interface FakeOpts {
  systemd?: boolean;
  crontab?: string | "none-binary";
  enableFails?: boolean;
  /** loginctl's Linger value; default "yes". */
  linger?: "yes" | "no";
  /** Is a cron daemon process running? default true. */
  cronDaemon?: boolean;
  /** `crontab -` fails with this stderr. */
  crontabWriteError?: string;
  /** stderr noise `crontab -l` prints next to the table. */
  crontabStderr?: string;
  /** What `command -v membral` prints; undefined = not on PATH. */
  membralOnPath?: string;
}

const res = (ok: boolean, stdout = "", stderr = "", missing?: boolean): CommandResult => ({
  ok,
  stdout,
  output: `${stdout}${stderr}`.trim(),
  ...(missing ? { missing } : {}),
});

/** A fake machine: user systemd on/off, a crontab, and a log of every call. */
function fakeMachine(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const state = { crontab: opts.crontab, enabled: false, active: false };
  const run = async (cmd: string, args: string[], input?: string): Promise<CommandResult> => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "systemctl") {
      if (!opts.systemd) return res(false, "", "Failed to connect to bus: No medium found");
      const verb = args[1];
      if (verb === "enable") {
        if (opts.enableFails) return res(false, "", "boom");
        state.enabled = true;
        state.active = true;
      }
      if (verb === "disable") {
        state.enabled = false;
        state.active = false;
      }
      if (verb === "is-enabled") return res(state.enabled);
      if (verb === "is-active") return res(state.active);
      return res(true);
    }
    if (cmd === "loginctl") return res(true, `Linger=${opts.linger ?? "yes"}\n`);
    if (cmd === "pgrep") return res(opts.cronDaemon ?? true, opts.cronDaemon === false ? "" : "123\n");
    if (cmd === "sh") return opts.membralOnPath ? res(true, `${opts.membralOnPath}\n`) : res(false);
    if (cmd === "crontab") {
      if (state.crontab === "none-binary") return res(false, "", "spawn crontab ENOENT", true);
      if (args[0] === "-l") {
        return state.crontab === undefined
          ? res(false, "", "no crontab for user")
          : res(true, state.crontab, opts.crontabStderr ?? "");
      }
      if (args[0] === "-") {
        if (opts.crontabWriteError) return res(false, "", opts.crontabWriteError);
        state.crontab = input ?? "";
        return res(true);
      }
    }
    return res(false, "", "unexpected", true);
  };
  return { run, calls, state };
}

describe("sweep scheduler on Linux", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "membral-sweep-linux-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("unit files: absolute node + entry, oneshot, appends to the sweep log; timer every 20 min", () => {
    const service = buildSweepService(INVOCATION, "/h/.membral/logs/sweep.log");
    expect(service).toContain('ExecStart="/usr/bin/node" "/usr/lib/node_modules/membral/dist/index.js" "sweep"');
    expect(service).toContain("Type=oneshot");
    expect(service).toContain('Environment="PATH=/usr/bin:/usr/local/bin:/usr/bin:/bin"');
    expect(service).toContain("StandardOutput=append:/h/.membral/logs/sweep.log");
    const timer = buildSweepTimer();
    expect(timer).toContain("OnBootSec=2min");
    expect(timer).toContain("OnUnitActiveSec=20min");
    expect(timer).toContain("OnActiveSec=1min");
    expect(timer).not.toContain("Persistent");
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("escapes systemd specifiers and quotes", () => {
    const service = buildSweepService({ argv: ['/o"dd/100%/$x/node', "/e"] }, "/l");
    expect(service).toContain('ExecStart="/o\\"dd/100%%/$$x/node"');
  });

  it("systemd path: writes both units, daemon-reloads, enables --now", async () => {
    const m = fakeMachine({ systemd: true });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r).toMatchObject({ success: true, scheduler: "systemd" });
    const dir = systemdUnitDir(home);
    expect(readFileSync(join(dir, "membral-sweep.service"), "utf8")).toContain('"sweep"');
    expect(readFileSync(join(dir, "membral-sweep.timer"), "utf8")).toContain("OnUnitActiveSec=20min");
    expect(existsSync(join(home, ".membral", "logs"))).toBe(true);
    expect(m.calls).toEqual([
      "systemctl --user show-environment",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now membral-sweep.timer",
      "crontab -l",
      expect.stringMatching(/^loginctl show-user \S+ -p Linger$/),
    ]);
    expect(m.calls).not.toContain("crontab -");
    expect(r.warnings).toBeUndefined();
  });

  it("systemd re-run with unchanged units and an active timer changes nothing", async () => {
    const m = fakeMachine({ systemd: true });
    await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    m.calls.length = 0;
    const again = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(again.message).toContain("already installed");
    expect(m.calls).toEqual([
      "systemctl --user show-environment",
      "systemctl --user is-enabled membral-sweep.timer",
      "systemctl --user is-active membral-sweep.timer",
      "crontab -l",
      expect.stringMatching(/^loginctl show-user /),
    ]);
  });

  it("systemd enable failure is reported, not hidden", async () => {
    const m = fakeMachine({ systemd: true, enableFails: true });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r).toMatchObject({ success: false, scheduler: "systemd" });
    expect(r.message).toContain("systemctl --user enable --now membral-sweep.timer");
  });

  it("dry-run writes nothing and enables nothing", async () => {
    const m = fakeMachine({ systemd: true });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run, dryRun: true });
    expect(r.message).toContain("[dry-run]");
    expect(existsSync(systemdUnitDir(home))).toBe(false);
    expect(m.calls).toEqual(["systemctl --user show-environment"]);
  });

  it("no user systemd: falls back to a marked crontab entry, keeping other entries", async () => {
    const m = fakeMachine({ crontab: "0 3 * * * /usr/bin/backup\n" });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r).toMatchObject({ success: true, scheduler: "cron" });
    expect(existsSync(systemdUnitDir(home))).toBe(false);
    const lines = (m.state.crontab as string).split("\n");
    expect(lines[0]).toBe("0 3 * * * /usr/bin/backup");
    expect(lines[1]).toBe(CRON_MARKER);
    expect(lines[2]).toMatch(
      /^\*\/20 \* \* \* \* PATH='\/usr\/bin:[^']+' '\/usr\/bin\/node' '.+index\.js' 'sweep' >> '.+sweep\.log' 2>&1$/,
    );
  });

  it("cron re-run is idempotent: one entry, no rewrite", async () => {
    const m = fakeMachine({ crontab: undefined });
    await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    const first = m.state.crontab;
    m.calls.length = 0;
    const again = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(again.message).toContain("already installed");
    expect(m.calls).not.toContain("crontab -");
    expect(m.state.crontab).toBe(first);
    expect((first as string).split("\n").filter((l) => l === CRON_MARKER)).toHaveLength(1);
  });

  it("cron entry is replaced (not duplicated) when the CLI moves", () => {
    const a = withCronEntry("x\n", buildCronEntry({ argv: ["/a/node", "/a/i.js"] }, "/h/.membral/logs/sweep.log"));
    const b = withCronEntry(a, buildCronEntry({ argv: ["/b/node", "/b/i.js"] }, "/h/.membral/logs/sweep.log"));
    expect(b.split("\n").filter((l) => l === CRON_MARKER)).toHaveLength(1);
    expect(b).toContain("'/b/node'");
    expect(b).not.toContain("'/a/node'");
    expect(b.startsWith("x\n")).toBe(true);
    expect(stripCronEntry(b)).toBe("x\n");
  });

  it("neither systemd nor crontab: scheduler none, not success", async () => {
    const m = fakeMachine({ crontab: "none-binary" });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r).toMatchObject({ success: false, scheduler: "none" });
    expect(r.message).toContain("membral sweep");
  });

  it("uninstall removes the systemd units", async () => {
    const m = fakeMachine({ systemd: true });
    await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    m.calls.length = 0;
    const r = await uninstallSweepAgent({ home, platform: "linux", run: m.run });
    expect(r.success).toBe(true);
    expect(r.message).toContain("systemd user timer");
    expect(m.calls).toContain("systemctl --user disable --now membral-sweep.timer");
    expect(existsSync(join(systemdUnitDir(home), "membral-sweep.timer"))).toBe(false);
    expect(existsSync(join(systemdUnitDir(home), "membral-sweep.service"))).toBe(false);
  });

  it("uninstall removes only our crontab entry", async () => {
    const m = fakeMachine({ crontab: "0 3 * * * /usr/bin/backup\n" });
    await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    const r = await uninstallSweepAgent({ home, platform: "linux", run: m.run });
    expect(r.message).toContain("crontab entry");
    expect(m.state.crontab).toBe("0 3 * * * /usr/bin/backup\n");
    const again = await uninstallSweepAgent({ home, platform: "linux", run: m.run });
    expect(again.message).toContain("not installed");
  });

  it("linger off: systemd install succeeds with the linger note; never runs sudo", async () => {
    const m = fakeMachine({ systemd: true, linger: "no" });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r).toMatchObject({ success: true, scheduler: "systemd", warnings: [LINGER_NOTE] });
    expect(LINGER_NOTE).toContain("sudo loginctl enable-linger $USER");
    expect(m.calls.some((c) => c.startsWith("sudo"))).toBe(false);
  });

  it("cron daemon not running: entry still written, warning returned", async () => {
    const m = fakeMachine({ crontab: undefined, cronDaemon: false });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r).toMatchObject({ success: true, scheduler: "cron", warnings: [CRON_DAEMON_WARNING] });
    expect(m.state.crontab).toContain(CRON_MARKER);
    expect(m.calls).toContain("pgrep -x cron");
    expect(m.calls).toContain("pgrep -x crond");
  });

  it("cron daemon running: no warning", async () => {
    const m = fakeMachine({ crontab: undefined });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r.warnings).toBeUndefined();
  });

  it("bare `membral` is resolved to an absolute path at install time", async () => {
    const m = fakeMachine({ crontab: undefined, membralOnPath: "/home/u/.nvm/versions/node/v22/bin/membral" });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: { argv: ["membral"] }, run: m.run });
    expect(r.success).toBe(true);
    expect(m.calls[0]).toBe("sh -c command -v 'membral'");
    expect(m.state.crontab).toContain("PATH='/home/u/.nvm/versions/node/v22/bin:");
    expect(m.state.crontab).toContain("'/home/u/.nvm/versions/node/v22/bin/membral' 'sweep'");
  });

  it("bare `membral` not on PATH: not installed, npm i -g note", async () => {
    const m = fakeMachine({ systemd: true });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: { argv: ["membral"] }, run: m.run });
    expect(r).toMatchObject({ success: false, scheduler: "none" });
    expect(r.reason).toContain("npm i -g @membral/cli");
    expect(existsSync(systemdUnitDir(home))).toBe(false);
  });

  it("crontab -l: stderr noise never lands in the table (stdout only)", async () => {
    const m = fakeMachine({ crontab: "0 3 * * * /usr/bin/backup\n", crontabStderr: "warning: something odd" });
    await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(m.state.crontab).not.toContain("warning: something odd");
    expect((m.state.crontab as string).startsWith("0 3 * * * /usr/bin/backup\n")).toBe(true);
  });

  it("strip keeps a foreign line under the marker", () => {
    const tab = `a\n${CRON_MARKER}\n0 * * * * /usr/bin/other-job\nb\n`;
    expect(stripCronEntry(tab)).toBe("a\n0 * * * * /usr/bin/other-job\nb\n");
  });

  it("systemd install removes our old crontab entry, keeping the rest", async () => {
    const entry = buildCronEntry(INVOCATION, join(home, ".membral", "logs", "sweep.log"));
    const m = fakeMachine({ systemd: true, crontab: withCronEntry("0 3 * * * /usr/bin/backup\n", entry) });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r.scheduler).toBe("systemd");
    expect(m.state.crontab).toBe("0 3 * * * /usr/bin/backup\n");
  });

  it("cron install disables and removes leftover systemd units", async () => {
    const dir = systemdUnitDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "membral-sweep.timer"), "old");
    writeFileSync(join(dir, "membral-sweep.service"), "old");
    const m = fakeMachine({ crontab: undefined });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r.scheduler).toBe("cron");
    expect(m.calls).toContain("systemctl --user disable --now membral-sweep.timer");
    expect(existsSync(join(dir, "membral-sweep.timer"))).toBe(false);
    expect(existsSync(join(dir, "membral-sweep.service"))).toBe(false);
  });

  it("cron install and uninstall also remove the timer's enable symlink", async () => {
    const dir = systemdUnitDir(home);
    const link = join(dir, "timers.target.wants", "membral-sweep.timer");
    const seed = () => {
      mkdirSync(join(dir, "timers.target.wants"), { recursive: true });
      writeFileSync(join(dir, "membral-sweep.timer"), "old");
      symlinkSync(join(dir, "membral-sweep.timer"), link);
    };
    seed();
    const m = fakeMachine({ crontab: undefined });
    await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(() => lstatSync(link)).toThrow();
    seed();
    await uninstallSweepAgent({ home, platform: "linux", run: m.run });
    expect(() => lstatSync(link)).toThrow();
  });

  it("a home path with a single quote: reinstall replaces the entry, uninstall removes it", async () => {
    const qhome = join(home, "o'brien");
    mkdirSync(qhome, { recursive: true });
    const m = fakeMachine({ crontab: "0 3 * * * /usr/bin/backup\n" });
    await installSweepAgent({ home: qhome, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    const first = m.state.crontab as string;
    expect(first).toContain("'\\''");
    await installSweepAgent({
      home: qhome,
      platform: "linux",
      cliInvocation: { argv: ["/b/node", "/b/i.js"] },
      run: m.run,
    });
    const second = m.state.crontab as string;
    expect(second.split("\n").filter((l) => l === CRON_MARKER)).toHaveLength(1);
    expect(second).toContain("'/b/node'");
    expect(second).not.toContain("/usr/bin/node");
    await uninstallSweepAgent({ home: qhome, platform: "linux", run: m.run });
    expect(m.state.crontab).toBe("0 3 * * * /usr/bin/backup\n");
  });

  it("crontab present but the write fails: scheduler cron, not success, with the reason", async () => {
    const m = fakeMachine({ crontab: undefined, crontabWriteError: "crontab: permission denied" });
    const r = await installSweepAgent({ home, platform: "linux", cliInvocation: INVOCATION, run: m.run });
    expect(r).toMatchObject({ success: false, scheduler: "cron" });
    expect(r.reason).toContain("crontab: permission denied");
  });
});
