// `membral setup` — the new-user onboarding wizard (deliverable 4).
// Interactive by default (readline prompts), every prompt also has a flag
// for non-interactive use, and --dry-run previews every step without
// writing anything.
//
// Steps: (1) sign in (device auth, skipped if already signed in or
// --api-key given) -> (2) ensure ~/.membral/device.json -> (3) scan for
// coding harnesses -> (4) choose what to sync (-> ~/.membral/sync.json) ->
// (5) install the Claude Code SessionEnd + SessionStart hooks and the
// opencode capture plugin, the backstop sweep scheduler (--no-sweep skips
// it), and MCP for detected AI tools (opencode included) -> (6) run the
// first import now -> a summary -> a final nudge toward chat import / the
// extension. Capture (hooks/plugin/sweep/MCP) is installed and live BEFORE
// the (often long-running, paced against the server's rate limit) first
// import runs, so a new user is capturing new sessions within seconds
// rather than only after the backfill finishes. Nothing installed here
// bakes in a URL except the MCP entries; `membral use <profile>` re-points
// those.
//
// Idempotent: a second run with credentials and sync.json already in place
// mostly just prints status instead of redoing the work.

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { findMembralPlugin } from "./claude-plugin.js";
import { defaultCliConfigPath, promptRecallEnabled, setPromptRecall } from "./cli-config.js";
import { DEFAULT_API_URL } from "./code-session-upload.js";
import { CODEX_APPROVE_HOOK_ACTION, detectCodex, setupCodex } from "./codex-setup.js";
import { configureAgyHooks, configureMCPServer, configureUserPromptSubmitHook, type McpClientId } from "./configure.js";
import { installCopilotCliHooks } from "./copilot-cli-hooks.js";
import { installCopilotCliMcp } from "./copilot-cli-mcp.js";
import { userInstructionsPath, writeUserInstructions } from "./copilot-user-instructions.js";
import { setupCopilotVscode } from "./copilot-vscode.js";
import {
  defaultCredentialsPath,
  describeAuthRejection,
  loadCredentials,
  loadProfile,
  loadProfiles,
  profileNameForUrl,
  resolveApiKey,
  resolveApiUrl,
  resolveValidatedCredentials,
  saveCredentials,
  setActiveProfile,
} from "./credentials.js";
import { agyHooksConfigPath, agyMcpConfigPath, detectTools } from "./detect.js";
import { defaultDeviceIdentityPath, loadOrCreateDeviceIdentity, peekDeviceName } from "./device.js";
import { renderFirstRunReport } from "./first-run-report.js";
import {
  type CopilotPresence,
  detectCopilot,
  type HarnessId,
  type HarnessProject,
  scanHarnesses,
} from "./harness-scan.js";
import { DEFAULT_IMPORT_SOURCES, importSessions, type SessionFact } from "./import-sessions.js";
import { DEFAULT_IMPORT_WINDOW_DAYS, defaultImportSince } from "./import-window.js";
import { defaultSettingsPath, installSessionHook } from "./install-session-hook.js";
import { loginCommand } from "./login-command.js";
import { configureOpencodeMcp, detectOpencode, installOpencodePlugin } from "./opencode-integration.js";
import { parseExcludeList } from "./parse-exclude-list.js";
import { checklist, createPrompter, type Prompter } from "./prompt.js";
import { installSweepAgent } from "./sweep-command.js";
import {
  buildSyncAllowlist,
  defaultSyncAllowlistPath,
  emptySyncAllowlist,
  hasNewProjects,
  loadSyncAllowlist,
  type SyncAllowlist,
  saveSyncAllowlist,
} from "./sync-allowlist.js";

export interface SetupOptions {
  /** Overrides MEMBRAL_API_URL / the http://localhost:3000 default. */
  apiUrl?: string;
  /** Overrides MEMBRAL_API_KEY — also skips interactive sign-in when given. */
  apiKey?: string;
  /** Accept every default (sync all, no exclusions) without prompting. */
  yes?: boolean;
  /** Comma-separated 1-based numbers from the scan table to exclude from sync — implies non-interactive for that step. */
  exclude?: string;
  /** --device-name — bypasses the "Name this machine" prompt with an explicit name (also settable via MEMBRAL_DEVICE_NAME). */
  deviceName?: string;
  /** Preview every step without writing files. */
  dryRun?: boolean;
  /** --no-sweep — don't schedule the backstop sweep (launchd / systemd / cron). */
  noSweep?: boolean;
  /** --no-prompt-recall — turn the Claude Code UserPromptSubmit recall hook off (removed, and kept off in ~/.membral/config.json). */
  noPromptRecall?: boolean;
  /** --prompt-recall — turn it back on after a --no-prompt-recall. */
  promptRecall?: boolean;
  /** ~/.membral/config.json override — tests only. */
  cliConfigPath?: string;
  /** --copilot — also commit Copilot config into this repo for teammates (.vscode/mcp.json + .github/copilot-instructions.md). */
  copilot?: boolean;
  /** --agy — install the Antigravity hooks + MCP even if Antigravity is not detected. */
  agy?: boolean;
  /** --copilot-cli — install the Copilot CLI hooks + MCP even if Copilot is not detected. */
  copilotCli?: boolean;
  /** Use exactly this saved profile (e.g. `membral local up` passes "local") instead of deriving one from --api-url. */
  profile?: string;
}

const HARNESS_LABELS: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  "copilot-cli": "Copilot CLI",
};

// A harness with no cwd-grouping (codex/opencode today, see harness-scan.ts)
// degrades to one "project" per un-groupable file — on a real machine that
// can be hundreds of rows (observed in practice: a codex/opencode data
// directory with hundreds of loose per-session JSON files). Printing every
// single one would make the table unusable, so only the most recently
// active MAX_LISTED_PER_HARNESS are shown/numbered (selectable via
// --exclude); the rest are summarized and left unlisted in sync.json, which
// means they still sync by default (new/unlisted projects auto-sync unless
// defaultNewProjects:false) — nothing is silently dropped, just not
// individually toggleable from this table.
const MAX_LISTED_PER_HARNESS = 20;

function byMostRecentlyActive(a: HarnessProject, b: HarnessProject): number {
  const at = a.lastActiveAt ? Date.parse(a.lastActiveAt) : -Infinity;
  const bt = b.lastActiveAt ? Date.parse(b.lastActiveAt) : -Infinity;
  return bt - at;
}

/** Exported for unit testing — pure formatting, returns the flat numbered project list (only the listed/shown ones — see MAX_LISTED_PER_HARNESS) in print order. */
export function printScanTable(projects: HarnessProject[]): HarnessProject[] {
  const byHarness = new Map<HarnessId, HarnessProject[]>();
  for (const p of projects) {
    const list = byHarness.get(p.harness) ?? [];
    list.push(p);
    byHarness.set(p.harness, list);
  }

  const numbered: HarnessProject[] = [];
  let n = 1;

  for (const harness of Object.keys(HARNESS_LABELS) as HarnessId[]) {
    const list = byHarness.get(harness);
    if (!list || list.length === 0) continue;

    const sorted = [...list].sort(byMostRecentlyActive);
    const totalSessions = list.reduce((sum, p) => sum + p.sessions, 0);
    const pendingNote = list[0].importable ? "" : " (detected — import support pending)";
    console.log(`${HARNESS_LABELS[harness]} — ${list.length} project(s), ${totalSessions} session(s)${pendingNote}`);

    const shown = sorted.slice(0, MAX_LISTED_PER_HARNESS);
    for (const p of shown) {
      const idx = n++;
      numbered.push(p);
      const lastActive = p.lastActiveAt ? new Date(p.lastActiveAt).toISOString().slice(0, 10) : "never";
      const remotePart = p.remote ? ` [${p.remote}]` : "";
      console.log(`  ${idx}. ${p.displayName} — ${p.sessions} session(s), last active ${lastActive}${remotePart}`);
    }

    const remaining = sorted.length - shown.length;
    if (remaining > 0) {
      console.log(`  ... and ${remaining} more (not listed — they'll sync by default unless you edit sync.json)`);
    }
  }

  return numbered;
}

/**
 * Exported for unit testing (mocked prompt.js). Takes the ONE `Prompter`
 * shared across this whole `setup()` run — see ensurePrompter below and
 * prompt.ts's module doc comment for why a fresh readline Interface per
 * prompt is unsafe once a run asks more than one sequential question
 * (issue #137: setup can ask up to two — machine name, sync selection).
 */
export function promptSyncSelection(prompter: Prompter): Promise<string> {
  return prompter.ask("Sync all? [Y/n] or list numbers to exclude: ");
}

/**
 * TTY-only replacement for promptSyncSelection (goal 2026-09-26 P10): renders
 * the numbered scan as a checkbox list (space toggles, `a` toggles all, enter
 * confirms). On a re-run the boxes show what sync.json already says: a
 * project previously excluded stays unchecked, a project it lists as enabled
 * starts checked, and a never-seen project follows defaultNewProjects
 * (checked unless it is false). Resolves with the 1-based numbers to
 * EXCLUDE (same shape parseSyncAnswer produces), or `null` when the user
 * cancelled with ctrl-c. Exported for unit testing (mocked prompt.js).
 */
export async function promptSyncChecklist(
  numbered: HarnessProject[],
  existing: SyncAllowlist | null = null,
): Promise<Set<number> | null> {
  const labels = numbered.map((p, i) => {
    const remotePart = p.remote ? ` [${p.remote}]` : "";
    return `${i + 1}. ${HARNESS_LABELS[p.harness]} · ${p.displayName} — ${p.sessions} session(s)${remotePart}`;
  });
  const preselected: number[] = [];
  numbered.forEach((p, i) => {
    const entry = existing?.harnesses[p.harness]?.projects.find((e) => e.path === p.projectPath);
    if (entry ? entry.enabled : existing?.defaultNewProjects !== false) preselected.push(i);
  });
  const result = await checklist(labels, { header: "  Uncheck anything you don't want synced:", preselected });
  if (result.cancelled) return null;
  const keep = new Set(result.selected);
  const excluded = new Set<number>();
  numbered.forEach((_, i) => {
    if (!keep.has(i)) excluded.add(i + 1);
  });
  return excluded;
}

/** Exported for unit testing — pure. "" / "y"/"yes" -> sync everything; "n"/"no" -> exclude everything; otherwise parsed as a number list (parse-exclude-list.ts's parseExcludeList). */
export function parseSyncAnswer(answer: string, totalCount: number): Set<number> {
  const trimmed = answer.trim();
  if (trimmed === "" || /^y(es)?$/i.test(trimmed)) return new Set();
  if (/^n(o)?$/i.test(trimmed)) return new Set(Array.from({ length: totalCount }, (_, i) => i + 1));
  return parseExcludeList(trimmed);
}

/** Exported for unit testing (mocked prompt.js) — issue #137. Takes the shared Prompter (see promptSyncSelection's doc comment). Empty input keeps `defaultName`. */
export async function promptDeviceName(prompter: Prompter, defaultName: string): Promise<string> {
  const answer = await prompter.ask(`Name this machine [${defaultName}]: `);
  return answer.trim() || defaultName;
}

export async function setup(opts: SetupOptions = {}): Promise<void> {
  console.log("");
  console.log("Membral setup");
  console.log("");

  // --- 1. Sign in --------------------------------------------------------
  console.log("Step 1/6 — Sign in");
  // Profiles: `--api-url` picks (or creates) the profile for that server —
  // an existing one is made active, a new one goes through sign-in below.
  // Without --api-url the active profile is used as before.
  const targetProfile = opts.profile ?? (opts.apiUrl ? profileNameForUrl(opts.apiUrl, loadProfiles()) : undefined);
  const existingCreds = targetProfile ? loadProfile(targetProfile) : loadCredentials();
  if (existingCreds) {
    if (targetProfile && !opts.dryRun) setActiveProfile(targetProfile);
    const who = existingCreds.email ? `${existingCreds.email} ` : "";
    console.log(`  Already signed in as ${who}(${existingCreds.apiUrl}).`);
  } else if (opts.apiKey) {
    console.log("  Using --api-key (skipping interactive sign-in).");
  } else if (opts.dryRun) {
    console.log(`  [dry-run] not signed in — would run the device sign-in flow now (${defaultCredentialsPath()}).`);
  } else {
    await loginCommand({ apiUrl: opts.apiUrl });
    if (!loadCredentials()) {
      console.error("");
      console.error("Sign-in did not complete — run `membral setup` again when you're ready.");
      process.exitCode = 1;
      return;
    }
  }
  console.log("");

  let apiUrl: string;
  let apiKey: string;

  if (opts.dryRun) {
    // --dry-run previews only — never makes a real network call.
    apiUrl = resolveApiUrl(opts.apiUrl, process.env.MEMBRAL_API_URL, DEFAULT_API_URL);
    apiKey = resolveApiKey(opts.apiKey, process.env.MEMBRAL_API_KEY);
    if (apiKey) {
      console.log(`  [dry-run] would validate the API key against ${apiUrl} before writing the MCP config.`);
      console.log("");
    }
  } else {
    // Issue #136: validate the resolved key against the resolved API URL
    // BEFORE step 6 writes the MCP config. Before this fix, a stale
    // MEMBRAL_API_KEY left exported in the shell silently outranked a
    // freshly-signed-in credentials.json (plain flag > env > credentials.json
    // precedence never validates), so setup would bake a dead key into MCP
    // config and every later command would 401 forever with no message ever
    // naming the env var as the cause. resolveValidatedCredentials tries env
    // first (same precedence) but falls back to a working credentials.json
    // key — and says so — when env is the one getting rejected; it only
    // reports `invalid` with nothing left to try.
    const resolved = await resolveValidatedCredentials({
      flagKey: opts.apiKey,
      flagUrl: opts.apiUrl,
      envKey: process.env.MEMBRAL_API_KEY,
      envUrl: process.env.MEMBRAL_API_URL,
      defaultUrl: DEFAULT_API_URL,
    });
    apiUrl = resolved.apiUrl;
    apiKey = resolved.apiKey;

    if (resolved.fallbackWarning) {
      console.log(`  ${resolved.fallbackWarning}`);
      console.log("");
    }

    if (resolved.apiKeySource !== "none" && resolved.validation.status === "invalid") {
      console.error(describeAuthRejection(resolved));
      console.error("");
      console.error("Stopping before configuring any MCP client.");
      process.exitCode = 1;
      return;
    }

    // B2 (P6 local rehearsal): `membral setup --api-key <key>` used to never
    // write ~/.membral/credentials.json at all — the flag only won THIS run
    // (flag > env > credentials.json precedence), so every hook/MCP config
    // this run installs bakes in a key that no LATER command (which has no
    // --api-key of its own) can resolve without MEMBRAL_API_KEY also being
    // exported. Persist it here, in the exact shape/location/api url
    // `membral login` itself writes, so the hooks installed below actually
    // authenticate. Only triggered by the flag (not a bare env var or an
    // existing credentials.json key) — that would persist something the user
    // never asked to save. A credentials.json for a DIFFERENT key/url is
    // overwritten with a one-line notice instead of silently replaced.
    if (opts.apiKey && apiKey) {
      const existing = loadCredentials();
      const unchanged = existing && existing.apiKey === apiKey && existing.apiUrl === apiUrl;
      if (!unchanged) {
        // Profiles: only a login to the SAME server replaces anything; another
        // server's credentials become (or update) their own profile.
        if (existing && profileNameForUrl(existing.apiUrl) === profileNameForUrl(apiUrl)) {
          console.log(`  Overwriting ${defaultCredentialsPath()} — it held credentials for a different key.`);
        }
        saveCredentials({
          apiUrl,
          apiKey,
          email: existing?.apiKey === apiKey ? existing.email : "(unknown — signed in via --api-key)",
          userId: existing?.apiKey === apiKey ? existing.userId : "",
          createdAt: existing?.apiKey === apiKey ? existing.createdAt : new Date().toISOString(),
        });
        console.log(`  Saved credentials to ${defaultCredentialsPath()} (${apiUrl}).`);
      }
      console.log("");
    }
  }

  if (!apiKey && !opts.dryRun) {
    console.error("No API key available (sign-in didn't complete and no --api-key was given) — stopping.");
    process.exitCode = 1;
    return;
  }

  // Issue #137: setup can ask up to TWO sequential questions in one run
  // (machine name in Step 2, sync selection in Step 4) — see
  // promptSyncSelection's doc comment / prompt.ts for why that means one
  // shared Prompter, created lazily on first use and closed exactly once
  // here (the `finally` below). Step 6 (session-end hook) asks nothing.
  let prompter: Prompter | undefined;
  const summary: string[] = [];
  let opencodePresent = false;
  function ensurePrompter(): Prompter {
    if (!prompter) prompter = createPrompter();
    return prompter;
  }

  try {
    // --- 2. Device identity --------------------------------------------------
    // Idempotent, local-only metadata (no network, no system service) — always
    // ensured for real even under --dry-run.
    //
    // Issue #137: before this, an existing device.json name won forever with
    // no prompt or rename path — the maintainer's first public test showed up
    // under an old test machine's name they never chose. --device-name /
    // MEMBRAL_DEVICE_NAME / --yes all bypass the prompt (with --yes and no
    // explicit name, the pre-existing default behavior is unchanged: keep the
    // existing device.json name if any, else the hostname). The chosen name
    // is persisted to device.json and read back by every later command.
    console.log("Step 2/6 — Device identity");
    const explicitDeviceName = (opts.deviceName ?? process.env.MEMBRAL_DEVICE_NAME)?.trim() || undefined;
    let deviceNameOverride = explicitDeviceName;
    if (!deviceNameOverride && !opts.yes && !opts.dryRun) {
      const defaultDeviceName = peekDeviceName() ?? hostname();
      deviceNameOverride = await promptDeviceName(ensurePrompter(), defaultDeviceName);
    }
    const device = loadOrCreateDeviceIdentity(deviceNameOverride ? { deviceName: deviceNameOverride } : {});
    console.log(`  ${device.name} (${device.platform}) — ${defaultDeviceIdentityPath()}`);
    console.log("");

    // --- 3. Scan for coding harnesses ----------------------------------------
    console.log("Step 3/6 — Scanning this machine for coding harnesses");
    const scanned = await scanHarnesses();
    if (scanned.length === 0) {
      console.log("  No Claude Code, Codex, opencode, or Copilot CLI sessions found on this machine yet.");
    }
    const numbered = printScanTable(scanned);
    console.log("");

    // --- 4. Choose what to sync ----------------------------------------------
    console.log("Step 4/6 — Choose what to sync");
    const existingSync = loadSyncAllowlist();
    let allowlist: SyncAllowlist;

    if (numbered.length === 0) {
      allowlist = existingSync ?? emptySyncAllowlist();
      console.log("  Nothing found to sync yet.");
    } else if (existingSync && !hasNewProjects(existingSync, numbered) && !opts.exclude && !opts.yes) {
      allowlist = existingSync;
      const totalEnabled = numbered.filter((p) => {
        const entry = existingSync.harnesses[p.harness]?.projects.find((e) => e.path === p.projectPath);
        return entry ? entry.enabled : existingSync.defaultNewProjects !== false;
      }).length;
      console.log(
        `  Sync selection already saved (${totalEnabled}/${numbered.length} enabled) — no new projects found.`,
      );
    } else if (opts.dryRun) {
      allowlist = existingSync ?? buildSyncAllowlist(numbered, new Set(), existingSync);
      console.log(`  [dry-run] would write ${defaultSyncAllowlistPath()}.`);
    } else {
      const excluded = parseExcludeList(opts.exclude);
      if (!opts.yes && !opts.exclude) {
        // P10: a real terminal gets the checkbox list; piped / non-TTY stdin
        // keeps the numbered "[Y/n] or numbers to exclude" line (issue #137's
        // readline path, unchanged) so scripts and tests behave as before.
        if (process.stdin.isTTY) {
          const picked = await promptSyncChecklist(numbered, existingSync);
          if (picked === null) {
            console.log(
              "  Cancelled — sync selection not saved (sign-in and device name are kept). Re-run `membral setup` to choose again.",
            );
            process.exitCode = 130;
            return;
          }
          for (const n of picked) excluded.add(n);
        } else {
          const answer = await promptSyncSelection(ensurePrompter());
          for (const n of parseSyncAnswer(answer, numbered.length)) excluded.add(n);
        }
      }
      allowlist = buildSyncAllowlist(numbered, excluded, existingSync);
      saveSyncAllowlist(allowlist);
      console.log(
        `  Wrote ${defaultSyncAllowlistPath()} (${numbered.length - excluded.size}/${numbered.length} project(s) enabled).`,
      );
    }
    console.log("");

    // --- 5. Session hooks, opencode plugin, backstop sweep, MCP --------------
    // Capture live BEFORE the (often long, rate-limit-paced) first import
    // below, so a new user is capturing new sessions within seconds instead
    // of only after the backfill finishes (maintainer ask, 2026-09-25).
    // PRODUCT.md's user flow step 2 ("sessions are captured at session end")
    // is only true once setup actually installs the hook — before this, only
    // the maintainer-run `membral install-session-hook` did. Claude Code is
    // the only harness with a hook mechanism in this codebase today
    // (configureSessionEndHook/configureSessionStartHook write to
    // ~/.claude/settings.json); opencode gets the same two
    // behaviours from its plugin: capture on session.idle, and the preamble
    // pushed onto the system prompt (experimental.chat.system.transform).
    // installSessionHook() installs BOTH the SessionEnd capture hook and
    // (P4, memory-on-prod-new-user goal) the SessionStart preamble hook, and
    // is idempotent on its own for each (configureCommandHook finds and
    // updates its existing entry instead of appending a new one — see
    // install-session-hook.test.ts), so calling it unconditionally on every
    // setup run never duplicates either hook.
    console.log("Step 5/6 — Session hooks, opencode plugin, sweep, MCP");
    // P6 local rehearsal: a new user who has installed Claude Code but not
    // yet run a session has ~/.claude but zero transcripts — keying this on
    // the session scan alone skipped both hooks for exactly that user (while
    // the MCP config below, keyed on ~/.claude, still configured Claude
    // Code). Either signal now counts as "Claude Code is here".
    const tools = await detectTools();
    const hasAgy = tools.some((t) => t.id === "agy" && t.detected);
    const hasClaudeCode =
      scanned.some((p) => p.harness === "claude-code") || tools.some((t) => t.id === "claude-code" && t.detected);
    const hasOpencode = scanned.some((p) => p.harness === "opencode");
    // The Membral Claude Code plugin already brings both hooks and the MCP
    // server (claude-plugin.ts); writing setup's own copies would fire each
    // hook twice.
    const claudePlugin = hasClaudeCode ? await findMembralPlugin() : null;
    // Prompt recall (docs/design/prompt-time-recall.md §4): an explicit flag is
    // remembered in ~/.membral/config.json; without one the stored choice holds.
    const cliConfigPath = opts.cliConfigPath ?? defaultCliConfigPath();
    if (!opts.dryRun && (opts.noPromptRecall || opts.promptRecall)) {
      setPromptRecall(!opts.noPromptRecall, cliConfigPath);
    }
    const promptRecallOn = opts.noPromptRecall ? false : opts.promptRecall ? true : promptRecallEnabled(cliConfigPath);
    if (claudePlugin) {
      console.log(
        `  Claude Code: the Membral plugin (${claudePlugin}) is installed and already provides the hooks and MCP server — skipping both.`,
      );
      summary.push(`Claude Code: hooks + MCP from the ${claudePlugin} plugin (setup skipped them)`);
      // The plugin does not carry the prompt hook, but an earlier setup may have
      // written ours to settings.json: turning recall off still removes it.
      if (!promptRecallOn && !opts.dryRun) {
        const removed = await configureUserPromptSubmitHook(defaultSettingsPath(), { remove: true });
        console.log(`  ${removed.message}`);
      }
    } else if (opts.dryRun) {
      if (hasClaudeCode) {
        console.log(
          promptRecallOn
            ? `  [dry-run] would install/update the Claude Code SessionEnd + SessionStart + UserPromptSubmit hooks (${defaultSettingsPath()}).`
            : `  [dry-run] would install/update the Claude Code SessionEnd + SessionStart hooks and remove the Membral UserPromptSubmit hook (prompt recall off) (${defaultSettingsPath()}).`,
        );
        summary.push("Claude Code hooks: would install (dry-run)");
      } else {
        console.log("  [dry-run] no Claude Code sessions detected — nothing to hook.");
      }
    } else if (hasClaudeCode) {
      await installSessionHook({ promptRecall: promptRecallOn });
      summary.push(
        !promptRecallOn
          ? "Claude Code hooks: SessionEnd upload + SessionStart preamble (prompt recall off)"
          : "Claude Code hooks: SessionEnd upload + SessionStart preamble + UserPromptSubmit recall",
      );
    } else {
      console.log("  No Claude Code detected on this machine — nothing to hook.");
      summary.push("Claude Code hooks: skipped (Claude Code not found)");
    }

    // Antigravity: only where its own install root exists (see detect.ts), or with --agy.
    // Never inferred from ~/.gemini/config, which Gemini CLI shares.
    if (opts.agy || hasAgy) {
      if (opts.dryRun) {
        console.log(
          `  [dry-run] would install/update the Antigravity hooks (${agyHooksConfigPath()}) and MCP entry (${agyMcpConfigPath()}).`,
        );
        summary.push("Antigravity: would install hooks + MCP (dry-run)");
      } else {
        const hooks = await configureAgyHooks(agyHooksConfigPath(), {});
        console.log(`  Antigravity hooks (${agyHooksConfigPath()}): ${hooks.message}.`);
        const agyMcp = await configureMCPServer("agy", agyMcpConfigPath(), { apiUrl, apiKey });
        console.log(`  Antigravity MCP (${agyMcpConfigPath()}): ${agyMcp.message}`);
        summary.push(
          `Antigravity: hooks ${hooks.success ? "configured" : "FAILED"}, MCP ${agyMcp.success ? "configured" : "FAILED"}`,
        );
      }
    } else {
      summary.push("Antigravity: skipped (not found; --agy forces it)");
    }

    // Copilot: hooked whenever the Copilot CLI or VS Code is installed (VS
    // Code's chat runs on the Copilot CLI engine and fires ~/.copilot hooks),
    // not only once a Copilot CLI session exists; --copilot-cli forces it.
    let copilot: CopilotPresence | undefined;
    try {
      copilot = await detectCopilot();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`  Copilot detection: failed (${reason})`);
    }
    if (opts.copilotCli || copilot?.present || scanned.some((p) => p.harness === "copilot-cli")) {
      let res: Awaited<ReturnType<typeof installCopilotCliHooks>> | undefined;
      try {
        res = await installCopilotCliHooks({ dryRun: opts.dryRun });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`  Copilot CLI hooks: failed (${reason})`);
        summary.push(`Copilot CLI hooks: failed (${reason})`);
      }
      if (!res) {
        // failure already reported; carry on with the rest of setup
      } else if (opts.dryRun) {
        console.log(`  [dry-run] Copilot CLI hooks (${res.path}): ${res.outcome}.`);
        summary.push("Copilot CLI hooks: would install (dry-run)");
      } else {
        console.log(`  Copilot CLI hooks (${res.path}): ${res.outcome}. Restart Copilot CLI to load them.`);
        summary.push("Copilot CLI hooks: sessionEnd upload + sessionStart preamble");
      }
      if (res?.warning) console.log(res.warning);
      try {
        const mcp = await installCopilotCliMcp({ apiUrl, apiKey, dryRun: opts.dryRun });
        if (mcp.outcome === "invalid-json") {
          console.log(`  Copilot CLI MCP: ${mcp.path} is not valid JSON, left untouched. Add it by hand:`);
          console.log(`    ${mcp.manualCommand}`);
          summary.push("Copilot CLI MCP: failed (mcp-config.json is not valid JSON)");
        } else if (mcp.outcome === "would-write") {
          console.log(`  [dry-run] Copilot CLI MCP (${mcp.path}): would write.`);
          summary.push("Copilot CLI MCP: would write (dry-run)");
        } else {
          console.log(`  Copilot CLI MCP (${mcp.path}): ${mcp.outcome}.`);
          summary.push(`Copilot CLI MCP: ${mcp.outcome}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`  Copilot CLI MCP: failed (${reason})`);
        summary.push(`Copilot CLI MCP: failed (${reason})`);
      }
    } else {
      summary.push("Copilot CLI hooks: skipped (Copilot not found)");
    }
    // VS Code: one user-level instructions file so Copilot Chat in every
    // workspace knows Membral. Its MCP is ~/.copilot/mcp-config.json above.
    if (copilot && (copilot.vscodeUserDirs.length > 0 || copilot.vscodeExtension)) {
      if (opts.dryRun) {
        console.log(`  [dry-run] would write ${userInstructionsPath()}.`);
        summary.push("Copilot instructions: would write (dry-run)");
      } else {
        try {
          const f = await writeUserInstructions();
          console.log(`  Copilot instructions (${f.path}): ${f.outcome}`);
          summary.push(`Copilot instructions: ${f.outcome}`);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.log(`  Copilot instructions: failed (${reason})`);
          summary.push(`Copilot instructions: failed (${reason})`);
        }
      }
    }
    opencodePresent = hasOpencode || detectOpencode();
    if (opencodePresent) {
      const plugin = await installOpencodePlugin({ dryRun: opts.dryRun });
      console.log(`  ${plugin.message}`);
      summary.push(
        `opencode capture plugin: ${!plugin.success ? "NOT installed — see above" : opts.dryRun ? "would install (dry-run)" : "installed"}`,
      );
    } else {
      summary.push("opencode capture plugin: skipped (opencode not found)");
    }
    // Codex (W9): MCP, SessionStart preamble hook and an AGENTS.md block,
    // whenever `codex` is on PATH or ${CODEX_HOME:-~/.codex} exists.
    let codexPresent = scanned.some((p) => p.harness === "codex");
    if (!codexPresent) codexPresent = await detectCodex().catch(() => false);
    if (codexPresent) {
      try {
        const cx = await setupCodex({ apiUrl, dryRun: opts.dryRun });
        const written = [cx.mcp, cx.hooks, cx.agents].map((r) => `${r.path} ${r.outcome}`).join(", ");
        console.log(`  Codex${opts.dryRun ? " [dry-run]" : ""}: ${written}.`);
        for (const r of [cx.mcp, cx.hooks, cx.agents]) if (r.warning) console.log(`  WARNING: ${r.warning}`);
        if (cx.invocationWarning) console.log(cx.invocationWarning);
        if (cx.versionWarning) console.log(`  WARNING: ${cx.versionWarning}`);
        if (cx.hooks.outcome === "created" || cx.hooks.outcome === "updated") {
          console.log(`  Action: ${CODEX_APPROVE_HOOK_ACTION}`);
        }
        summary.push(`Codex: MCP ${cx.mcp.outcome}, preamble hook ${cx.hooks.outcome}, AGENTS.md ${cx.agents.outcome}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`  Codex: failed (${reason})`);
        summary.push(`Codex: failed (${reason})`);
      }
    } else {
      summary.push("Codex: skipped (Codex not found)");
    }
    console.log("");

    // --- Backstop sweep ------------------------------------------------------
    console.log("Backstop sweep");
    if (opts.noSweep) {
      console.log("  Skipped (--no-sweep).");
      summary.push("Backstop sweep: skipped (--no-sweep)");
    } else {
      const sweep = await installSweepAgent({ dryRun: opts.dryRun });
      console.log(`  ${sweep.message}`);
      for (const w of sweep.warnings ?? []) console.log(`  NOTE: ${w}`);
      // "none" is never a quiet success: nothing will run the sweep on this machine.
      const sweepStatus =
        sweep.scheduler === "none"
          ? `NONE — ${sweep.reason ?? "no scheduler found; run `membral sweep` every 20 min yourself"}`
          : !sweep.success
            ? `FAILED (${sweep.scheduler}): ${sweep.reason ?? "see above"}`
            : opts.dryRun
              ? `would install (${sweep.scheduler}, dry-run)`
              : `installed (${sweep.scheduler}), every 20 min`;
      const sweepWarnings = sweep.warnings?.length ? ` — ${sweep.warnings.join("; ")}` : "";
      summary.push(`Backstop sweep: ${sweepStatus}${sweepWarnings}`);
    }
    console.log("");

    // --- MCP configuration -----------------------------------------------------
    // Moved up from "kept last" (was its own unnumbered step after the
    // import) to land inside this same capture-goes-live-first step — an
    // agent host that reads MCP config at session start should see Membral
    // before the first import even begins.
    console.log("MCP configuration");
    // Antigravity's MCP entry is written once, by its own block above (it also covers --agy on an
    // undetected install), so it is excluded here.
    const detected = tools.filter((t) => t.detected && t.id !== "agy" && !(claudePlugin && t.id === "claude-code"));
    if (detected.length === 0) {
      console.log("  No supported AI tools detected (Claude Desktop, Claude Code, Cursor).");
    } else {
      for (const tool of detected) {
        if (opts.dryRun) {
          console.log(`  [dry-run] would configure MCP for ${tool.name}.`);
          continue;
        }
        const result = await configureMCPServer(tool.id as McpClientId, tool.configPath ?? "", { apiUrl, apiKey });
        console.log(`  ${tool.name}: ${result.message}`);
        summary.push(`MCP ${tool.name}: ${result.success ? "configured" : "FAILED"}`);
      }
    }
    if (opencodePresent) {
      if (opts.dryRun) {
        console.log("  [dry-run] would configure MCP for opencode.");
      } else {
        const oc = await configureOpencodeMcp({ apiUrl, apiKey });
        console.log(`  opencode: ${oc.message}`);
        const ocStatus = !oc.success
          ? "FAILED"
          : /untouched/.test(oc.message)
            ? "add the snippet above by hand"
            : "configured";
        summary.push(`MCP opencode: ${ocStatus}`);
      }
    }
    console.log("");

    if (opts.copilot) {
      console.log("GitHub Copilot (VS Code)");
      if (opts.dryRun) {
        console.log("  [dry-run] would write .vscode/mcp.json and .github/copilot-instructions.md.");
      } else {
        let repoRoot: string | undefined;
        try {
          repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        } catch {
          repoRoot = undefined;
        }
        if (!repoRoot) {
          console.log(
            `  membral setup --copilot: run this from inside the repo you open in VS Code (no git repo at ${process.cwd()})`,
          );
          summary.push("Copilot (VS Code): skipped (not inside a git repo)");
        } else {
          const res = await setupCopilotVscode({ repoRoot, apiUrl });
          for (const f of [res.mcp, res.instructions]) {
            console.log(`  ${f.path}: ${f.outcome}`);
            if (f.message) console.log(f.message);
            summary.push(`Copilot ${f.path}: ${f.outcome}`);
          }
          console.log("  Open Copilot Chat in agent mode, VS Code will ask for the key once.");
        }
      }
      console.log("");
    }

    // --- 6. Run the first import now ------------------------------------------
    // Last on purpose: hooks/plugin/sweep/MCP above are already live, so this
    // (often long, rate-limit-paced — see import-progress.ts) backfill no
    // longer delays capture.
    console.log("Step 6/6 — Importing sessions");
    if (opts.dryRun) {
      console.log("  [dry-run] would run sessions now.");
    } else if (!apiKey) {
      console.log("  Skipped — no API key available.");
    } else {
      // 2026-09-12 review, finding 11: this used to call importSessions()
      // with no --source (defaults to claude-code alone), while step 3 now
      // lists opencode projects as importable too — so a machine with both
      // harnesses had this step silently skip every opencode session. Loop
      // over the SAME source list `membral sessions` (index.ts) uses.
      // Only the last DEFAULT_IMPORT_WINDOW_DAYS days: older sessions yield no
      // memories and cost storage. `membral sessions --all` imports the rest.
      const since = defaultImportSince();
      console.log(
        `  Importing sessions from the last ${DEFAULT_IMPORT_WINDOW_DAYS} days (use \`membral sessions --all\` for older history).`,
      );
      let totalImported = 0;
      let totalErrored = 0;
      const facts: SessionFact[] = [];
      let authRejected = false;
      for (const source of DEFAULT_IMPORT_SOURCES) {
        const result = await importSessions({ apiUrl, apiKey, source, since });
        totalImported += result.totalImported;
        totalErrored += result.totalErrored;
        facts.push(...(result.sessionFacts ?? []));
        // Every source shares this key and server: the rest would be rejected the same way.
        if (result.authRejected) {
          authRejected = true;
          break;
        }
      }
      const errorNote = totalErrored > 0 ? `, ${totalErrored} error(s)` : "";
      console.log(`  Imported ${totalImported} session(s)${errorNote}.`);
      // A run that imported nothing and hit errors says nothing true about the history; skip the report.
      if (!authRejected && !(totalImported === 0 && totalErrored > 0)) {
        const report = renderFirstRunReport({
          windowDays: DEFAULT_IMPORT_WINDOW_DAYS,
          windowStart: since,
          sessions: facts,
        });
        for (const line of report) console.log(`  ${line}`);
      }
    }
    console.log("");
  } finally {
    // Every prompt above shares this ONE Prompter (see ensurePrompter's
    // creation comment) — close it exactly once, whether or not any prompt
    // was actually asked this run (prompter stays undefined and this is a
    // no-op).
    prompter?.close();
  }

  // --- Summary ---------------------------------------------------------------
  const activeProfile = opts.dryRun ? (targetProfile ?? loadProfiles()?.activeProfile) : loadProfiles()?.activeProfile;
  console.log("Summary");
  console.log(
    `  Profile: ${activeProfile ?? profileNameForUrl(apiUrl)} (${apiUrl}) — switch with \`membral use <profile>\``,
  );
  for (const line of summary) console.log(`  ${line}`);
  console.log("");

  // --- Final nudge -----------------------------------------------------------
  const line = "─".repeat(60);
  console.log(line);
  console.log("Your chats aren't in Membral yet:");
  console.log(`  - Import a ChatGPT/Claude export: membral import <conversations.json>`);
  console.log(`  - Or install the extension for ongoing sync: ${apiUrl}/import`);
  console.log(line);
  console.log("");
}
