import { parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { loginCommand as runLoginCommand } from "../login-command.js";
import type { Command } from "./types.js";

export const loginCommand: Command = {
  name: "login",
  async run(rest) {
    const flags = parseFlags(rest);
    await runLoginCommand({ apiUrl: stringFlag(flags, "api-url") });
  },
  help: HELP.login,
};
