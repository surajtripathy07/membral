// Plain `membral setup`: one user-level Copilot instructions file so Copilot
// in every VS Code workspace knows Membral. ~/.copilot/instructions is a
// default user instructions location (chat.instructionsFilesLocations);
// `applyTo: "**"` applies it to every request. Membral owns the file whole.
// MCP for both Copilot CLI and VS Code is ~/.copilot/mcp-config.json
// (copilot-cli-mcp.ts); the repo-committed pair stays behind `--copilot`.

import { homedir } from "node:os";
import { join } from "node:path";
import { type CopilotFileResult, MEMBRAL_RULES, readIfExists, write } from "./copilot-vscode.js";

export const INSTRUCTIONS_CONTENT = `---
applyTo: "**"
---
${MEMBRAL_RULES}
`;

export function userInstructionsPath(home: string = homedir()): string {
  return join(home, ".copilot", "instructions", "membral.instructions.md");
}

export async function writeUserInstructions(home: string = homedir()): Promise<CopilotFileResult> {
  const path = userInstructionsPath(home);
  const existing = await readIfExists(path);
  if (existing === INSTRUCTIONS_CONTENT) return { path, outcome: "unchanged" };
  await write(path, INSTRUCTIONS_CONTENT);
  return { path, outcome: existing === undefined ? "created" : "updated" };
}
