import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copilotMcpConfigPath, installCopilotCliMcp } from "../copilot-cli-mcp.js";

const KEY = "mbl_secretkey1234567890";
const URL_ = "https://membral.example";
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "copilot-mcp-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});
const run = (extra: { dryRun?: boolean } = {}) =>
  installCopilotCliMcp({ apiUrl: URL_, apiKey: KEY, copilotHome: home, ...extra });
const read = async () => JSON.parse(await readFile(copilotMcpConfigPath(home), "utf-8"));

describe("installCopilotCliMcp", () => {
  it("creates the file with the membral http entry", async () => {
    expect((await run()).outcome).toBe("created");
    expect(await read()).toEqual({
      mcpServers: {
        membral: {
          type: "http",
          url: `${URL_}/api/mcp`,
          headers: { Authorization: `Bearer ${KEY}` },
          tools: ["*"],
        },
      },
    });
  });

  it("merges beside other servers and top-level keys", async () => {
    await writeFile(
      copilotMcpConfigPath(home),
      JSON.stringify({ theme: "x", mcpServers: { other: { type: "local", command: "foo" }, membral: { old: 1 } } }),
    );
    expect((await run()).outcome).toBe("updated");
    const c = await read();
    expect(c.theme).toBe("x");
    expect(c.mcpServers.other).toEqual({ type: "local", command: "foo" });
    expect(c.mcpServers.membral.url).toBe(`${URL_}/api/mcp`);
  });

  it("is unchanged and byte-identical on rerun", async () => {
    await run();
    const a = await readFile(copilotMcpConfigPath(home), "utf-8");
    expect((await run()).outcome).toBe("unchanged");
    expect(await readFile(copilotMcpConfigPath(home), "utf-8")).toBe(a);
  });

  it("leaves invalid JSON untouched and prints a masked manual command", async () => {
    const p = copilotMcpConfigPath(home);
    await writeFile(p, "{ not json");
    const res = await run();
    expect(res.outcome).toBe("invalid-json");
    expect(await readFile(p, "utf-8")).toBe("{ not json");
    expect(res.manualCommand).toContain("copilot mcp add --transport http");
    expect(res.manualCommand).not.toContain(KEY);
  });

  it("writes mode 0600", async () => {
    await run();
    expect((await stat(copilotMcpConfigPath(home))).mode & 0o777).toBe(0o600);
  });

  it("dry-run writes nothing", async () => {
    expect((await run({ dryRun: true })).outcome).toBe("would-write");
    await expect(stat(copilotMcpConfigPath(home))).rejects.toThrow();
  });

  it("never prints the key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await run();
    await writeFile(copilotMcpConfigPath(home), "nope");
    await run();
    const printed = [...log.mock.calls, ...out.mock.calls].flat().join(" ");
    expect(printed).not.toContain(KEY);
  });
});
