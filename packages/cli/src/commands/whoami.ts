import { parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { whoamiCommand as runWhoamiCommand } from "../login-command.js";
import type { Command } from "./types.js";

export const whoamiCommand: Command = {
  name: "whoami",
  async run(rest) {
    const flags = parseFlags(rest);
    await runWhoamiCommand({ apiUrl: stringFlag(flags, "api-url"), apiKey: stringFlag(flags, "api-key") });
  },
  help: HELP.whoami,
};
