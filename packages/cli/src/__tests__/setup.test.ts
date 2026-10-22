// `membral setup` — the onboarding wizard. Every I/O-touching collaborator
// is mocked (credentials, login, device identity, harness scan, sync
// allowlist, import-sessions, MCP configure, node:fs's existsSync, node:os's
// hostname) so these tests never touch the real filesystem or network —
// same isolation posture as start-command.test.ts used to have.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn(() => false);
vi.mock("node:fs", () => ({ existsSync: (...a: unknown[]) => existsSyncMock(...(a as [string])) }));

// issue #137: setup's machine-name prompt shows the hostname as its default
// when there's no existing device.json name — pinned to a fixed value here
// so tests can assert on the exact prompt string. homedir() is left real
// (via importOriginal) since sync-allowlist.ts also pulls paths from node:os
// and isn't otherwise mocked in this file.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, hostname: () => "unit-test-host" };
});

const loadOrCreateDeviceIdentityMock = vi.fn((opts?: { deviceName?: string }) => ({
  id: "device-1",
  name: opts?.deviceName || "test-machine",
  platform: "darwin" as const,
}));
const peekDeviceNameMock = vi.fn((): string | undefined => undefined);
vi.mock("../device.js", () => ({
  loadOrCreateDeviceIdentity: (...a: unknown[]) => loadOrCreateDeviceIdentityMock(...(a as [{ deviceName?: string }?])),
  peekDeviceName: (...a: unknown[]) => peekDeviceNameMock(...(a as [])),
  defaultDeviceIdentityPath: () => "/home/test/.membral/device.json",
}));

const loadCredentialsMock = vi.fn();
const resolveApiUrlMock = vi.fn();
const resolveApiKeyMock = vi.fn();
const resolveValidatedCredentialsMock = vi.fn();
const saveCredentialsMock = vi.fn();
const loadProfileMock = vi.fn();
const loadProfilesMock = vi.fn();
const setActiveProfileMock = vi.fn();
vi.mock("../credentials.js", () => ({
  loadCredentials: (...a: unknown[]) => loadCredentialsMock(...a),
  loadProfile: (...a: unknown[]) => loadProfileMock(...a),
  loadProfiles: (...a: unknown[]) => loadProfilesMock(...a),
  setActiveProfile: (...a: unknown[]) => setActiveProfileMock(...a),
  profileNameForUrl: (url: string) => (url.includes("localhost") ? "local" : "prod"),
  resolveApiUrl: (...a: unknown[]) => resolveApiUrlMock(...a),
  resolveApiKey: (...a: unknown[]) => resolveApiKeyMock(...a),
  resolveValidatedCredentials: (...a: unknown[]) => resolveValidatedCredentialsMock(...a),
  saveCredentials: (...a: unknown[]) => saveCredentialsMock(...a),
  describeAuthRejection: () => "AUTH REJECTION MESSAGE",
  defaultCredentialsPath: () => "/home/test/.membral/credentials.json",
}));

const loginCommandMock = vi.fn();
vi.mock("../login-command.js", () => ({ loginCommand: (...a: unknown[]) => loginCommandMock(...a) }));

const scanHarnessesMock = vi.fn();
const NO_COPILOT = { cliOnPath: false, copilotHome: false, vscodeUserDirs: [], vscodeExtension: false, present: false };
const detectCopilotMock = vi.fn(async () => NO_COPILOT);
vi.mock("../harness-scan.js", () => ({
  scanHarnesses: (...a: unknown[]) => scanHarnessesMock(...a),
  detectCopilot: () => detectCopilotMock(),
}));
const writeUserInstructionsMock = vi.fn();
vi.mock("../copilot-user-instructions.js", () => ({
  writeUserInstructions: (...a: unknown[]) => writeUserInstructionsMock(...a),
  userInstructionsPath: () => "/home/test/.copilot/instructions/membral.instructions.md",
}));

const loadSyncAllowlistMock = vi.fn();
const saveSyncAllowlistMock = vi.fn();
vi.mock("../sync-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sync-allowlist.js")>();
  return {
    ...actual,
    loadSyncAllowlist: (...a: unknown[]) => loadSyncAllowlistMock(...a),
    saveSyncAllowlist: (...a: unknown[]) => saveSyncAllowlistMock(...a),
  };
});

const importSessionsMock = vi.fn();
vi.mock("../import-sessions.js", () => ({
  importSessions: (...a: unknown[]) => importSessionsMock(...a),
  // Finding 11 (2026-09-12 review): setup.ts loops over the same source
  // list `membral sessions` uses — keep this literal in sync with
  // import-sessions.ts's own `Object.keys(PARSERS)`.
  DEFAULT_IMPORT_SOURCES: ["claude-code", "opencode"],
}));

const detectToolsMock = vi.fn();
vi.mock("../detect.js", () => ({ detectTools: (...a: unknown[]) => detectToolsMock(...a) }));

const configureMCPServerMock = vi.fn();
const configureUserPromptSubmitHookMock = vi.fn(async (..._a: unknown[]) => ({ success: true, message: "removed" }));
vi.mock("../configure.js", () => ({
  configureMCPServer: (...a: unknown[]) => configureMCPServerMock(...a),
  configureUserPromptSubmitHook: (...a: unknown[]) => configureUserPromptSubmitHookMock(...a),
}));

// Prompt recall's stored choice (~/.membral/config.json), in memory.
const cliConfigState = vi.hoisted(() => ({ promptRecall: true as boolean, writes: [] as boolean[] }));
vi.mock("../cli-config.js", () => ({
  defaultCliConfigPath: () => "/home/test/.membral/config.json",
  promptRecallEnabled: () => cliConfigState.promptRecall,
  setPromptRecall: (enabled: boolean) => {
    cliConfigState.promptRecall = enabled;
    cliConfigState.writes.push(enabled);
    return true;
  },
}));

// Step 6 (session-end hook) — mocked one level deep, same as every other
// setup.ts collaborator in this file. install-session-hook.ts's own
// idempotency (it updates its existing settings.json entry instead of
// duplicating it) is covered by install-session-hook.test.ts; these tests
// only assert setup.ts calls it exactly when it should.
// Profiles/opencode/sweep wiring — mocked so nothing touches the real
// ~/.config/opencode or ~/Library/LaunchAgents.
const installOpencodePluginMock = vi.fn();
const configureOpencodeMcpMock = vi.fn();
const detectOpencodeMock = vi.fn(() => false);
vi.mock("../opencode-integration.js", () => ({
  installOpencodePlugin: (...a: unknown[]) => installOpencodePluginMock(...a),
  configureOpencodeMcp: (...a: unknown[]) => configureOpencodeMcpMock(...a),
  detectOpencode: () => detectOpencodeMock(),
}));
const installSweepAgentMock = vi.fn();
vi.mock("../sweep-command.js", () => ({
  installSweepAgent: (...a: unknown[]) => installSweepAgentMock(...a),
}));

const detectCodexMock = vi.fn(async () => false);
const setupCodexMock = vi.fn();
vi.mock("../codex-setup.js", () => ({
  CODEX_APPROVE_HOOK_ACTION: "APPROVE THE HOOK",
  detectCodex: (...a: unknown[]) => detectCodexMock(...(a as [])),
  setupCodex: (...a: unknown[]) => setupCodexMock(...a),
}));

const installCopilotCliHooksMock = vi.fn();
vi.mock("../copilot-cli-hooks.js", () => ({
  installCopilotCliHooks: (...a: unknown[]) => installCopilotCliHooksMock(...a),
}));

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
}));
const setupCopilotVscodeMock = vi.fn();
vi.mock("../copilot-vscode.js", () => ({
  setupCopilotVscode: (...a: unknown[]) => setupCopilotVscodeMock(...a),
}));

const installSessionHookMock = vi.fn();
vi.mock("../install-session-hook.js", () => ({
  installSessionHook: (...a: unknown[]) => installSessionHookMock(...a),
  defaultSettingsPath: () => "/home/test/.claude/settings.json",
}));

const findMembralPluginMock = vi.fn(async (): Promise<string | null> => null);
vi.mock("../claude-plugin.js", () => ({ findMembralPlugin: () => findMembralPluginMock() }));

// Defaults to "" (blank answer) so a prompt this test doesn't care about
// (e.g. the device-name prompt in a test that's only exercising the sync
// step) never throws on an unset mock — matches each real prompt's
// "blank keeps the default / [y/N] default No" behavior. prompt.js (not
// node:readline directly — see its module doc comment for why setup.ts no
// longer calls readline's question()/asyncIterator itself) is mocked
// wholesale so these tests never touch real stdin/stdout.
const askMock = vi.fn(async () => "");
const promptCloseMock = vi.fn();
// P10: the raw-mode checklist setup uses for step 4 on a TTY. Default: keep
// everything checked (the same outcome as a blank answer to the piped prompt).
const checklistMock = vi.fn(async (items: string[]) => ({
  selected: items.map((_, i) => i),
  cancelled: false,
}));
vi.mock("../prompt.js", () => ({
  createPrompter: () => ({ ask: (...args: unknown[]) => askMock(...args), close: promptCloseMock }),
  checklist: (...args: unknown[]) => checklistMock(...(args as [string[]])),
}));

/** Forces `process.stdin.isTTY` for one test; returns the restore function. */
function withStdinTTY(isTTY: boolean): () => void {
  const had = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(process.stdin, "isTTY", had);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  };
}

import { setup } from "../setup.js";

const CREDS = { email: "a@b.com", apiUrl: "https://membral.me", apiKey: "lls_key", userId: "u1", createdAt: "now" };

describe("setup", () => {
  beforeEach(() => {
    cliConfigState.promptRecall = true;
    cliConfigState.writes.length = 0;
    existsSyncMock.mockReturnValue(false);
    loadCredentialsMock.mockReturnValue(CREDS);
    resolveApiUrlMock.mockReturnValue("https://membral.me");
    resolveApiKeyMock.mockReturnValue("lls_key");
    resolveValidatedCredentialsMock.mockResolvedValue({
      apiUrl: "https://membral.me",
      apiUrlSource: "credentials",
      apiKey: "lls_key",
      apiKeySource: "credentials",
      validation: { status: "valid" },
    });
    scanHarnessesMock.mockResolvedValue([]);
    loadSyncAllowlistMock.mockReturnValue(null);
    importSessionsMock.mockResolvedValue({ ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0 });
    peekDeviceNameMock.mockReturnValue(undefined);
    loadOrCreateDeviceIdentityMock.mockImplementation((opts?: { deviceName?: string }) => ({
      id: "device-1",
      name: opts?.deviceName || "test-machine",
      platform: "darwin" as const,
    }));
    askMock.mockReset();
    askMock.mockImplementation(async () => "");
    checklistMock.mockReset();
    checklistMock.mockImplementation(async (items: string[]) => ({
      selected: items.map((_, i) => i),
      cancelled: false,
    }));
    detectToolsMock.mockResolvedValue([]);
    configureMCPServerMock.mockResolvedValue({ success: true, message: "Configured" });
    loadProfileMock.mockReturnValue(null);
    loadProfilesMock.mockReturnValue({ activeProfile: "prod", profiles: { prod: CREDS } });
    detectOpencodeMock.mockReturnValue(false);
    detectCopilotMock.mockResolvedValue(NO_COPILOT);
    writeUserInstructionsMock.mockResolvedValue({
      path: "/home/test/.copilot/instructions/membral.instructions.md",
      outcome: "created",
    });
    installOpencodePluginMock.mockResolvedValue({ success: true, message: "Installed opencode capture plugin" });
    configureOpencodeMcpMock.mockResolvedValue({ success: true, message: "Added opencode MCP entry" });
    installSweepAgentMock.mockResolvedValue({
      success: true,
      scheduler: "launchd",
      message: "Installed backstop sweep (every 20 min)",
    });
    installCopilotCliHooksMock.mockResolvedValue({
      path: "/home/test/.copilot/hooks/membral.json",
      outcome: "created",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.MEMBRAL_DEVICE_NAME;
    process.exitCode = 0;
  });

  it("skips login when credentials already exist", async () => {
    await setup({ yes: true });
    expect(loginCommandMock).not.toHaveBeenCalled();
  });

  it("skips login when --api-key is given, even without credentials", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await setup({ apiKey: "lls_flag", yes: true });
    expect(loginCommandMock).not.toHaveBeenCalled();
  });

  // B2 (P6 local rehearsal): `--api-key` must persist ~/.membral/credentials.json
  // the same way a successful `membral login` does, so hooks/other commands
  // installed by this run (and any later command) can authenticate without
  // MEMBRAL_API_KEY also being exported.
  describe("B2 — persisting --api-key credentials", () => {
    it("saves credentials.json (same shape/location/api url as login) when none exist yet", async () => {
      loadCredentialsMock.mockReturnValue(null);
      resolveValidatedCredentialsMock.mockResolvedValue({
        apiUrl: "https://membral.me",
        apiUrlSource: "flag",
        apiKey: "lls_new",
        apiKeySource: "flag",
        validation: { status: "valid" },
      });

      await setup({ apiKey: "lls_new", yes: true });

      expect(saveCredentialsMock).toHaveBeenCalledTimes(1);
      const [saved] = saveCredentialsMock.mock.calls[0];
      expect(saved).toMatchObject({ apiUrl: "https://membral.me", apiKey: "lls_new" });
      expect(typeof saved.email).toBe("string");
      expect(typeof saved.userId).toBe("string");
      expect(typeof saved.createdAt).toBe("string");
    });

    it("overwrites an existing credentials.json for a DIFFERENT key, with a one-line notice", async () => {
      loadCredentialsMock.mockReturnValue({
        apiUrl: "https://membral.me",
        apiKey: "lls_old",
        email: "old@example.com",
        userId: "u-old",
        createdAt: "then",
      });
      resolveValidatedCredentialsMock.mockResolvedValue({
        apiUrl: "https://membral.me",
        apiUrlSource: "flag",
        apiKey: "lls_new",
        apiKeySource: "flag",
        validation: { status: "valid" },
      });
      const logSpy = vi.spyOn(console, "log");

      await setup({ apiKey: "lls_new", yes: true });

      expect(saveCredentialsMock).toHaveBeenCalledTimes(1);
      expect(saveCredentialsMock.mock.calls[0][0]).toMatchObject({
        apiUrl: "https://membral.me",
        apiKey: "lls_new",
      });
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toMatch(/Overwriting.*credentials\.json.*different key/i);
    });

    it("does not re-save when the same key/url are already persisted", async () => {
      loadCredentialsMock.mockReturnValue({
        apiUrl: "https://membral.me",
        apiKey: "lls_same",
        email: "a@b.com",
        userId: "u1",
        createdAt: "now",
      });
      resolveValidatedCredentialsMock.mockResolvedValue({
        apiUrl: "https://membral.me",
        apiUrlSource: "flag",
        apiKey: "lls_same",
        apiKeySource: "flag",
        validation: { status: "valid" },
      });

      await setup({ apiKey: "lls_same", yes: true });

      expect(saveCredentialsMock).not.toHaveBeenCalled();
    });
  });

  it("runs login when there's no credentials and no --api-key, then stops if it didn't complete", async () => {
    loadCredentialsMock.mockReturnValue(null); // never signs in during this run
    await setup({ yes: true });
    expect(loginCommandMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    // Nothing past sign-in should have run.
    expect(scanHarnessesMock).not.toHaveBeenCalled();
  });

  it("runs login and proceeds once credentials appear after it", async () => {
    loadCredentialsMock.mockReturnValueOnce(null).mockReturnValue(CREDS);
    await setup({ yes: true });
    expect(loginCommandMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
    expect(scanHarnessesMock).toHaveBeenCalledTimes(1);
  });

  it("--dry-run never writes sync.json, never imports, never configures MCP", async () => {
    scanHarnessesMock.mockResolvedValue([
      {
        harness: "claude-code",
        projectPath: "/home/dev/app",
        displayName: "app",
        sessions: 3,
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        importable: true,
      },
    ]);

    await setup({ dryRun: true });

    expect(saveSyncAllowlistMock).not.toHaveBeenCalled();
    expect(importSessionsMock).not.toHaveBeenCalled();
    expect(configureMCPServerMock).not.toHaveBeenCalled();
    // Step 6 previews too — --dry-run must never touch ~/.claude/settings.json.
    expect(installSessionHookMock).not.toHaveBeenCalled();
  });

  it("--dry-run --no-prompt-recall says the prompt hook would be removed, and stores nothing", async () => {
    detectToolsMock.mockResolvedValue([{ name: "Claude Code", id: "claude-code", detected: true }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cliConfigState.writes.length = 0;
    await setup({ dryRun: true, noPromptRecall: true });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("remove the Membral UserPromptSubmit hook (prompt recall off)");
    expect(cliConfigState.writes).toEqual([]);
    expect(installSessionHookMock).not.toHaveBeenCalled();
  });

  // Step 6 — session-end hook (2026-09-12 refocus goal, W4/D5: PRODUCT.md's
  // user flow step 2, "sessions are captured at session end", is only true
  // once setup actually calls the installer instead of leaving it as a
  // maintainer-only command).
  describe("Step 6 — session-end hook", () => {
    it("installs the Claude Code hook when Claude Code is detected", async () => {
      scanHarnessesMock.mockResolvedValue([
        {
          harness: "claude-code",
          projectPath: "/home/dev/app",
          displayName: "app",
          sessions: 3,
          lastActiveAt: null,
          importable: true,
        },
      ]);

      await setup({ yes: true });

      expect(installSessionHookMock).toHaveBeenCalledTimes(1);
      expect(installSessionHookMock).toHaveBeenCalledWith({ promptRecall: true });

      // --no-prompt-recall is stored, and a later plain setup keeps it off.
      installSessionHookMock.mockClear();
      cliConfigState.writes.length = 0;
      await setup({ yes: true, noPromptRecall: true });
      expect(installSessionHookMock).toHaveBeenCalledWith({ promptRecall: false });
      expect(cliConfigState.writes).toEqual([false]);
      installSessionHookMock.mockClear();
      await setup({ yes: true });
      expect(installSessionHookMock).toHaveBeenCalledWith({ promptRecall: false });
      // --prompt-recall turns it back on, and that is stored too.
      installSessionHookMock.mockClear();
      await setup({ yes: true, promptRecall: true });
      expect(installSessionHookMock).toHaveBeenCalledWith({ promptRecall: true });
      expect(cliConfigState.writes).toEqual([false, true]);
      expect(cliConfigState.promptRecall).toBe(true);
    });

    it("skips the Claude Code hooks and MCP when the Membral plugin is installed, and says so", async () => {
      findMembralPluginMock.mockResolvedValueOnce("membral@membral");
      detectToolsMock.mockResolvedValue([
        { name: "Claude Code", id: "claude-code", detected: true },
        { name: "Cursor", id: "cursor", configPath: "/home/test/.cursor/mcp.json", detected: true },
      ]);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await setup({ yes: true });

      expect(installSessionHookMock).not.toHaveBeenCalled();
      expect(configureMCPServerMock).toHaveBeenCalledTimes(1);
      expect(configureMCPServerMock.mock.calls[0][0]).toBe("cursor");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("the Membral plugin (membral@membral) is installed");
    });

    it("with the plugin installed, --no-prompt-recall still removes only our prompt hook from settings.json", async () => {
      detectToolsMock.mockResolvedValue([{ name: "Claude Code", id: "claude-code", detected: true }]);
      vi.spyOn(console, "log").mockImplementation(() => {});
      findMembralPluginMock.mockResolvedValueOnce("membral@membral");
      await setup({ yes: true });
      expect(configureUserPromptSubmitHookMock).not.toHaveBeenCalled();

      findMembralPluginMock.mockResolvedValueOnce("membral@membral");
      await setup({ yes: true, noPromptRecall: true });
      expect(installSessionHookMock).not.toHaveBeenCalled();
      expect(configureUserPromptSubmitHookMock).toHaveBeenCalledWith("/home/test/.claude/settings.json", {
        remove: true,
      });
    });

    it("installs the Claude Code hooks and MCP when no Membral plugin is installed", async () => {
      detectToolsMock.mockResolvedValue([{ name: "Claude Code", id: "claude-code", detected: true }]);

      await setup({ yes: true });

      expect(findMembralPluginMock).toHaveBeenCalled();
      expect(installSessionHookMock).toHaveBeenCalledTimes(1);
      expect(configureMCPServerMock.mock.calls[0][0]).toBe("claude-code");
    });

    it("installs the Copilot CLI hooks when the scan finds Copilot CLI sessions", async () => {
      scanHarnessesMock.mockResolvedValue([
        {
          harness: "copilot-cli",
          projectPath: "/home/dev/app",
          displayName: "app",
          sessions: 2,
          lastActiveAt: null,
          importable: true,
        },
      ]);

      await setup({ yes: true });

      expect(installCopilotCliHooksMock).toHaveBeenCalledTimes(1);
      expect(installCopilotCliHooksMock).toHaveBeenCalledWith({ dryRun: undefined });
      expect(installSessionHookMock).not.toHaveBeenCalled();
    });

    it("skips the Copilot CLI hooks when none is found, unless --copilot-cli is given", async () => {
      await setup({ yes: true });
      expect(installCopilotCliHooksMock).not.toHaveBeenCalled();

      await setup({ yes: true, copilotCli: true });
      expect(installCopilotCliHooksMock).toHaveBeenCalledTimes(1);
    });

    it("a Copilot CLI hook install failure is reported in the summary and setup carries on", async () => {
      installCopilotCliHooksMock.mockRejectedValueOnce(new Error("EACCES: hooks dir"));
      const logSpy = vi.spyOn(console, "log");
      await expect(setup({ yes: true, copilotCli: true })).resolves.not.toThrow();
      const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain("Copilot CLI hooks: failed (EACCES: hooks dir)");
      expect(out).toContain("Importing sessions");
    });

    it("--copilot outside a git repo writes nothing, says why, and setup carries on", async () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("not a git repository");
      });
      const logSpy = vi.spyOn(console, "log");
      await setup({ yes: true, copilot: true });
      expect(setupCopilotVscodeMock).not.toHaveBeenCalled();
      const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain(
        "membral setup --copilot: run this from inside the repo you open in VS Code (no git repo at ",
      );
      expect(out).toContain("Copilot (VS Code): skipped");
      expect(out).toContain("Importing sessions");
    });

    it("--copilot inside a git repo writes into the repo root", async () => {
      execFileSyncMock.mockReturnValue("/work/repo\n");
      setupCopilotVscodeMock.mockResolvedValue({
        mcp: { path: "/work/repo/.vscode/mcp.json", outcome: "created" },
        instructions: { path: "/work/repo/.github/copilot-instructions.md", outcome: "created" },
      });
      await setup({ yes: true, copilot: true });
      expect(setupCopilotVscodeMock).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: "/work/repo" }));
    });

    it("is idempotent: running setup twice calls the (independently idempotent) installer twice, never duplicating or erroring", async () => {
      scanHarnessesMock.mockResolvedValue([
        {
          harness: "claude-code",
          projectPath: "/home/dev/app",
          displayName: "app",
          sessions: 3,
          lastActiveAt: null,
          importable: true,
        },
      ]);

      await setup({ yes: true });
      await setup({ yes: true });

      // installSessionHook itself de-duplicates the settings.json entry on a
      // repeat call with the same options — see
      // install-session-hook.test.ts's "is idempotent" case, which asserts
      // the underlying settings.json ends up with exactly one hook entry
      // after two calls. Here we only pin that setup.ts re-invokes it (not a
      // one-shot "install once, skip forever") with the same args each time.
      expect(installSessionHookMock).toHaveBeenCalledTimes(2);
      expect(installSessionHookMock.mock.calls[0]).toEqual(installSessionHookMock.mock.calls[1]);
    });

    it("installs the hooks when ~/.claude exists but Claude Code has no sessions yet (brand-new user)", async () => {
      scanHarnessesMock.mockResolvedValue([]);
      detectToolsMock.mockResolvedValue([{ name: "Claude Code", id: "claude-code", detected: true }]);

      await setup({ yes: true });

      expect(installSessionHookMock).toHaveBeenCalledTimes(1);
      expect(installSessionHookMock).toHaveBeenCalledWith({ promptRecall: true });
    });

    it("skips the hook (and does not error) when no Claude Code is detected", async () => {
      scanHarnessesMock.mockResolvedValue([
        {
          harness: "opencode",
          projectPath: "/home/dev/oc-project",
          displayName: "oc-project",
          sessions: 2,
          lastActiveAt: null,
          importable: false,
        },
      ]);

      await setup({ yes: true });

      expect(installSessionHookMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    });

    it("installs the opencode capture plugin and opencode MCP when opencode is detected", async () => {
      const logSpy = vi.spyOn(console, "log");
      scanHarnessesMock.mockResolvedValue([
        {
          harness: "opencode",
          projectPath: "/home/dev/oc-project",
          displayName: "oc-project",
          sessions: 2,
          lastActiveAt: null,
          importable: false,
        },
      ]);

      await setup({ yes: true });

      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(installOpencodePluginMock).toHaveBeenCalledTimes(1);
      expect(configureOpencodeMcpMock).toHaveBeenCalledWith({ apiUrl: "https://membral.me", apiKey: "lls_key" });
      expect(lines.some((l) => l.includes("opencode capture plugin: installed"))).toBe(true);
      expect(lines.some((l) => l.includes("MCP opencode: configured"))).toBe(true);
    });

    it("skips opencode wiring when opencode isn't on the machine", async () => {
      await setup({ yes: true });
      expect(installOpencodePluginMock).not.toHaveBeenCalled();
      expect(configureOpencodeMcpMock).not.toHaveBeenCalled();
    });
  });

  describe("profiles, sweep and summary", () => {
    it("installs the backstop sweep by default and lists it in the summary with the profile", async () => {
      const logSpy = vi.spyOn(console, "log");
      await setup({ yes: true });
      expect(installSweepAgentMock).toHaveBeenCalledWith({ dryRun: undefined });
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("Profile: prod (https://membral.me)"))).toBe(true);
      expect(lines.some((l) => l.includes("Backstop sweep: installed (launchd), every 20 min"))).toBe(true);
    });

    it("names the Linux scheduler in the summary", async () => {
      installSweepAgentMock.mockResolvedValue({ success: true, scheduler: "systemd", message: "Installed (systemd)" });
      const logSpy = vi.spyOn(console, "log");
      await setup({ yes: true });
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("Backstop sweep: installed (systemd), every 20 min"))).toBe(true);
    });

    it("says loudly when no scheduler could be installed", async () => {
      installSweepAgentMock.mockResolvedValue({ success: false, scheduler: "none", message: "NOT scheduled" });
      const logSpy = vi.spyOn(console, "log");
      await setup({ yes: true });
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some((l) =>
          l.includes("Backstop sweep: NONE — no scheduler found; run `membral sweep` every 20 min yourself"),
        ),
      ).toBe(true);
      expect(lines.some((l) => l.includes("from cron"))).toBe(false);
    });

    it("cron write failure shows FAILED (cron) with the reason in the summary", async () => {
      installSweepAgentMock.mockResolvedValue({
        success: false,
        scheduler: "cron",
        reason: "crontab write failed: permission denied",
        message: "Backstop sweep: NOT scheduled — crontab write failed: permission denied",
      });
      const logSpy = vi.spyOn(console, "log");
      await setup({ yes: true });
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some((l) => l.includes("Backstop sweep: FAILED (cron): crontab write failed: permission denied")),
      ).toBe(true);
    });

    it("prints scheduler warnings (linger, cron daemon) and shows them in the summary", async () => {
      installSweepAgentMock.mockResolvedValue({
        success: true,
        scheduler: "cron",
        message: "Installed (cron)",
        warnings: ["cron daemon not running: sudo service cron start"],
      });
      const logSpy = vi.spyOn(console, "log");
      await setup({ yes: true });
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("  NOTE: cron daemon not running: sudo service cron start");
      expect(
        lines.some((l) =>
          l.includes(
            "Backstop sweep: installed (cron), every 20 min — cron daemon not running: sudo service cron start",
          ),
        ),
      ).toBe(true);
    });

    it("--no-sweep skips the sweep agent", async () => {
      await setup({ yes: true, noSweep: true });
      expect(installSweepAgentMock).not.toHaveBeenCalled();
    });

    it("--dry-run passes dryRun to the sweep installer (prints only)", async () => {
      await setup({ dryRun: true });
      expect(installSweepAgentMock).toHaveBeenCalledWith({ dryRun: true });
    });

    it("--api-url for an existing profile makes it active without signing in again", async () => {
      const local = { ...CREDS, apiUrl: "http://localhost:3000", apiKey: "lls_local" };
      loadProfileMock.mockReturnValue(local);
      await setup({ yes: true, apiUrl: "http://localhost:3000" });
      expect(loadProfileMock).toHaveBeenCalledWith("local");
      expect(setActiveProfileMock).toHaveBeenCalledWith("local");
      expect(loginCommandMock).not.toHaveBeenCalled();
    });

    it("--api-url for a server with no profile runs sign-in against that URL", async () => {
      loadProfileMock.mockReturnValue(null);
      await setup({ yes: true, apiUrl: "http://localhost:3000" });
      expect(loginCommandMock).toHaveBeenCalledWith({ apiUrl: "http://localhost:3000" });
    });

    // Maintainer ask (2026-09-25): capture (hooks, opencode plugin, sweep,
    // MCP) goes live BEFORE the first import, which can run long — so a new
    // user's sessions start being captured within seconds instead of only
    // once the backfill finishes. `invocationCallOrder` compares vitest's
    // global call-order counters across every mock in this file. Detection
    // is set up so every one of these actually fires (a plain `{ yes: true }`
    // run detects nothing, so none of these mocks would be called at all).
    it("installs hooks, opencode plugin, sweep, and MCP before running the first import", async () => {
      scanHarnessesMock.mockResolvedValue([
        {
          harness: "claude-code",
          projectPath: "/home/dev/app",
          displayName: "app",
          sessions: 3,
          lastActiveAt: null,
          importable: true,
        },
        {
          harness: "opencode",
          projectPath: "/home/dev/oc-project",
          displayName: "oc-project",
          sessions: 2,
          lastActiveAt: null,
          importable: false,
        },
      ]);
      detectToolsMock.mockResolvedValue([{ name: "Claude Code", id: "claude-code", detected: true }]);

      await setup({ yes: true });

      const hookOrder = installSessionHookMock.mock.invocationCallOrder[0];
      const pluginOrder = installOpencodePluginMock.mock.invocationCallOrder[0];
      const sweepOrder = installSweepAgentMock.mock.invocationCallOrder[0];
      const mcpOrder = configureMCPServerMock.mock.invocationCallOrder[0];
      const importOrder = importSessionsMock.mock.invocationCallOrder[0];
      expect(hookOrder).toBeLessThan(importOrder);
      expect(pluginOrder).toBeLessThan(importOrder);
      expect(sweepOrder).toBeLessThan(importOrder);
      expect(mcpOrder).toBeLessThan(importOrder);
    });

    it("labels the reordered steps 5 (capture) and 6 (import)", async () => {
      const logSpy = vi.spyOn(console, "log");
      await setup({ yes: true });
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("Step 5/6 — Session hooks, opencode plugin, sweep, MCP");
      expect(lines).toContain("Step 6/6 — Importing sessions");
    });
  });

  it("--yes writes sync.json with every scanned project enabled", async () => {
    scanHarnessesMock.mockResolvedValue([
      {
        harness: "claude-code",
        projectPath: "/home/dev/app",
        displayName: "app",
        sessions: 3,
        lastActiveAt: null,
        importable: true,
      },
      {
        harness: "claude-code",
        projectPath: "/home/dev/other",
        displayName: "other",
        sessions: 1,
        lastActiveAt: null,
        importable: true,
      },
    ]);

    await setup({ yes: true });

    expect(askMock).not.toHaveBeenCalled();
    expect(saveSyncAllowlistMock).toHaveBeenCalledTimes(1);
    const [written] = saveSyncAllowlistMock.mock.calls[0];
    expect(written.harnesses["claude-code"].projects).toEqual([
      { path: "/home/dev/app", enabled: true },
      { path: "/home/dev/other", enabled: true },
    ]);
  });

  it("--exclude drops exactly the numbered projects from sync.json, non-interactively", async () => {
    scanHarnessesMock.mockResolvedValue([
      {
        harness: "claude-code",
        projectPath: "/home/dev/app",
        displayName: "app",
        sessions: 3,
        lastActiveAt: null,
        importable: true,
      },
      {
        harness: "claude-code",
        projectPath: "/home/dev/other",
        displayName: "other",
        sessions: 1,
        lastActiveAt: null,
        importable: true,
      },
    ]);

    // deviceName bypasses the other prompt (#137) so this assertion stays
    // focused on the sync-selection prompt it's actually testing.
    await setup({ exclude: "2", deviceName: "test-box" });

    expect(askMock).not.toHaveBeenCalled();
    const [written] = saveSyncAllowlistMock.mock.calls[0];
    expect(written.harnesses["claude-code"].projects).toEqual([
      { path: "/home/dev/app", enabled: true },
      { path: "/home/dev/other", enabled: false },
    ]);
  });

  // P10 (goal 2026-09-26): step 4 is a checklist on a TTY; piped stdin keeps
  // the numbered prompt so issue #137's readline path stays as it was.
  describe("sync selection — TTY checklist vs piped prompt (P10)", () => {
    const TWO = [
      {
        harness: "claude-code",
        projectPath: "/home/dev/app",
        displayName: "app",
        sessions: 3,
        lastActiveAt: null,
        importable: true,
        remote: "codehub.example/dev/app",
      },
      {
        harness: "claude-code",
        projectPath: "/home/dev/other",
        displayName: "other",
        sessions: 1,
        lastActiveAt: null,
        importable: true,
      },
    ];

    it("a non-TTY stdin uses the existing path", async () => {
      const restore = withStdinTTY(false);
      try {
        scanHarnessesMock.mockResolvedValue(TWO);
        askMock.mockResolvedValue("2");

        await setup({ deviceName: "test-box" });

        expect(checklistMock).not.toHaveBeenCalled();
        expect(askMock).toHaveBeenCalledWith("Sync all? [Y/n] or list numbers to exclude: ");
        const [written] = saveSyncAllowlistMock.mock.calls[0];
        expect(written.harnesses["claude-code"].projects).toEqual([
          { path: "/home/dev/app", enabled: true },
          { path: "/home/dev/other", enabled: false },
        ]);
      } finally {
        restore();
      }
    });

    it("a TTY stdin renders the checklist and writes exactly the checked projects", async () => {
      const restore = withStdinTTY(true);
      try {
        scanHarnessesMock.mockResolvedValue(TWO);
        // The user unchecked row 1 and kept row 2.
        checklistMock.mockResolvedValue({ selected: [1], cancelled: false });

        await setup({ deviceName: "test-box" });

        expect(askMock).not.toHaveBeenCalled();
        expect(checklistMock).toHaveBeenCalledTimes(1);
        const [labels, options] = checklistMock.mock.calls[0] as unknown as [string[], { header?: string }];
        expect(labels).toEqual([
          "1. Claude Code · app — 3 session(s) [codehub.example/dev/app]",
          "2. Claude Code · other — 1 session(s)",
        ]);
        expect(options.header).toBeTruthy();
        const [written] = saveSyncAllowlistMock.mock.calls[0];
        expect(written.harnesses["claude-code"].projects).toEqual([
          { path: "/home/dev/app", enabled: false },
          { path: "/home/dev/other", enabled: true },
        ]);
      } finally {
        restore();
      }
    });

    it("re-run: the checklist preselects from sync.json — previously excluded stay unchecked, new projects follow defaultNewProjects", async () => {
      const restore = withStdinTTY(true);
      try {
        const THREE = [
          ...TWO,
          {
            harness: "claude-code",
            projectPath: "/home/dev/new",
            displayName: "new",
            sessions: 1,
            lastActiveAt: null,
            importable: true,
          },
        ];
        scanHarnessesMock.mockResolvedValue(THREE);
        loadSyncAllowlistMock.mockReturnValue({
          version: 1,
          updatedAt: "2026-09-01T00:00:00.000Z",
          defaultNewProjects: true,
          harnesses: {
            "claude-code": {
              projects: [
                { path: "/home/dev/app", enabled: false },
                { path: "/home/dev/other", enabled: true },
              ],
            },
          },
        });
        checklistMock.mockResolvedValue({ selected: [1, 2], cancelled: false });

        await setup({ deviceName: "test-box" });

        const [, options] = checklistMock.mock.calls[0] as unknown as [string[], { preselected?: number[] }];
        expect(options.preselected).toEqual([1, 2]); // app (excluded before) unchecked; other + new checked

        // defaultNewProjects: false → a never-seen project starts unchecked.
        checklistMock.mockClear();
        loadSyncAllowlistMock.mockReturnValue({
          version: 1,
          updatedAt: "2026-09-01T00:00:00.000Z",
          defaultNewProjects: false,
          harnesses: {
            "claude-code": {
              projects: [
                { path: "/home/dev/app", enabled: false },
                { path: "/home/dev/other", enabled: true },
              ],
            },
          },
        });
        await setup({ deviceName: "test-box" });
        const [, opts2] = checklistMock.mock.calls[0] as unknown as [string[], { preselected?: number[] }];
        expect(opts2.preselected).toEqual([1]);
      } finally {
        restore();
      }
    });

    it("ctrl-c in the checklist writes nothing and stops setup with exit code 130", async () => {
      const restore = withStdinTTY(true);
      try {
        scanHarnessesMock.mockResolvedValue(TWO);
        checklistMock.mockResolvedValue({ selected: [0, 1], cancelled: true });
        const logSpy = vi.spyOn(console, "log");

        await setup({ deviceName: "test-box" });

        expect(saveSyncAllowlistMock).not.toHaveBeenCalled();
        expect(importSessionsMock).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(130);
        expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/sync selection not saved/);
      } finally {
        restore();
      }
    });

    it("--yes and --exclude never open the checklist, even on a TTY", async () => {
      const restore = withStdinTTY(true);
      try {
        scanHarnessesMock.mockResolvedValue(TWO);
        await setup({ yes: true });
        await setup({ exclude: "1", deviceName: "test-box" });
        expect(checklistMock).not.toHaveBeenCalled();
        expect(askMock).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });

  it("skips re-prompting when sync.json already covers every scanned project", async () => {
    const scanned = [
      {
        harness: "claude-code",
        projectPath: "/home/dev/app",
        displayName: "app",
        sessions: 3,
        lastActiveAt: null,
        importable: true,
      },
    ];
    scanHarnessesMock.mockResolvedValue(scanned);
    loadSyncAllowlistMock.mockReturnValue({
      version: 1,
      harnesses: { "claude-code": { projects: [{ path: "/home/dev/app", enabled: true }] } },
      updatedAt: "earlier",
    });

    // deviceName bypasses the other prompt (#137) so this assertion stays
    // focused on the sync-selection prompt it's actually testing.
    await setup({ deviceName: "test-box" });

    expect(askMock).not.toHaveBeenCalled();
    expect(saveSyncAllowlistMock).not.toHaveBeenCalled();
  });

  it("runs the first import with the resolved apiUrl/apiKey, once per harness (finding 11 — every DEFAULT_IMPORT_SOURCES entry)", async () => {
    await setup({ yes: true });
    expect(importSessionsMock).toHaveBeenCalledTimes(2);
    expect(importSessionsMock).toHaveBeenCalledWith({
      apiUrl: "https://membral.me",
      apiKey: "lls_key",
      source: "claude-code",
      since: expect.any(String),
    });
    expect(importSessionsMock).toHaveBeenCalledWith({
      apiUrl: "https://membral.me",
      apiKey: "lls_key",
      source: "opencode",
      since: expect.any(String),
    });
  });

  it("stops the first import at the first source whose key was rejected, and skips the report", async () => {
    importSessionsMock.mockResolvedValue({
      ok: false,
      totalImported: 0,
      totalErrored: 0,
      totalSessions: 2,
      authRejected: true,
      sessionFacts: [{ harness: "claude-code", startedAt: "2026-09-20T08:00:00Z", isSubAgent: false }],
    });
    const logSpy = vi.spyOn(console, "log");
    await setup({ yes: true });
    expect(importSessionsMock).toHaveBeenCalledTimes(1);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toContain("Found on this machine");
  });

  it("prints the first-run report built from the imported sessions' facts", async () => {
    importSessionsMock.mockImplementation(async (o: { source: string }) => ({
      ok: true,
      totalImported: 2,
      totalErrored: 0,
      totalSessions: 2,
      sessionFacts:
        o.source === "claude-code"
          ? [
              { harness: "claude-code", startedAt: "2026-09-20T08:00:00Z", isSubAgent: false },
              { harness: "claude-code", startedAt: "2026-09-21T08:00:00Z", isSubAgent: true },
            ]
          : [],
    }));
    const logSpy = vi.spyOn(console, "log");
    await setup({ yes: true });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Found on this machine, last 30 days: 2 sessions");
    expect(out).toContain("Sub-agents: 1 of 2 (50%)");
  });

  it("skips the first-run report when nothing imported and errors occurred", async () => {
    importSessionsMock.mockResolvedValue({
      ok: false,
      totalImported: 0,
      totalErrored: 2,
      totalSessions: 2,
      sessionFacts: [{ harness: "claude-code", startedAt: "2026-09-20T08:00:00Z", isSubAgent: false }],
    });
    const logSpy = vi.spyOn(console, "log");
    await setup({ yes: true });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toContain("Found on this machine");
  });

  it("first import is bounded to the last 30 days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
    try {
      await setup({ yes: true });
    } finally {
      vi.useRealTimers();
    }
    for (const c of importSessionsMock.mock.calls) {
      expect((c[0] as { since?: string }).since).toBe("2026-09-02T12:00:00.000Z");
    }
    expect(importSessionsMock).toHaveBeenCalledTimes(2);
  });

  // Issue #136: setup must validate the resolved key BEFORE writing the MCP
  // config, not just trust flag > env > credentials.json precedence blindly.
  describe("key validation (issue #136)", () => {
    it("uses resolveValidatedCredentials' apiUrl/apiKey (not the plain resolvers) for import/MCP", async () => {
      resolveValidatedCredentialsMock.mockResolvedValue({
        apiUrl: "https://from-validated.example",
        apiUrlSource: "credentials",
        apiKey: "lls_validated",
        apiKeySource: "credentials",
        validation: { status: "valid" },
      });

      await setup({ yes: true });

      expect(importSessionsMock).toHaveBeenCalledWith({
        apiUrl: "https://from-validated.example",
        apiKey: "lls_validated",
        source: "claude-code",
        since: expect.any(String),
      });
      expect(importSessionsMock).toHaveBeenCalledWith({
        apiUrl: "https://from-validated.example",
        apiKey: "lls_validated",
        source: "opencode",
        since: expect.any(String),
      });
    });

    it("prints the one-line fallback warning and PROCEEDS when env failed validation but credentials.json's key worked", async () => {
      resolveValidatedCredentialsMock.mockResolvedValue({
        apiUrl: "https://membral.me",
        apiUrlSource: "credentials",
        apiKey: "lls_from_creds",
        apiKeySource: "credentials",
        validation: { status: "valid" },
        fallbackWarning: "The MEMBRAL_API_KEY environment variable was rejected (401) — using credentials.json.",
      });

      detectToolsMock.mockResolvedValue([
        { name: "Claude Desktop", id: "claude-desktop", configPath: "/mock/config.json", detected: true },
      ]);

      const logSpy = vi.spyOn(console, "log");
      await setup({ yes: true });

      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("MEMBRAL_API_KEY environment variable was rejected");
      // Proceeded — this is the "fallback succeeded" outcome, not a stop.
      expect(process.exitCode).toBe(0);
      expect(importSessionsMock).toHaveBeenCalledWith({
        apiUrl: "https://membral.me",
        apiKey: "lls_from_creds",
        source: "claude-code",
        since: expect.any(String),
      });
      expect(importSessionsMock).toHaveBeenCalledWith({
        apiUrl: "https://membral.me",
        apiKey: "lls_from_creds",
        source: "opencode",
        since: expect.any(String),
      });
      expect(configureMCPServerMock).toHaveBeenCalled();
    });

    it("stops BEFORE configuring MCP when validation finds no working key", async () => {
      resolveValidatedCredentialsMock.mockResolvedValue({
        apiUrl: "https://membral.me",
        apiUrlSource: "env",
        apiKey: "lls_stale_env",
        apiKeySource: "env",
        validation: { status: "invalid", httpStatus: 401 },
      });

      const errorSpy = vi.spyOn(console, "error");
      await setup({ yes: true });

      expect(process.exitCode).toBe(1);
      expect(configureMCPServerMock).not.toHaveBeenCalled();
      expect(importSessionsMock).not.toHaveBeenCalled();
      const output = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("AUTH REJECTION MESSAGE");
    });

    it("--dry-run never calls resolveValidatedCredentials (no real network call)", async () => {
      await setup({ dryRun: true });
      expect(resolveValidatedCredentialsMock).not.toHaveBeenCalled();
    });
  });

  describe("Codex (W9)", () => {
    const written = (outcome: string) => ({
      mcp: { path: "/h/.codex/config.toml", outcome },
      hooks: { path: "/h/.codex/hooks.json", outcome },
      agents: { path: "/h/.codex/AGENTS.md", outcome },
    });
    beforeEach(() => {
      detectCodexMock.mockReset();
      detectCodexMock.mockResolvedValue(false);
      setupCodexMock.mockReset();
    });

    it("configures Codex when detected, printing one line plus the approve-hook action", async () => {
      detectCodexMock.mockResolvedValue(true);
      setupCodexMock.mockResolvedValue(written("created"));
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
      await setup({ yes: true });
      spy.mockRestore();
      expect(setupCodexMock).toHaveBeenCalledWith({ apiUrl: "https://membral.me", dryRun: undefined });
      const line = logs.find((l) => l.startsWith("  Codex: "));
      expect(line).toContain("/h/.codex/config.toml created");
      expect(line).toContain("/h/.codex/hooks.json created");
      expect(line).toContain("/h/.codex/AGENTS.md created");
      expect(logs).toContain("  Action: APPROVE THE HOOK");
    });

    it("no approve line when the hook is unchanged", async () => {
      detectCodexMock.mockResolvedValue(true);
      setupCodexMock.mockResolvedValue(written("unchanged"));
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
      await setup({ yes: true });
      spy.mockRestore();
      expect(logs.some((l) => l.includes("APPROVE THE HOOK"))).toBe(false);
    });

    it("skips Codex when not detected and no Codex sessions were scanned", async () => {
      await setup({ yes: true });
      expect(setupCodexMock).not.toHaveBeenCalled();
    });
  });

  it("configures MCP for every detected tool as the last step", async () => {
    detectToolsMock.mockResolvedValue([
      { name: "Claude Desktop", id: "claude-desktop", configPath: "/mock/config.json", detected: true },
      { name: "Cursor", id: "cursor", configPath: "/mock/cursor.json", detected: false },
    ]);

    await setup({ yes: true });

    expect(configureMCPServerMock).toHaveBeenCalledTimes(1);
    expect(configureMCPServerMock).toHaveBeenCalledWith("claude-desktop", "/mock/config.json", {
      apiUrl: "https://membral.me",
      apiKey: "lls_key",
    });
  });

  it("caps a large ungroupable harness listing to the most recently active MAX_LISTED_PER_HARNESS, summarizing the rest", async () => {
    // Reproduces a real-world case: opencode/codex degrade to one "project"
    // per un-groupable file (no discoverable cwd) — a real machine can have
    // hundreds. The table must stay usable.
    const many = Array.from({ length: 45 }, (_, i) => ({
      harness: "opencode" as const,
      projectPath: `/tmp/file-${i}.json`,
      displayName: `file-${i}.json`,
      sessions: 1,
      lastActiveAt: new Date(2026, 0, i + 1).toISOString(),
      importable: false,
    }));
    scanHarnessesMock.mockResolvedValue(many);

    const logSpy = vi.spyOn(console, "log");
    await setup({ yes: true });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("45 project(s)");
    expect(output).toContain("... and 25 more");

    // Only the 20 shown/numbered ones get written to sync.json.
    const [written] = saveSyncAllowlistMock.mock.calls[0];
    expect(written.harnesses.opencode.projects).toHaveLength(20);
    // Most recently active (highest index, i=44) shown first.
    expect(written.harnesses.opencode.projects[0].path).toBe("/tmp/file-44.json");
  });

  it("prints the final nudge toward chat import and the extension", async () => {
    const logSpy = vi.spyOn(console, "log");
    await setup({ yes: true });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Your chats aren't in Membral yet");
    expect(output).toContain("membral import");
  });

  // Issue #137: the machine-name prompt (Step 2) — root cause was an
  // existing device.json name winning forever with no prompt or rename
  // path.
  describe("machine-name prompt (issue #137)", () => {
    it("prompts with the hostname as the default when no device.json name exists yet", async () => {
      peekDeviceNameMock.mockReturnValue(undefined);
      askMock.mockResolvedValueOnce("chosen-name");

      await setup({});

      expect(askMock).toHaveBeenCalledWith("Name this machine [unit-test-host]: ");
      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({ deviceName: "chosen-name" });
    });

    it("shows the existing device.json name as the default, not the hostname", async () => {
      peekDeviceNameMock.mockReturnValue("login-e2e");
      askMock.mockResolvedValueOnce("real-laptop");

      await setup({});

      expect(askMock).toHaveBeenCalledWith("Name this machine [login-e2e]: ");
      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({ deviceName: "real-laptop" });
    });

    it("an empty answer keeps the shown default", async () => {
      peekDeviceNameMock.mockReturnValue(undefined);
      askMock.mockResolvedValueOnce(""); // blank

      await setup({});

      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({ deviceName: "unit-test-host" });
    });

    it("--device-name bypasses the prompt with an explicit name", async () => {
      await setup({ deviceName: "explicit-name" });

      expect(askMock).not.toHaveBeenCalled();
      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({ deviceName: "explicit-name" });
    });

    it("MEMBRAL_DEVICE_NAME bypasses the prompt with an explicit name", async () => {
      process.env.MEMBRAL_DEVICE_NAME = "env-name";

      await setup({});

      expect(askMock).not.toHaveBeenCalled();
      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({ deviceName: "env-name" });
    });

    it("--yes bypasses the prompt, keeping the existing name/hostname default (no forced rename)", async () => {
      await setup({ yes: true });

      expect(askMock).not.toHaveBeenCalled();
      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({});
    });

    it("--dry-run bypasses the prompt", async () => {
      await setup({ dryRun: true });

      expect(askMock).not.toHaveBeenCalled();
      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({});
    });
  });
});
