// Characterization tests for every HTTP call site in the CLI (G3 3C-2 part
// a) — written BEFORE the api-client extraction (3C-2 part b) so that
// extraction can be checked against these locked request/response
// contracts with zero behavior change. One `describe` per module, one `it`
// per response class per site. Nothing here changes production code.
//
// Locked per site: method, URL/path, every header (exact casing), body
// shape, timeout/AbortSignal use, `fetchImpl ?? globalThis.fetch` resolved
// at call time, and exact error strings/return values for success, 401,
// 403, 429 (with/without Retry-After), 500, network error, and malformed
// JSON where the site parses JSON.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function ok(body: unknown, status = 200) {
  const res = {
    ok: true,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone(): typeof res {
      return res;
    },
  };
  return res;
}
function badJson(status = 200) {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token in JSON");
    },
    text: async () => "not json",
    clone(): typeof res {
      return res;
    },
  };
  return res;
}
function notOk(status: number, text = "", headers?: Record<string, string>) {
  return {
    ok: false,
    status,
    statusText: `Status ${status}`,
    text: async () => text,
    json: async () => JSON.parse(text || "{}"),
    headers: headers ? new Headers(headers) : new Headers(),
  };
}
function capturedInit(mock: ReturnType<typeof vi.fn>, callIndex = 0): [string, RequestInit] {
  return mock.mock.calls[callIndex] as [string, RequestInit];
}
/** An env-key client whose credentials.json (in `dir`) holds a different key for the same server. */
async function envFallbackClient(dir: string, url: string, lines: string[], fetchImpl?: typeof fetch) {
  const { saveCredentials } = await import("../credentials.js");
  const { createApiClient } = await import("../lib/api-client.js");
  const credsPath = join(dir, "credentials.json");
  saveCredentials({ apiUrl: url, apiKey: "lls_creds", email: "e", userId: "u", createdAt: "c" }, credsPath);
  return createApiClient({
    credentials: { apiKey: "lls_env", apiKeySource: "env", apiUrl: url, apiUrlSource: "env" },
    credsPath,
    markerDir: dir,
    log: (l) => lines.push(l),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
function headerObj(init: RequestInit): Record<string, string> {
  const h = init.headers as Record<string, string> | Headers | undefined;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  return { ...h };
}

// ---------------------------------------------------------------------------
// code-session-upload.ts:268 — uploadBatch. Seam: global `fetch` (no
// injection param). POST /api/code-sessions.
// R4 4.3 site 1 (#177): on the policy client (endpoint "upload"). Flipped:
// `:157` split (5xx still retried 3x; 400/413 now terminal), `:179` (bad JSON
// typed, no retry). New: timeout, force-timeout, fallback, route-429-no-
// fallback, marker and concurrency rows.
// ---------------------------------------------------------------------------
describe("code-session-upload.ts uploadBatch (:268)", () => {
  let uploadBatch: typeof import("../code-session-upload.js").uploadBatch;
  let createRateLimitState: typeof import("../code-session-upload.js").createRateLimitState;
  let UploadAuthError: typeof import("../code-session-upload.js").UploadAuthError;

  const config = { apiUrl: "https://api.example.com", apiKey: "lls_abc" };
  const session = {
    source: "claude-code" as const,
    sourceSessionId: "11111111-1111-4111-8111-111111111111",
    contentHash: "a".repeat(64),
    repo: { path: "/home/dev/acme", remoteUrl: "https://codehub.example/acme/webapp.git", branch: "main" },
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    turns: [],
    filesTouched: [],
    toolCounts: {},
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    const mod = await import("../code-session-upload.js");
    uploadBatch = mod.uploadBatch;
    createRateLimitState = mod.createRateLimitState;
    UploadAuthError = mod.UploadAuthError;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("success: POSTs exact request shape and returns the parsed outcome", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ imported: 1, skipped: 0, total: 1, errors: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadBatch(config, [session]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = capturedInit(fetchMock);
    expect(url).toBe("https://api.example.com/api/code-sessions");
    expect(init.method).toBe("POST");
    expect(headerObj(init)).toEqual({ "content-type": "application/json", authorization: "Bearer lls_abc" });
    expect(JSON.parse(init.body as string)).toEqual({
      sessions: [expect.objectContaining({ contentHash: session.contentHash })],
    });
    expect(result).toEqual({ imported: 1, skipped: 0, total: 1, errors: [] });
  });

  it("401: throws UploadAuthError immediately, no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(401));
    vi.stubGlobal("fetch", fetchMock);
    // FLIPPED (2026-10-08): the 401 names the server, the masked key, its source and the fix.
    await expect(uploadBatch(config, [session])).rejects.toThrow(
      /^Invalid or missing API key \(401\) — the server at https:\/\/api\.example\.com rejected API key .* `membral (status|login)`/,
    );
    await expect(uploadBatch(config, [session])).rejects.toBeInstanceOf(UploadAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // one per call above, none retried
  });

  it("403: throws UploadAuthError immediately with the scoped-key message, no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(403));
    vi.stubGlobal("fetch", fetchMock);
    const promise = uploadBatch(config, [session]);
    await expect(promise).rejects.toThrow(/API key is scoped \(403\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("429 with Retry-After: honors the header for the wait, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(notOk(429, "", { "retry-after": "3" }))
      .mockResolvedValueOnce(ok({ imported: 1, skipped: 0, total: 1, errors: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const logs: string[] = [];
    const promise = uploadBatch(config, [session], createRateLimitState(), (m) => logs.push(m));
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs[0]).toMatch(/waiting 3000ms \(Retry-After\)/);
  });

  it("429 without Retry-After: uses the proportional delay, exhausts MAX_RATE_LIMIT_ATTEMPTS=6, exact error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(429));
    vi.stubGlobal("fetch", fetchMock);
    const promise = uploadBatch(config, [session]);
    const assertion = expect(promise).rejects.toThrow("Rate limited (429) after 6 attempts");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("500: retries MAX_RETRIES=3 times then throws with status+body detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(500, "boom"));
    vi.stubGlobal("fetch", fetchMock);
    const promise = uploadBatch(config, [session]);
    const assertion = expect(promise).rejects.toThrow("Upload failed: 500 boom");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("network error: retries MAX_RETRIES=3 times then throws with the exact message", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);
    const promise = uploadBatch(config, [session]);
    const assertion = expect(promise).rejects.toThrow(
      "Network error uploading to https://api.example.com/api/code-sessions: ECONNRESET",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // FLIPPED (R4 4.3 site 1): was "propagates the raw parse error, uncaught".
  it("malformed JSON on a 2xx: typed 'response was not JSON' error, no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(badJson(200));
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadBatch(config, [session])).rejects.toThrow("Upload failed: 200 response was not JSON");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // NEW (R4 4.3 site 1, split from the 500 row): other 4xx are terminal (were retried 3x as generic non-2xx).
  it.each([400, 413])("%i: terminal — no retry, status+body detail", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(status, "nope"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadBatch(config, [session])).rejects.toThrow(`Upload failed: ${status} nope`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** A fetch that never answers until the client aborts it. */
  function hangingFetch() {
    return vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
  }

  // NEW (R4 4.3 site 1): 135 s per attempt; a non-force upload is idempotent, so a timeout is retried.
  it("timeout: each attempt is cut at 135 s, retried 3 times, exact message", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const promise = uploadBatch(config, [session]);
    const assertion = expect(promise).rejects.toThrow(
      "Network error uploading to https://api.example.com/api/code-sessions: timed out after 135000 ms",
    );
    await vi.advanceTimersByTimeAsync(134_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // NEW (R4 4.3 site 1): a `force` upload re-queues paid extraction, so it is never re-sent after a timeout.
  it("force timeout: not retried", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const promise = uploadBatch(config, [session], createRateLimitState(), () => {}, true);
    const assertion = expect(promise).rejects.toThrow("timed out after 135000 ms");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("env-key fallback inside the client (R4 4.3 site 1)", () => {
    const url = "https://api.example.com";
    let dir: string;
    let credsPath: string;
    let lines: string[];
    const okOutcome = () => ok({ imported: 1, skipped: 0, total: 1, errors: [] });
    const authOf = (init: RequestInit) => headerObj(init).authorization;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "membral-upload-fallback-"));
      credsPath = join(dir, "credentials.json");
      lines = [];
      const { saveCredentials } = await import("../credentials.js");
      saveCredentials({ apiUrl: url, apiKey: "lls_creds", email: "e", userId: "u", createdAt: "c" }, credsPath);
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    async function envClient() {
      const { createApiClient } = await import("../lib/api-client.js");
      return createApiClient({
        credentials: { apiKey: "lls_env", apiKeySource: "env", apiUrl: url, apiUrlSource: "env" },
        credsPath,
        markerDir: dir,
        log: (l) => lines.push(l),
      });
    }
    async function markerPath() {
      const { envKeyMarkerPath } = await import("../lib/api-client.js");
      return envKeyMarkerPath(dir, "lls_env", url);
    }

    it("fallback: an env-key 401 retries once with the credentials.json key (same server), logs one line, writes the marker", async () => {
      const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
        authOf(init) === "Bearer lls_env" ? notOk(401) : okOutcome(),
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await uploadBatch(config, [session], createRateLimitState(), () => {}, false, await envClient());
      expect(result.imported).toBe(1);
      expect(fetchMock.mock.calls.map(([, init]) => authOf(init))).toEqual(["Bearer lls_env", "Bearer lls_creds"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("MEMBRAL_API_KEY was rejected by https://api.example.com (401)");
      expect(lines[0]).not.toContain("lls_");
      expect(existsSync(await markerPath())).toBe(true);
    });

    it("fallback: the credentials.json key also 401s → UploadAuthError 401, no marker", async () => {
      const fetchMock = vi.fn().mockResolvedValue(notOk(401));
      vi.stubGlobal("fetch", fetchMock);
      const client = await envClient();
      await expect(
        uploadBatch(config, [session], createRateLimitState(), () => {}, false, client),
      ).rejects.toBeInstanceOf(UploadAuthError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(existsSync(await markerPath())).toBe(false);
    });

    it("route 429 with a valid env key: never falls back (zero requests with the credentials.json key)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(notOk(429, "", { "retry-after": "1" }))
        .mockResolvedValueOnce(okOutcome());
      vi.stubGlobal("fetch", fetchMock);
      const promise = uploadBatch(config, [session], createRateLimitState(), () => {}, false, await envClient());
      await vi.runAllTimersAsync();
      expect((await promise).imported).toBe(1);
      expect(fetchMock.mock.calls.map(([, init]) => authOf(init))).toEqual(["Bearer lls_env", "Bearer lls_env"]);
      expect(lines).toEqual([]);
    });

    it("marker: a fresh one starts with the credentials.json key; an expired one costs exactly one env-key attempt", async () => {
      const path = await markerPath();
      const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
        authOf(init) === "Bearer lls_env" ? notOk(401) : okOutcome(),
      );
      vi.stubGlobal("fetch", fetchMock);

      writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), url }));
      await uploadBatch(config, [session], createRateLimitState(), () => {}, false, await envClient());
      expect(fetchMock.mock.calls.map(([, init]) => authOf(init))).toEqual(["Bearer lls_creds"]);

      fetchMock.mockClear();
      writeFileSync(path, JSON.stringify({ at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), url }));
      await uploadBatch(config, [session], createRateLimitState(), () => {}, false, await envClient());
      expect(fetchMock.mock.calls.map(([, init]) => authOf(init))).toEqual(["Bearer lls_env", "Bearer lls_creds"]);
    });

    it("marker: an env-key 2xx deletes it", async () => {
      const path = await markerPath();
      // No different creds key: the marker cannot swap, so the env key is sent and works.
      const { saveCredentials } = await import("../credentials.js");
      saveCredentials({ apiUrl: url, apiKey: "lls_env", email: "e", userId: "u", createdAt: "c" }, credsPath);
      writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), url }));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okOutcome()));
      await uploadBatch(config, [session], createRateLimitState(), () => {}, false, await envClient());
      expect(existsSync(path)).toBe(false);
    });

    it("concurrency: three uploads on one client whose env key 401s fall back once, and all three succeed", async () => {
      const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
        authOf(init) === "Bearer lls_env" ? notOk(401) : okOutcome(),
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = await envClient();
      const results = await Promise.all(
        [0, 1, 2].map(() => uploadBatch(config, [session], createRateLimitState(), () => {}, false, client)),
      );
      expect(results.map((r) => r.imported)).toEqual([1, 1, 1]);
      expect(lines).toHaveLength(1);
      const creds = fetchMock.mock.calls.filter(([, init]) => authOf(init) === "Bearer lls_creds");
      expect(creds).toHaveLength(3);
    });
  });

  it("fetch is resolved at call time: swapping globalThis.fetch between calls changes which one is used", async () => {
    const a = vi.fn().mockResolvedValue(ok({ imported: 1, skipped: 0, total: 1, errors: [] }));
    vi.stubGlobal("fetch", a);
    await uploadBatch(config, [session]);
    expect(a).toHaveBeenCalledTimes(1);

    const b = vi.fn().mockResolvedValue(ok({ imported: 1, skipped: 0, total: 1, errors: [] }));
    vi.stubGlobal("fetch", b);
    await uploadBatch(config, [session]);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1); // `a` was never called again
  });
});

// ---------------------------------------------------------------------------
// import-command.ts:70 — postImportBatch, not exported; exercised through
// importCommand (POST /api/import). Seam: global `fetch`.
// ---------------------------------------------------------------------------
// R4 4.3 site 6 (#170): on the policy client (endpoint "import"), ONE client
// per run. Flipped: `:273`/`:283` (401/403 — and 402 — stop the remaining
// batches), `:296` (Retry-After honoured, 6 tries, pace), `:304` split (5xx
// still 3 tries; other 4xx terminal), the network row (a mid-request error is
// not re-sent: import is not idempotent). New: connect-phase retry,
// cross-batch decay, no-retry-on-timeout rows.
describe("import-command.ts postImportBatch (:70, via importCommand)", () => {
  let importCommand: typeof import("../import-command.js").importCommand;
  let dir: string;

  function chatGptFixture() {
    return [
      {
        id: "conv-1",
        title: "Trip",
        create_time: 1700000000,
        update_time: 1700000100,
        current_node: "n2",
        mapping: {
          n1: {
            id: "n1",
            message: {
              id: "m1",
              author: { role: "user" },
              content: { content_type: "text", parts: ["hi"] },
              create_time: 1700000000,
            },
            parent: null,
            children: ["n2"],
          },
          n2: {
            id: "n2",
            message: {
              id: "m2",
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["hello"] },
              create_time: 1700000050,
            },
            parent: "n1",
            children: [],
          },
        },
      },
    ];
  }

  function writeExport(copies = 1) {
    const file = join(dir, "conversations.json");
    const one = chatGptFixture()[0];
    writeFileSync(file, JSON.stringify(Array.from({ length: copies }, (_, i) => ({ ...one, id: `conv-${i}` }))));
    return file;
  }

  /** A run client whose waits are recorded, not slept. */
  async function recordingClient(sleeps: number[]) {
    const { createApiClient } = await import("../lib/api-client.js");
    return createApiClient({
      credentials: { apiKey: "k", apiKeySource: "flag", apiUrl: "http://localhost:3000", apiUrlSource: "flag" },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "membral-http-sites-"));
    process.exitCode = undefined;
    ({ importCommand } = await import("../import-command.js"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("success: POSTs exact request shape, exitCode left untouched (never set to 0 explicitly)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ imported: 1, total: 1, errors: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await importCommand({ file: writeExport(), apiUrl: "http://localhost:3000", apiKey: "lls_key" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = capturedInit(fetchMock);
    expect(url).toBe("http://localhost:3000/api/import");
    expect(init.method).toBe("POST");
    expect(headerObj(init)).toEqual({ "content-type": "application/json", authorization: "Bearer lls_key" });
    expect(JSON.parse(init.body as string).conversations).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  // FLIPPED (site 6, `:273`): 401 still no retry, and now stops the remaining batches (was: one failure per batch).
  it.each([401, 402, 403])("%i: no retry, exitCode 1, the remaining batches are not sent", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(status, "{}"));
    vi.stubGlobal("fetch", fetchMock);
    await importCommand({ file: writeExport(250), apiUrl: "http://localhost:3000", apiKey: "bad" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 3 batches of up to 100; only the first is sent
    expect(process.exitCode).toBe(1);
  });

  // Flipped deliberately (R4, #182 / D-067): /api/import now answers a scoped lls_ key with 403, so the
  // CLI treats 403 as terminal like code-session-upload (was: retried 3x as a generic non-2xx).
  // FLIPPED again (site 6, `:283`): see the 401/402/403 row above for the stop.
  it("403: terminal — no retry, exitCode 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(403, "scoped"));
    vi.stubGlobal("fetch", fetchMock);
    await importCommand({ file: writeExport(), apiUrl: "http://localhost:3000", apiKey: "k" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  // These use REAL timers (not fake): postImportBatch's real setTimeout
  // races with importCommand's real fs readFile before the retry loop is
  // even reached, so fake-timer flushing can resolve before the sleep is
  // even scheduled. Real waits here total well under the timeout below.

  // FLIPPED (site 6, `:296`): was "no Retry-After handling — 3 tries on the plain delay".
  it("429: honours Retry-After, 6 tries, then paces; exitCode 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(429, "", { "retry-after": "7" }));
    vi.stubGlobal("fetch", fetchMock);
    const sleeps: number[] = [];
    await importCommand(
      { file: writeExport(), apiUrl: "http://localhost:3000", apiKey: "k" },
      await recordingClient(sleeps),
    );
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleeps).toEqual([7000, 7000, 7000, 7000, 7000]);
    expect(process.exitCode).toBe(1);
  });

  // NEW (site 6, #170): one client per run, so a 429 in batch 1 paces batch 2 and the delay decays, never resets.
  it("cross-batch: a 429 in batch 1 paces batch 2 on the same run client (state not rebuilt per batch)", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => (++call === 1 ? notOk(429) : ok({ imported: 1, total: 1, errors: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const sleeps: number[] = [];
    await importCommand(
      { file: writeExport(150), apiUrl: "http://localhost:3000", apiKey: "k" },
      await recordingClient(sleeps),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // batch 1: the 429 wait (500); batch 2: the pace grown by that 429 and decayed by the success (1000 x 0.9).
    expect(sleeps).toEqual([500, 900]);
    expect(process.exitCode).toBeUndefined();
  });

  it("500: retries MAX_RETRIES=3 times, exact failure message, exitCode 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(500, "boom"));
    vi.stubGlobal("fetch", fetchMock);
    await importCommand({ file: writeExport(), apiUrl: "http://localhost:3000", apiKey: "k" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);
  }, 10_000);

  // FLIPPED (site 6): was "retries 3 times". A mid-request error may have reached the server; import is not idempotent.
  it("network error mid-request: not re-sent, exact message, exitCode 1", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    await importCommand({ file: writeExport(), apiUrl: "http://localhost:3000", apiKey: "k" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errors.join("\n")).toContain("Network error uploading to http://localhost:3000/api/import: ECONNRESET");
    expect(process.exitCode).toBe(1);
  });

  // NEW (site 6): a connect-phase failure never reached the server, so it is retried (3 tries).
  it("connect-phase error (ECONNREFUSED): retried 3 times", async () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const fetchMock = vi.fn().mockRejectedValue(err);
    vi.stubGlobal("fetch", fetchMock);
    await importCommand(
      { file: writeExport(), apiUrl: "http://localhost:3000", apiKey: "k" },
      await recordingClient([]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);
  });

  // NEW (site 6): an import attempt cut at 310 s is never re-sent (quota and dedup race on the server).
  it("timeout: cut at 310 s, not retried", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchMock = vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_r, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const done = importCommand({ file: writeExport(), apiUrl: "http://localhost:3000", apiKey: "k" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(310_000);
      await done;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // NEW (site 6, `:304` split): other 4xx are terminal (were retried 3x).
  it("400: terminal, one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(400, "bad"));
    vi.stubGlobal("fetch", fetchMock);
    await importCommand({ file: writeExport(), apiUrl: "http://localhost:3000", apiKey: "k" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
  it("malformed JSON on a 2xx: propagates, caught by importCommand, exitCode 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(badJson(200));
    vi.stubGlobal("fetch", fetchMock);
    await importCommand({ file: writeExport(), apiUrl: "http://localhost:3000", apiKey: "k" });
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// known-sessions.ts:67 — postChunk (via fetchKnownSessions). Seam: global
// `fetch`; sleep injected via deps.sleep.
// ---------------------------------------------------------------------------
// R4 4.3 site 5 (#218): on the policy client (endpoint "known"); its env-key
// fallback moved from import-sessions.ts into the client. Flipped: `:393`
// (header-less 429 waits 500 ms, was 2,000). New: 429-Retry-After-on-client
// and timeout rows.
describe("known-sessions.ts postChunk (:67)", () => {
  let fetchKnownSessions: typeof import("../known-sessions.js").fetchKnownSessions;
  let KnownSessionsUnavailableError: typeof import("../known-sessions.js").KnownSessionsUnavailableError;
  let UploadAuthError: typeof import("../code-session-upload.js").UploadAuthError;
  const config = { apiUrl: "https://api.example.com", apiKey: "lls_abc" };
  const s = {
    source: "claude-code" as const,
    sourceSessionId: "s-1",
    contentHash: "h",
    repo: {},
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    turns: [],
    filesTouched: [],
    toolCounts: {},
  };

  beforeEach(async () => {
    const mod = await import("../known-sessions.js");
    fetchKnownSessions = mod.fetchKnownSessions;
    KnownSessionsUnavailableError = mod.KnownSessionsUnavailableError;
    ({ UploadAuthError } = await import("../code-session-upload.js"));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("success: POSTs exact request shape and maps indexes back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ known: [0] }));
    vi.stubGlobal("fetch", fetchMock);
    const known = await fetchKnownSessions(config, [s]);
    expect([...known]).toEqual([s]);
    const [url, init] = capturedInit(fetchMock);
    expect(url).toBe("https://api.example.com/api/code-sessions/known");
    expect(init.method).toBe("POST");
    expect(headerObj(init)).toEqual({ "content-type": "application/json", authorization: "Bearer lls_abc" });
  });

  it("401/403: throws UploadAuthError immediately with the exact message, no retry", async () => {
    for (const status of [401, 403]) {
      const fetchMock = vi.fn().mockResolvedValue(notOk(status));
      vi.stubGlobal("fetch", fetchMock);
      const promise = fetchKnownSessions(config, [s]);
      await expect(promise).rejects.toBeInstanceOf(UploadAuthError);
      await expect(fetchKnownSessions(config, [s])).rejects.toThrow(
        `known-sessions check rejected the API key (${status})`,
      );
    }
  });

  it("429 with Retry-After: sleeps exactly the header value", async () => {
    const sleep = vi.fn(async () => {});
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        call++;
        return call === 1 ? notOk(429, "", { "retry-after": "3" }) : ok({ known: [] });
      }),
    );
    await fetchKnownSessions(config, [s], { sleep });
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  // FLIPPED (site 5, `:393`): the rule-4 first wait, 500 ms (was delayForAttempt(1) = 2000 ms).
  it("429 without Retry-After: sleeps the rule-4 first wait, 500ms", async () => {
    const sleep = vi.fn(async () => {});
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => (call++ === 0 ? notOk(429) : ok({ known: [] }))),
    );
    await fetchKnownSessions(config, [s], { sleep });
    expect(sleep).toHaveBeenCalledWith(500);
  });

  // NEW (site 5): 30 s per attempt, no retry; the caller then uploads everything.
  it("timeout: cut at 30 s, not retried, KnownSessionsUnavailableError", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchMock = vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_r, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const promise = fetchKnownSessions(config, [s]);
      const assertion = expect(promise).rejects.toThrow("network error: timed out after 30000 ms");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("429 exhausted (MAX_RATE_LIMIT_ATTEMPTS=3): throws KnownSessionsUnavailableError('server answered 429')", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notOk(429)));
    await expect(fetchKnownSessions(config, [s], { sleep: vi.fn(async () => {}) })).rejects.toThrow(
      "server answered 429",
    );
  });

  it("500: throws immediately (no retry) with 'server answered 500'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notOk(500)));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await expect(fetchKnownSessions(config, [s])).rejects.toThrow("server answered 500");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("network error: throws immediately (no retry) with 'network error: <message>'", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchKnownSessions(config, [s])).rejects.toBeInstanceOf(KnownSessionsUnavailableError);
    await expect(fetchKnownSessions(config, [s])).rejects.toThrow("network error: ECONNRESET");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("malformed JSON on a 2xx: 'response was not JSON'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(badJson(200)));
    await expect(fetchKnownSessions(config, [s])).rejects.toThrow("response was not JSON");
  });
});

// ---------------------------------------------------------------------------
// device-auth.ts:46/:59 — startDeviceAuth / pollDeviceAuth. Seam: global
// `fetch`; NO retry logic of any kind (contrast with every upload/import
// site above).
// ---------------------------------------------------------------------------
// R4 4.3 site 5 (#218): on the policy client (no key, 15 s, never retried).
// Flipped: `:492`, `:498`, `:522` (typed DeviceAuthError for every non-ok),
// the 429 rows (the message names the wait), and the empty-body row (the
// standard reason phrase; the client does not carry statusText). New: 429
// Retry-After and timeout rows.
describe("device-auth.ts startDeviceAuth (:46) and pollDeviceAuth (:59)", () => {
  let startDeviceAuth: typeof import("../device-auth.js").startDeviceAuth;
  let pollDeviceAuth: typeof import("../device-auth.js").pollDeviceAuth;
  let DeviceAuthError: typeof import("../device-auth.js").DeviceAuthError;
  const device = { id: "dev-1", name: "MacBook", platform: "darwin" };

  beforeEach(async () => {
    const mod = await import("../device-auth.js");
    startDeviceAuth = mod.startDeviceAuth;
    pollDeviceAuth = mod.pollDeviceAuth;
    DeviceAuthError = mod.DeviceAuthError;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("startDeviceAuth success: exact request shape and parsed body", async () => {
    const body = {
      deviceCode: "dc",
      userCode: "AAAA-BBBB",
      verificationUri: "https://x/verify",
      verificationUriComplete: "https://x/verify?c=AAAA-BBBB",
      expiresIn: 600,
      interval: 3,
    };
    const fetchMock = vi.fn().mockResolvedValue(ok(body));
    vi.stubGlobal("fetch", fetchMock);
    const result = await startDeviceAuth("https://api.example.com", device);
    expect(result).toEqual(body);
    const [url, init] = capturedInit(fetchMock);
    expect(url).toBe("https://api.example.com/api/auth/device/start");
    expect(init.method).toBe("POST");
    expect(headerObj(init)).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      deviceName: "MacBook",
      devicePlatform: "darwin",
      deviceId: "dev-1",
    });
  });

  it.each([401, 403, 500])("startDeviceAuth %i: throws DeviceAuthError(status, detail), no retry", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(status, "nope"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(startDeviceAuth("https://api.example.com", device)).rejects.toBeInstanceOf(DeviceAuthError);
    const fetchMock2 = vi.fn().mockResolvedValue(notOk(status, "nope"));
    vi.stubGlobal("fetch", fetchMock2);
    await expect(startDeviceAuth("https://api.example.com", device)).rejects.toThrow("nope");
    expect(fetchMock2).toHaveBeenCalledTimes(1);
  });

  // FLIPPED (site 5): was "DeviceAuthError(429, detail)"; now the message names the wait and carries it.
  it("startDeviceAuth 429: DeviceAuthError(429) naming the Retry-After wait, no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(429, "nope", { "retry-after": "20" }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await startDeviceAuth("https://api.example.com", device).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect((err as Error).message).toBe("rate limited (429) — retry in 20s");
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // FLIPPED (site 5): was '<status> <statusText>' from the response; now the standard reason phrase.
  it("startDeviceAuth non-ok with empty body falls back to '<status> <reason phrase>'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notOk(500, "")));
    await expect(startDeviceAuth("https://api.example.com", device)).rejects.toThrow("500 Internal Server Error");
  });

  // FLIPPED (site 5, `:492`): was the raw rejection.
  it("startDeviceAuth network error: DeviceAuthError(0, message), not retried", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);
    const err = await startDeviceAuth("https://api.example.com", device).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect((err as Error).message).toBe("ECONNRESET");
    expect((err as { status: number }).status).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // FLIPPED (site 5, `:498`): was the raw SyntaxError.
  it("startDeviceAuth malformed JSON on a 2xx: DeviceAuthError(200, 'response was not JSON')", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(badJson(200)));
    await expect(startDeviceAuth("https://api.example.com", device)).rejects.toThrow("response was not JSON");
  });

  // NEW (site 5): 15 s per attempt, never retried.
  it("startDeviceAuth timeout: cut at 15 s, DeviceAuthError, one request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchMock = vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_r, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const promise = startDeviceAuth("https://api.example.com", device);
      const assertion = expect(promise).rejects.toThrow("timed out after 15000 ms");
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pollDeviceAuth success: exact request shape and parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: "pending" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollDeviceAuth("https://api.example.com", "dc-1");
    expect(result).toEqual({ status: "pending" });
    const [url, init] = capturedInit(fetchMock);
    expect(url).toBe("https://api.example.com/api/auth/device/poll");
    expect(init.method).toBe("POST");
    expect(headerObj(init)).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ deviceCode: "dc-1" });
  });

  it.each([401, 429, 500])("pollDeviceAuth %i: throws DeviceAuthError, no retry", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(status, "err"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(pollDeviceAuth("https://api.example.com", "dc-1")).rejects.toBeInstanceOf(DeviceAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // FLIPPED (site 5, `:522`): was the raw rejection.
  it("pollDeviceAuth network error: DeviceAuthError(0, message)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(pollDeviceAuth("https://api.example.com", "dc-1")).rejects.toThrow("offline");
    await expect(pollDeviceAuth("https://api.example.com", "dc-1")).rejects.toBeInstanceOf(DeviceAuthError);
  });

  // NEW (site 5): a poll 429 carries the raw Retry-After for the login loop's wait.
  it("pollDeviceAuth 429 with Retry-After: DeviceAuthError carrying retryAfterMs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notOk(429, "", { "retry-after": "9" })));
    const err = await pollDeviceAuth("https://api.example.com", "dc-1").catch((e: unknown) => e);
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(9000);
  });
});

// ---------------------------------------------------------------------------
// memory-kick.ts:118 — kickMemoryExtraction. Seam: `fetchImpl` param
// (`typeof fetch = fetch`), resolved at call time. Never throws.
// ---------------------------------------------------------------------------
// R4 4.3 site 3 (#180): on the policy client (endpoint "kick"). Flipped: `:572`
// split (401 with an env key retried once with the creds key; 401 without a
// different creds key still logs `server returned 401`); the success row's
// headers (no content-type without a body, design note §3). New: fallback and
// raw Retry-After over 1 h rows.
describe("memory-kick.ts kickMemoryExtraction (:118)", () => {
  let kickMemoryExtraction: typeof import("../memory-kick.js").kickMemoryExtraction;
  let dir: string;
  let statePath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "membral-kick-"));
    statePath = join(dir, "kick-backoff.json");
    // resolveUploadConfig falls back to ~/.membral/credentials.json (a REAL
    // file with a REAL key on this machine) when no apiKey is given —
    // isolate HOME so the "no API key" seam-lock test below is trustworthy.
    process.env.HOME = dir;
    delete process.env.MEMBRAL_API_KEY;
    ({ kickMemoryExtraction } = await import("../memory-kick.js"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it("success: exact request shape (no body), returns { ok, kicked, pending }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ kicked: true, pending: 3 }));
    const result = await kickMemoryExtraction(
      { apiUrl: "https://api.example.com", apiKey: "lls_x" },
      vi.fn(),
      fetchMock as unknown as typeof fetch,
      { statePath },
    );
    expect(result).toEqual({ ok: true, kicked: true, pending: 3 });
    const [url, init] = capturedInit(fetchMock);
    expect(url).toBe("https://api.example.com/api/memory/extraction/kick");
    expect(init.method).toBe("POST");
    // FLIPPED (site 3): no `content-type` on a body-less POST (design note §3 request shape).
    expect(headerObj(init)).toEqual({ authorization: "Bearer lls_x" });
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // FLIPPED (site 3, `:572` split): a 401 with no different creds key still ends here; see the fallback row below.
  // FLIPPED (2026-10-08): the line names the endpoint path; a 401 also names the key source and the fix.
  it("401/403/500: never throws, logs 'server returned <status>', returns { ok: false }, no retry", async () => {
    for (const status of [401, 403, 500]) {
      const logLine = vi.fn();
      const fetchMock = vi.fn().mockResolvedValue(notOk(status));
      const result = await kickMemoryExtraction(
        { apiUrl: "https://api.example.com", apiKey: "lls_x" },
        logLine,
        fetchMock as unknown as typeof fetch,
        { statePath: join(dir, `s-${status}.json`) },
      );
      expect(result).toEqual({ ok: false });
      const line = String(logLine.mock.calls[0]?.[0]);
      expect(
        line.startsWith(`memory extraction kick (POST /api/memory/extraction/kick): server returned ${status}`),
      ).toBe(true);
      expect(line.includes("lls_x")).toBe(false); // a key ≤ 8 chars is never shown, even as a prefix
      expect(line.includes("rejected API key … from the --api-key flag")).toBe(status === 401);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  // NEW (site 3, `:572` split): an env-key 401 is retried once with the credentials.json key.
  it("401 with an env key: retried once with the credentials.json key, one fallback line", async () => {
    const lines: string[] = [];
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
      headerObj(init).authorization === "Bearer lls_env" ? notOk(401) : ok({ kicked: true, pending: 0 }),
    );
    const client = await envFallbackClient(dir, "https://api.example.com", lines, fetchMock as unknown as typeof fetch);
    const result = await kickMemoryExtraction(
      { apiUrl: "https://api.example.com", apiKey: "lls_x" },
      vi.fn(),
      undefined,
      {
        statePath,
      },
      client,
    );
    expect(result).toEqual({ ok: true, kicked: true, pending: 0 });
    expect(fetchMock.mock.calls.map(([, init]) => headerObj(init).authorization)).toEqual([
      "Bearer lls_env",
      "Bearer lls_creds",
    ]);
    expect(lines).toHaveLength(1);
  });

  // NEW (site 3): the raw Retry-After reaches the file backoff, which caps it at 1 h.
  it("429 with Retry-After 7200: the file backoff waits the 1 h cap", async () => {
    const logLine = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(notOk(429, "", { "retry-after": "7200" }));
    await kickMemoryExtraction(
      { apiUrl: "https://api.example.com", apiKey: "lls_x" },
      logLine,
      fetchMock as unknown as typeof fetch,
      { statePath: join(dir, "cap.json"), now: () => 0 },
    );
    expect(logLine).toHaveBeenCalledWith("memory extraction kick: server returned 429 — next try in 3600s");
  });

  it("429 with Retry-After: waits at least the header value, logs it, returns { ok: false }", async () => {
    const logLine = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(notOk(429, "", { "retry-after": "30" }));
    const result = await kickMemoryExtraction(
      { apiUrl: "https://api.example.com", apiKey: "lls_x" },
      logLine,
      fetchMock as unknown as typeof fetch,
      { statePath: join(dir, "ra.json"), now: () => 0 },
    );
    expect(result).toEqual({ ok: false });
    expect(logLine).toHaveBeenCalledWith("memory extraction kick: server returned 429 — next try in 30s");
  });

  it("429 without Retry-After: falls back to KICK_INITIAL_DELAY_MS (10s)", async () => {
    const logLine = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(notOk(429));
    const result = await kickMemoryExtraction(
      { apiUrl: "https://api.example.com", apiKey: "lls_x" },
      logLine,
      fetchMock as unknown as typeof fetch,
      { statePath: join(dir, "no-ra.json"), now: () => 0 },
    );
    expect(result).toEqual({ ok: false });
    expect(logLine).toHaveBeenCalledWith("memory extraction kick: server returned 429 — next try in 10s");
  });

  it("network error: caught, logs 'kick failed: <message>', returns { ok: false }, never throws", async () => {
    const logLine = vi.fn();
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const result = await kickMemoryExtraction(
      { apiUrl: "https://api.example.com", apiKey: "lls_x" },
      logLine,
      fetchMock as unknown as typeof fetch,
      { statePath },
    );
    expect(result).toEqual({ ok: false });
    expect(logLine).toHaveBeenCalledWith("memory extraction kick failed: ECONNRESET");
  });

  it("malformed JSON on a 2xx: swallowed — returns { ok: true, kicked: undefined, pending: undefined }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(badJson(200));
    const result = await kickMemoryExtraction(
      { apiUrl: "https://api.example.com", apiKey: "lls_x" },
      vi.fn(),
      fetchMock as unknown as typeof fetch,
      { statePath },
    );
    expect(result).toEqual({ ok: true, kicked: undefined, pending: undefined });
  });

  it("no API key: never calls fetch, returns { ok: true }", async () => {
    const fetchMock = vi.fn();
    const result = await kickMemoryExtraction({ apiUrl: "https://api.example.com", apiKey: "" }, vi.fn(), fetchMock);
    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchImpl defaults to fetch, resolved at call time", async () => {
    const a = vi.fn().mockResolvedValue(ok({ kicked: false }));
    vi.stubGlobal("fetch", a);
    await kickMemoryExtraction({ apiUrl: "https://api.example.com", apiKey: "lls_x" }, vi.fn(), undefined, {
      statePath: join(dir, "gt1.json"),
    });
    expect(a).toHaveBeenCalledTimes(1);

    const b = vi.fn().mockResolvedValue(ok({ kicked: false }));
    vi.stubGlobal("fetch", b);
    await kickMemoryExtraction({ apiUrl: "https://api.example.com", apiKey: "lls_x" }, vi.fn(), undefined, {
      statePath: join(dir, "gt2.json"),
    });
    expect(b).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// credentials.ts:430 — validateApiKey. Seam: `fetchImpl` param. Never
// throws; 429 gets NO special handling (falls into "unknown" like any
// other non-2xx, non-401 status — contrast with every retrying site above).
// ---------------------------------------------------------------------------
// R4 4.3 PR 7: validateApiKey moved onto the policy client (endpoint
// "validateKey"). No row flips except the GET shape (no `method` key).
describe("credentials.ts validateApiKey (:430)", () => {
  let validateApiKey: typeof import("../credentials.js").validateApiKey;

  beforeEach(async () => {
    ({ validateApiKey } = await import("../credentials.js"));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("success: exact request shape (GET, no content-type) and status 'valid'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ totals: {} }));
    const result = await validateApiKey("https://api.example.com/", "lls_key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ status: "valid", httpStatus: 200 });
    const [url, init] = capturedInit(fetchMock);
    expect(url).toBe("https://api.example.com/api/code-sessions/stats?days=1");
    // FLIPPED (PR 7): a GET carries no `method` key (design note §3 / #218).
    expect(init.method).toBeUndefined();
    expect(headerObj(init)).toEqual({ authorization: "Bearer lls_key" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("401: status 'invalid', httpStatus 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(401));
    const result = await validateApiKey("https://api.example.com", "lls_bad", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ status: "invalid", httpStatus: 401 });
  });

  it("403: NOT distinguished from a generic failure — status 'unknown'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(403));
    const result = await validateApiKey("https://api.example.com", "lls_key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ status: "unknown", httpStatus: 403 });
  });

  it("429: NOT retried, NOT distinguished — status 'unknown', httpStatus 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(429, "", { "retry-after": "10" }));
    const result = await validateApiKey("https://api.example.com", "lls_key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ status: "unknown", httpStatus: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("500: status 'unknown', httpStatus 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(500));
    const result = await validateApiKey("https://api.example.com", "lls_key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ status: "unknown", httpStatus: 500 });
  });

  it("network error: status 'unknown' with the caught message, never throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await validateApiKey("https://api.example.com", "lls_key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ status: "unknown", error: "ECONNREFUSED" });
  });

  it("malformed JSON on a 2xx: status 'unknown' with the exact message, never throws", async () => {
    const fetchMock = vi.fn().mockResolvedValue(badJson(200));
    const result = await validateApiKey("https://api.example.com", "lls_key", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ status: "unknown", httpStatus: 200, error: "200 response was not valid JSON" });
  });

  it("empty API key: never calls fetch, status 'invalid'", async () => {
    const fetchMock = vi.fn();
    const result = await validateApiKey("https://api.example.com", "", fetchMock);
    expect(result).toEqual({ status: "invalid", error: "no API key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// branch-state-check.ts:197/:216 — fetchRefsToCheck / postBranchState. Seam:
// `fetchImpl` param. NO retry of any kind and NO Retry-After awareness on
// either site — sharpest contrast with the upload/known-sessions sites.
// ---------------------------------------------------------------------------
// R4 4.3 site 4 (#180): on the policy client (endpoints "refs" and
// "branchState"). Flipped: `:776` (GET bad JSON is a typed error), the GET
// shape (no `method` key, design note §3 / #218), and the network rows (an
// Error carrying the message, not the raw rejection). New: 401 fallback rows.
describe("branch-state-check.ts fetchRefsToCheck (:197) and postBranchState (:216)", () => {
  let fetchRefsToCheck: typeof import("../branch-state-check.js").fetchRefsToCheck;
  let postBranchState: typeof import("../branch-state-check.js").postBranchState;
  const config = { apiUrl: "https://api.example.com", apiKey: "lls_abc" };

  beforeEach(async () => {
    ({ fetchRefsToCheck, postBranchState } = await import("../branch-state-check.js"));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetchRefsToCheck success: exact GET shape, returns repos", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ repos: [{ codeProjectId: "p1" }] }));
    const result = await fetchRefsToCheck(config, fetchMock as unknown as typeof fetch);
    expect(result).toEqual([{ codeProjectId: "p1" }]);
    const [url, init] = capturedInit(fetchMock);
    expect(url).toBe("https://api.example.com/api/memory/branch-state");
    // FLIPPED (site 4): a GET carries no `method` key (fetch's default).
    expect(init.method).toBeUndefined();
    expect(headerObj(init)).toEqual({ authorization: "Bearer lls_abc" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fetchRefsToCheck: a body with no `repos` array returns []", async () => {
    const result = await fetchRefsToCheck(config, vi.fn().mockResolvedValue(ok({})) as unknown as typeof fetch);
    expect(result).toEqual([]);
  });

  it.each([
    401, 403, 429, 500,
  ])("fetchRefsToCheck %i: throws Error('server returned <status>'), no retry", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(status, "", { "retry-after": "5" }));
    await expect(fetchRefsToCheck(config, fetchMock as unknown as typeof fetch)).rejects.toThrow(
      `server returned ${status}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // FLIPPED (site 4): was "propagates raw, unwrapped" (the same Error object).
  it("fetchRefsToCheck network error: an Error with the message, no retry", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(fetchRefsToCheck(config, fetchMock as unknown as typeof fetch)).rejects.toThrow("ECONNRESET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // FLIPPED (site 4, `:776`): was the raw SyntaxError text.
  it("fetchRefsToCheck malformed JSON on a 2xx: typed error (contrast with postBranchState)", async () => {
    await expect(
      fetchRefsToCheck(config, vi.fn().mockResolvedValue(badJson(200)) as unknown as typeof fetch),
    ).rejects.toThrow("server returned 200 but the response was not JSON");
  });

  // NEW (site 4): an env-key 401 falls back once, for both calls, on one client.
  it("401 with an env key: refs and branchState retry once with the credentials.json key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "membral-branch-fallback-"));
    try {
      const lines: string[] = [];
      const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
        headerObj(init).authorization === "Bearer lls_env" ? notOk(401) : ok({ repos: [], upserted: 1, rejected: 0 }),
      );
      const client = await envFallbackClient(dir, config.apiUrl, lines, fetchMock as unknown as typeof fetch);
      await expect(fetchRefsToCheck(config, undefined, client)).resolves.toEqual([]);
      await expect(
        postBranchState(config, [sampleResult], "2026-09-28T00:00:00.000Z", undefined, client),
      ).resolves.toEqual({
        upserted: 1,
        rejected: 0,
      });
      expect(fetchMock.mock.calls.map(([, init]) => headerObj(init).authorization)).toEqual([
        "Bearer lls_env",
        "Bearer lls_creds",
        "Bearer lls_creds",
      ]);
      expect(lines).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const sampleResult = {
    code_project_id: "p1",
    branch: "main",
    default_branch: "main",
    last_seen_sha: "s",
    merged_into_default: false,
    sha_superseded_by: null,
    branch_gone: false,
  };

  it("postBranchState success: exact POST shape, returns counts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ upserted: 1, rejected: 0 }));
    const result = await postBranchState(
      config,
      [sampleResult],
      "2026-09-28T00:00:00.000Z",
      fetchMock as unknown as typeof fetch,
    );
    expect(result).toEqual({ upserted: 1, rejected: 0 });
    const [url, init] = capturedInit(fetchMock);
    expect(url).toBe("https://api.example.com/api/memory/branch-state");
    expect(init.method).toBe("POST");
    expect(headerObj(init)).toEqual({ authorization: "Bearer lls_abc", "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      checked_at: "2026-09-28T00:00:00.000Z",
      results: [sampleResult],
    });
  });

  it.each([
    401, 403, 429, 500,
  ])("postBranchState %i: throws Error('server returned <status>'), no retry", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(status));
    await expect(
      postBranchState(config, [sampleResult], "2026-09-28T00:00:00.000Z", fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(`server returned ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // FLIPPED (site 4): was "propagates raw, unwrapped".
  it("postBranchState network error: an Error with the message", async () => {
    await expect(
      postBranchState(
        config,
        [sampleResult],
        "2026-09-28T00:00:00.000Z",
        vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch,
      ),
    ).rejects.toThrow("offline");
  });

  it("postBranchState malformed JSON on a 2xx: swallowed via .catch — returns { upserted: 0, rejected: 0 }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(badJson(200));
    const result = await postBranchState(
      config,
      [sampleResult],
      "2026-09-28T00:00:00.000Z",
      fetchMock as unknown as typeof fetch,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ upserted: 0, rejected: 0 });
  });
});

// R4 4.3 site 2 (#180): on the policy client (endpoint "preamble"). Flipped:
// `:890` header casing (`authorization`, `accept`). New: fallback and
// 4 s-budget rows.
// ---------------------------------------------------------------------------
// preamble-hook.ts:146 — preambleHookInner's fetch call (via preambleHook).
// Seam: `opts.fetchImpl ?? fetch`. Header casing here is `Authorization`
// (capital A) + `Accept` — differs from every other site's lowercase
// `authorization` and no `Accept` header. NEVER throws; only ever writes
// stdout on a fully-validated success.
// ---------------------------------------------------------------------------
describe("preamble-hook.ts preambleHookInner fetch (:146)", () => {
  let preambleHook: typeof import("../preamble-hook.js").preambleHook;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  function hookInput() {
    return JSON.stringify({ session_id: "s1", cwd: "/tmp/nonexistent-repo", source: "startup" });
  }
  function stdinWith(text: string) {
    return Readable.from([text]);
  }
  function goodBody() {
    return { lines: ["line one"], recall_token: "tok", open_blockers: [] };
  }

  let root: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Same isolation as memory-kick above: resolveUploadConfig falls back to
    // a REAL ~/.membral/credentials.json when no apiKey is given.
    root = mkdtempSync(join(tmpdir(), "membral-preamble-http-sites-"));
    process.env.HOME = root;
    delete process.env.MEMBRAL_API_KEY;
    ({ preambleHook } = await import("../preamble-hook.js"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });
  function stdout(): string {
    return writeSpy.mock.calls.map((c) => String(c[0])).join("");
  }

  // FLIPPED (site 2, `:890`): casing only — was `Authorization` / `Accept`.
  it("success: exact GET request shape (lowercase authorization, accept header), writes hook output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(goodBody()));
    await preambleHook({
      stdin: stdinWith(hookInput()),
      apiUrl: "https://api.example.com",
      apiKey: "lls_x",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = capturedInit(fetchMock);
    expect(url).toMatch(/^https:\/\/api\.example\.com\/api\/memory\/preamble\?repo=/);
    expect(headerObj(init)).toEqual({ authorization: "Bearer lls_x", accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(stdout())).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "line one" },
    });
  });

  it.each([401, 403, 429, 500])("%i: silent — no stdout write, no throw, no retry", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(notOk(status));
    await preambleHook({
      stdin: stdinWith(hookInput()),
      apiUrl: "https://api.example.com",
      apiKey: "lls_x",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stdout()).toBe("");
  });

  it("network error: silent, never throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      preambleHook({
        stdin: stdinWith(hookInput()),
        apiUrl: "https://api.example.com",
        apiKey: "lls_x",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    expect(stdout()).toBe("");
  });

  it("malformed JSON on a 2xx: silent, never throws", async () => {
    const fetchMock = vi.fn().mockResolvedValue(badJson(200));
    await preambleHook({
      stdin: stdinWith(hookInput()),
      apiUrl: "https://api.example.com",
      apiKey: "lls_x",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(stdout()).toBe("");
  });

  // NEW (site 2): an env-key 401 falls back inside the budget; stdout gets the preamble, the line goes to hook.log.
  it("401 with an env key: retried once with the credentials.json key; stdout silent about it, one hook-log line", async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
      headerObj(init).authorization === "Bearer lls_env" ? notOk(401) : ok(goodBody()),
    );
    const lines: string[] = [];
    const client = await envFallbackClient(
      root,
      "https://api.example.com",
      lines,
      fetchMock as unknown as typeof fetch,
    );
    await preambleHook({ stdin: stdinWith(hookInput()), apiUrl: "https://api.example.com", apiKey: "lls_x", client });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(stdout())).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "line one" },
    });
  });

  // NEW (site 2): the default client logs the fallback line to hook.log, never stdout.
  it("401 with an env key on the default client: the fallback line lands in hook.log as JSON", async () => {
    const { saveCredentials } = await import("../credentials.js");
    const { readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    saveCredentials(
      { apiUrl: "https://api.example.com", apiKey: "lls_creds", email: "e", userId: "u", createdAt: "c" },
      join(homedir(), ".membral", "credentials.json"),
    );
    process.env.MEMBRAL_API_KEY = "lls_env";
    const hookLogPath = join(root, "hook.log");
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
      headerObj(init).authorization === "Bearer lls_env" ? notOk(401) : ok(goodBody()),
    );
    await preambleHook({
      stdin: stdinWith(hookInput()),
      apiUrl: "https://api.example.com",
      fetchImpl: fetchMock as unknown as typeof fetch,
      hookLogPath,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const logged = readFileSync(hookLogPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ hook: "preamble" });
    expect(String(logged[0].reason)).toContain("MEMBRAL_API_KEY was rejected");
    expect(stdout()).toContain("line one");
    rmSync(join(homedir(), ".membral"), { recursive: true, force: true });
  });

  // NEW (site 2): the caller's budget (4 s under the plugin; scaled down here) bounds the whole call; past it, silent.
  it("budget: a reply slower than timeoutMs is cut at the budget, silent, no retry", async () => {
    const fetchMock = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(ok(goodBody())), 5_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const started = Date.now();
    await preambleHook({
      stdin: stdinWith(hookInput()),
      apiUrl: "https://api.example.com",
      apiKey: "lls_x",
      timeoutMs: 300,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stdout()).toBe("");
  });

  it("no API key: never calls fetch", async () => {
    const fetchMock = vi.fn();
    await preambleHook({
      stdin: stdinWith(hookInput()),
      apiUrl: "https://api.example.com",
      apiKey: "",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchImpl defaults to global fetch, resolved at call time", async () => {
    const a = vi.fn().mockResolvedValue(ok(goodBody()));
    vi.stubGlobal("fetch", a);
    await preambleHook({ stdin: stdinWith(hookInput()), apiUrl: "https://api.example.com", apiKey: "lls_x" });
    expect(a).toHaveBeenCalledTimes(1);
  });
});
