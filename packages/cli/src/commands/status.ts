import { parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { statusCommand as runStatusCommand } from "../status-command.js";
import type { Command } from "./types.js";

export const statusCommand: Command = {
  name: "status",
  async run(rest) {
    const flags = parseFlags(rest);
    await runStatusCommand(
      {},
      {
        apiUrl: stringFlag(flags, "api-url"),
        apiKey: stringFlag(flags, "api-key"),
        rename: stringFlag(flags, "rename"),
      },
    );
  },
  help: HELP.status,
};
