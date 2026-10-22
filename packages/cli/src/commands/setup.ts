import { boolFlag, parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { setup } from "../setup.js";
import type { Command } from "./types.js";

export const setupCommand: Command = {
  name: "setup",
  async run(rest) {
    const flags = parseFlags(rest);
    await setup({
      apiUrl: stringFlag(flags, "api-url"),
      apiKey: stringFlag(flags, "api-key"),
      yes: boolFlag(flags, "yes"),
      exclude: stringFlag(flags, "exclude"),
      deviceName: stringFlag(flags, "device-name"),
      dryRun: boolFlag(flags, "dry-run"),
      noSweep: boolFlag(flags, "no-sweep"),
      noPromptRecall: boolFlag(flags, "no-prompt-recall"),
      promptRecall: boolFlag(flags, "prompt-recall"),
      copilot: boolFlag(flags, "copilot"),
      copilotCli: boolFlag(flags, "copilot-cli"),
      agy: boolFlag(flags, "agy"),
    });
  },
  help: HELP.setup,
};
