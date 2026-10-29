import { boolFlag, parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { statusCommand as runStatusCommand } from "../status-command.js";
import { statusCommand as embeddedServerStatus, serverPidFileExists } from "../up-command.js";
import type { Command } from "./types.js";

export const statusCommand: Command = {
  name: "status",
  async run(rest) {
    const flags = parseFlags(rest);
    // `--server`, or a `membral up` server on this machine: its state comes first.
    if (boolFlag(flags, "server")) {
      await embeddedServerStatus();
      return;
    }
    if (serverPidFileExists()) {
      const code = process.exitCode;
      await embeddedServerStatus();
      process.exitCode = code; // a stopped server must not fail the account status
      console.log("");
    }
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
