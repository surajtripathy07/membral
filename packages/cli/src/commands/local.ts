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
    // `membral local up --help` must print usage, not start the preflight (index.ts only catches rest[0]).
    if (sub && flags.help === true) {
      console.log(HELP.local);
      return;
    }
    const project = stringFlag(flags, "project");
    switch (sub) {
      case "up":
        await localUp({
          port: stringFlag(flags, "port"),
          gatewayPort: stringFlag(flags, "gateway-port"),
          image: stringFlag(flags, "image"),
          email: stringFlag(flags, "email"),
          yes: boolFlag(flags, "yes"),
          embeddings: flags.embeddings === true ? "" : stringFlag(flags, "embeddings"),
          embeddingModel: stringFlag(flags, "embedding-model"),
          noSweep: boolFlag(flags, "no-sweep"),
          project,
        });
        return;
      case "down":
        await localDown({
          wipe: boolFlag(flags, "wipe") || boolFlag(flags, "purge"),
          yes: boolFlag(flags, "yes"),
          project,
        });
        return;
      case "status":
        await localStatus({ showPassword: boolFlag(flags, "show-password"), project });
        return;
      case "logs":
        await localLogs({
          service: args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--project"),
          project,
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
