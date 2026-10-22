// The Linux half of the backstop sweep scheduler (sweep-command.ts holds the
// macOS launchd half). Preferred: a systemd --user timer
// (~/.config/systemd/user/membral-sweep.{service,timer}). When the user's
// systemd manager is not reachable (WSL without systemd, containers, a shell
// with no DBUS session), it falls back to one marked crontab entry. Neither
// available: nothing is installed and the caller says so loudly.
//
// Every outside call goes through an injected CommandRunner, and every file
// lives under the injected home, so tests run without touching the machine.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type CliInvocation, writeFileAtomic } from "./configure.js";

export const SYSTEMD_UNIT = "membral-sweep";
export const SYSTEMD_TIMER = `${SYSTEMD_UNIT}.timer`;
/** The comment line above the crontab entry; the line after it is ours too. */
export const CRON_MARKER =
  "# membral-sweep: backstop sweep, managed by `membral setup` (remove with `membral sweep --remove`)";
export const CRON_SCHEDULE = "*/20 * * * *";
const BASE_PATH = "/usr/local/bin:/usr/bin:/bin";

export type SweepScheduler = "launchd" | "systemd" | "cron" | "none";

export interface CommandResult {
  ok: boolean;
  /** stdout and stderr together, trimmed — for error messages. */
  output: string;
  /** stdout alone, untrimmed — for parsing (`crontab -l`, `command -v`, `loginctl`). */
  stdout: string;
  /** True when the binary itself was not found (ENOENT). */
  missing?: boolean;
}

/** Runs `cmd args`, with `input` on stdin when given. Never throws. */
export type CommandRunner = (cmd: string, args: string[], input?: string) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = (cmd, args, input) =>
  new Promise((resolve) => {
    let out = "";
    let stdout = "";
    let settled = false;
    const done = (r: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const child = spawn(cmd, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) =>
      done({ ok: false, output: err.message, stdout: "", missing: err.code === "ENOENT" }),
    );
    child.on("close", (code) => done({ ok: code === 0, output: out.trim(), stdout }));
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });

export interface LinuxSweepOptions {
  home: string;
  invocation: CliInvocation;
  run: CommandRunner;
  dryRun?: boolean;
}

export interface SweepInstallResult {
  success: boolean;
  message: string;
  scheduler: SweepScheduler;
  /** Short cause for the setup summary when success is false. */
  reason?: string;
  /** Installed, but something limits it (no linger, no cron daemon); setup prints and summarises these. */
  warnings?: string[];
}

export function systemdUnitDir(home: string): string {
  return join(home, ".config", "systemd", "user");
}

export function sweepLogPath(home: string): string {
  return join(home, ".membral", "logs", "sweep.log");
}

/** node's own directory first, so `#!/usr/bin/env node` children and git resolve as in the user's shell. */
function sweepPath(invocation: CliInvocation): string {
  const first = invocation.argv[0];
  return first && isAbsolute(first) ? `${dirname(first)}:${BASE_PATH}` : BASE_PATH;
}

/** systemd ExecStart quoting: double quotes, backslash-escaped; `%` and `$` doubled so no specifier/variable expands. */
function systemdQuote(arg: string): string {
  const escaped = arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}

/** POSIX sh single quotes; `%` escaped because cron turns a bare `%` into a newline. */
function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`.replace(/%/g, "\\%");
}

export function buildSweepService(invocation: CliInvocation, logPath: string): string {
  const exec = [...invocation.argv, "sweep"].map(systemdQuote).join(" ");
  const log = logPath.replace(/%/g, "%%");
  return `[Unit]
Description=Membral backstop sweep (uploads sessions no hook caught)

[Service]
Type=oneshot
ExecStart=${exec}
Environment=${systemdQuote(`PATH=${sweepPath(invocation)}`)}
StandardOutput=append:${log}
StandardError=append:${log}
`;
}

export function buildSweepTimer(): string {
  return `[Unit]
Description=Run the Membral backstop sweep every 20 minutes

[Timer]
OnBootSec=2min
OnActiveSec=1min
OnUnitActiveSec=20min

[Install]
WantedBy=timers.target
`;
}

export function buildCronEntry(invocation: CliInvocation, logPath: string): string {
  const cmd = [...invocation.argv, "sweep"].map(shQuote).join(" ");
  return `${CRON_SCHEDULE} PATH=${shQuote(sweepPath(invocation))} ${cmd} >> ${shQuote(logPath)} 2>&1`;
}

/** Our entry's shape: the schedule, and output appended to the sweep log. */
const CRON_ENTRY_SHAPE = /^\*\/20 \* \* \* \* .* >> '.*sweep\.log' 2>&1$/;

/** Removes our marker line and, when it has our entry's shape, the line under it; every other line is kept as is. */
export function stripCronEntry(crontab: string): string {
  const lines = crontab.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === CRON_MARKER) {
      if (CRON_ENTRY_SHAPE.test(lines[i + 1] ?? "")) i++; // the entry line under the marker
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join("\n");
}

/** Our block appended to whatever else is there, with exactly one trailing newline. */
export function withCronEntry(crontab: string, entry: string): string {
  const rest = stripCronEntry(crontab).replace(/\n+$/, "");
  return `${rest ? `${rest}\n` : ""}${CRON_MARKER}\n${entry}\n`;
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Is the user's systemd manager reachable? (No: WSL without systemd, containers, no DBUS session.) */
export async function userSystemdAvailable(run: CommandRunner): Promise<boolean> {
  const r = await run("systemctl", ["--user", "show-environment"]);
  return r.ok;
}

/** `crontab -l`: the current table, "" when the user has none, undefined when cron is not usable. */
async function readCrontab(run: CommandRunner): Promise<string | undefined> {
  const r = await run("crontab", ["-l"]);
  if (r.ok) {
    const table = r.stdout.replace(/\n+$/, "");
    return table ? `${table}\n` : "";
  }
  if (r.missing) return undefined;
  return /no crontab/i.test(r.output) ? "" : undefined;
}

const NONE_MESSAGE =
  "Backstop sweep: NOT scheduled — neither `systemctl --user` nor `crontab` is usable here. " +
  "Run `membral sweep` every 20 minutes yourself (cron, a systemd timer, or by hand).";

export const LINGER_NOTE =
  "timer runs only while you are logged in; for headless machines run: sudo loginctl enable-linger $USER";
export const CRON_DAEMON_WARNING = "cron daemon not running: sudo service cron start";

/**
 * A bare `membral` (the npx fallback) would be looked up on the scheduler's
 * minimal PATH, which usually misses npm's global bin. Resolve it once, now,
 * from the user's shell; undefined when it is not on PATH at all.
 */
export async function resolveSchedulerInvocation(
  invocation: CliInvocation,
  run: CommandRunner,
): Promise<CliInvocation | undefined> {
  const [first, ...rest] = invocation.argv;
  if (!first) return undefined;
  if (isAbsolute(first)) return invocation;
  const r = await run("sh", ["-c", `command -v '${first.replace(/'/g, `'\\''`)}'`]);
  const found = r.ok ? r.stdout.trim().split("\n")[0] : "";
  return found && isAbsolute(found) ? { ...invocation, argv: [found, ...rest] } : undefined;
}

/** `loginctl show-user` says Linger=no: user timers stop when the last session of this user ends. */
async function lingerWarnings(run: CommandRunner): Promise<string[] | undefined> {
  const user = process.env.USER || userInfo().username;
  const r = await run("loginctl", ["show-user", user, "-p", "Linger"]);
  return r.ok && /^Linger=no$/m.test(r.stdout) ? [LINGER_NOTE] : undefined;
}

/** Neither `cron` nor `crond` is running. Unknown (no pgrep) is not a warning. */
async function cronDaemonWarnings(run: CommandRunner): Promise<string[] | undefined> {
  const cron = await run("pgrep", ["-x", "cron"]);
  if (cron.ok || cron.missing) return undefined;
  const crond = await run("pgrep", ["-x", "crond"]);
  return crond.ok || crond.missing ? undefined : [CRON_DAEMON_WARNING];
}

/** After a switch to systemd: our old crontab entry would run the sweep twice. */
async function removeOurCronEntry(run: CommandRunner): Promise<void> {
  const current = await readCrontab(run);
  if (current?.split("\n").includes(CRON_MARKER)) await run("crontab", ["-"], stripCronEntry(current));
}

/** systemd's enable symlink for the timer, next to the unit directory's files. */
function wantsLink(timerPath: string): string {
  return join(dirname(timerPath), "timers.target.wants", SYSTEMD_TIMER);
}

/** After a switch to cron: leftover units from an earlier systemd install. */
async function removeOurUnits(run: CommandRunner, servicePath: string, timerPath: string): Promise<void> {
  const had = (await readOrUndefined(timerPath)) !== undefined || (await readOrUndefined(servicePath)) !== undefined;
  if (!had) return;
  await run("systemctl", ["--user", "disable", "--now", SYSTEMD_TIMER]);
  await rm(timerPath, { force: true });
  await rm(servicePath, { force: true });
  await rm(wantsLink(timerPath), { force: true }); // a dangling enable symlink
}

function withWarnings(result: SweepInstallResult, warnings: string[] | undefined): SweepInstallResult {
  return warnings?.length ? { ...result, warnings } : result;
}

export async function installLinuxSweep(opts: LinuxSweepOptions): Promise<SweepInstallResult> {
  const { home, run } = opts;
  const logPath = sweepLogPath(home);
  const unitDir = systemdUnitDir(home);
  const servicePath = join(unitDir, `${SYSTEMD_UNIT}.service`);
  const timerPath = join(unitDir, SYSTEMD_TIMER);

  try {
    const invocation = await resolveSchedulerInvocation(opts.invocation, run);
    if (!invocation) {
      const reason = "`membral` is not on PATH; run `npm i -g @membral/cli`, then `membral setup` again";
      return { success: false, scheduler: "none", reason, message: `Backstop sweep: NOT scheduled — ${reason}.` };
    }
    const service = buildSweepService(invocation, logPath);
    const timer = buildSweepTimer();

    if (await userSystemdAvailable(run)) {
      if (opts.dryRun) {
        return {
          success: true,
          scheduler: "systemd",
          message: `[dry-run] would write ${servicePath} and ${timerPath} (every 20 min, log ${logPath}) and run: systemctl --user enable --now ${SYSTEMD_TIMER}`,
        };
      }
      const unchanged =
        (await readOrUndefined(servicePath)) === service && (await readOrUndefined(timerPath)) === timer;
      if (
        unchanged &&
        (await run("systemctl", ["--user", "is-enabled", SYSTEMD_TIMER])).ok &&
        (await run("systemctl", ["--user", "is-active", SYSTEMD_TIMER])).ok
      ) {
        await removeOurCronEntry(run);
        return withWarnings(
          {
            success: true,
            scheduler: "systemd",
            message: `Backstop sweep already installed and active (systemd user timer): ${timerPath}`,
          },
          await lingerWarnings(run),
        );
      }
      await mkdir(dirname(logPath), { recursive: true });
      await mkdir(unitDir, { recursive: true });
      await writeFileAtomic(servicePath, service);
      await writeFileAtomic(timerPath, timer);
      await run("systemctl", ["--user", "daemon-reload"]);
      const enable = await run("systemctl", ["--user", "enable", "--now", SYSTEMD_TIMER]);
      if (!enable.ok) {
        return {
          success: false,
          scheduler: "systemd",
          reason: `enabling ${SYSTEMD_TIMER} failed: ${enable.output}`,
          message: `Wrote ${timerPath} but enabling it failed: ${enable.output}\n  Run: systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_TIMER}`,
        };
      }
      await removeOurCronEntry(run);
      return withWarnings(
        {
          success: true,
          scheduler: "systemd",
          message: `Installed backstop sweep (systemd user timer, every 20 min): ${timerPath}, log ${logPath}`,
        },
        await lingerWarnings(run),
      );
    }

    const current = await readCrontab(run);
    if (current === undefined) return { success: false, scheduler: "none", message: NONE_MESSAGE };
    const entry = buildCronEntry(invocation, logPath);
    if (opts.dryRun) {
      return {
        success: true,
        scheduler: "cron",
        message: `[dry-run] no systemd user session; would add to your crontab (other entries kept): ${entry}`,
      };
    }
    await removeOurUnits(run, servicePath, timerPath);
    const next = withCronEntry(current, entry);
    if (next === current) {
      return withWarnings(
        { success: true, scheduler: "cron", message: "Backstop sweep already installed (crontab, every 20 min)" },
        await cronDaemonWarnings(run),
      );
    }
    await mkdir(dirname(logPath), { recursive: true });
    const write = await run("crontab", ["-"], next);
    if (!write.ok) {
      const reason = `crontab write failed: ${write.output || "unknown error"}`;
      return { success: false, scheduler: "cron", reason, message: `Backstop sweep: NOT scheduled — ${reason}` };
    }
    return withWarnings(
      {
        success: true,
        scheduler: "cron",
        message: `Installed backstop sweep (crontab, every 20 min; no systemd user session found), log ${logPath}`,
      },
      await cronDaemonWarnings(run),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, scheduler: "none", message: `Failed to install the backstop sweep: ${msg}` };
  }
}

/** Undoes both Linux schedulers, whichever is present. Missing pieces are not errors. */
export async function uninstallLinuxSweep(opts: Omit<LinuxSweepOptions, "invocation">): Promise<SweepInstallResult> {
  const { home, run } = opts;
  const unitDir = systemdUnitDir(home);
  const servicePath = join(unitDir, `${SYSTEMD_UNIT}.service`);
  const timerPath = join(unitDir, SYSTEMD_TIMER);
  const removed: string[] = [];
  try {
    const hadUnits =
      (await readOrUndefined(timerPath)) !== undefined || (await readOrUndefined(servicePath)) !== undefined;
    if (hadUnits) {
      if (opts.dryRun) {
        removed.push(`[dry-run] would disable ${SYSTEMD_TIMER} and delete ${servicePath}, ${timerPath}`);
      } else {
        await run("systemctl", ["--user", "disable", "--now", SYSTEMD_TIMER]);
        await rm(timerPath, { force: true });
        await rm(servicePath, { force: true });
        await rm(wantsLink(timerPath), { force: true });
        await run("systemctl", ["--user", "daemon-reload"]);
        removed.push(`systemd user timer (${timerPath})`);
      }
    }
    const current = await readCrontab(run);
    if (current?.split("\n").includes(CRON_MARKER)) {
      if (opts.dryRun) {
        removed.push("[dry-run] would remove the membral-sweep crontab entry");
      } else {
        const write = await run("crontab", ["-"], stripCronEntry(current));
        if (!write.ok) return { success: false, scheduler: "cron", message: `crontab write failed: ${write.output}` };
        removed.push("crontab entry");
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, scheduler: "none", message: `Failed to remove the backstop sweep: ${msg}` };
  }
  return {
    success: true,
    scheduler: "none",
    message: removed.length ? `Removed backstop sweep: ${removed.join("; ")}` : "Backstop sweep was not installed.",
  };
}
