// loginCommand/logoutCommand/whoamiCommand — every network + fs + browser
// call is injected (LoginDeps) or path-parameterized, so these tests never
// hit the real network or filesystem.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCredentials, saveCredentials } from "../credentials.js";
import { envKeyMarkerPath } from "../lib/api-client.js";
import { loginCommand, logoutCommand, whoamiCommand } from "../login-command.js";

describe("loginCommand", () => {
  let dir: string;
  let credentialsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-login-"));
    credentialsPath = join(dir, "credentials.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  function baseDeps(overrides: Record<string, unknown> = {}) {
    return {
      startDeviceAuth: vi.fn().mockResolvedValue({
        deviceCode: "dc-1",
        userCode: "ABCD-1234",
        verificationUri: "https://membral.me/device",
        verificationUriComplete: "https://membral.me/device?code=ABCD-1234",
        expiresIn: 600,
        interval: 3,
      }),
      pollDeviceAuth: vi.fn(),
      openBrowser: vi.fn(),
      loadOrCreateDeviceIdentity: vi.fn().mockReturnValue({ id: "d1", name: "test-machine", platform: "darwin" }),
      saveCredentials,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi.fn().mockReturnValue(0),
      credentialsPath,
      ...overrides,
    };
  }

  // R4 4.3 site 5: a poll 429 waits max(interval, Retry-After), not just the interval.
  it("a rate-limited poll waits the server's Retry-After when it is longer than the interval", async () => {
    const { DeviceAuthError } = await import("../device-auth.js");
    const deps = baseDeps({
      pollDeviceAuth: vi
        .fn()
        .mockRejectedValueOnce(new DeviceAuthError(429, "rate limited (429) — retry in 30s", 30_000))
        .mockRejectedValueOnce(new DeviceAuthError(429, "rate limited (429)"))
        .mockResolvedValue({ status: "approved", apiKey: "lls_new", email: "a@b.com", userId: "u1" }),
    });
    await loginCommand({}, deps);
    expect(deps.sleep.mock.calls.map((c: unknown[]) => c[0])).toEqual([30_000, 3_000]);
  });

  it("saves credentials and prints confirmation once approved", async () => {
    const deps = baseDeps({
      pollDeviceAuth: vi.fn().mockResolvedValue({
        status: "approved",
        apiKey: "lls_new",
        email: "a@b.com",
        userId: "u1",
      }),
    });

    await loginCommand({ apiUrl: "https://membral.me" }, deps);

    expect(deps.openBrowser).toHaveBeenCalledWith("https://membral.me/device?code=ABCD-1234");
    const saved = loadCredentials(credentialsPath);
    expect(saved?.apiKey).toBe("lls_new");
    expect(saved?.email).toBe("a@b.com");
    expect(process.exitCode).toBe(0);
  });

  it("polls repeatedly until approved", async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "approved", apiKey: "lls_new", email: "a@b.com", userId: "u1" });
    const deps = baseDeps({ pollDeviceAuth: poll });

    await loginCommand({}, deps);

    expect(poll).toHaveBeenCalledTimes(3);
    expect(loadCredentials(credentialsPath)?.apiKey).toBe("lls_new");
  });

  it("does not write credentials and exits 1 when the sign-in expires", async () => {
    const deps = baseDeps({ pollDeviceAuth: vi.fn().mockResolvedValue({ status: "expired" }) });

    await loginCommand({}, deps);

    expect(loadCredentials(credentialsPath)).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("cancels cleanly on SIGINT without writing credentials", async () => {
    let sigintHandler: (() => void) | undefined;
    const originalOn = process.on.bind(process);
    vi.spyOn(process, "on").mockImplementation((event: string | symbol, cb: (...a: unknown[]) => void) => {
      if (event === "SIGINT") sigintHandler = cb as () => void;
      return originalOn(event as never, cb as never);
    });
    vi.spyOn(process, "off").mockImplementation(() => process);

    const poll = vi.fn().mockImplementation(async () => {
      sigintHandler?.();
      return { status: "pending" };
    });
    const deps = baseDeps({ pollDeviceAuth: poll });

    await loginCommand({}, deps);

    expect(loadCredentials(credentialsPath)).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 without polling when starting the device flow fails", async () => {
    const deps = baseDeps({ startDeviceAuth: vi.fn().mockRejectedValue(new Error("network down")) });

    await loginCommand({}, deps);

    expect(deps.pollDeviceAuth).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("logoutCommand / whoamiCommand", () => {
  let dir: string;
  let credentialsPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-logout-"));
    credentialsPath = join(dir, "credentials.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = 0;
    // This dev shell may itself export MEMBRAL_API_KEY/MEMBRAL_API_URL —
    // every test here must control those explicitly (issue #136), not
    // inherit whatever the maintainer's real shell happens to have set.
    delete process.env.MEMBRAL_API_KEY;
    delete process.env.MEMBRAL_API_URL;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
    process.env = { ...originalEnv };
  });

  it("logoutCommand removes an existing credentials file", async () => {
    saveCredentials({ apiUrl: "u", apiKey: "k", email: "e", userId: "i", createdAt: "c" }, credentialsPath);
    await logoutCommand(credentialsPath);
    expect(loadCredentials(credentialsPath)).toBeNull();
  });

  it("logoutCommand deletes env-key-rejected markers beside credentials.json, and nothing else", async () => {
    saveCredentials({ apiUrl: "u", apiKey: "k", email: "e", userId: "i", createdAt: "c" }, credentialsPath);
    const a = envKeyMarkerPath(dir, "lls_env_a", "https://membral.me");
    const b = envKeyMarkerPath(dir, "lls_env_b", "http://localhost:3000");
    const other = join(dir, "kick-backoff-abc.json");
    for (const p of [a, b, other]) writeFileSync(p, "{}");
    await logoutCommand(credentialsPath);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("logoutCommand removes only the active profile and reports the promoted one", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const common = { email: "e", userId: "i", createdAt: "c" };
    saveCredentials({ ...common, apiUrl: "https://membral.me", apiKey: "kp" }, credentialsPath);
    saveCredentials({ ...common, apiUrl: "http://localhost:3000", apiKey: "kl" }, credentialsPath);
    await logoutCommand(credentialsPath);
    expect(loadCredentials(credentialsPath)?.apiKey).toBe("kp");
    expect(log.mock.calls.flat().join("\n")).toContain('Active profile is now "prod"');
  });

  it("whoamiCommand exits 1 when not signed in (no flag, no env, no credentials.json)", async () => {
    await whoamiCommand({ credentialsPath });
    expect(process.exitCode).toBe(1);
  });

  it("whoamiCommand prints the signed-in email when credentials exist", async () => {
    saveCredentials(
      { apiUrl: "https://membral.me", apiKey: "k", email: "a@b.com", userId: "i", createdAt: "c" },
      credentialsPath,
    );
    const logSpy = vi.spyOn(console, "log");
    await whoamiCommand({ credentialsPath });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("a@b.com");
    expect(process.exitCode).toBe(0);
  });

  // Issue #136 req 5: prints the source of both the key and the URL, and
  // never the raw key.
  it("whoamiCommand prints the api url and key SOURCE, and never the raw key", async () => {
    saveCredentials(
      { apiUrl: "https://membral.me", apiKey: "lls_supersecretvalue", email: "a@b.com", userId: "i", createdAt: "c" },
      credentialsPath,
    );
    const logSpy = vi.spyOn(console, "log");
    await whoamiCommand({ credentialsPath });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("credentials.json");
    expect(output).not.toContain("lls_supersecretvalue");
  });

  // Issue #136: this is the whole bug — an env key must not be able to
  // silently hide a working credentials.json from the one command whose
  // entire job is telling the user what's actually active.
  it("whoamiCommand reports the env key (and its source) when MEMBRAL_API_KEY is set, even though credentials.json also exists", async () => {
    saveCredentials(
      { apiUrl: "https://membral.me", apiKey: "lls_from_creds", email: "a@b.com", userId: "i", createdAt: "c" },
      credentialsPath,
    );
    process.env.MEMBRAL_API_KEY = "lls_stale_env_key";
    const logSpy = vi.spyOn(console, "log");
    await whoamiCommand({ credentialsPath });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("MEMBRAL_API_KEY environment variable");
    expect(output).not.toContain("a@b.com"); // env key is active — this isn't `membral login`'s identity
  });

  it("whoamiCommand prefers an explicit --api-key flag over both env and credentials.json", async () => {
    saveCredentials(
      { apiUrl: "https://membral.me", apiKey: "lls_from_creds", email: "a@b.com", userId: "i", createdAt: "c" },
      credentialsPath,
    );
    process.env.MEMBRAL_API_KEY = "lls_from_env";
    const logSpy = vi.spyOn(console, "log");
    await whoamiCommand({ credentialsPath, apiKey: "lls_from_flag" });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("--api-key flag");
  });
});
