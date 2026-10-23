import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  chmod: vi.fn(),
  // writeFileAtomic: lstat/stat fail (no symlink, no existing mode), rename succeeds.
  lstat: vi.fn(async () => {
    throw new Error("ENOENT");
  }),
  stat: vi.fn(async () => {
    throw new Error("ENOENT");
  }),
  realpath: vi.fn(async (p: string) => p),
  rename: vi.fn(async () => undefined),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const { configureMCPServer, resolveCliInvocation } = await import("../configure.js");

// node:os is mocked above (homedir only) for the whole file, so
// node:os's real tmpdir() isn't reachable here — TMPDIR is how macOS
// exposes the same per-process temp dir; falls back to /tmp (Linux CI).
function realTmpdir(): string {
  return process.env.TMPDIR?.replace(/\/+$/, "") || "/tmp";
}

/** Writes go through writeFileAtomic (tmp + rename): strip the tmp suffix, split the backup from the real write. */
function writesOf(mock: ReturnType<typeof vi.fn>): { path: string; content: string; options: unknown }[] {
  return mock.mock.calls.map((c) => ({
    path: String(c[0]).replace(/\.tmp-\d+-\d+$/, ""),
    content: c[1] as string,
    options: c[2],
  }));
}

describe("configureMCPServer", () => {
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockWriteFile: ReturnType<typeof vi.fn>;
  let mockMkdir: ReturnType<typeof vi.fn>;
  let mockChmod: ReturnType<typeof vi.fn>;
  let mockExecFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const fs = await import("node:fs/promises");
    const cp = await import("node:child_process");
    mockReadFile = vi.mocked(fs.readFile);
    mockWriteFile = vi.mocked(fs.writeFile);
    mockMkdir = vi.mocked(fs.mkdir);
    mockChmod = vi.mocked(fs.chmod);
    mockExecFile = vi.mocked(cp.execFile);
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockChmod.mockReset();
    mockExecFile.mockReset();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    delete process.env.MEMBRAL_API_URL;
    delete process.env.MEMBRAL_API_KEY;
  });

  function mainWrite(): [string, string, unknown] {
    const w = writesOf(mockWriteFile).find((x) => !x.path.endsWith(".membral.bak"));
    if (!w) throw new Error("no config write");
    return [w.path, w.content, w.options];
  }

  // --- claude-desktop: mcp-remote bridge, key inlined in "env" -------------

  describe("claude-desktop", () => {
    it("emits a command+args+env entry — never a bare url-shape entry (destructive-shape regression)", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
        apiKey: "lls_test-123",
      });

      expect(result.success).toBe(true);
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      const entry = config.mcpServers.membral;

      // The destructive regression this pins against: Claude Desktop's
      // config schema doesn't recognize a bare `{ url, headers }` entry and
      // silently drops the entire mcpServers key when it sees one.
      expect(entry.url).toBeUndefined();
      expect(entry).toEqual({
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          "http://localhost:3000/api/mcp",
          "--header",
          `Authorization:\${MEMBRAL_AUTH_HEADER}`,
        ],
        env: { MEMBRAL_AUTH_HEADER: "Bearer lls_test-123" },
      });
    });

    // M3 (adversarial round 1 on #136): this file carries a raw API key
    // (see buildMcpRemoteEntry's doc comment for why it's inlined at all) —
    // it must write 0600, same as ~/.membral/credentials.json, and
    // best-effort chmod an existing file back to 0600 on rewrite.
    it("M3: writes the config file at mode 0600 and chmods it", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", { apiKey: "lls_test-123" });

      const [, , options] = mainWrite() as [string, string, { mode?: number }];
      expect(options.mode).toBe(0o600);
      expect(mockChmod).toHaveBeenCalledWith(
        expect.stringMatching(/^\/mock\/claude_desktop_config\.json\.tmp-/),
        0o600,
      );
    });

    it("writes a placeholder + warning when no API key is available", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json");

      expect(result.success).toBe(true);
      expect(result.message).toContain("placeholder");
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.membral.env.MEMBRAL_AUTH_HEADER).toBe("Bearer YOUR_API_KEY");
    });

    it("is a no-op when a genuine current-shape entry already exists", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            membral: {
              command: "npx",
              args: ["-y", "mcp-remote", "https://membral.me/api/mcp", "--header", "x"],
              env: { MEMBRAL_AUTH_HEADER: "Bearer lls_existing" },
            },
          },
        }),
      );

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json");

      expect(result.success).toBe(true);
      expect(result.message).toBe("MCP server already configured");
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("replaces a previously-written placeholder-key entry once a real key is available (no dead end)", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            membral: {
              command: "npx",
              args: ["-y", "mcp-remote", "https://membral.me/api/mcp", "--header", "x"],
              env: { MEMBRAL_AUTH_HEADER: "Bearer YOUR_API_KEY" },
            },
          },
        }),
      );

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
        apiKey: "lls_real-key",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Replaced placeholder");
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.membral.env.MEMBRAL_AUTH_HEADER).toBe("Bearer lls_real-key");
    });

    it("replaces an old bare url-shape entry (destructive shape pasted from the pre-fix README/dashboard)", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            membral: { url: "https://membral.me/api/mcp", headers: { Authorization: "Bearer lls_old" } },
          },
        }),
      );

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
        apiKey: "lls_test-123",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Replaced");
      expect(result.message).toContain("destructive shape");
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.membral.command).toBe("npx");
      expect(config.mcpServers.membral.url).toBeUndefined();
    });

    it("rewrites (migrates) a legacy pre-#40 stdio @membral/mcp entry instead of leaving it dangling", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: { membral: { command: "npx", args: ["-y", "@membral/mcp"] } },
        }),
      );

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
        apiKey: "lls_test-123",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Migrated");
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.membral.command).toBe("npx");
      expect(config.mcpServers.membral.args).toContain("mcp-remote");
    });

    it("preserves other mcpServers entries and top-level keys", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: { other: { command: "npx", args: ["-y", "other-server"] } },
          someOtherSetting: true,
        }),
      );

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
        apiKey: "lls_test-123",
      });

      expect(result.success).toBe(true);
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.other).toEqual({ command: "npx", args: ["-y", "other-server"] });
      expect(config.someOtherSetting).toBe(true);
    });

    it("respects a custom apiUrl, stripping trailing slashes", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
        apiUrl: "http://localhost:3000/",
        apiKey: "lls_test-123",
      });

      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.membral.args).toContain("http://localhost:3000/api/mcp");
    });

    it("returns success: false when the write fails", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      mockWriteFile.mockRejectedValue(new Error("EACCES: permission denied"));

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json");

      expect(result.success).toBe(false);
      expect(result.message).toContain("EACCES");
    });

    // Issue #136 req 1: configureMCPServer used to have its OWN private
    // resolver with NO credentials.json fallback at all (opts.apiKey ??
    // process.env.MEMBRAL_API_KEY, nothing else) — a machine that had only
    // ever run `membral setup` (never manually exported MEMBRAL_API_KEY)
    // got a placeholder key written into its MCP config even with a real
    // key sitting in credentials.json. It now goes through the same shared
    // resolveApiKey/resolveApiUrl every other command uses.
    it("falls back to ~/.membral/credentials.json when no flag/env key is set (shared resolver, issue #136)", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const { saveCredentials } = await import("../credentials.js");
      const credsDir = mkdtempSync(join(realTmpdir(), "membral-configure-creds-"));
      const credentialsPath = join(credsDir, "credentials.json");
      saveCredentials(
        { apiUrl: "https://membral.me", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        credentialsPath,
      );

      try {
        const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
          credentialsPath,
        });

        expect(result.success).toBe(true);
        expect(result.message).not.toContain("placeholder");
        const [, written] = mainWrite();
        const config = JSON.parse(written);
        expect(config.mcpServers.membral.env.MEMBRAL_AUTH_HEADER).toBe("Bearer lls_from_creds");
      } finally {
        rmSync(credsDir, { recursive: true, force: true });
      }
    });

    it("still prefers an explicit MEMBRAL_API_KEY env var over credentials.json (unvalidated precedence, issue #136)", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const { saveCredentials } = await import("../credentials.js");
      const credsDir = mkdtempSync(join(realTmpdir(), "membral-configure-creds-"));
      const credentialsPath = join(credsDir, "credentials.json");
      saveCredentials(
        { apiUrl: "https://membral.me", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        credentialsPath,
      );
      process.env.MEMBRAL_API_KEY = "lls_from_env";

      try {
        const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
          credentialsPath,
        });

        expect(result.success).toBe(true);
        const [, written] = mainWrite();
        const config = JSON.parse(written);
        expect(config.mcpServers.membral.env.MEMBRAL_AUTH_HEADER).toBe("Bearer lls_from_env");
      } finally {
        rmSync(credsDir, { recursive: true, force: true });
      }
    });
  });

  // --- cursor: url+headers, key inlined ------------------------------------

  describe("cursor", () => {
    it("emits a url+headers entry with the key inline", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      const result = await configureMCPServer("cursor", "/mock/.cursor/mcp.json", { apiKey: "lls_test-123" });

      expect(result.success).toBe(true);
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.membral).toEqual({
        url: "http://localhost:3000/api/mcp",
        headers: { Authorization: "Bearer lls_test-123" },
      });
    });

    it("writes to a path ending mcp.json", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      await configureMCPServer("cursor", "/mock-home/.cursor/mcp.json", { apiKey: "lls_test-123" });

      const [path] = mainWrite();
      expect(path.endsWith("mcp.json")).toBe(true);
    });

    it("migrates a legacy stdio entry", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ mcpServers: { membral: { command: "npx", args: ["-y", "@membral/mcp"] } } }),
      );

      const result = await configureMCPServer("cursor", "/mock/.cursor/mcp.json", { apiKey: "lls_test-123" });

      expect(result.message).toContain("Migrated");
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.membral.url).toBe("http://localhost:3000/api/mcp");
    });

    it("is a no-op when already configured with the current shape", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ mcpServers: { membral: { url: "https://membral.me/api/mcp", headers: {} } } }),
      );

      const result = await configureMCPServer("cursor", "/mock/.cursor/mcp.json");

      expect(result.message).toBe("MCP server already configured");
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("replaces a previously-written placeholder-key entry once a real key is available", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            membral: { url: "https://membral.me/api/mcp", headers: { Authorization: "Bearer YOUR_API_KEY" } },
          },
        }),
      );

      const result = await configureMCPServer("cursor", "/mock/.cursor/mcp.json", { apiKey: "lls_real-key" });

      expect(result.message).toContain("Replaced placeholder");
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.membral.headers.Authorization).toBe("Bearer lls_real-key");
    });
  });

  // --- re-point: an existing entry on another server/key is rewritten -----

  describe("re-point (desktop + cursor)", () => {
    const desktopEntry = (url: string, key: string) => ({
      command: "npx",
      args: ["-y", "mcp-remote", url, "--header", `Authorization:\${MEMBRAL_AUTH_HEADER}`],
      env: { MEMBRAL_AUTH_HEADER: `Bearer ${key}` },
    });

    it("rewrites a Claude Desktop entry whose mcp-remote URL differs from the active server, backing it up at 0600", async () => {
      const original = JSON.stringify({
        mcpServers: { membral: desktopEntry("https://membral.me/api/mcp", "lls_prod"), other: { command: "x" } },
      });
      mockReadFile.mockResolvedValue(original);

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
        apiUrl: "http://localhost:3000",
        apiKey: "lls_local",
      });

      expect(result.repointed).toBe(true);
      expect(result.message).toContain("Re-pointed");
      expect(result.message).toContain("was https://membral.me/api/mcp");
      expect(result.message).toContain("Restart Claude Desktop");
      const [, written] = mainWrite();
      const config = JSON.parse(written);
      expect(config.mcpServers.membral).toEqual(desktopEntry("http://localhost:3000/api/mcp", "lls_local"));
      expect(config.mcpServers.other).toEqual({ command: "x" });
      const bak = writesOf(mockWriteFile).find((w) => w.path === "/mock/claude_desktop_config.json.membral.bak");
      expect(bak?.content).toBe(original);
      expect((bak?.options as { mode?: number }).mode).toBe(0o600);
    });

    it("is 'already configured' when the Claude Desktop entry matches URL and key exactly", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ mcpServers: { membral: desktopEntry("http://localhost:3000/api/mcp", "lls_local") } }),
      );

      const result = await configureMCPServer("claude-desktop", "/mock/claude_desktop_config.json", {
        apiUrl: "http://localhost:3000",
        apiKey: "lls_local",
      });

      expect(result.message).toBe("MCP server already configured");
      expect(result.repointed).toBeUndefined();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("rewrites a Cursor entry whose Authorization key differs even when the URL matches", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: { membral: { url: "https://membral.me/api/mcp", headers: { Authorization: "Bearer lls_old" } } },
        }),
      );

      const result = await configureMCPServer("cursor", "/mock/.cursor/mcp.json", { apiKey: "lls_new" });

      expect(result.repointed).toBe(true);
      const [path, written] = mainWrite();
      expect(path).toBe("/mock/.cursor/mcp.json");
      expect(JSON.parse(written).mcpServers.membral.headers.Authorization).toBe("Bearer lls_new");
    });

    it("rewrites a Cursor entry on another server", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: { membral: { url: "https://membral.me/api/mcp", headers: { Authorization: "Bearer lls_k" } } },
        }),
      );

      const result = await configureMCPServer("cursor", "/mock/.cursor/mcp.json", {
        apiUrl: "http://localhost:3000/",
        apiKey: "lls_k",
      });

      expect(result.repointed).toBe(true);
      expect(JSON.parse(mainWrite()[1]).mcpServers.membral.url).toBe("http://localhost:3000/api/mcp");
    });

    it("never swaps a working entry for a placeholder when no key is resolvable", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: { membral: { url: "https://membral.me/api/mcp", headers: { Authorization: "Bearer lls_k" } } },
        }),
      );

      const result = await configureMCPServer("cursor", "/mock/.cursor/mcp.json", {
        apiUrl: "http://localhost:3000",
        credentialsPath: "/nonexistent/credentials.json",
      });

      expect(result.message).toBe("MCP server already configured");
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("onlyExisting: skips a config with no membral entry without writing", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ mcpServers: { other: { url: "x" } } }));

      const result = await configureMCPServer("cursor", "/mock/.cursor/mcp.json", {
        apiKey: "lls_k",
        onlyExisting: true,
      });

      expect(result.skipped).toBe(true);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  // --- claude-code: shells out to `claude mcp add`, writes no file ---------

  describe("claude-code", () => {
    it("shells out to `claude mcp add` and never touches the filesystem", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(null));

      const result = await configureMCPServer("claude-code", "/mock/.claude/settings.json", {
        apiKey: "lls_test-123",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Configured Claude Code via");
      expect(mockExecFile).toHaveBeenCalledWith(
        "claude",
        [
          "mcp",
          "add-json",
          "membral",
          JSON.stringify({
            type: "http",
            url: "http://localhost:3000/api/mcp",
            headers: { Authorization: "Bearer lls_test-123" },
            alwaysLoad: true,
          }),
          "--scope",
          "user",
        ],
        expect.any(Function),
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("always passes --scope user (claude mcp add defaults to project-local scope)", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(null));

      await configureMCPServer("claude-code", "/mock/.claude/settings.json", { apiKey: "lls_test-123" });

      const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
      const scopeIdx = args.indexOf("--scope");
      expect(scopeIdx).toBeGreaterThanOrEqual(0);
      expect(args[scopeIdx + 1]).toBe("user");
    });

    it("never writes settings.json even when a configPath is passed", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(null));

      await configureMCPServer("claude-code", "/mock/.claude/settings.json", { apiKey: "lls_test-123" });

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("prints the exact command to run when the claude CLI isn't on PATH", async () => {
      const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(enoent));

      const result = await configureMCPServer("claude-code", "/mock/.claude/settings.json", {
        apiKey: "lls_test-123",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("not found on PATH");
      expect(result.message).toContain(
        `claude mcp add-json membral '{"type":"http","url":"http://localhost:3000/api/mcp","headers":{"Authorization":"Bearer lls_test-123"},"alwaysLoad":true}' --scope user`,
      );
    });

    it("recovers from 'entry already exists' by removing and re-adding — a re-run with a real key succeeds", async () => {
      // First `add` fails (e.g. an entry named "membral" already exists from
      // a prior placeholder-key run); `remove` then the retried `add` both
      // succeed.
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) =>
          cb(new Error("Error: MCP server membral already exists")),
        )
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(null))
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(null));

      const result = await configureMCPServer("claude-code", "/mock/.claude/settings.json", {
        apiKey: "lls_real-key",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Replaced existing Claude Code MCP entry");
      expect(mockExecFile).toHaveBeenCalledTimes(3);
      const [, removeArgs] = mockExecFile.mock.calls[1] as [string, string[]];
      expect(removeArgs).toEqual(["mcp", "remove", "membral", "--scope", "user"]);
      const [, reAddArgs] = mockExecFile.mock.calls[2] as [string, string[]];
      expect(reAddArgs[1]).toBe("add-json");
      const reAdded = JSON.parse(reAddArgs[3] as string);
      expect(reAdded.headers.Authorization).toBe("Bearer lls_real-key");
      // upgrade path: an old entry without the field is replaced with one that has it
      expect(reAdded.alwaysLoad).toBe(true);
    });

    it("falls back to the older `mcp add` form when this claude has no add-json, so the entry is not lost", async () => {
      // add-json fails (unknown command), remove succeeds, add-json fails again, then the older add succeeds.
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) =>
          cb(new Error("error: unknown command 'add-json'")),
        )
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(null))
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) =>
          cb(new Error("error: unknown command 'add-json'")),
        )
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(null));

      const result = await configureMCPServer("claude-code", "/mock/.claude/settings.json", {
        apiKey: "lls_real-key",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("alwaysLoad could not be set");
      expect(mockExecFile).toHaveBeenCalledTimes(4);
      const [, legacyArgs] = mockExecFile.mock.calls[3] as [string, string[]];
      expect(legacyArgs).toEqual([
        "mcp",
        "add",
        "--transport",
        "http",
        "membral",
        "http://localhost:3000/api/mcp",
        "--header",
        "Authorization: Bearer lls_real-key",
        "--scope",
        "user",
      ]);
    });

    it("returns success: false when remove+re-add also fails after the initial failure", async () => {
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(new Error("boom")))
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) =>
          cb(new Error("remove failed too")),
        )
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: unknown) => void) =>
          cb(new Error("legacy failed too")),
        );

      const result = await configureMCPServer("claude-code", "/mock/.claude/settings.json", {
        apiKey: "lls_test-123",
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("boom");
      expect(result.message).toContain("remove failed too");
    });

    it("uses a placeholder and warns when no API key is available", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(null));

      const result = await configureMCPServer("claude-code", "/mock/.claude/settings.json");

      expect(result.message).toContain("YOUR_API_KEY");
      expect(result.message).toContain("placeholder");
    });

    it("respects a custom apiUrl", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown) => void) => cb(null));

      await configureMCPServer("claude-code", "/mock/.claude/settings.json", {
        apiUrl: "http://localhost:3000",
        apiKey: "lls_test-123",
      });

      const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
      expect(JSON.parse(args[3] as string).url).toBe("http://localhost:3000/api/mcp");
    });
  });

  // --- shared: resolves apiKey/apiUrl from env when opts omit them ---------

  it("falls back to MEMBRAL_API_KEY / MEMBRAL_API_URL env vars when opts don't override them", async () => {
    process.env.MEMBRAL_API_URL = "http://env-url:3000/";
    process.env.MEMBRAL_API_KEY = "lls_from-env";
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await configureMCPServer("cursor", "/mock/.cursor/mcp.json");

    const [, written] = mainWrite();
    const config = JSON.parse(written);
    expect(config.mcpServers.membral.url).toBe("http://env-url:3000/api/mcp");
    expect(config.mcpServers.membral.headers.Authorization).toBe("Bearer lls_from-env");
  });

  it("returns an error result for an unrecognized client id", async () => {
    // @ts-expect-error — exercising the runtime guard against an id outside McpClientId
    const result = await configureMCPServer("some-other-client", "/mock/path");
    expect(result.success).toBe(false);
  });
});

// P10 review finding 2: hook commands must not depend on npm resolution at
// each session start — resolve the exact node+entry invocation once here.
describe("resolveCliInvocation", () => {
  it("returns the absolute node execPath + entry script path as separate argv entries", () => {
    const result = resolveCliInvocation({ execPath: "/usr/bin/node", entryPath: "/opt/membral/dist/index.js" });
    expect(result.argv).toEqual(["/usr/bin/node", "/opt/membral/dist/index.js"]);
    expect(result.fallbackWarning).toBeUndefined();
  });

  it("falls back to bare `membral` on PATH (with a warning) when the entry path is inside an npx temp cache", () => {
    const result = resolveCliInvocation({
      execPath: "/usr/bin/node",
      entryPath: "/Users/x/.npm/_npx/abc123/node_modules/@membral/cli/dist/index.js",
    });
    expect(result.argv).toEqual(["membral"]);
    expect(result.fallbackWarning).toMatch(/npx/i);
  });

  it("falls back to `membral` when no entry path is resolvable at all", () => {
    const result = resolveCliInvocation({ execPath: "/usr/bin/node", entryPath: "" });
    expect(result.argv).toEqual(["membral"]);
    expect(result.fallbackWarning).toBeDefined();
  });

  // B3 (P6 local rehearsal): a Homebrew node execPath is a VERSIONED Cellar
  // path that `brew upgrade node` removes — swap it for whichever stable
  // alias (/opt/homebrew/bin/node or /usr/local/bin/node) actually resolves
  // to it.
  describe("B3 — Homebrew Cellar node/entry paths", () => {
    it("swaps a Cellar node execPath for the /opt/homebrew/bin/node alias when its realpath matches", () => {
      const cellarNode = "/opt/homebrew/Cellar/node/26.8.1/bin/node";
      const realpathSync = vi.fn((p: string) => {
        if (p === "/opt/homebrew/bin/node") return cellarNode;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = resolveCliInvocation({
        execPath: cellarNode,
        entryPath: "/opt/homebrew/lib/node_modules/@membral/cli/dist/index.js",
        realpathSync,
      });

      expect(result.argv).toEqual([
        "/opt/homebrew/bin/node",
        "/opt/homebrew/lib/node_modules/@membral/cli/dist/index.js",
      ]);
      expect(result.fallbackWarning).toBeUndefined();
    });

    it("falls back to /usr/local/bin/node when that's the one that resolves to the Cellar path", () => {
      const cellarNode = "/usr/local/Cellar/node/26.8.1/bin/node";
      const realpathSync = vi.fn((p: string) => {
        if (p === "/usr/local/bin/node") return cellarNode;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = resolveCliInvocation({ execPath: cellarNode, entryPath: "/opt/x/dist/index.js", realpathSync });

      expect(result.argv[0]).toBe("/usr/local/bin/node");
    });

    it("leaves the Cellar path as-is when neither stable alias resolves to it (nothing to swap to)", () => {
      const cellarNode = "/opt/homebrew/Cellar/node/26.8.1/bin/node";
      const realpathSync = vi.fn(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = resolveCliInvocation({ execPath: cellarNode, entryPath: "/opt/x/dist/index.js", realpathSync });

      expect(result.argv[0]).toBe(cellarNode);
    });

    it("also swaps a Cellar-versioned CLI entry path for its stable /opt/homebrew/bin/membral alias", () => {
      const cellarEntry = "/opt/homebrew/Cellar/node/26.8.1/lib/node_modules/@membral/cli/dist/index.js";
      const realpathSync = vi.fn((p: string) => {
        if (p === "/opt/homebrew/bin/membral") return cellarEntry;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = resolveCliInvocation({ execPath: "/usr/bin/node", entryPath: cellarEntry, realpathSync });

      expect(result.argv).toEqual(["/usr/bin/node", "/opt/homebrew/bin/membral"]);
    });

    it("nvm node path: keeps the absolute path but adds a one-line version-switch note", () => {
      const nvmNode = "/Users/dev/.nvm/versions/node/v20.11.0/bin/node";
      const result = resolveCliInvocation({ execPath: nvmNode, entryPath: "/opt/x/dist/index.js" });

      expect(result.argv).toEqual([nvmNode, "/opt/x/dist/index.js"]);
      expect(result.fallbackWarning).toMatch(/nvm/i);
      expect(result.fallbackWarning).toMatch(/membral setup/);
    });

    it("a plain non-Cellar, non-nvm path is untouched and carries no note", () => {
      const result = resolveCliInvocation({ execPath: "/usr/bin/node", entryPath: "/opt/x/dist/index.js" });
      expect(result.argv).toEqual(["/usr/bin/node", "/opt/x/dist/index.js"]);
      expect(result.fallbackWarning).toBeUndefined();
    });
  });
});
