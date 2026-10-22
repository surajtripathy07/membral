// `membral setup --copilot`: wire GitHub Copilot Chat (VS Code agent mode) to
// the Membral MCP server for the current repo. The mcp.json is committable, so
// it never holds the API key: VS Code prompts once via `inputs` and keeps the
// answer in its secret storage.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RECALL_VS_STATE_FULL } from "@membral/core";
import { writeFileAtomic } from "./configure.js";

export type FileOutcome = "created" | "updated" | "unchanged" | "skipped";

export interface CopilotFileResult {
  path: string;
  outcome: FileOutcome;
  /** Set for "skipped": why, and the snippet to paste by hand. */
  message?: string;
}

export interface CopilotSetupResult {
  mcp: CopilotFileResult;
  instructions: CopilotFileResult;
}

const INPUT_ID = "membral-api-key";
const START = "<!-- membral:start -->";
const END = "<!-- membral:end -->";

/**
 * The rule text, shared with the user-level instructions file (copilot-user-instructions.ts): the one
 * recall-vs-state rule every agent surface states (@membral/core agent-guidance.ts).
 */
export const MEMBRAL_RULES = RECALL_VS_STATE_FULL;

const BLOCK = `${START}
${MEMBRAL_RULES}
${END}`;

function serverEntry(apiUrl: string) {
  return {
    type: "http",
    url: `${apiUrl.replace(/\/+$/, "")}/api/mcp`,
    headers: { Authorization: `Bearer \${input:${INPUT_ID}}` },
  };
}

const INPUT_ENTRY = {
  type: "promptString",
  id: INPUT_ID,
  description: "Membral API key (membral status shows where it lives)",
  password: true,
};

export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, content);
}

export async function writeMcpJson(repoRoot: string, apiUrl: string): Promise<CopilotFileResult> {
  const path = join(repoRoot, ".vscode", "mcp.json");
  const existing = await readIfExists(path);
  let config: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      const snippet = JSON.stringify({ servers: { membral: serverEntry(apiUrl) }, inputs: [INPUT_ENTRY] }, null, 2);
      return {
        path,
        outcome: "skipped",
        message: `${path} is not plain JSON (comments?), left untouched. Merge this by hand:\n${snippet}`,
      };
    }
    config = parsed as Record<string, unknown>;
  }

  const servers =
    typeof config.servers === "object" && config.servers !== null && !Array.isArray(config.servers)
      ? (config.servers as Record<string, unknown>)
      : {};
  servers.membral = serverEntry(apiUrl);
  config.servers = servers;

  const inputs = Array.isArray(config.inputs) ? (config.inputs as unknown[]) : [];
  const kept = inputs.filter((i) => !(typeof i === "object" && i !== null && (i as { id?: unknown }).id === INPUT_ID));
  const idx = inputs.findIndex((i) => typeof i === "object" && i !== null && (i as { id?: unknown }).id === INPUT_ID);
  // Keep the entry where the user had it; append when new.
  if (idx === -1) kept.push(INPUT_ENTRY);
  else kept.splice(Math.min(idx, kept.length), 0, INPUT_ENTRY);
  config.inputs = kept;

  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (existing === next) return { path, outcome: "unchanged" };
  await write(path, next);
  return { path, outcome: existing === undefined ? "created" : "updated" };
}

export async function writeInstructions(repoRoot: string): Promise<CopilotFileResult> {
  const path = join(repoRoot, ".github", "copilot-instructions.md");
  const existing = await readIfExists(path);
  let next: string;
  if (existing === undefined || existing.trim() === "") {
    next = `${BLOCK}\n`;
  } else {
    const s = existing.indexOf(START);
    const e = s === -1 ? -1 : existing.indexOf(END, s);
    if (s !== -1 && e === -1) {
      return {
        path,
        outcome: "skipped",
        message: `${path} has a "${START}" marker with no "${END}" after it, left untouched. Fix or remove the stray marker, then re-run.`,
      };
    }
    if (s !== -1 && e !== -1) {
      next = existing.slice(0, s) + BLOCK + existing.slice(e + END.length);
    } else {
      next = `${existing.replace(/\n*$/, "")}\n\n${BLOCK}\n`;
    }
  }
  if (existing === next) return { path, outcome: "unchanged" };
  await write(path, next);
  return { path, outcome: existing === undefined ? "created" : "updated" };
}

export async function setupCopilotVscode(opts: { repoRoot: string; apiUrl: string }): Promise<CopilotSetupResult> {
  return {
    mcp: await writeMcpJson(opts.repoRoot, opts.apiUrl),
    instructions: await writeInstructions(opts.repoRoot),
  };
}
