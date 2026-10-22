// The command registry (step 3C-4, rung G3) — replaces the 14-arm `switch`
// that used to live in index.ts. Order matches the original `case` order
// exactly (index.ts's unknown-command / help-guard behavior never depended
// on it, but keeping it makes this a pure move, easy to diff against the
// old switch). Every function body moved verbatim into its own
// `commands/<name>.ts`; only the `case` wrapper and dispatch changed.
import { dogfoodCommand } from "./dogfood.js";
import { helpCommand } from "./help.js";
import { importCommand } from "./import.js";
import { importSessionCommand } from "./import-session.js";
import { installSessionHookCommand } from "./install-session-hook.js";
import { localCommand } from "./local.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";
import { mcpHeadersCommand } from "./mcp-headers.js";
import { preambleCommand } from "./preamble.js";
import { promptHookCommand } from "./prompt-hook.js";
import { sessionEndHookCommand } from "./session-end-hook.js";
import { sessionsCommand } from "./sessions.js";
import { setupCommand } from "./setup.js";
import { statusCommand } from "./status.js";
import { sweepCommand } from "./sweep.js";
import type { Command } from "./types.js";
import { useCommand } from "./use.js";
import { whoamiCommand } from "./whoami.js";

export const COMMANDS: readonly Command[] = [
  setupCommand,
  useCommand,
  sweepCommand,
  loginCommand,
  logoutCommand,
  whoamiCommand,
  importCommand,
  statusCommand,
  sessionsCommand,
  localCommand,
  importSessionCommand,
  sessionEndHookCommand,
  preambleCommand,
  promptHookCommand,
  mcpHeadersCommand,
  installSessionHookCommand,
  dogfoodCommand,
  helpCommand,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export type { Command };
