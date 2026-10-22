import { parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { installSessionHook } from "../install-session-hook.js";
import type { Command } from "./types.js";

export const installSessionHookCommand: Command = {
  name: "install-session-hook",
  async run(rest) {
    const flags = parseFlags(rest);
    await installSessionHook({
      apiUrl: stringFlag(flags, "api-url"),
      settings: stringFlag(flags, "settings"),
      remove: flags.remove === true,
    });
  },
  help: HELP["install-session-hook"],
};
