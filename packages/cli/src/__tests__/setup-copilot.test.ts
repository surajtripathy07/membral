// `membral setup` with Copilot present but no Copilot session yet — the mock
// set mirrors setup.test.ts. Every I/O-touching collaborator
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

const installCopilotCliMcpMock = vi.fn();
vi.mock("../copilot-cli-mcp.js", () => ({
  installCopilotCliMcp: (...a: unknown[]) => installCopilotCliMcpMock(...a),
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

import { setup } from "../setup.js";

const CREDS = { email: "a@b.com", apiUrl: "https://membral.me", apiKey: "lls_key", userId: "u1", createdAt: "now" };
const VSCODE_ONLY = {
  cliOnPath: false,
  copilotHome: false,
  vscodeUserDirs: ["/home/test/Library/Application Support/Code/User"],
  vscodeExtension: false,
  present: true,
};

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((c) => c.join(" "))
    .join("\n");
}

describe("plain setup with Copilot present", () => {
  beforeEach(() => {
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
    installCopilotCliMcpMock.mockResolvedValue({ path: "/home/test/.copilot/mcp-config.json", outcome: "created" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.MEMBRAL_DEVICE_NAME;
    process.exitCode = 0;
  });

  it.each([
    ["VS Code User dir only", VSCODE_ONLY],
    ["Copilot Chat extension only", { ...NO_COPILOT, vscodeExtension: true, present: true }],
  ])("%s, zero Copilot sessions: hooks + ~/.copilot MCP + instructions", async (_label, presence) => {
    detectCopilotMock.mockResolvedValue(presence);
    await setup({ yes: true });
    expect(installCopilotCliHooksMock).toHaveBeenCalledWith({ dryRun: undefined });
    expect(installCopilotCliMcpMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: "https://membral.me", apiKey: "lls_key" }),
    );
    expect(writeUserInstructionsMock).toHaveBeenCalledTimes(1);
    expect(setupCopilotVscodeMock).not.toHaveBeenCalled();
    expect(output()).toContain("Copilot instructions: created");
  });

  it("Copilot CLI on PATH only: hooks + MCP, no instructions file", async () => {
    detectCopilotMock.mockResolvedValue({ ...NO_COPILOT, cliOnPath: true, present: true });
    await setup({ yes: true });
    expect(installCopilotCliHooksMock).toHaveBeenCalledTimes(1);
    expect(installCopilotCliMcpMock).toHaveBeenCalledTimes(1);
    expect(writeUserInstructionsMock).not.toHaveBeenCalled();
  });

  it("no Copilot anywhere: no Copilot writes", async () => {
    await setup({ yes: true });
    expect(installCopilotCliHooksMock).not.toHaveBeenCalled();
    expect(installCopilotCliMcpMock).not.toHaveBeenCalled();
    expect(writeUserInstructionsMock).not.toHaveBeenCalled();
    expect(output()).toContain("Copilot CLI hooks: skipped (Copilot not found)");
  });

  it("--dry-run with VS Code present writes nothing", async () => {
    detectCopilotMock.mockResolvedValue(VSCODE_ONLY);
    await setup({ yes: true, dryRun: true });
    expect(writeUserInstructionsMock).not.toHaveBeenCalled();
    expect(installCopilotCliHooksMock).toHaveBeenCalledWith({ dryRun: true });
    expect(output()).toContain("[dry-run] would write /home/test/.copilot/instructions/membral.instructions.md.");
    expect(output()).toContain("Copilot instructions: would write (dry-run)");
  });

  it("detection or instructions failures are reported and setup carries on", async () => {
    detectCopilotMock.mockRejectedValueOnce(new Error("EACCES"));
    await setup({ yes: true });
    expect(output()).toContain("Copilot detection: failed (EACCES)");

    detectCopilotMock.mockResolvedValue(VSCODE_ONLY);
    writeUserInstructionsMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(setup({ yes: true })).resolves.not.toThrow();
    expect(output()).toContain("Copilot instructions: failed (disk full)");
    expect(output()).toContain("Importing sessions");
  });
});
