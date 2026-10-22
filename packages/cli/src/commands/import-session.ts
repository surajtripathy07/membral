import { parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { importSession } from "../import-session.js";
import type { Command } from "./types.js";

export const importSessionCommand: Command = {
  name: "import-session",
  // NEVER exits non-zero — see import-session.ts. This runs from a Claude
  // Code hook and must not block or interrupt a session on failure.
  async run(rest) {
    const flags = parseFlags(rest);
    await importSession({
      transcript: stringFlag(flags, "transcript"),
      source: stringFlag(flags, "source"),
      apiUrl: stringFlag(flags, "api-url"),
      apiKey: stringFlag(flags, "api-key"),
    });
  },
  help: HELP["import-session"],
};
