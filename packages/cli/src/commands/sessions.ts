import { parseFlags, stringFlag } from "../args.js";
import { createUploadClient, resolveUploadConfig } from "../code-session-upload.js";
import { HELP } from "../help.js";
import { acquireImportLock } from "../import-lock.js";
import { DEFAULT_IMPORT_SOURCES, importSessions, sendHeartbeatPing } from "../import-sessions.js";
import { DEFAULT_IMPORT_WINDOW_DAYS, resolveImportSince } from "../import-window.js";
import { kickMemoryExtraction } from "../memory-kick.js";
import type { Command } from "./types.js";

// Renamed from `import-sessions` (ADR 0050 D2/D7) — the old name is
// removed outright, no alias; every repo reference was updated in the
// same change. The underlying function/module keeps its name:
// sweep.ts calls importSessions() in-process, not as a subcommand.
//
// Goal 2026-09-12 W6/D5 — "CLI ingests two harnesses": with no explicit
// --source, run every known harness (DEFAULT_IMPORT_SOURCES —
// claude-code, opencode) rather than defaulting to claude-code alone,
// so `membral sessions --dry-run` reports both as importable on a
// machine with both installed. An explicit --source keeps the
// single-harness behavior exactly as before.
//
// #143 follow-up: --root now applies to whichever --source is given —
// importSessions() already resolves `opts.root ?? defaultRootFor(source)`
// per-source (import-sessions.ts), so passing rootFlag straight through
// for every source is correct as-is; the bug was here, not there. A
// multi-source run (no --source) has no single meaningful root, so
// --root REQUIRES an explicit --source — guessing which harness it was
// meant for would silently import the wrong directory (or the real one
// instead of a throwaway --root the caller only meant for one harness).
export const sessionsCommand: Command = {
  name: "sessions",
  async run(rest) {
    const flags = parseFlags(rest);
    const explicitSource = stringFlag(flags, "source");
    const rootFlag = stringFlag(flags, "root");
    if (rootFlag !== undefined && !explicitSource) {
      console.error(
        "--root needs --source <claude-code|opencode|copilot-cli|codex> because each harness has its own root",
      );
      process.exitCode = 1;
      return;
    }
    const sources = explicitSource ? [explicitSource] : DEFAULT_IMPORT_SOURCES;
    const apiUrl = stringFlag(flags, "api-url");
    const apiKey = stringFlag(flags, "api-key");
    const dryRun = flags["dry-run"] === true;
    // One bulk import at a time (import-lock.ts): the opencode plugin's idle
    // trigger and the launchd sweep must not upload the same window twice.
    // A dry run uploads nothing, so it never waits on or takes the lock.
    const lock = dryRun ? { release: () => {} } : acquireImportLock();
    if (!lock) {
      console.log("another import is running — skipping (it covers the same sessions).");
      return;
    }
    // Default window = last DEFAULT_IMPORT_WINDOW_DAYS days (import-window.ts);
    // --since <date> wins, --all uploads everything. --force is bound by the
    // same window unless one of those is given.
    const sinceFlag = stringFlag(flags, "since");
    const all = flags.all === true;
    const since = resolveImportSince({ since: sinceFlag, all });
    if (sinceFlag === undefined && !all) {
      console.log(`Importing sessions from the last ${DEFAULT_IMPORT_WINDOW_DAYS} days (use --all for older history).`);
    }
    // One policy client for the whole run: every source's /known check and
    // uploads, the heartbeat and the kick share its backoff state and its
    // env-key fallback (a stale MEMBRAL_API_KEY costs one 401 per run).
    const config = resolveUploadConfig({ apiUrl, apiKey });
    const client = !dryRun && config.apiKey ? createUploadClient(config, { log: (l) => console.warn(l) }) : undefined;
    let anyFailed = false;
    let authRejected = false;
    let combinedTotalSessions = 0;
    for (const source of sources) {
      const result = await importSessions(
        {
          root: rootFlag,
          since,
          dryRun,
          source,
          explicitSource: explicitSource !== undefined,
          apiUrl,
          apiKey,
          force: flags.force === true,
          full: flags.full === true,
          // One heartbeat for the whole run, not one per source (2026-09-12
          // review, finding 12) — sent below once every source has reported
          // in, only if the grand total across all of them was zero.
          heartbeat: sources.length > 1 ? false : undefined,
        },
        client,
      );
      if (!result.ok) anyFailed = true;
      combinedTotalSessions += result.totalSessions;
      if (result.authRejected) {
        // Every source shares this key and server: the rest would be rejected the same way.
        authRejected = true;
        const rest = sources.slice(sources.indexOf(source) + 1);
        if (rest.length > 0) console.error(`Skipped ${rest.join(", ")}: the API key was rejected (see above).`);
        break;
      }
    }
    if (sources.length > 1 && !dryRun && combinedTotalSessions === 0 && !anyFailed) {
      const heartbeatOk = await sendHeartbeatPing({ apiUrl, apiKey }, undefined, undefined, client);
      if (!heartbeatOk) anyFailed = true;
    }
    // Nudges a stalled memory-extraction chain once per run (same reasoning
    // as sweep-command.ts): never affects this command's own exit code, so a
    // failed kick (already logged by kickMemoryExtraction) is ignored here.
    // Skipped after a rejected key: the kick would only repeat the same 401.
    if (!dryRun && !authRejected) {
      await kickMemoryExtraction({ apiUrl, apiKey }, undefined, undefined, {}, client);
    }
    lock.release();
    if (anyFailed) process.exitCode = 1;
  },
  help: HELP.sessions,
};
