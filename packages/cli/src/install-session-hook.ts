// `membral install-session-hook [--api-url <url>] [--settings <path>]
// [--remove]` — writes (or removes) the Claude Code SessionEnd hook entry
// that runs `membral session-end-hook` after every session (ADR 0021
// Q1/P1b). The actual read-merge-write logic lives in configure.ts
// (`configureSessionEndHook`), reusing the same pattern configureMCPServer
// already uses for ~/.claude/settings.json — this file just resolves CLI
// defaults and prints the result.
import { homedir } from "node:os";
import { join } from "node:path";
import { promptRecallEnabled } from "./cli-config.js";
import {
  type CliInvocation,
  type ConfigureResult,
  configureAgyHooks,
  configureSessionEndHook,
  configureSessionStartHook,
  configureStopHook,
  configureUserPromptSubmitHook,
} from "./configure.js";
import { agyHooksConfigPath } from "./detect.js";

export interface InstallSessionHookOptions {
  /** Accepted for compatibility only — hooks resolve the URL at run time from the active profile (see `membral use`). */
  apiUrl?: string;
  settings?: string;
  remove?: boolean;
  /** Overrides the resolved node+entry invocation — tests only; see configure.ts's resolveCliInvocation. */
  cliInvocation?: CliInvocation;
  /** False removes only the UserPromptSubmit hook. Omitted: the stored choice in ~/.membral/config.json (default on). */
  promptRecall?: boolean;
  /** Also install the Antigravity hooks (`~/.gemini/config/hooks.json`). Removal always includes them. */
  agy?: boolean;
  /** Antigravity hooks.json override — tests only. */
  agyHooksPath?: string;
  /** ~/.membral/config.json override — tests only. */
  cliConfigPath?: string;
}

/** Printed whenever the prompt hook is registered (docs/design/prompt-time-recall.md §6). */
export const PROMPT_RECALL_DISCLOSURE =
  "Prompt recall: prompts of 4+ words (up to 2,000 chars), with the repo and session id, are sent to your Membral server, which embeds them with its configured model provider to find related past work; the prompt is not stored. Turn off: membral setup --no-prompt-recall";

export function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

// P4 (memory-on-prod-new-user goal): installs both the SessionEnd capture
// hook and the SessionStart preamble hook in one call — same install
// mechanics/idempotency style, same settings.json, same options. setup.ts's
// step 6 calls this unconditionally on every run for machines with Claude
// Code detected; each of the two configure* calls is independently
// idempotent (see configure.ts's configureCommandHook), so calling both
// here never duplicates either entry.
export async function installSessionHook(opts: InstallSessionHookOptions = {}): Promise<void> {
  const settingsPath = opts.settings ?? defaultSettingsPath();

  if (opts.apiUrl && !opts.remove) {
    console.log(
      "Note: hook commands no longer embed --api-url — they use the active profile in\n" +
        "~/.membral/credentials.json at run time. Switch servers with `membral use <profile>`.",
    );
  }

  const endResult = await configureSessionEndHook(settingsPath, {
    remove: opts.remove,
    cliInvocation: opts.cliInvocation,
  });
  console.log(endResult.message);

  const startResult = await configureSessionStartHook(settingsPath, {
    remove: opts.remove,
    cliInvocation: opts.cliInvocation,
  });
  console.log(startResult.message);

  // Open-session upload: Stop fires after each turn group; the hook hands a detached child the transcript so far.
  const stopResult = await configureStopHook(settingsPath, {
    remove: opts.remove,
    cliInvocation: opts.cliInvocation,
  });
  console.log(stopResult.message);

  // Prompt-time recall (docs/design/prompt-time-recall.md): Claude Code only.
  const promptOn = opts.promptRecall ?? promptRecallEnabled(opts.cliConfigPath);
  const promptResult = await configureUserPromptSubmitHook(settingsPath, {
    remove: opts.remove || !promptOn,
    cliInvocation: opts.cliInvocation,
  });
  console.log(promptResult.message);
  if (promptOn && !opts.remove && promptResult.success) console.log(PROMPT_RECALL_DISCLOSURE);

  // Antigravity hooks are installed by `membral setup` (which detects Antigravity) or here with
  // `agy: true`; `--remove` always sweeps them, which deletes only the `membral` key.
  let agyResult: ConfigureResult | undefined;
  if (opts.remove || opts.agy) {
    agyResult = await configureAgyHooks(opts.agyHooksPath ?? agyHooksConfigPath(), {
      remove: opts.remove,
      cliInvocation: opts.cliInvocation,
    });
    console.log(agyResult.message);
  }

  if (
    !endResult.success ||
    !startResult.success ||
    !stopResult.success ||
    !promptResult.success ||
    (agyResult && !agyResult.success)
  ) {
    process.exitCode = 1;
  }
}
