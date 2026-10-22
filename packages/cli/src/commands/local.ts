import { boolFlag, parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { localDown, localLogs, localStatus, localUp } from "../local-command.js";
import type { Command } from "./types.js";

export const localCommand: Command = {
  name: "local",
  async run(rest) {
    const sub = rest[0];
    const args = rest.slice(1);
    const flags = parseFlags(args);
    switch (sub) {
      case "up":
        await localUp({
          port: stringFlag(flags, "port"),
          gatewayPort: stringFlag(flags, "gateway-port"),
          image: stringFlag(flags, "image"),
          email: stringFlag(flags, "email"),
          yes: boolFlag(flags, "yes"),
          noSweep: boolFlag(flags, "no-sweep"),
        });
        return;
      case "down":
        await localDown({ wipe: boolFlag(flags, "wipe") || boolFlag(flags, "purge"), yes: boolFlag(flags, "yes") });
        return;
      case "status":
        await localStatus({ showPassword: boolFlag(flags, "show-password") });
        return;
      case "logs":
        await localLogs({
          service: args.find((a) => !a.startsWith("-")),
          follow: args.includes("-f") || args.includes("--follow"),
        });
        return;
      default:
        if (sub) console.error(`Unknown subcommand: membral local ${sub}`);
        console.log(HELP.local);
        if (sub) process.exitCode = 1;
    }
  },
  help: HELP.local,
};
