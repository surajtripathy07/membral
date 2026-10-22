import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawCodeSession } from "@membral/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deliverable 1: resolveUploadConfig now layers ~/.membral/credentials.json
// in between env vars and the default, via credentials.ts's ONE shared
// resolveCredentials (issue #136). Keep the REAL resolver (existing
// behavior, e.g. trailing-slash stripping, must stay correct) but spy on
// it, with a nonexistent credentials.json path override so no test here
// ever touches the real ~/.membral/credentials.json on this machine.
vi.mock("../credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials.js")>();
  return {
    ...actual,
    resolveCredentials: vi.fn((input: Parameters<typeof actual.resolveCredentials>[0]) =>
      actual.resolveCredentials({ ...input, credsPath: input.credsPath ?? "/nonexistent/credentials.json" }),
    ),
    loadCredentials: vi.fn((path?: string) => actual.loadCredentials(path ?? "/nonexistent/credentials.json")),
  };
});

const {
  createRateLimitState,
  createUploadClient,
  DEFAULT_API_URL,
  describeKeyRejected,
  resolveUploadConfig,
  splitIntoBatches,
  parseRetryAfterMs,
  UploadAuthError,
  UploadDeferredError,
  uploadBatch,
  sessionForWire,
} = await import("../code-session-upload.js");
const { resolveCredentials, resolveKeyFallback, saveCredentials } = await import("../credentials.js");

function makeSession(overrides: Partial<RawCodeSession> = {}): RawCodeSession {
  return {
    source: "claude-code",
    sourceSessionId: "11111111-1111-4111-8111-111111111111",
    contentHash: "a".repeat(64),
    repo: { path: "/home/dev/acme-webapp", remoteUrl: "https://codehub.example/acme/webapp.git", branch: "main" },
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    turns: [],
    filesTouched: [],
    toolCounts: {},
    ...overrides,
  };
}

describe("resolveUploadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("falls back to the default API URL and empty key when nothing is set", () => {
    delete process.env.MEMBRAL_API_URL;
    delete process.env.MEMBRAL_API_KEY;

    const config = resolveUploadConfig({});
    expect(config.apiUrl).toBe(DEFAULT_API_URL);
    expect(config.apiKey).toBe("");
  });

  it("prefers env vars over the default", () => {
    process.env.MEMBRAL_API_URL = "https://staging.example.com/";
    process.env.MEMBRAL_API_KEY = "lls_from_env";

    const config = resolveUploadConfig({});
    expect(config.apiUrl).toBe("https://staging.example.com"); // trailing slash stripped
    expect(config.apiKey).toBe("lls_from_env");
  });

  it("prefers explicit flags over env vars", () => {
    process.env.MEMBRAL_API_URL = "https://staging.example.com";
    process.env.MEMBRAL_API_KEY = "lls_from_env";

    const config = resolveUploadConfig({ apiUrl: "https://flag.example.com", apiKey: "lls_from_flag" });
    expect(config.apiUrl).toBe("https://flag.example.com");
    expect(config.apiKey).toBe("lls_from_flag");
  });

  it("delegates to credentials.ts's resolveCredentials (the flag>env>credentials.json>default chain)", () => {
    delete process.env.MEMBRAL_API_URL;
    delete process.env.MEMBRAL_API_KEY;

    resolveUploadConfig({ apiUrl: "https://flag.example.com", apiKey: "lls_from_flag" });

    expect(resolveCredentials).toHaveBeenCalledWith({
      flagKey: "lls_from_flag",
      flagUrl: "https://flag.example.com",
      envKey: undefined,
      envUrl: undefined,
      defaultUrl: DEFAULT_API_URL,
    });
  });

  // M4 (adversarial round 1 on #136): resolveUploadConfig now also reports
  // WHICH source won, so a 401 can be attributed and the client's env-key
  // fallback can decide whether to run.
  it("reports apiKeySource/apiUrlSource alongside the resolved values", () => {
    process.env.MEMBRAL_API_URL = "https://staging.example.com";
    process.env.MEMBRAL_API_KEY = "lls_from_env";

    const config = resolveUploadConfig({});
    expect(config.apiKeySource).toBe("env");
    expect(config.apiUrlSource).toBe("env");
  });
});

// M4 (adversarial round 1 on #136), moved by R4 4.3 to credentials.ts as
// resolveKeyFallback, the rule the policy client applies after an env-key
// 401 (design note §4: same server only). Explicit credsPath: no homedir.
describe("resolveKeyFallback (credentials.ts)", () => {
  const credsPath = "/tmp/membral-test-resolve-key-fallback-credentials.json";
  const save = (apiUrl: string, apiKey: string) =>
    saveCredentials({ apiUrl, apiKey, email: "e", userId: "i", createdAt: "c" }, credsPath);

  afterEach(() => {
    try {
      unlinkSync(credsPath);
    } catch {
      // may not exist
    }
  });

  it("returns the credentials.json key when the used key came from env, differs, and the server is the same", () => {
    save("https://from-creds.example/", "lls_from_creds");
    const used = { apiUrl: "https://from-creds.example", apiKey: "lls_stale_env", apiKeySource: "env" as const };
    expect(resolveKeyFallback(used, credsPath)).toEqual({
      apiUrl: "https://from-creds.example",
      apiKey: "lls_from_creds",
    });
  });

  it("returns null when the used key did NOT come from env (flag or credentials — nothing to fall back from)", () => {
    save("https://from-creds.example", "lls_from_creds");
    for (const apiKeySource of ["flag", "credentials"] as const) {
      expect(
        resolveKeyFallback({ apiUrl: "https://from-creds.example", apiKey: "lls_x", apiKeySource }, credsPath),
      ).toBeNull();
    }
  });

  it("returns null when credentials.json holds the SAME key, or does not exist", () => {
    save("https://from-creds.example", "lls_same");
    const used = { apiUrl: "https://from-creds.example", apiKey: "lls_same", apiKeySource: "env" as const };
    expect(resolveKeyFallback(used, credsPath)).toBeNull();
    expect(resolveKeyFallback({ ...used, apiKey: "lls_other" }, "/nonexistent/credentials.json")).toBeNull();
  });

  // n1 (adversarial round 2), tightened by §4: the credentials.json key is
  // never sent to a host it was not saved for, explicit URL or not.
  it("returns null when credentials.json was saved for a different server", () => {
    save("https://from-creds.example", "lls_from_creds");
    const used = { apiUrl: "https://flag.example.com", apiKey: "lls_stale_env", apiKeySource: "env" as const };
    expect(resolveKeyFallback(used, credsPath)).toBeNull();
  });
});

describe("splitIntoBatches", () => {
  it("returns a single batch when everything fits", () => {
    const sessions = [makeSession(), makeSession({ sourceSessionId: "s2" })];
    const batches = splitIntoBatches(sessions);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("splits once the count cap is reached", () => {
    const sessions = Array.from({ length: 45 }, (_, i) => makeSession({ sourceSessionId: `s${i}` }));
    const batches = splitIntoBatches(sessions, 20, Number.POSITIVE_INFINITY);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(20);
    expect(batches[1]).toHaveLength(20);
    expect(batches[2]).toHaveLength(5);
  });

  it("splits once the byte cap is reached, even under the count cap", () => {
    const big = makeSession({
      turns: [{ idx: 0, role: "user", kind: "prose", text: "x".repeat(500), ts: "2026-01-01T00:00:00.000Z" }],
    });
    const sessions = [big, big, big, big];
    const perSessionBytes = Buffer.byteLength(JSON.stringify(big), "utf8");
    // cap sized to fit exactly two sessions per batch
    const batches = splitIntoBatches(sessions, 20, perSessionBytes * 2 + 10);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(2);
  });

  it("gives an oversized single session its own batch rather than dropping it", () => {
    const huge = makeSession({
      turns: [{ idx: 0, role: "user", kind: "prose", text: "x".repeat(1000), ts: "2026-01-01T00:00:00.000Z" }],
    });
    const batches = splitIntoBatches([huge], 20, 10); // maxBytes far smaller than one session
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([huge]);
  });

  it("returns no batches for an empty input", () => {
    expect(splitIntoBatches([])).toEqual([]);
  });
});

describe("uploadBatch", () => {
  const config = { apiUrl: "https://cloud.example.com", apiKey: "lls_test_key" };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the parsed outcome on a 2xx response and posts the right request shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = makeSession();
    const result = await uploadBatch(config, [session]);

    expect(result).toEqual({ imported: 1, skipped: 0, total: 1, errors: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cloud.example.com/api/code-sessions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer lls_test_key");
    expect(JSON.parse(init.body as string)).toEqual({ sessions: [session] });
  });

  it("omits `force` from the body entirely when not requested (default behavior unchanged, issue #91)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = makeSession();
    await uploadBatch(config, [session]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ sessions: [session] });
  });

  it("sends force:true in the body when requested (issue #91 backfill)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = makeSession();
    await uploadBatch(config, [session], createRateLimitState(), () => {}, true);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ sessions: [session], force: true });
  });

  it("throws UploadAuthError immediately on 401 without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadBatch(config, [makeSession()])).rejects.toThrow(UploadAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws UploadAuthError with a scoped-key message on 403 without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadBatch(config, [makeSession()])).rejects.toThrow(/unscoped/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits before retrying a 429 (never retries immediately) and eventually succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
        text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const state = createRateLimitState();
    const logs: string[] = [];
    const promise = uploadBatch(config, [makeSession()], state, (m) => logs.push(m));

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.imported).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs[0]).toMatch(/rate limited.*waiting 500ms/i);
  });

  it("uses decreasing proportional backoff multipliers across repeated 429s, not fixed doubling", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const state = createRateLimitState(); // starts at 500ms
    const logs: string[] = [];
    const promise = uploadBatch(config, [makeSession()], state, (m) => logs.push(m));
    // Attach the rejection assertion before advancing timers so the promise
    // never has a tick unobserved (avoids a spurious unhandled-rejection
    // warning from vitest).
    const assertion = expect(promise).rejects.toThrow(/rate limited/i);

    await vi.runAllTimersAsync();
    await assertion;

    // 429s get 6 attempts (MAX_RATE_LIMIT_ATTEMPTS), 5 waits logged before the final failure.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(logs.filter((l) => /rate limited/.test(l))).toHaveLength(5);
    expect(logs[0]).toMatch(/waiting 500ms/);
    // 500 * 5 = 2500 (proportional multiplier under 1s), not 500 * 2 = 1000.
    expect(logs[1]).toMatch(/waiting 2500ms/);
  });

  // R4 4.3 site 1: the backoff state lives in the shared ApiClient, not in
  // the RateLimitState argument, so these observe it through the waits.
  it("decays the delay on success instead of resetting it to the initial value (state held by the shared client)", async () => {
    const okRes = {
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    };
    const rateLimited = { ok: false, status: 429, text: async () => "" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(okRes)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(okRes);
    vi.stubGlobal("fetch", fetchMock);

    const client = createUploadClient(config);
    const logs: string[] = [];
    const first = uploadBatch(config, [makeSession()], createRateLimitState(), (m) => logs.push(m), false, client);
    await vi.runAllTimersAsync();
    await first;
    const second = uploadBatch(config, [makeSession()], createRateLimitState(), (m) => logs.push(m), false, client);
    await vi.runAllTimersAsync();
    await second;

    // 429 waits 500 and grows the delay to 2500; success decays it to 2250, not back to 500.
    expect(logs[0]).toMatch(/waiting 500ms/);
    expect(logs[1]).toMatch(/waiting 2250ms/);
  });

  it("honors a Retry-After header (seconds) instead of its own backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "7" }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
        text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const logs: string[] = [];
    const promise = uploadBatch(config, [makeSession()], createRateLimitState(), (m) => logs.push(m));
    await vi.advanceTimersByTimeAsync(6_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect((await promise).imported).toBe(1);
    expect(logs[0]).toMatch(/waiting 7000ms \(Retry-After\)/);
  });

  it("paces later batches after a 429 (grows on 429, decays 0.9x on success, never reset; state held by the shared client)", async () => {
    const ok = {
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "" })
      .mockResolvedValue(ok);
    vi.stubGlobal("fetch", fetchMock);

    const client = createUploadClient(config);
    const first = uploadBatch(config, [makeSession()], createRateLimitState(), () => {}, false, client);
    await vi.runAllTimersAsync();
    await first;
    // The 429 set pace to 1000ms; the success decayed it to 900.

    const second = uploadBatch(config, [makeSession()], createRateLimitState(), () => {}, false, client);
    await vi.advanceTimersByTimeAsync(899);
    expect(fetchMock).toHaveBeenCalledTimes(2); // still pacing
    await vi.runAllTimersAsync();
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Decayed again to 810, never reset.
    const third = uploadBatch(config, [makeSession()], createRateLimitState(), () => {}, false, client);
    await vi.advanceTimersByTimeAsync(809);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.runAllTimersAsync();
    await third;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("defers (UploadDeferredError) instead of waiting past the state's deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "30" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = createRateLimitState(Date.now() + 20_000);
    await expect(uploadBatch(config, [makeSession()], state)).rejects.toBeInstanceOf(UploadDeferredError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds, HTTP dates, and rejects junk", () => {
    const now = Date.parse("2026-09-25T10:00:00.000Z");
    expect(parseRetryAfterMs("12", now)).toBe(12_000);
    expect(parseRetryAfterMs("Fri, 25 Sep 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfterMs("Fri, 25 Sep 2026 09:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("soon", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });
});

// A 401 names the key the client actually sent: after the env-key fallback
// that is the credentials.json key, and "unset MEMBRAL_API_KEY" is wrong advice.
describe("describeKeyRejected", () => {
  const base = { apiUrl: "https://cloud.example.com", apiKey: "lls_envkey_123" };

  it("an env key: masks it and says to unset MEMBRAL_API_KEY", () => {
    const text = describeKeyRejected({ ...base, apiKeySource: "env" });
    expect(text).toContain("rejected API key lls_en…");
    expect(text).toContain("unset MEMBRAL_API_KEY");
    expect(text).not.toContain("lls_envkey_123");
  });

  it("a credentials.json key: masks it and gives profile/login advice", () => {
    const text = describeKeyRejected({ ...base, apiKey: "lls_credkey_456", apiKeySource: "credentials" });
    expect(text).toContain("rejected API key lls_cr…");
    expect(text).toContain("membral use <profile>");
    expect(text).toContain("membral login");
    expect(text).not.toContain("unset MEMBRAL_API_KEY");
  });

  it("an env key that fell back and then 401ed: names the credentials key, not the env one", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(join(tmpdir(), "membral-krej-"));
    const credsPath = join(dir, "credentials.json");
    try {
      saveCredentials(
        {
          apiUrl: base.apiUrl,
          apiKey: "lls_credkey_456",
          email: "dev@example.com",
          userId: "u1",
          createdAt: "2026-10-08T00:00:00Z",
        },
        credsPath,
      );
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "" });
      const config = { ...base, apiKeySource: "env" as const };
      const client = createUploadClient(config, {
        credsPath,
        markerDir: dir,
        fetchImpl: fetchMock as unknown as typeof fetch,
        log: () => {},
      });
      const err = await uploadBatch(config, [makeSession()], createRateLimitState(), () => {}, false, client).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2); // env key, then the credentials key
      expect(err).toBeInstanceOf(UploadAuthError);
      expect(err?.message).toContain("rejected MEMBRAL_API_KEY and then API key lls_cr…");
      expect(err?.message).toContain("membral use <profile>");
      expect(err?.message).not.toContain("unset MEMBRAL_API_KEY");
      expect(err?.message).not.toContain("lls_en");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sessionForWire size clamp (#480)", () => {
  const MAX = 100_000;
  const turn = (idx: number, text: string) =>
    ({ idx, role: "user", kind: "prose", text, ts: "2026-10-10T00:00:00Z" }) as RawCodeSession["turns"][number];
  const sessionWith = (turns: RawCodeSession["turns"]) =>
    ({ source: "claude-code", sourceSessionId: "s", repo: {}, turns }) as unknown as RawCodeSession;

  it("clamps a 150,000-char turn under the server limit with a marker; the input stays whole", () => {
    const big = "x".repeat(150_000);
    const input = sessionWith([turn(0, big)]);
    const wire = sessionForWire(input);
    const text = wire.turns[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(MAX);
    expect(text).toMatch(/\n…\[truncated \d+ chars by membral\]$/);
    const n = Number(/truncated (\d+) chars/.exec(text)?.[1]);
    expect(text.length - text.slice(text.indexOf("\n…[truncated")).length + n).toBe(150_000);
    expect(input.turns[0]?.text).toBe(big);
  });

  it("leaves turns at or under the limit byte-identical (same object when nothing is over)", () => {
    const ok = sessionWith([turn(0, "y".repeat(MAX)), turn(1, "short é 🙂")]);
    expect(sessionForWire(ok)).toBe(ok);
  });

  it("clamps only the oversized turn, ownerText, inputDigest and sub-agent description", () => {
    const small = turn(0, "keep me");
    const session = {
      ...sessionWith([
        small,
        { ...turn(1, "a".repeat(120_000)), ownerText: "b".repeat(120_000), inputDigest: "c".repeat(3_000) },
      ]),
      subAgents: [{ description: "d".repeat(30_000) }],
    } as unknown as RawCodeSession;
    const wire = sessionForWire(session);
    expect(wire.turns[0]).toBe(small);
    expect(wire.turns[1]?.text?.length).toBeLessThanOrEqual(MAX);
    expect(wire.turns[1]?.ownerText?.length).toBeLessThanOrEqual(MAX);
    expect(wire.turns[1]?.inputDigest?.length).toBeLessThanOrEqual(2_000);
    expect(wire.subAgents?.[0]?.description?.length).toBeLessThanOrEqual(20_000);
  });

  it("uploadBatch sends the clamped body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => "{}",
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await uploadBatch({ apiUrl: "https://cloud.example.com", apiKey: "k" }, [
        sessionWith([turn(0, "z".repeat(150_000))]),
      ]);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as { sessions: RawCodeSession[] };
      expect(sent.sessions[0]?.turns[0]?.text?.length).toBeLessThanOrEqual(MAX);
      expect(sent.sessions[0]?.turns[0]?.text).toContain("chars by membral]");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
