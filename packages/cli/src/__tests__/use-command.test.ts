// `membral use` — switches the active profile and re-points MCP. The
// `claude` CLI is mocked at node:child_process; opencode config lives in a
// temp dir. Nothing touches the real HOME.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: (...a: unknown[]) => execFileMock(...a) };
});

import { loadCredentials, saveCredentials } from "../credentials.js";
import { useCommand } from "../use-command.js";

const base = { email: "a@b.com", userId: "u1", createdAt: "now" };

describe("useCommand", () => {
  let dir: string;
  let credentialsPath: string;
  let opencodeConfigDir: string;
  let logs: string[];
  let originalHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-use-"));
    credentialsPath = join(dir, "credentials.json");
    opencodeConfigDir = join(dir, "opencode");
    saveCredentials({ ...base, apiUrl: "https://membral.me", apiKey: "lls_prod" }, credentialsPath);
    saveCredentials({ ...base, apiUrl: "http://localhost:3000", apiKey: "lls_local" }, credentialsPath);
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null));
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    delete process.env.MEMBRAL_API_URL;
    delete process.env.MEMBRAL_API_KEY;
    // Never the real ~/.claude/settings.json: defaultSettingsPath() reads HOME live.
    originalHome = process.env.HOME;
    process.env.HOME = dir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("lists profiles and marks the active one", async () => {
    await useCommand(undefined, { credentialsPath });
    expect(logs.some((l) => /^\* local\s+http:\/\/localhost:3000/.test(l))).toBe(true);
    expect(logs.some((l) => /^ {2}prod\s+https:\/\/membral\.me/.test(l))).toBe(true);
  });

  it("switches profile, then removes + re-adds Claude Code MCP and writes opencode MCP", async () => {
    await useCommand("prod", { credentialsPath, opencodeConfigDir, detectOpencodeFn: () => true });

    expect(loadCredentials(credentialsPath)?.apiUrl).toBe("https://membral.me");
    const calls = execFileMock.mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(" "));
    expect(calls[0]).toBe("claude mcp remove membral --scope user");
    expect(calls[1]).toContain("claude mcp add-json membral");
    expect(calls[1]).toContain('"url":"https://membral.me/api/mcp"');
    expect(calls[1]).toContain('"Authorization":"Bearer lls_prod"');
    expect(calls[1]).toContain('"alwaysLoad":true');

    const oc = JSON.parse(readFileSync(join(opencodeConfigDir, "opencode.json"), "utf8"));
    expect(oc.mcp.membral).toEqual({
      type: "remote",
      url: "https://membral.me/api/mcp",
      headers: { Authorization: "Bearer lls_prod" },
      enabled: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("tolerates a missing `claude` binary", async () => {
    execFileMock.mockImplementation((_c: string, _a: string[], cb: (err: Error | null) => void) =>
      cb(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })),
    );
    await useCommand("prod", { credentialsPath, opencodeConfigDir, detectOpencodeFn: () => false });
    expect(loadCredentials(credentialsPath)?.apiUrl).toBe("https://membral.me");
    expect(logs.some((l) => l.includes("claude not on PATH"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("unknown profile: exits 1 with a login hint and changes nothing", async () => {
    await useCommand("staging", { credentialsPath, opencodeConfigDir });
    expect(process.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("membral login --api-url"))).toBe(true);
    expect(loadCredentials(credentialsPath)?.apiUrl).toBe("http://localhost:3000");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("refreshes Claude Code hooks: a legacy entry with --api-url is migrated and the output says so", async () => {
    const claudeDir = join(dir, "claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    const invocation = { argv: ["/usr/bin/node", "/opt/membral/dist/index.js"] };
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    '"/usr/bin/node" "/opt/membral/dist/index.js" session-end-hook --api-url "http://localhost:3000"',
                },
              ],
            },
          ],
        },
      }),
    );

    await useCommand("prod", {
      credentialsPath,
      opencodeConfigDir,
      detectOpencodeFn: () => false,
      settingsPath,
      cliInvocation: invocation,
    });

    const raw = readFileSync(settingsPath, "utf8");
    expect(raw).toContain("session-end-hook");
    expect(raw).not.toContain("--api-url");
    expect(JSON.parse(raw).hooks.SessionEnd).toHaveLength(1);
    expect(logs.some((l) => l.includes("Claude Code hooks: refreshed"))).toBe(true);
  });

  it("re-points existing Claude Desktop + Cursor entries and never creates an absent config", async () => {
    const desktopPath = join(dir, "claude_desktop_config.json");
    writeFileSync(
      desktopPath,
      JSON.stringify({
        mcpServers: {
          membral: {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              "https://membral.me/api/mcp",
              "--header",
              `Authorization:\${MEMBRAL_AUTH_HEADER}`,
            ],
            env: { MEMBRAL_AUTH_HEADER: "Bearer lls_prod" },
          },
        },
      }),
    );
    const cursorPath = join(dir, "no-cursor", "mcp.json");

    await useCommand("local", {
      credentialsPath,
      opencodeConfigDir,
      detectOpencodeFn: () => false,
      claudeDesktopConfigPath: desktopPath,
      cursorConfigPath: cursorPath,
    });

    const desktop = JSON.parse(readFileSync(desktopPath, "utf8"));
    expect(desktop.mcpServers.membral.args[2]).toBe("http://localhost:3000/api/mcp");
    expect(desktop.mcpServers.membral.env.MEMBRAL_AUTH_HEADER).toBe("Bearer lls_local");
    expect(readFileSync(`${desktopPath}.membral.bak`, "utf8")).toContain("https://membral.me/api/mcp");
    expect(
      logs.some((l) =>
        /Claude Desktop MCP: re-pointed to http:\/\/localhost:3000\/api\/mcp — restart Claude Desktop/.test(l),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("Cursor MCP: no config file — skipped"))).toBe(true);
    expect(() => readFileSync(cursorPath)).toThrow();
    expect(process.exitCode).toBeUndefined();
  });

  it("reports an already-matching Cursor entry and skips a Cursor config without a membral entry", async () => {
    const cursorPath = join(dir, "mcp.json");
    writeFileSync(
      cursorPath,
      JSON.stringify({
        mcpServers: {
          membral: { url: "http://localhost:3000/api/mcp", headers: { Authorization: "Bearer lls_local" } },
        },
      }),
    );
    const desktopPath = join(dir, "desktop.json");
    writeFileSync(desktopPath, JSON.stringify({ mcpServers: {} }));

    await useCommand("local", {
      credentialsPath,
      opencodeConfigDir,
      detectOpencodeFn: () => false,
      claudeDesktopConfigPath: desktopPath,
      cursorConfigPath: cursorPath,
    });

    expect(logs.some((l) => l.includes("Cursor MCP: already pointed at http://localhost:3000/api/mcp"))).toBe(true);
    expect(logs.some((l) => l.includes("Claude Desktop MCP: no Membral MCP entry — skipped"))).toBe(true);
    expect(JSON.parse(readFileSync(desktopPath, "utf8"))).toEqual({ mcpServers: {} });
  });
});
