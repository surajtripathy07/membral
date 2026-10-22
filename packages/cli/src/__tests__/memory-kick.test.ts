// POST /api/memory/extraction/kick client (memory-kick.ts).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same isolation as code-session-upload.test.ts: force a nonexistent
// credentials.json path so this never reads the real
// ~/.membral/credentials.json on this machine.
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

const { kickMemoryExtraction, nextKickDelay, kickBackoffPath } = await import("../memory-kick.js");

const ENV_KEYS = ["MEMBRAL_API_KEY", "MEMBRAL_API_URL"] as const;

describe("kickMemoryExtraction", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.MEMBRAL_API_KEY;
    delete process.env.MEMBRAL_API_URL;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("no-ops (ok: true) when there is no api key configured", async () => {
    const fetchImpl = vi.fn();
    const result = await kickMemoryExtraction({}, vi.fn(), fetchImpl);
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the kick endpoint with the resolved profile's Bearer key and returns the body", async () => {
    process.env.MEMBRAL_API_KEY = "lls_test";
    process.env.MEMBRAL_API_URL = "https://membral.example";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ kicked: true, pending: 3 }), { status: 200 }));
    const result = await kickMemoryExtraction({}, vi.fn(), fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, kicked: true, pending: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://membral.example/api/memory/extraction/kick");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer lls_test");
  });

  it("logs one line and returns ok:false on a non-2xx response, without throwing", async () => {
    process.env.MEMBRAL_API_KEY = "lls_test";
    const logLine = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const result = await kickMemoryExtraction({}, logLine, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false });
    expect(logLine).toHaveBeenCalledTimes(1);
    expect(logLine.mock.calls[0][0]).toContain("500");
  });

  it("logs one line and returns ok:false when the request throws, without throwing", async () => {
    process.env.MEMBRAL_API_KEY = "lls_test";
    const logLine = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await kickMemoryExtraction({}, logLine, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false });
    expect(logLine.mock.calls[0][0]).toContain("network down");
  });

  it("a 401 names the endpoint, the server, the masked key and its source, and the fix command", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "membral-kick-")), "kick-backoff.json");
    const rejected = vi.fn(async () => new Response("Invalid API key", { status: 401 }));
    const log = vi.fn();
    const result = await kickMemoryExtraction(
      { apiUrl: "http://localhost:3000", apiKey: "lls_new_stack_key" },
      log,
      rejected,
      { statePath },
    );
    expect(result).toEqual({ ok: false });
    expect(rejected).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls.at(-1)?.[0]);
    expect(line).toContain("memory extraction kick (POST /api/memory/extraction/kick): server returned 401");
    expect(line).not.toContain("/api/internal/cron");
    expect(line).toContain("the server at http://localhost:3000 rejected API key lls_ne… from the --api-key flag");
    expect(line).not.toContain("lls_new_stack_key");
    expect(line).toContain("lsof -nP -iTCP:3000 -sTCP:LISTEN");
  });

  it("a 429 is never retried at once: later runs wait out max(Retry-After, delay), the delay grows and decays, never resets", async () => {
    process.env.MEMBRAL_API_KEY = "lls_test";
    process.env.MEMBRAL_API_URL = "http://127.0.0.1:9";
    const statePath = join(mkdtempSync(join(tmpdir(), "membral-kick-")), "kick-backoff.json");
    let t = 1_000_000;
    const now = () => t;
    const limited = vi.fn(async () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    const log = vi.fn();

    expect(await kickMemoryExtraction({}, log, limited, { statePath, now })).toEqual({ ok: false });
    expect(log).toHaveBeenLastCalledWith("memory extraction kick: server returned 429 — next try in 30s");
    // An immediate second run sends nothing.
    t += 5_000;
    expect(await kickMemoryExtraction({}, log, limited, { statePath, now })).toEqual({ ok: true });
    expect(limited).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith("memory extraction kick: rate-limited, next try in 25s");

    // After the wait, another 429 without Retry-After grows the delay x3 (10s -> 30s).
    t += 30_000;
    const bare = vi.fn(async () => new Response("", { status: 429 }));
    await kickMemoryExtraction({}, log, bare, { statePath, now });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ delayMs: 30_000, notBefore: t + 30_000 });

    // A success after the wait decays it by 0.9, not back to the initial 10s.
    t += 30_000;
    const ok = vi.fn(async () => new Response(JSON.stringify({ kicked: true }), { status: 200 }));
    expect(await kickMemoryExtraction({}, log, ok, { statePath, now })).toMatchObject({ ok: true, kicked: true });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ delayMs: 27_000, notBefore: 0 });
  });

  it("caps Retry-After at an hour", async () => {
    process.env.MEMBRAL_API_KEY = "lls_test";
    process.env.MEMBRAL_API_URL = "http://127.0.0.1:9";
    const statePath = join(mkdtempSync(join(tmpdir(), "membral-kick-")), "kick-backoff.json");
    const t = 1_000_000;
    const huge = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "99999999" } }));
    await kickMemoryExtraction({}, vi.fn(), huge, { statePath, now: () => t });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ delayMs: 10_000, notBefore: t + 60 * 60_000 });
    const far = new Date(t + 10 * 24 * 3600_000).toUTCString();
    const dated = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": far } }));
    const statePath2 = join(mkdtempSync(join(tmpdir(), "membral-kick-")), "kick-backoff.json");
    await kickMemoryExtraction({}, vi.fn(), dated, { statePath: statePath2, now: () => t });
    expect(JSON.parse(readFileSync(statePath2, "utf8")).notBefore).toBe(t + 60 * 60_000);
  });

  it("clamps a corrupt persisted state on read: delay 0 is the 10s initial, a far notBefore waits at most an hour", async () => {
    process.env.MEMBRAL_API_KEY = "lls_test";
    process.env.MEMBRAL_API_URL = "http://127.0.0.1:9";
    const statePath = join(mkdtempSync(join(tmpdir(), "membral-kick-")), "kick-backoff.json");
    const t = 1_000_000;
    writeFileSync(statePath, JSON.stringify({ delayMs: 0, notBefore: 0 }));
    const bare = vi.fn(async () => new Response("", { status: 429 }));
    await kickMemoryExtraction({}, vi.fn(), bare, { statePath, now: () => t });
    // 0 -> clamped to 10s, then x3 on the 429: never an immediate retry.
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ delayMs: 30_000, notBefore: t + 30_000 });

    writeFileSync(statePath, JSON.stringify({ delayMs: 1e15, notBefore: t + 1e12 }));
    const log = vi.fn();
    expect(await kickMemoryExtraction({}, log, bare, { statePath, now: () => t })).toEqual({ ok: true });
    expect(log).toHaveBeenLastCalledWith("memory extraction kick: rate-limited, next try in 3600s");
    await kickMemoryExtraction({}, vi.fn(), bare, { statePath, now: () => t + 60 * 60_000 });
    expect(JSON.parse(readFileSync(statePath, "utf8")).delayMs).toBe(60 * 60_000);

    writeFileSync(statePath, JSON.stringify({ delayMs: -5, notBefore: 0 }));
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    await kickMemoryExtraction({}, vi.fn(), ok, { statePath, now: () => t });
    expect(JSON.parse(readFileSync(statePath, "utf8")).delayMs).toBe(10_000);
  });

  it("keys the backoff state by API base URL, so local and prod profiles back off separately", async () => {
    process.env.MEMBRAL_API_KEY = "lls_test";
    const stateDir = mkdtempSync(join(tmpdir(), "membral-kick-"));
    const t = 1_000_000;
    const limited = vi.fn(async () => new Response("", { status: 429 }));
    process.env.MEMBRAL_API_URL = "http://localhost:3000";
    await kickMemoryExtraction({}, vi.fn(), limited, { stateDir, now: () => t });
    expect(existsSync(kickBackoffPath("http://localhost:3000", stateDir))).toBe(true);
    expect(kickBackoffPath("http://localhost:3000/", stateDir)).toBe(
      kickBackoffPath("http://localhost:3000", stateDir),
    );
    expect(kickBackoffPath("https://membral.example", stateDir)).not.toBe(
      kickBackoffPath("http://localhost:3000", stateDir),
    );

    process.env.MEMBRAL_API_URL = "https://membral.example";
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    await kickMemoryExtraction({}, vi.fn(), ok, { stateDir, now: () => t + 1 });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("the delay grows x1.5 once past a minute and is capped", () => {
    expect(nextKickDelay(10_000)).toBe(30_000);
    expect(nextKickDelay(90_000)).toBe(90_000 * 1.5);
    expect(nextKickDelay(50 * 60_000)).toBe(60 * 60_000);
  });
});
