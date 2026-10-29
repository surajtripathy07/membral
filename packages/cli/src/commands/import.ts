import { parseFlags, stringFlag } from "../args.js";
import { claudeMemImportCommand } from "../claude-mem-import.js";
import { HELP } from "../help.js";
import { importCommand as runImportCommand } from "../import-command.js";
import type { Command } from "./types.js";

export const importCommand: Command = {
  name: "import",
  async run(rest) {
    const flags = parseFlags(rest);
    // `membral import claude-mem` is a subcommand; anything else is the chat-export file.
    if (rest[0] === "claude-mem") {
      await claudeMemImportCommand({
        db: stringFlag(flags, "db"),
        apiUrl: stringFlag(flags, "api-url"),
        apiKey: stringFlag(flags, "api-key"),
      });
      return;
    }
    const file = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    await runImportCommand({
      file,
      apiUrl: stringFlag(flags, "api-url"),
      apiKey: stringFlag(flags, "api-key"),
    });
  },
  help: HELP.import,
};
