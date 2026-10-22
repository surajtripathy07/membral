import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECALL_VS_STATE_FULL } from "@membral/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupCopilotVscode } from "../copilot-vscode.js";

const API = "https://example.test";
const KEY = "mbl_secret_key_123";
let root: string;
const mcpPath = () => join(root, ".vscode", "mcp.json");
const insPath = () => join(root, ".github", "copilot-instructions.md");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "copilot-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("setupCopilotVscode", () => {
  it("creates both files", async () => {
    const r = await setupCopilotVscode({ repoRoot: root, apiUrl: API });
    expect(r.mcp.outcome).toBe("created");
    expect(r.instructions.outcome).toBe("created");
    const cfg = JSON.parse(await readFile(mcpPath(), "utf-8"));
    expect(cfg.servers.membral).toEqual({
      type: "http",
      url: `${API}/api/mcp`,
      headers: { Authorization: `Bearer \${input:membral-api-key}` },
    });
    expect(cfg.inputs).toHaveLength(1);
    expect(cfg.inputs[0]).toMatchObject({ id: "membral-api-key", type: "promptString", password: true });
    const ins = await readFile(insPath(), "utf-8");
    expect(ins).toContain("<!-- membral:start -->");
    expect(ins).toContain(RECALL_VS_STATE_FULL);
  });

  it("merges into an existing mcp.json preserving other servers and inputs", async () => {
    await mkdir(join(root, ".vscode"));
    await writeFile(
      mcpPath(),
      JSON.stringify({
        servers: { other: { type: "stdio", command: "x" } },
        inputs: [{ type: "promptString", id: "other-key", description: "d" }],
      }),
    );
    await setupCopilotVscode({ repoRoot: root, apiUrl: API });
    const cfg = JSON.parse(await readFile(mcpPath(), "utf-8"));
    expect(cfg.servers.other).toEqual({ type: "stdio", command: "x" });
    expect(cfg.servers.membral.url).toBe(`${API}/api/mcp`);
    expect(cfg.inputs.map((i: { id: string }) => i.id).sort()).toEqual(["membral-api-key", "other-key"]);
  });

  it("is byte-identical on a second run", async () => {
    await setupCopilotVscode({ repoRoot: root, apiUrl: API });
    const a = [await readFile(mcpPath(), "utf-8"), await readFile(insPath(), "utf-8")];
    const r = await setupCopilotVscode({ repoRoot: root, apiUrl: API });
    expect(r.mcp.outcome).toBe("unchanged");
    expect(r.instructions.outcome).toBe("unchanged");
    expect([await readFile(mcpPath(), "utf-8"), await readFile(insPath(), "utf-8")]).toEqual(a);
  });

  it("never writes the API key", async () => {
    const prev = process.env.MEMBRAL_API_KEY;
    process.env.MEMBRAL_API_KEY = KEY;
    try {
      await setupCopilotVscode({ repoRoot: root, apiUrl: API });
    } finally {
      if (prev === undefined) delete process.env.MEMBRAL_API_KEY;
      else process.env.MEMBRAL_API_KEY = prev;
    }
    expect(await readFile(mcpPath(), "utf-8")).not.toContain(KEY);
    expect(await readFile(insPath(), "utf-8")).not.toContain(KEY);
  });

  it("keeps user content in instructions and updates the block in place", async () => {
    await mkdir(join(root, ".github"));
    await writeFile(
      insPath(),
      "# Mine\nuse tabs\n\n<!-- membral:start -->\nstale rule text\n<!-- membral:end -->\n\ntrailing rule\n",
    );
    const r = await setupCopilotVscode({ repoRoot: root, apiUrl: API });
    expect(r.instructions.outcome).toBe("updated");
    const ins = await readFile(insPath(), "utf-8");
    expect(ins.startsWith("# Mine\nuse tabs\n\n<!-- membral:start -->")).toBe(true);
    expect(ins).not.toContain("stale rule text");
    expect(ins).toContain(RECALL_VS_STATE_FULL);
    expect(ins.endsWith("<!-- membral:end -->\n\ntrailing rule\n")).toBe(true);
    expect(ins.match(/membral:start/g)).toHaveLength(1);
  });

  it("appends the block when absent", async () => {
    await mkdir(join(root, ".github"));
    await writeFile(insPath(), "# Mine\n");
    await setupCopilotVscode({ repoRoot: root, apiUrl: API });
    const ins = await readFile(insPath(), "utf-8");
    expect(ins.startsWith("# Mine\n\n<!-- membral:start -->")).toBe(true);
  });

  it("leaves invalid JSONC mcp.json untouched", async () => {
    await mkdir(join(root, ".vscode"));
    const jsonc = '{\n  // my servers\n  "servers": {}\n}\n';
    await writeFile(mcpPath(), jsonc);
    const r = await setupCopilotVscode({ repoRoot: root, apiUrl: API });
    expect(r.mcp.outcome).toBe("skipped");
    expect(r.mcp.message).toContain("membral-api-key");
    expect(await readFile(mcpPath(), "utf-8")).toBe(jsonc);
    expect(r.instructions.outcome).toBe("created");
  });

  it("leaves instructions untouched when the start marker has no end marker", async () => {
    await mkdir(join(root, ".github"));
    const stray = "# Mine\n\n<!-- membral:start -->\nhalf-edited\n";
    await writeFile(insPath(), stray);
    const r = await setupCopilotVscode({ repoRoot: root, apiUrl: API });
    expect(r.instructions.outcome).toBe("skipped");
    expect(r.instructions.message).toMatch(/marker/);
    expect(await readFile(insPath(), "utf-8")).toBe(stray);
  });
});
