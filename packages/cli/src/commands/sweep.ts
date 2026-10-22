import { boolFlag, parseFlags } from "../args.js";
import { HELP } from "../help.js";
import { sweepCommand as runSweepCommand, uninstallSweepAgent } from "../sweep-command.js";
import type { Command } from "./types.js";

export const sweepCommand: Command = {
  name: "sweep",
  async run(rest) {
    if (boolFlag(parseFlags(rest), "remove")) {
      const r = await uninstallSweepAgent();
      console.log(r.message);
      if (!r.success) process.exitCode = 1;
      return;
    }
    await runSweepCommand();
  },
  help: HELP.sweep,
};
