// The harness registry: every code-agent harness Membral can import, keyed by
// the harness id that becomes `code_sessions.source`. The CLI's import
// commands look parsers up here instead of keeping their own tables.
//
// Data only. Key order is the default import order (`membral sessions` and
// `membral setup` walk `Object.keys(PARSERS)`), so `claude-code` stays first.
import { agyParser } from "./agy.js";
import { claudeCodeParser } from "./claude-code.js";
import { codexParser } from "./codex.js";
import { copilotCliParser } from "./copilot-cli.js";
import { opencodeParser } from "./opencode.js";
import type { CodeSessionParser } from "./types.js";

/** The harness ids in registry order. */
export const HARNESS_IDS = ["claude-code", "opencode", "copilot-cli", "codex", "agy"] as const;

/** A harness id with a parser in {@link PARSERS}. */
export type ImportableHarnessId = (typeof HARNESS_IDS)[number];

export const PARSERS: Readonly<Record<ImportableHarnessId, CodeSessionParser>> = {
  "claude-code": claudeCodeParser,
  opencode: opencodeParser,
  "copilot-cli": copilotCliParser,
  codex: codexParser,
  agy: agyParser,
};
