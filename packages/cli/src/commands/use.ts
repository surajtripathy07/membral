import { HELP } from "../help.js";
import { useCommand as runUseCommand } from "../use-command.js";
import type { Command } from "./types.js";

export const useCommand: Command = {
  name: "use",
  async run(rest) {
    const name = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    await runUseCommand(name);
  },
  help: HELP.use,
};
