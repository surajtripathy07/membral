// `membral sessions` across several harnesses: once one source reports the
// API key rejected, the others (same key, same server) are skipped with a
// line saying so, and the memory-extraction kick is not sent (2026-10-08:
// three sources and the kick each 401ed in turn).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const importSessionsMock = vi.fn();
const kickMock = vi.fn(async () => ({ ok: true }));
vi.mock("../import-sessions.js", () => ({
  importSessions: (...a: unknown[]) => importSessionsMock(...a),
  sendHeartbeatPing: vi.fn(async () => true),
  DEFAULT_IMPORT_SOURCES: ["claude-code", "opencode", "copilot-cli"],
}));
vi.mock("../import-lock.js", () => ({ acquireImportLock: () => ({ release: () => {} }) }));
vi.mock("../memory-kick.js", () => ({ kickMemoryExtraction: (...a: unknown[]) => kickMock(...(a as [])) }));

describe("membral sessions after a rejected key", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    importSessionsMock.mockReset();
    kickMock.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function run(): Promise<void> {
    const { sessionsCommand } = await import("../commands/sessions.js");
    await sessionsCommand.run(["--api-key", "lls_test_key_123", "--api-url", "https://cloud.example.com"]);
  }

  it("skips the remaining sources and the kick, and exits 1", async () => {
    importSessionsMock.mockResolvedValue({
      ok: false,
      totalImported: 0,
      totalErrored: 0,
      totalSessions: 5,
      authRejected: true,
    });
    await run();
    expect(importSessionsMock).toHaveBeenCalledTimes(1);
    expect(kickMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const err = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toContain("Skipped opencode, copilot-cli: the API key was rejected (see above).");
  });

  it("an ordinary failure still runs every source and the kick", async () => {
    importSessionsMock.mockResolvedValue({ ok: false, totalImported: 0, totalErrored: 1, totalSessions: 5 });
    await run();
    expect(importSessionsMock).toHaveBeenCalledTimes(3);
    expect(kickMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
