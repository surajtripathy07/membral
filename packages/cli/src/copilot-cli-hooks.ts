// `membral setup --copilot-cli`: GitHub Copilot CLI hooks. Copilot CLI merges
// every `*.json` under `${COPILOT_HOME:-~/.copilot}/hooks/`, so Membral owns
// one standalone file there (`membral.json`) and never reads or edits any
// other hook file; uninstall is deleting it.
//
//   sessionStart -> `membral preamble --hook --format copilot` (prints
//                   `{"additionalContext": ...}`, preamble-hook.ts)
//   sessionEnd   -> `membral session-end-hook --source copilot-cli` (derives
//                   session-state/<id>/events.jsonl, session-end-hook.ts)
//
// No agentStop: it fires after every agent turn, and each fire would upload a
// grown events.jsonl, whose new content hash fails the server's unchanged
// short-circuit (apps/cloud/src/lib/code-sessions/import.ts:104), rewrites
// every turn and re-queues memory extraction for the session
// (apps/cloud/src/app/api/code-sessions/route.ts:151-194). A session killed
// before sessionEnd is caught by the periodic `membral sessions` sweep,
// which iterates every registered parser, copilot-cli included.
//
// Like the Claude Code hooks (configure.ts), the commands embed no API key
// or URL: both are resolved at hook run time from credentials.json.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CliInvocation, isEnoent, quoteInvocation, resolveCliInvocation, writeFileAtomic } from "./configure.js";
import { defaultCopilotHome } from "./import-sessions.js";
import { PREAMBLE_HOOK_TIMEOUT_MS } from "./preamble-hook.js";
import { HOOK_TIMEOUT_MS } from "./session-end-hook.js";

export const COPILOT_HOOKS_FILE = "membral.json";

// Copilot's own per-hook timeout sits a few seconds above each command's
// internal cap, so the command always finishes (and logs) first.
const PREAMBLE_TIMEOUT_SEC = Math.ceil(PREAMBLE_HOOK_TIMEOUT_MS / 1000) + 5;
const SESSION_END_TIMEOUT_SEC = Math.ceil(HOOK_TIMEOUT_MS / 1000) + 5;

export type CopilotHooksOutcome = "created" | "updated" | "unchanged" | "would-write";

export interface CopilotCliHooksOptions {
  /** Defaults to ${COPILOT_HOME:-~/.copilot}. */
  copilotHome?: string;
  /** Overrides the resolved node+entry invocation — tests only. */
  cliInvocation?: CliInvocation;
  dryRun?: boolean;
}

export interface CopilotCliHooksResult {
  path: string;
  outcome: CopilotHooksOutcome;
  /** Set when the CLI fell back to `membral` on PATH (npx temp cache) or pinned an nvm node. */
  warning?: string;
}

export function copilotHooksPath(copilotHome: string = defaultCopilotHome()): string {
  return join(copilotHome, "hooks", COPILOT_HOOKS_FILE);
}

// PowerShell: call operator plus single-quoted args ('' escapes a quote).
function powershellInvocation(invocation: CliInvocation): string {
  return `& ${invocation.argv.map((a) => `'${a.replace(/'/g, "''")}'`).join(" ")}`;
}

function entry(invocation: CliInvocation, args: string, timeoutSec: number) {
  return {
    type: "command",
    bash: `${quoteInvocation(invocation)} ${args}`,
    powershell: `${powershellInvocation(invocation)} ${args}`,
    timeoutSec,
  };
}

/** The exact file content written; deterministic for a given invocation. */
export function buildCopilotHooksFile(invocation: CliInvocation): string {
  const config = {
    version: 1,
    hooks: {
      sessionStart: [entry(invocation, "preamble --hook --format copilot", PREAMBLE_TIMEOUT_SEC)],
      sessionEnd: [entry(invocation, "session-end-hook --source copilot-cli", SESSION_END_TIMEOUT_SEC)],
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Writes `<copilotHome>/hooks/membral.json` atomically; a rerun with the same CLI is byte-identical and reports "unchanged". */
export async function installCopilotCliHooks(opts: CopilotCliHooksOptions = {}): Promise<CopilotCliHooksResult> {
  const path = copilotHooksPath(opts.copilotHome);
  const invocation = opts.cliInvocation ?? resolveCliInvocation();
  const next = buildCopilotHooksFile(invocation);
  const warning = invocation.fallbackWarning;

  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf-8");
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  if (existing === next) return { path, outcome: "unchanged", warning };
  if (opts.dryRun) return { path, outcome: "would-write", warning };

  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, next);
  return { path, outcome: existing === undefined ? "created" : "updated", warning };
}
