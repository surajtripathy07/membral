// The 30-day default upload window (import-window.ts) and its wiring in
// `membral sessions` and setup's first import. The sweep full-walk bound is
// covered in sweep-command.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IMPORT_WINDOW_DAYS, defaultImportSince, resolveImportSince } from "../import-window.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const WINDOW_START = "2026-09-02T12:00:00.000Z";

describe("import window helpers", () => {
  it("is 30 days", () => {
    expect(DEFAULT_IMPORT_WINDOW_DAYS).toBe(30);
    expect(defaultImportSince(NOW)).toBe(WINDOW_START);
  });

  it("no flags -> window; --all -> no since; explicit --since wins (even with --all)", () => {
    expect(resolveImportSince({}, NOW)).toBe(WINDOW_START);
    expect(resolveImportSince({ all: true }, NOW)).toBeUndefined();
    expect(resolveImportSince({ since: "2025-01-01" }, NOW)).toBe("2025-01-01");
    expect(resolveImportSince({ since: "2025-01-01", all: true }, NOW)).toBe("2025-01-01");
  });
});

const importSessionsMock = vi.fn();
vi.mock("../import-sessions.js", () => ({
  importSessions: (...a: unknown[]) => importSessionsMock(...a),
  sendHeartbeatPing: vi.fn(async () => true),
  DEFAULT_IMPORT_SOURCES: ["claude-code"],
}));
vi.mock("../import-lock.js", () => ({ acquireImportLock: () => ({ release: () => {} }) }));
vi.mock("../memory-kick.js", () => ({ kickMemoryExtraction: vi.fn(async () => ({ ok: true })) }));

describe("membral sessions window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    importSessionsMock.mockReset();
    importSessionsMock.mockResolvedValue({ ok: true, totalSessions: 1 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function runSessions(args: string[]): Promise<string> {
    const { sessionsCommand } = await import("../commands/sessions.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sessionsCommand.run(args);
    return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
  }
  const sinceArg = () => (importSessionsMock.mock.calls[0] as [{ since?: string }])[0].since;

  it("without --since uses the 30-day window and says so", async () => {
    const out = await runSessions([]);
    expect(sinceArg()).toBe(WINDOW_START);
    expect(out).toContain("Importing sessions from the last 30 days (use --all for older history).");
  });

  it("--all disables the window", async () => {
    const out = await runSessions(["--all"]);
    expect(sinceArg()).toBeUndefined();
    expect(out).not.toContain("last 30 days");
  });

  it("explicit --since wins over the window", async () => {
    await runSessions(["--since", "2026-01-01"]);
    expect(sinceArg()).toBe("2026-01-01");
  });

  it("--force stays bound by the window unless --since/--all is given", async () => {
    await runSessions(["--force"]);
    expect(sinceArg()).toBe(WINDOW_START);
    expect((importSessionsMock.mock.calls[0] as [{ force?: boolean }])[0].force).toBe(true);
  });
});
