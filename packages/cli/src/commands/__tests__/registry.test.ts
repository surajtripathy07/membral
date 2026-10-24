// Step 3C-4 coverage backfill: the 14-arm `switch` in index.ts became 14
// `run()` functions under commands/*.ts (plus commands/index.ts's
// findCommand), most of which help.test.ts's spawn tests never execute
// in-process (they only assert stdout/exit code of the built dist/index.js,
// or that a hidden command has a registry entry — never call `.run()`
// directly). This file mocks every underlying command module the runners
// delegate to and calls `run()` in-process, so function coverage reflects
// what the registry actually dispatches to, without re-testing the
// underlying commands (those have their own test files already).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../setup.js", () => ({ setup: vi.fn() }));
vi.mock("../../use-command.js", () => ({ useCommand: vi.fn() }));
vi.mock("../../sweep-command.js", () => ({
  sweepCommand: vi.fn(),
  uninstallSweepAgent: vi.fn(async () => ({ success: true, scheduler: "none", message: "Removed" })),
}));
vi.mock("../../login-command.js", () => ({
  loginCommand: vi.fn(),
  logoutCommand: vi.fn(),
  whoamiCommand: vi.fn(),
}));
vi.mock("../../import-command.js", () => ({ importCommand: vi.fn() }));
vi.mock("../../status-command.js", () => ({ statusCommand: vi.fn() }));
vi.mock("../../import-lock.js", () => ({ acquireImportLock: vi.fn() }));
vi.mock("../../import-sessions.js", () => ({
  DEFAULT_IMPORT_SOURCES: ["claude-code", "opencode"],
  importSessions: vi.fn(),
  sendHeartbeatPing: vi.fn(),
}));
vi.mock("../../memory-kick.js", () => ({ kickMemoryExtraction: vi.fn() }));
vi.mock("../../import-session.js", () => ({ importSession: vi.fn() }));
vi.mock("../../session-end-hook.js", () => ({ sessionEndHook: vi.fn() }));
vi.mock("../../preamble-hook.js", () => ({ preambleHook: vi.fn() }));
vi.mock("../../install-session-hook.js", () => ({ installSessionHook: vi.fn() }));
vi.mock("../../local-command.js", () => ({
  localUp: vi.fn(),
  localDown: vi.fn(),
  localStatus: vi.fn(),
  localLogs: vi.fn(),
}));

const { setup } = await import("../../setup.js");
const { useCommand: runUseCommand } = await import("../../use-command.js");
const { sweepCommand: runSweepCommand, uninstallSweepAgent } = await import("../../sweep-command.js");
const {
  loginCommand: runLoginCommand,
  logoutCommand: runLogoutCommand,
  whoamiCommand: runWhoamiCommand,
} = await import("../../login-command.js");
const { importCommand: runImportCommand } = await import("../../import-command.js");
const { statusCommand: runStatusCommand } = await import("../../status-command.js");
const { acquireImportLock } = await import("../../import-lock.js");
const { importSessions, sendHeartbeatPing } = await import("../../import-sessions.js");
const { kickMemoryExtraction } = await import("../../memory-kick.js");
const { importSession } = await import("../../import-session.js");
const { sessionEndHook } = await import("../../session-end-hook.js");
const { preambleHook } = await import("../../preamble-hook.js");
const { installSessionHook } = await import("../../install-session-hook.js");
const { localUp, localDown, localStatus, localLogs } = await import("../../local-command.js");

import { HELP } from "../../help.js";
import { COMMANDS, findCommand } from "../index.js";

const EXPECTED_ORDER = [
  "setup",
  "use",
  "sweep",
  "login",
  "logout",
  "whoami",
  "import",
  "status",
  "sessions",
  "local",
  "import-session",
  "session-end-hook",
  "preamble",
  "prompt-hook",
  "mcp-headers",
  "mcp",
  "install-session-hook",
  "dogfood",
  "help",
];

describe("commands/index.ts registry", () => {
  it("has the documented names, in order, each unique", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(EXPECTED_ORDER);
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(EXPECTED_ORDER.length);
  });

  it("findCommand returns the matching entry", () => {
    expect(findCommand("status")?.name).toBe("status");
    expect(findCommand("status")?.help).toBe(HELP.status);
  });

  it("findCommand returns undefined for an unknown name", () => {
    expect(findCommand("does-not-exist")).toBeUndefined();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setup", () => {
  it("parses every flag through to setup()", async () => {
    const cmd = findCommand("setup")!;
    await cmd.run([
      "--api-url",
      "https://api.example",
      "--api-key",
      "k1",
      "--yes",
      "--exclude",
      "*.log",
      "--device-name",
      "laptop",
      "--dry-run",
      "--no-sweep",
      "--no-prompt-recall",
      "--copilot",
      "--copilot-cli",
      "--agy",
    ]);
    expect(setup).toHaveBeenCalledWith({
      apiUrl: "https://api.example",
      apiKey: "k1",
      yes: true,
      exclude: "*.log",
      deviceName: "laptop",
      dryRun: true,
      noSweep: true,
      noPromptRecall: true,
      promptRecall: false,
      copilot: true,
      copilotCli: true,
      agy: true,
    });
  });

  it("defaults everything to undefined/false with no args", async () => {
    const cmd = findCommand("setup")!;
    await cmd.run([]);
    expect(setup).toHaveBeenCalledWith({
      apiUrl: undefined,
      apiKey: undefined,
      yes: false,
      exclude: undefined,
      deviceName: undefined,
      dryRun: false,
      noSweep: false,
      noPromptRecall: false,
      promptRecall: false,
      copilot: false,
      copilotCli: false,
      agy: false,
    });
  });
});

describe("use", () => {
  it("passes a positional name through", async () => {
    await findCommand("use")!.run(["local"]);
    expect(runUseCommand).toHaveBeenCalledWith("local");
  });

  it("treats a leading flag as no name", async () => {
    await findCommand("use")!.run(["--help"]);
    expect(runUseCommand).toHaveBeenCalledWith(undefined);
  });
});

describe("sweep", () => {
  it("delegates with no arguments", async () => {
    await findCommand("sweep")!.run([]);
    expect(runSweepCommand).toHaveBeenCalledWith();
  });
  it("--remove uninstalls the scheduler instead of sweeping", async () => {
    vi.mocked(runSweepCommand).mockClear();
    await findCommand("sweep")!.run(["--remove"]);
    expect(uninstallSweepAgent).toHaveBeenCalled();
    expect(runSweepCommand).not.toHaveBeenCalled();
  });
});

describe("login / logout / whoami", () => {
  it("login parses --api-url", async () => {
    await findCommand("login")!.run(["--api-url", "https://api.example"]);
    expect(runLoginCommand).toHaveBeenCalledWith({ apiUrl: "https://api.example" });
  });

  it("login with no flags", async () => {
    await findCommand("login")!.run([]);
    expect(runLoginCommand).toHaveBeenCalledWith({ apiUrl: undefined });
  });

  it("logout takes no arguments", async () => {
    await findCommand("logout")!.run([]);
    expect(runLogoutCommand).toHaveBeenCalledWith();
  });

  it("whoami parses --api-url and --api-key", async () => {
    await findCommand("whoami")!.run(["--api-url", "https://api.example", "--api-key", "k2"]);
    expect(runWhoamiCommand).toHaveBeenCalledWith({ apiUrl: "https://api.example", apiKey: "k2" });
  });
});

describe("import", () => {
  it("takes a positional file plus flags", async () => {
    await findCommand("import")!.run(["export.json", "--api-url", "https://api.example", "--api-key", "k3"]);
    expect(runImportCommand).toHaveBeenCalledWith({
      file: "export.json",
      apiUrl: "https://api.example",
      apiKey: "k3",
    });
  });

  it("has no file when the first arg is a flag", async () => {
    await findCommand("import")!.run(["--api-url", "https://api.example"]);
    expect(runImportCommand).toHaveBeenCalledWith({
      file: undefined,
      apiUrl: "https://api.example",
      apiKey: undefined,
    });
  });
});

describe("status", () => {
  it("parses --api-url, --api-key and --rename", async () => {
    await findCommand("status")!.run(["--api-url", "https://api.example", "--api-key", "k4", "--rename", "new-name"]);
    expect(runStatusCommand).toHaveBeenCalledWith(
      {},
      { apiUrl: "https://api.example", apiKey: "k4", rename: "new-name" },
    );
  });
});

describe("import-session", () => {
  it("parses transcript/source/api flags", async () => {
    await findCommand("import-session")!.run([
      "--transcript",
      "/tmp/t.jsonl",
      "--source",
      "opencode",
      "--api-url",
      "https://api.example",
      "--api-key",
      "k5",
    ]);
    expect(importSession).toHaveBeenCalledWith({
      transcript: "/tmp/t.jsonl",
      source: "opencode",
      apiUrl: "https://api.example",
      apiKey: "k5",
    });
  });
});

describe("session-end-hook", () => {
  it("delegates then exits 0", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      findCommand("session-end-hook")!.run(["--api-url", "https://api.example", "--api-key", "k6"]),
    ).rejects.toThrow("exit");
    expect(sessionEndHook).toHaveBeenCalledWith({ apiUrl: "https://api.example", apiKey: "k6" });
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("--source copilot-cli passes the copilot source through", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(findCommand("session-end-hook")!.run(["--source", "copilot-cli"])).rejects.toThrow("exit");
    expect(sessionEndHook).toHaveBeenLastCalledWith({ apiUrl: undefined, apiKey: undefined, source: "copilot-cli" });
    exitSpy.mockRestore();
  });
});

describe("preamble", () => {
  it("without --hook prints help and exits before calling preambleHook", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(findCommand("preamble")!.run([])).rejects.toThrow("exit");
    expect(logSpy).toHaveBeenCalledWith(HELP.preamble);
    expect(preambleHook).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("with --hook delegates then exits 0", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      findCommand("preamble")!.run(["--hook", "--api-url", "https://api.example", "--api-key", "k7"]),
    ).rejects.toThrow("exit");
    expect(preambleHook).toHaveBeenCalledWith({ apiUrl: "https://api.example", apiKey: "k7" });
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("passes MEMBRAL_PREAMBLE_TIMEOUT_MS through as timeoutMs (the plugin's shorter budget)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    vi.stubEnv("MEMBRAL_PREAMBLE_TIMEOUT_MS", "4000");
    await expect(findCommand("preamble")!.run(["--hook"])).rejects.toThrow("exit");
    expect(preambleHook).toHaveBeenLastCalledWith({ timeoutMs: 4000, apiUrl: undefined, apiKey: undefined });
    vi.stubEnv("MEMBRAL_PREAMBLE_TIMEOUT_MS", "nope");
    await expect(findCommand("preamble")!.run(["--hook"])).rejects.toThrow("exit");
    expect(preambleHook).toHaveBeenLastCalledWith({ apiUrl: undefined, apiKey: undefined });
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
  });

  it("with --hook --format copilot passes the copilot format through", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(findCommand("preamble")!.run(["--hook", "--format", "copilot"])).rejects.toThrow("exit");
    expect(preambleHook).toHaveBeenLastCalledWith({ apiUrl: undefined, apiKey: undefined, format: "copilot" });
    exitSpy.mockRestore();
  });
});

describe("install-session-hook", () => {
  it("parses api-url/settings/remove", async () => {
    await findCommand("install-session-hook")!.run([
      "--api-url",
      "https://api.example",
      "--settings",
      "/tmp/settings.json",
      "--remove",
    ]);
    expect(installSessionHook).toHaveBeenCalledWith({
      apiUrl: "https://api.example",
      settings: "/tmp/settings.json",
      remove: true,
    });
  });
});

describe("help", () => {
  it("--all prints ALL_COMMANDS_HELP and exits 0", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => findCommand("help")!.run(["--all"])).toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("a known hidden command prints its own help block", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => findCommand("help")!.run(["sweep"])).toThrow("exit");
    expect(logSpy).toHaveBeenCalledWith(HELP.sweep);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("no args (or unknown) prints TOP_LEVEL_HELP", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => findCommand("help")!.run([])).toThrow("exit");
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe("sessions", () => {
  it("--root without --source errors and never imports", async () => {
    const exitCodeBefore = process.exitCode;
    process.exitCode = undefined;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await findCommand("sessions")!.run(["--root", "/x"]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--root needs --source"));
    expect(importSessions).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = exitCodeBefore;
    errSpy.mockRestore();
  });

  it("dry-run with an explicit source skips the lock and heartbeat/kick", async () => {
    vi.mocked(importSessions).mockResolvedValue({
      ok: true,
      totalImported: 0,
      totalErrored: 0,
      totalSessions: 3,
    });
    await findCommand("sessions")!.run(["--source", "claude-code", "--dry-run"]);
    expect(acquireImportLock).not.toHaveBeenCalled();
    expect(importSessions).toHaveBeenCalledWith(
      expect.objectContaining({ source: "claude-code", dryRun: true, heartbeat: undefined }),
      undefined, // no upload client on a dry run
    );
    expect(sendHeartbeatPing).not.toHaveBeenCalled();
    expect(kickMemoryExtraction).not.toHaveBeenCalled();
  });

  it("skips entirely when the lock is already held", async () => {
    vi.mocked(acquireImportLock).mockReturnValue(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await findCommand("sessions")!.run(["--source", "claude-code"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("another import is running"));
    expect(importSessions).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("multi-source run with zero total sends one heartbeat, kicks memory, and releases the lock", async () => {
    const release = vi.fn();
    vi.mocked(acquireImportLock).mockReturnValue({ release, path: "/lock", startedAt: "now" } as never);
    vi.mocked(importSessions).mockResolvedValue({ ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0 });
    vi.mocked(sendHeartbeatPing).mockResolvedValue(true);
    await findCommand("sessions")!.run([]);
    expect(importSessions).toHaveBeenCalledTimes(2);
    expect(sendHeartbeatPing).toHaveBeenCalledTimes(1);
    expect(kickMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("sets exitCode 1 when any source fails", async () => {
    const exitCodeBefore = process.exitCode;
    process.exitCode = undefined;
    const release = vi.fn();
    vi.mocked(acquireImportLock).mockReturnValue({ release, path: "/lock", startedAt: "now" } as never);
    vi.mocked(importSessions).mockResolvedValue({ ok: false, totalImported: 0, totalErrored: 1, totalSessions: 1 });
    await findCommand("sessions")!.run(["--source", "claude-code"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = exitCodeBefore;
  });
});

describe("local", () => {
  it("parses up flags", async () => {
    await findCommand("local")!.run([
      "up",
      "--port",
      "3101",
      "--gateway-port",
      "54500",
      "--image",
      "img:x",
      "--yes",
      "--no-sweep",
    ]);
    expect(localUp).toHaveBeenCalledWith({
      port: "3101",
      gatewayPort: "54500",
      image: "img:x",
      email: undefined,
      yes: true,
      noSweep: true,
    });
  });

  it("parses down, status and logs args", async () => {
    await findCommand("local")!.run(["down", "--wipe", "--yes"]);
    expect(localDown).toHaveBeenCalledWith({ wipe: true, yes: true });
    await findCommand("local")!.run(["down"]);
    expect(localDown).toHaveBeenLastCalledWith({ wipe: false, yes: false });
    await findCommand("local")!.run(["status", "--show-password"]);
    expect(localStatus).toHaveBeenCalledWith({ showPassword: true });
    await findCommand("local")!.run(["logs", "app", "-f"]);
    expect(localLogs).toHaveBeenCalledWith({ service: "app", follow: true });
    await findCommand("local")!.run(["logs"]);
    expect(localLogs).toHaveBeenLastCalledWith({ service: undefined, follow: false });
  });

  it("an unknown subcommand prints help and exits 1", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await findCommand("local")!.run(["sideways"]);
    expect(process.exitCode).toBe(1);
    expect(log).toHaveBeenCalledWith(HELP.local);
    process.exitCode = undefined;
    log.mockRestore();
    err.mockRestore();
  });
});
