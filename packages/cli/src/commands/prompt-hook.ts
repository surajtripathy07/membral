import { parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { promptHook } from "../prompt-hook.js";
import type { Command } from "./types.js";

export const promptHookCommand: Command = {
  name: "prompt-hook",
  // NEVER exits non-zero, NEVER blocks the prompt — see prompt-hook.ts.
  // Invoked by Claude Code's UserPromptSubmit hook with JSON on stdin.
  async run(rest) {
    const flags = parseFlags(rest);
    await promptHook({ apiUrl: stringFlag(flags, "api-url"), apiKey: stringFlag(flags, "api-key") });
    process.exit(0);
  },
  help: HELP["prompt-hook"],
};
