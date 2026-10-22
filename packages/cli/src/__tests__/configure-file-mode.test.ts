// M3 (adversarial round 1 on #136): configure.test.ts mocks node:fs/promises
// wholesale for the whole file (needed for its many read-merge-write
// scenarios), so it can only assert the MODE ARGUMENT passed to the mocked
// writeFile — not that the mode actually lands on disk. This file uses the
// REAL node:fs/promises (nothing mocked) against a real scratch temp
// directory to verify the on-disk file actually ends up at 0600, the same
// way agent-install.test.ts's own real-filesystem describe block verifies
// the plist.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureMCPServer } from "../configure.js";

describe("configureMCPServer — writes the MCP config file at mode 0600 on the real filesystem (M3)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "membral-configure-mode-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a fresh Claude Desktop config at 0600", async () => {
    const configPath = join(dir, "claude_desktop_config.json");
    const result = await configureMCPServer("claude-desktop", configPath, { apiKey: "lls_super_secret" });
    expect(result.success).toBe(true);

    const mode = (await stat(configPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writes a fresh Cursor config at 0600", async () => {
    const configPath = join(dir, "mcp.json");
    const result = await configureMCPServer("cursor", configPath, { apiKey: "lls_super_secret" });
    expect(result.success).toBe(true);

    const mode = (await stat(configPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("chmods an EXISTING config back to 0600 on rewrite, even if it was left world-readable", async () => {
    const { writeFile, chmod } = await import("node:fs/promises");
    const configPath = join(dir, "claude_desktop_config.json");
    await writeFile(configPath, "{}", { mode: 0o644 });
    await chmod(configPath, 0o644); // belt and suspenders — some platforms ignore writeFile's mode on an existing file

    const result = await configureMCPServer("claude-desktop", configPath, { apiKey: "lls_super_secret" });
    expect(result.success).toBe(true);

    const mode = (await stat(configPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-pointing an existing entry leaves a 0600 .membral.bak holding the previous content", async () => {
    const { writeFile, readFile, chmod } = await import("node:fs/promises");
    const configPath = join(dir, "mcp.json");
    const original = JSON.stringify({
      mcpServers: { membral: { url: "https://membral.me/api/mcp", headers: { Authorization: "Bearer lls_old" } } },
    });
    await writeFile(configPath, original, { mode: 0o644 });
    await chmod(configPath, 0o644);

    const result = await configureMCPServer("cursor", configPath, {
      apiUrl: "http://localhost:3000",
      apiKey: "lls_new",
    });
    expect(result.repointed).toBe(true);

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${configPath}.membral.bak`)).mode & 0o777).toBe(0o600);
    expect(await readFile(`${configPath}.membral.bak`, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(configPath, "utf8")).mcpServers.membral.url).toBe("http://localhost:3000/api/mcp");
  });
});
