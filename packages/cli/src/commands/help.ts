import {
  ALL_COMMANDS_HELP,
  HELP,
  HIDDEN_COMMANDS,
  type HiddenCommand,
  PUBLIC_COMMANDS,
  type PublicCommand,
  TOP_LEVEL_HELP,
} from "../help.js";
import type { Command } from "./types.js";

// Same KNOWN set index.ts builds for the unknown-command guard — recomputed
// here (rather than imported from commands/index.ts) to avoid a cycle
// between this module and the registry that assembles it.
const KNOWN = new Set<string>([...PUBLIC_COMMANDS, ...HIDDEN_COMMANDS, "help"]);

export const helpCommand: Command = {
  name: "help",
  run(rest) {
    const sub = rest[0];
    if (sub === "--all") {
      console.log(ALL_COMMANDS_HELP);
      process.exit(0);
    }
    if (sub && KNOWN.has(sub) && sub !== "help") {
      console.log(HELP[sub as PublicCommand | HiddenCommand]);
      process.exit(0);
    }
    console.log(TOP_LEVEL_HELP);
    process.exit(0);
  },
  help: HELP.help,
};
