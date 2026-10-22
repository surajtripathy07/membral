import { HELP } from "../help.js";
import { logoutCommand as runLogoutCommand } from "../login-command.js";
import type { Command } from "./types.js";

export const logoutCommand: Command = {
  name: "logout",
  async run() {
    await runLogoutCommand();
  },
  help: HELP.logout,
};
