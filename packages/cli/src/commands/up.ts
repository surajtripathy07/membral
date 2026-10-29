import { boolFlag, parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { downCommand, logsCommand, upCommand } from "../up-command.js";
import type { Command } from "./types.js";

export const upCmd: Command = {
  name: "up",
  async run(rest) {
    const flags = parseFlags(rest);
    await upCommand({
      port: stringFlag(flags, "port"),
      serverDir: stringFlag(flags, "server-dir"),
      foreground: boolFlag(flags, "foreground"),
      yes: boolFlag(flags, "yes"),
      noSweep: boolFlag(flags, "no-sweep"),
      email: stringFlag(flags, "email"),
    });
  },
  help: HELP.up,
};

export const downCmd: Command = {
  name: "down",
  async run(rest) {
    const flags = parseFlags(rest);
    await downCommand({ wipe: boolFlag(flags, "wipe"), yes: boolFlag(flags, "yes") });
  },
  help: HELP.down,
};

export const logsCmd: Command = {
  name: "logs",
  async run(rest) {
    await logsCommand({ follow: rest.includes("-f") || rest.includes("--follow") });
  },
  help: HELP.logs,
};
