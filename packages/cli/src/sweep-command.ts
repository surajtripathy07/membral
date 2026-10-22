// `membral sweep` + its scheduler (launchd on macOS here; systemd/cron on Linux in sweep-linux.ts) — the backstop that uploads
// sessions no hook caught (ctrl+c, a crashed laptop, opencode without the
// plugin loaded). The agent runs `membral sweep` every 20 minutes; each run
// imports every harness's sessions that ended since the last successful
// sweep (with a 5-minute overlap), then records the time in
// ~/.membral/sweep-state.json — the same file and format sweep.ts reads for
// `membral status`'s "Last sweep" line. Unchanged sessions are skipped
// server-side by content hash, so overlap is cheap.
//
// Every SWEEP_FULL_WALK_EVERY-th run walks everything (whole import window). The delta
// window is anchored on the last success, so sleep alone never opens a gap,
// but the prefilter is mtime/endedAt-keyed: a transcript copied or restored
// with its old mtime, a session a partial failure skipped while the run
// still counted as ok, or a clock jump would never be retried by a delta. The
// periodic full walk is the backstop the old shell sweep had (every 12 runs).
//
// After the import it (1) kicks the server's memory-extraction queue and
// (2) runs the ref-keyed git check (branch-state-check.ts, goal 2026-09-26
// W6/P4): asks the server which shas/branches the uploaded sessions named,
// answers with read-only, ref-keyed git commands, reports back. Neither
// step ever affects the sweep's own exit code. the launchd sweep script's
// `sweep` subcommand is a one-line call to this command.
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runBranchStateCheck } from "./branch-state-check.js";
import { createUploadClient, resolveUploadConfig } from "./code-session-upload.js";
import { type CliInvocation, type ConfigureResult, resolveCliInvocation, writeFileAtomic } from "./configure.js";
import { readDogfoodConfig, runWeeklyDogfood } from "./dogfood.js";
import { acquireImportLock } from "./import-lock.js";
import { DEFAULT_IMPORT_SOURCES, importSessions, sendHeartbeatPing } from "./import-sessions.js";
import { DEFAULT_IMPORT_WINDOW_DAYS, defaultImportSince } from "./import-window.js";
import { rotateLogIfLarge } from "./log-rotate.js";
import { kickMemoryExtraction } from "./memory-kick.js";
import { defaultSweepStatePath, readSweepState, writeSweepState } from "./sweep.js";
import {
  type CommandRunner,
  defaultCommandRunner,
  installLinuxSweep,
  type SweepInstallResult,
  uninstallLinuxSweep,
} from "./sweep-linux.js";

export type { SweepInstallResult, SweepScheduler } from "./sweep-linux.js";

export const SWEEP_LABEL = "me.membral.sweep";
export const SWEEP_INTERVAL_SECONDS = 20 * 60;
const OVERLAP_MS = 5 * 60_000;
/** Every Nth successful run is a full walk (no --since); with a 20-min interval that is every ~4 h. */
export const SWEEP_FULL_WALK_EVERY = 12;
const FIRST_RUN_WINDOW_MS = 24 * 60 * 60_000;

/** Second-precision ISO, the only shape sweep.ts's validateSweepState accepts. */
function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface SweepCommandOptions {
  /** Default ~/.membral/sweep-state.json; the import lock and sweep log live beside it (import.lock, logs/sweep.log). */
  statePath?: string;
  now?: () => Date;
  importFn?: typeof importSessions;
  heartbeatFn?: typeof sendHeartbeatPing;
  kickFn?: typeof kickMemoryExtraction;
  branchStateFn?: typeof runBranchStateCheck;
  /** The weekly "Membral on Membral" step (dogfood.ts); injected in tests. */
  dogfoodFn?: typeof runWeeklyDogfood;
  /** ~/.membral/config.json override (tests). */
  cliConfigPath?: string;
}

/** Returns true when every source imported cleanly (and the state advanced). */
export async function sweepCommand(opts: SweepCommandOptions = {}): Promise<boolean> {
  const statePath = opts.statePath ?? defaultSweepStatePath();
  const now = opts.now ?? (() => new Date());
  const importFn = opts.importFn ?? importSessions;
  const heartbeatFn = opts.heartbeatFn ?? sendHeartbeatPing;
  const kickFn = opts.kickFn ?? kickMemoryExtraction;
  const branchStateFn = opts.branchStateFn ?? runBranchStateCheck;
  const dogfoodFn = opts.dogfoodFn ?? runWeeklyDogfood;
  const stamp = (m: string) => `${new Date().toISOString()} ${m}`;
  const log = (m: string) => console.log(stamp(m));
  const logWarn = (m: string) => console.warn(stamp(m));
  const logError = (m: string) => console.error(stamp(m));

  // launchd appends stdout/stderr to logs/sweep.log itself, so the sweep
  // rotates that file at start (> 1 MB -> sweep.log.1). launchd keeps the
  // already-open descriptor for this run; the next run starts a fresh file.
  const membralDir = dirname(statePath);
  rotateLogIfLarge(join(membralDir, "logs", "sweep.log"));

  const lock = acquireImportLock({ path: join(membralDir, "import.lock") });
  if (!lock) {
    log("sweep: another import is running — skipping this run (state not advanced)");
    return true;
  }
  // One policy client for the run: every source's /known check and uploads,
  // the heartbeat, the kick and the branch-state check share its backoff
  // state and its env-key fallback (a stale MEMBRAL_API_KEY costs one 401 per run).
  const uploadConfig = resolveUploadConfig({});
  const client = uploadConfig.apiKey ? createUploadClient(uploadConfig, { log: logWarn }) : undefined;
  // Set when the server rejected the key: one bad key logs one message per run.
  let authRejected = false;
  try {
    const result = await runSweep();
    // Nudges a stalled memory-extraction chain once per run, regardless of
    // this sweep's own outcome — a self-hosted server has no Vercel cron to
    // do it otherwise. Never affects the sweep's own return value/exit code
    // (kickFn never throws; a failure is already logged internally).
    // Skipped after a rejected key: the kick would only repeat the same 401.
    if (!authRejected) await kickFn({}, logWarn, undefined, {}, client);
    // Ref-keyed git check (B4/B6/B9): read-only git against the checkouts
    // the uploaded sessions ran in, keyed by the shas/branches they named.
    // Never affects the exit code either (runBranchStateCheck never throws);
    // the count lands in the state file for `membral status`.
    const refs = await branchStateFn(client ? { client } : {}, logWarn);
    if (refs.ran) {
      const state = await readSweepState(statePath);
      await writeSweepState(statePath, { ...state, last_ref_checks: refs.checked });
    }
    // Recall-precision W3b: the weekly digest + candidates, at most once per
    // ISO week and only when config `dogfood.*` is set. Bounded (each read has
    // a 4 s timeout, gh 30 s) and never affects the exit code.
    if (!authRejected && uploadConfig.apiKey) {
      const dogfood = readDogfoodConfig(opts.cliConfigPath);
      const before = await readSweepState(statePath);
      const week = await dogfoodFn({
        config: uploadConfig,
        dogfood,
        now: now(),
        lastWeek: before.dogfood_last_week,
        log,
        ...(client ? { fetch: { client } } : {}),
      });
      if (week) await writeSweepState(statePath, { ...(await readSweepState(statePath)), dogfood_last_week: week });
    }
    return result;
  } finally {
    lock.release();
  }

  async function runSweep(): Promise<boolean> {
    const state = await readSweepState(statePath);
    const startedAt = now();
    // No previous sweep: `membral setup` already ran a full import, so a first
    // sweep only needs the last day, not another full walk.
    const fullWalk = Boolean(state.last_success_at) && state.runs_since_full_walk + 1 >= SWEEP_FULL_WALK_EVERY;
    let since: string | undefined;
    if (fullWalk) {
      // Bounded to the import window: older sessions give no memories and cost storage.
      since = defaultImportSince(startedAt);
      log(
        `sweep: full walk (every ${SWEEP_FULL_WALK_EVERY}th run) — every session in the last ${DEFAULT_IMPORT_WINDOW_DAYS} days, unchanged ones skipped server-side`,
      );
    } else {
      const sinceMs = state.last_success_at
        ? Date.parse(state.last_success_at) - OVERLAP_MS
        : startedAt.getTime() - FIRST_RUN_WINDOW_MS;
      since = isoSeconds(new Date(sinceMs));
      log(`sweep: sessions ended since ${since}`);
    }

    let ok = true;
    let total = 0;
    for (const source of DEFAULT_IMPORT_SOURCES) {
      const result = await importFn(
        {
          source,
          since,
          heartbeat: false,
          missingHarnessOk: true,
          log,
          logWarn,
          logError,
        },
        client,
      );
      if (!result.ok) ok = false;
      total += result.totalSessions;
      if (result.authRejected) {
        // Every source shares this key and server: the rest would be rejected the same way.
        authRejected = true;
        break;
      }
    }
    if (ok && total === 0 && !(await heartbeatFn({}, logWarn, logError, client))) ok = false;

    if (!ok) {
      logError("sweep: failed — state not advanced, the next run retries the same window");
      process.exitCode = 1;
      return false;
    }
    await writeSweepState(statePath, {
      ...state,
      last_success_at: isoSeconds(startedAt),
      run_count: state.run_count + 1,
      runs_since_full_walk: fullWalk ? 0 : state.runs_since_full_walk + 1,
    });
    log(`sweep: done (${total} session(s) in window)`);
    return true;
  }
}

// --- launchd agent -------------------------------------------------------------

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildSweepPlist(invocation: CliInvocation, logPath: string): string {
  const args = [...invocation.argv, "sweep"].map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SWEEP_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${SWEEP_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export type LaunchctlRunner = (args: string[]) => Promise<{ ok: boolean; output: string }>;

const defaultLaunchctl: LaunchctlRunner = (args) =>
  new Promise((resolve) => {
    execFile("launchctl", args, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout ?? ""}${stderr ?? ""}`.trim() || (err?.message ?? "") });
    });
  });

export interface InstallSweepAgentOptions {
  home?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  cliInvocation?: CliInvocation;
  dryRun?: boolean;
  launchctl?: LaunchctlRunner;
  /** Linux: runs systemctl / crontab. */
  run?: CommandRunner;
}

export function sweepPlistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${SWEEP_LABEL}.plist`);
}

/**
 * Schedules `membral sweep` every 20 minutes: a launchd agent on macOS, a
 * systemd --user timer on Linux (crontab when user systemd is not reachable).
 * Idempotent: an unchanged, loaded schedule is left alone. `scheduler` says
 * which one is in place; "none" means nothing runs the sweep.
 */
export async function installSweepAgent(opts: InstallSweepAgentOptions = {}): Promise<SweepInstallResult> {
  const platform = opts.platform ?? process.platform;
  if (platform === "linux") {
    return installLinuxSweep({
      home: opts.home ?? homedir(),
      invocation: opts.cliInvocation ?? resolveCliInvocation(),
      run: opts.run ?? defaultCommandRunner,
      dryRun: opts.dryRun,
    });
  }
  if (platform !== "darwin") {
    return {
      success: false,
      scheduler: "none",
      message: `Backstop sweep: NOT scheduled — no scheduler support on ${platform}. Run \`membral sweep\` every 20 minutes yourself.`,
    };
  }
  return { ...(await installLaunchdAgent(opts)), scheduler: "launchd" };
}

/** Removes whatever installSweepAgent put in place on this platform. Missing pieces are not errors. */
export async function uninstallSweepAgent(opts: InstallSweepAgentOptions = {}): Promise<SweepInstallResult> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  if (platform === "linux") {
    return uninstallLinuxSweep({ home, run: opts.run ?? defaultCommandRunner, dryRun: opts.dryRun });
  }
  if (platform !== "darwin") return { success: true, scheduler: "none", message: "Backstop sweep was not installed." };
  const plistPath = sweepPlistPath(home);
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const launchctl = opts.launchctl ?? defaultLaunchctl;
  if (opts.dryRun) {
    return {
      success: true,
      scheduler: "none",
      message: `[dry-run] would run: launchctl bootout ${domain}/${SWEEP_LABEL} and delete ${plistPath}`,
    };
  }
  try {
    const existed = (await readFile(plistPath, "utf-8").catch(() => undefined)) !== undefined;
    // bootout fails harmlessly when nothing is loaded.
    await launchctl(["bootout", `${domain}/${SWEEP_LABEL}`]);
    await rm(plistPath, { force: true });
    return {
      success: true,
      scheduler: "none",
      message: existed ? `Removed backstop sweep: ${plistPath}` : "Backstop sweep was not installed.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, scheduler: "none", message: `Failed to remove the backstop sweep: ${msg}` };
  }
}

/** Writes and loads the launchd agent (macOS). */
async function installLaunchdAgent(opts: InstallSweepAgentOptions): Promise<ConfigureResult> {
  const home = opts.home ?? homedir();
  const plistPath = sweepPlistPath(home);
  const logPath = join(home, ".membral", "logs", "sweep.log");
  const invocation = opts.cliInvocation ?? resolveCliInvocation();
  const content = buildSweepPlist(invocation, logPath);
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const launchctl = opts.launchctl ?? defaultLaunchctl;

  if (opts.dryRun) {
    return {
      success: true,
      message: `[dry-run] would write ${plistPath} (every ${SWEEP_INTERVAL_SECONDS / 60} min, log ${logPath}) and run: launchctl bootstrap ${domain} ${plistPath}`,
    };
  }

  try {
    let existing: string | undefined;
    try {
      existing = await readFile(plistPath, "utf-8");
    } catch {
      existing = undefined;
    }

    if (existing === content && (await launchctl(["print", `${domain}/${SWEEP_LABEL}`])).ok) {
      return { success: true, message: `Backstop sweep already installed and loaded: ${plistPath}` };
    }

    await mkdir(join(home, ".membral", "logs"), { recursive: true });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFileAtomic(plistPath, content);

    // Reload so a changed plist takes effect; bootout fails harmlessly when nothing is loaded.
    await launchctl(["bootout", `${domain}/${SWEEP_LABEL}`]);
    const boot = await launchctl(["bootstrap", domain, plistPath]);
    if (!boot.ok && !/already|in progress|service is already loaded/i.test(boot.output)) {
      return {
        success: false,
        message: `Wrote ${plistPath} but launchctl bootstrap failed: ${boot.output}\n  Run: launchctl bootstrap ${domain} ${plistPath}`,
      };
    }
    return {
      success: true,
      message: `Installed backstop sweep (every ${SWEEP_INTERVAL_SECONDS / 60} min): ${plistPath}, log ${logPath}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to install the backstop sweep: ${msg}` };
  }
}
