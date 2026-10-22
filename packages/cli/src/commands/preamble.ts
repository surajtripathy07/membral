import { boolFlag, parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { preambleHook } from "../preamble-hook.js";
import type { Command } from "./types.js";

export const preambleCommand: Command = {
  name: "preamble",
  // NEVER exits non-zero, NEVER blocks — see preamble-hook.ts. Invoked
  // directly by Claude Code's SessionStart hook with JSON on stdin; the
  // explicit process.exit(0) bounds total process lifetime the same way
  // session-end-hook does above.
  async run(rest) {
    const flags = parseFlags(rest);
    if (!boolFlag(flags, "hook")) {
      console.log(HELP.preamble);
      process.exit(0);
    }
    // The Claude Code plugin (plugins/membral/scripts/run.mjs) sets a shorter
    // fetch budget so its SessionStart entry fits a 5 s hook timeout.
    const envTimeout = Number(process.env.MEMBRAL_PREAMBLE_TIMEOUT_MS);
    await preambleHook({
      ...(Number.isInteger(envTimeout) && envTimeout > 0 ? { timeoutMs: envTimeout } : {}),
      apiUrl: stringFlag(flags, "api-url"),
      apiKey: stringFlag(flags, "api-key"),
      // Only Copilot CLI passes --format; Claude Code's call is unchanged.
      ...(stringFlag(flags, "format") === "copilot" ? { format: "copilot" as const } : {}),
      ...(stringFlag(flags, "format") === "text" ? { format: "text" as const } : {}),
      ...(stringFlag(flags, "format") === "agy" ? { format: "agy" as const } : {}),
    });
    process.exit(0);
  },
  help: HELP.preamble,
};
