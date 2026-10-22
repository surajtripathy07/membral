// `membral status` — read-only. Mocks every collaborator (credentials,
// device, sync allowlist, sweep state) so no real filesystem is touched.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadCredentialsMock = vi.fn();
const resolveCredentialsMock = vi.fn();
// Keep the real describeSource/maskApiKey/etc (pure, no I/O) but replace
// loadCredentials and resolveCredentials — resolveCredentials is mocked
// SEPARATELY (not left to call the real, un-mocked loadCredentials
// internally, which importOriginal's re-export wouldn't intercept) so
// per-test source/masking behavior (issue #136 req 5) is directly
// controllable without touching a real filesystem.
vi.mock("../credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials.js")>();
  return {
    ...actual,
    loadCredentials: (...a: unknown[]) => loadCredentialsMock(...a),
    resolveCredentials: (...a: unknown[]) => resolveCredentialsMock(...a),
    defaultCredentialsPath: () => "/home/test/.membral/credentials.json",
  };
});

const loadOrCreateDeviceIdentityMock = vi.fn((opts?: { deviceName?: string }) => ({
  id: "device-1",
  name: opts?.deviceName || "test-machine",
  platform: "darwin" as const,
}));
vi.mock("../device.js", () => ({
  loadOrCreateDeviceIdentity: (...a: unknown[]) => loadOrCreateDeviceIdentityMock(...(a as [{ deviceName?: string }?])),
  defaultDeviceIdentityPath: () => "/home/test/.membral/device.json",
}));

const loadSyncAllowlistMock = vi.fn();
vi.mock("../sync-allowlist.js", () => ({
  loadSyncAllowlist: (...a: unknown[]) => loadSyncAllowlistMock(...a),
  defaultSyncAllowlistPath: () => "/home/test/.membral/sync.json",
}));

const readSweepStateMock = vi.fn();
vi.mock("../sweep.js", () => ({
  readSweepState: (...a: unknown[]) => readSweepStateMock(...a),
  defaultSweepStatePath: () => "/home/test/.membral/sweep-state.json",
}));

import { envKeyMarkerPath } from "../lib/api-client.js";
import { statusCommand } from "../status-command.js";

describe("statusCommand", () => {
  beforeEach(() => {
    loadSyncAllowlistMock.mockReturnValue(null);
    readSweepStateMock.mockResolvedValue({ last_success_at: "", run_count: 0, runs_since_full_walk: 0 });
    resolveCredentialsMock.mockReturnValue({
      apiKey: "",
      apiKeySource: "none",
      apiUrl: "https://membral.me",
      apiUrlSource: "none",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Never reach the network: tests that need the served-used call pass their own fetchImpl.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nf", { status: 404 })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reports not signed in when there's no credentials file", async () => {
    loadCredentialsMock.mockReturnValue(null);
    const logSpy = vi.spyOn(console, "log");
    await statusCommand();
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("not signed in");
  });

  it("reports the signed-in email when credentials exist", async () => {
    loadCredentialsMock.mockReturnValue({
      email: "a@b.com",
      apiUrl: "https://membral.me",
      apiKey: "k",
      userId: "u1",
      createdAt: "now",
    });
    resolveCredentialsMock.mockReturnValue({
      apiKey: "k",
      apiKeySource: "credentials",
      apiUrl: "https://membral.me",
      apiUrlSource: "credentials",
    });
    const logSpy = vi.spyOn(console, "log");
    await statusCommand();
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("a@b.com");
  });

  // Issue #136 req 5: status prints the api url + source and the key source,
  // key masked — and, critically, shows the env source when MEMBRAL_API_KEY
  // is what's actually active (not silently showing the credentials.json
  // identity as if it were in use).
  describe("credential source reporting (issue #136)", () => {
    it("prints the api url source and a masked key when signed in via credentials.json", async () => {
      loadCredentialsMock.mockReturnValue({
        email: "a@b.com",
        apiUrl: "https://membral.me",
        apiKey: "lls_supersecretvalue",
        userId: "u1",
        createdAt: "now",
      });
      resolveCredentialsMock.mockReturnValue({
        apiKey: "lls_supersecretvalue",
        apiKeySource: "credentials",
        apiUrl: "https://membral.me",
        apiUrlSource: "credentials",
      });
      const logSpy = vi.spyOn(console, "log");
      await statusCommand();
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("https://membral.me");
      expect(output).toContain("credentials.json");
      expect(output).not.toContain("lls_supersecretvalue");
    });

    it("reports the env source (not the credentials.json identity) when MEMBRAL_API_KEY is what's active", async () => {
      loadCredentialsMock.mockReturnValue({
        email: "a@b.com",
        apiUrl: "https://membral.me",
        apiKey: "lls_from_creds",
        userId: "u1",
        createdAt: "now",
      });
      resolveCredentialsMock.mockReturnValue({
        apiKey: "lls_stale_env_key",
        apiKeySource: "env",
        apiUrl: "https://membral.me",
        apiUrlSource: "credentials",
      });
      const logSpy = vi.spyOn(console, "log");
      await statusCommand();
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("MEMBRAL_API_KEY environment variable");
      expect(output).not.toContain("a@b.com");
      expect(output).not.toContain("lls_stale_env_key");
    });
  });

  // R4 4.3 site 1: the upload client's env-key-rejected marker (design note §4), read from disk, no network.
  describe("env-key-rejected marker", () => {
    const envResolved = {
      apiKey: "lls_stale_env_key",
      apiKeySource: "env",
      apiUrl: "https://membral.me",
      apiUrlSource: "credentials",
    };
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "membral-status-marker-"));
      resolveCredentialsMock.mockReturnValue(envResolved);
      loadCredentialsMock.mockReturnValue(null);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("prints the rejected line for a fresh marker, never the key", async () => {
      writeFileSync(
        envKeyMarkerPath(dir, envResolved.apiKey, envResolved.apiUrl),
        JSON.stringify({ at: new Date(Date.now() - 12 * 60_000).toISOString(), url: envResolved.apiUrl }),
      );
      const logSpy = vi.spyOn(console, "log");
      await statusCommand({}, { markerDir: dir });
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain(
        "MEMBRAL_API_KEY was rejected by https://membral.me (12 min ago); using the key from ~/.membral/credentials.json — unset it",
      );
      expect(output).not.toContain("lls_stale_env_key");
    });

    it("prints nothing for an expired marker or none", async () => {
      const logSpy = vi.spyOn(console, "log");
      await statusCommand({}, { markerDir: dir });
      writeFileSync(
        envKeyMarkerPath(dir, envResolved.apiKey, envResolved.apiUrl),
        JSON.stringify({ at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), url: envResolved.apiUrl }),
      );
      await statusCommand({}, { markerDir: dir });
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).not.toContain("was rejected by");
    });
  });

  it("summarizes sync.json when present", async () => {
    loadCredentialsMock.mockReturnValue(null);
    loadSyncAllowlistMock.mockReturnValue({
      version: 1,
      harnesses: {
        "claude-code": {
          projects: [
            { path: "/a", enabled: true },
            { path: "/b", enabled: false },
          ],
        },
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const logSpy = vi.spyOn(console, "log");
    await statusCommand();
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("1/2");
  });

  it("reports the last sweep when sweep-state.json has a successful run", async () => {
    loadCredentialsMock.mockReturnValue(null);
    readSweepStateMock.mockResolvedValue({
      last_success_at: "2026-01-01T00:00:00Z",
      run_count: 5,
      runs_since_full_walk: 2,
    });
    const logSpy = vi.spyOn(console, "log");
    await statusCommand();
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("2026-01-01T00:00:00Z");
    expect(output).toContain("5");
  });

  // Issue #137: `membral status --rename <name>` — a one-shot rename that
  // doesn't require running the rest of `membral setup`.
  describe("--rename", () => {
    it("persists the new name via loadOrCreateDeviceIdentity's --device-name override and reports it", async () => {
      loadCredentialsMock.mockReturnValue(null);
      const logSpy = vi.spyOn(console, "log");

      await statusCommand({}, { rename: "new-box" });

      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({ deviceName: "new-box" });
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain('Renamed to "new-box"');
      expect(output).toContain("new-box (darwin)");
    });

    it("without --rename, doesn't pass a deviceName override", async () => {
      loadCredentialsMock.mockReturnValue(null);
      await statusCommand();
      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({});
    });

    it("a blank --rename is treated as not renaming", async () => {
      loadCredentialsMock.mockReturnValue(null);
      const logSpy = vi.spyOn(console, "log");
      await statusCommand({}, { rename: "   " });
      expect(loadOrCreateDeviceIdentityMock).toHaveBeenCalledWith({});
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).not.toContain("Renamed to");
    });
  });
});

describe("statusCommand served/used line", () => {
  const signedIn = () => {
    loadCredentialsMock.mockReturnValue(null);
    resolveCredentialsMock.mockReturnValue({
      apiKey: "lls_k",
      apiKeySource: "credentials",
      apiUrl: "https://membral.test",
      apiUrlSource: "credentials",
    });
    loadSyncAllowlistMock.mockReturnValue(null);
    readSweepStateMock.mockResolvedValue({ last_success_at: "", run_count: 0, runs_since_full_walk: 0 });
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints one `served ` line when the server answers", async () => {
    signedIn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const body = { days: 7, totals: { served: 3, used: 1, ignored: 1, pending: 1, unlinked: 2 }, surfaces: [] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    await statusCommand({}, { fetchImpl });
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith("served "))).toEqual([
      "served 3 · used 1 · ignored 1 · pending 1 · unlinked 2 (7 days)",
    ]);
  });

  it("prints nothing extra and does not fail on a 404", async () => {
    signedIn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("nf", { status: 404 })) as unknown as typeof fetch;
    await expect(statusCommand({}, { fetchImpl })).resolves.toBeUndefined();
    expect(logSpy.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("served "))).toBe(false);
  });
});

describe("statusCommand membral-on-membral line", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const signedIn = () => {
    loadCredentialsMock.mockReturnValue(null);
    resolveCredentialsMock.mockReturnValue({
      apiKey: "lls_k",
      apiKeySource: "credentials",
      apiUrl: "https://membral.test",
      apiUrlSource: "credentials",
    });
    loadSyncAllowlistMock.mockReturnValue(null);
    readSweepStateMock.mockResolvedValue({ last_success_at: "", run_count: 0, runs_since_full_walk: 0 });
  };

  it("prints the line from /api/memory/dogfood", async () => {
    signedIn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const dog = {
      days: 7,
      since: "x",
      totals: {
        served: 5,
        used: 2,
        contradicted: 1,
        empty: 3,
        hook: { budget_hit: 1, timeout: 1 },
        feedback: { total: 4, stale: 4 },
      },
      quotes: [],
    };
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes("/api/memory/dogfood")
        ? new Response(JSON.stringify(dog), { status: 200 })
        : new Response("nf", { status: 404 }),
    ) as unknown as typeof fetch;
    await statusCommand({}, { fetchImpl });
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith("membral on membral: "))).toEqual([
      "membral on membral: served 5 · used 2 · contradicted 1 · feedback 4 · empty 3 · budget-hit 2 (7 days)",
    ]);
  });

  it("prints nothing on a 404 and never fails", async () => {
    signedIn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("nf", { status: 404 })) as unknown as typeof fetch;
    await expect(statusCommand({}, { fetchImpl })).resolves.toBeUndefined();
    expect(logSpy.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("membral on membral"))).toBe(false);
  });
});
