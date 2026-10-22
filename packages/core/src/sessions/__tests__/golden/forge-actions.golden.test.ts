// Step 0.2 (behaviour lock, D-059/D-051, G0 goal §0.2): golden test over the
// forge-action assigner (`deriveToolActions`, `assignActions`,
// `settleActionDir`, `parseSlashCommandMessage`, `actionFromPastedText`).
// forge-actions.test.ts has no file-based fixtures of its own (every case is
// built inline in TS) — see fixtures/forge-command-table.json's own comment
// for why this golden test carries its own small, committed command table
// instead, modelled on the same input shapes that file's tests use.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ActionDirVerdict,
  actionFromPastedText,
  assignActions,
  deriveToolActions,
  type ForgeAction,
  parseSlashCommandMessage,
  settleActionDir,
} from "../../forge-actions.js";
import { golden } from "./serialize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface BashCase {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
  cwd?: string;
}
interface McpCase {
  id: string;
  toolName: string;
  mcpTool: string;
  input: Record<string, unknown>;
  result: string;
}
interface TextCase {
  id: string;
  text: string;
}
interface CommandTable {
  bash: BashCase[];
  mcp: McpCase[];
  slash: TextCase[];
  paste: TextCase[];
  settleActionDirVerdicts: ActionDirVerdict[];
}

const TABLE: CommandTable = JSON.parse(readFileSync(join(__dirname, "fixtures", "forge-command-table.json"), "utf8"));

describe("golden: deriveToolActions over the committed forge command table (bash + mcp)", () => {
  it("matches the committed snapshot", async () => {
    const results: Record<string, { actions: ForgeAction[]; primaryOnTurn: unknown }> = {};

    for (const c of TABLE.bash) {
      const actions = deriveToolActions({
        toolName: c.toolName,
        input: c.input,
        result: c.result,
        isError: c.isError,
        cwd: c.cwd,
      });
      const turn: { action?: ForgeAction; actions?: ForgeAction[] } = {};
      assignActions(turn, actions);
      results[c.id] = { actions, primaryOnTurn: turn };
    }
    for (const c of TABLE.mcp) {
      const actions = deriveToolActions({ toolName: c.toolName, mcpTool: c.mcpTool, input: c.input, result: c.result });
      const turn: { action?: ForgeAction; actions?: ForgeAction[] } = {};
      assignActions(turn, actions);
      results[c.id] = { actions, primaryOnTurn: turn };
    }

    await expect(golden(results)).toMatchFileSnapshot("./__snapshots__/forge-actions.command-table.json");
  });
});

describe("golden: parseSlashCommandMessage / actionFromPastedText over the committed table", () => {
  it("matches the committed snapshot", async () => {
    const results: Record<string, unknown> = {};
    for (const c of TABLE.slash) {
      results[c.id] = parseSlashCommandMessage(c.text);
    }
    for (const c of TABLE.paste) {
      results[c.id] = actionFromPastedText(c.text) ?? null;
    }
    await expect(golden(results)).toMatchFileSnapshot("./__snapshots__/forge-actions.text-entrypoints.json");
  });
});

describe("golden: settleActionDir over every derived action that carries a `dir`, crossed with every verdict kind", () => {
  it("matches the committed snapshot", async () => {
    const results: Record<string, Record<string, ForgeAction>> = {};

    for (const c of TABLE.bash) {
      const actions = deriveToolActions({
        toolName: c.toolName,
        input: c.input,
        result: c.result,
        isError: c.isError,
        cwd: c.cwd,
      });
      const primary = actions[0];
      if (!primary || primary.dir === undefined) continue; // only actions with a `dir` exercise settleActionDir
      const byVerdict: Record<string, ForgeAction> = {};
      for (const verdict of TABLE.settleActionDirVerdicts) {
        byVerdict[verdict.kind] = settleActionDir(primary, verdict);
      }
      results[c.id] = byVerdict;
    }

    await expect(golden(results)).toMatchFileSnapshot("./__snapshots__/forge-actions.settle-action-dir.json");
  });
});
