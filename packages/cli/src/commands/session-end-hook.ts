import { boolFlag, parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { sessionEndHook } from "../session-end-hook.js";
import type { Command } from "./types.js";

export const sessionEndHookCommand: Command = {
  name: "session-end-hook",
  // NEVER exits non-zero, NEVER blocks — see session-end-hook.ts. Invoked
  // directly by Claude Code's SessionEnd hook with JSON on stdin; the
  // explicit process.exit(0) below bounds total process lifetime even if
  // something (e.g. a slow network handle) would otherwise keep the event
  // loop alive past sessionEndHook()'s own internal timeout.
  async run(rest) {
    const flags = parseFlags(rest);
    const rawOffset = Number(stringFlag(flags, "deferred-offset"));
    const deferredOffset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : undefined;
    await sessionEndHook({
      apiUrl: stringFlag(flags, "api-url"),
      apiKey: stringFlag(flags, "api-key"),
      // Only Copilot CLI passes --source; Claude Code's call is unchanged.
      ...(stringFlag(flags, "source") === "copilot-cli" ? { source: "copilot-cli" as const } : {}),
      ...(stringFlag(flags, "source") === "agy" ? { source: "agy" as const } : {}),
      // Claude Code Stop hook (session still open): hand the transcript so far to a detached child.
      ...(boolFlag(flags, "stop") ? { stop: true } : {}),
      // Internal: set only on the Stop hook's detached child (open-session upload; no paid extraction).
      ...(boolFlag(flags, "open") ? { open: true } : {}),
      // Internal: set only on the detached child the hook spawns (Claude Code and Copilot).
      ...(stringFlag(flags, "deferred-path") ? { deferredPath: stringFlag(flags, "deferred-path") } : {}),
      ...(deferredOffset !== undefined ? { deferredOffset } : {}),
      // Internal: the detached session-end questionnaire child (questionnaire.ts).
      ...(stringFlag(flags, "questionnaire") ? { questionnaireSession: stringFlag(flags, "questionnaire") } : {}),
      ...(stringFlag(flags, "cwd") ? { cwd: stringFlag(flags, "cwd") } : {}),
    });
    process.exit(0);
  },
  help: HELP["session-end-hook"],
};
