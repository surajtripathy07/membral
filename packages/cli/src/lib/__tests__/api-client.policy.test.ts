// R4 step 4.2 — the policy client (docs/design/cli-api-client-contract.md §3-§5,
// test plan §7 item 1). No site uses it yet; these pin its contract.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialSource, ResolvedCredentials } from "../../credentials.js";
import {
  type ApiClientOptions,
  type ApiResult,
  createApiClient,
  ENDPOINTS,
  ENV_KEY_MARKER_TTL_MS,
  type EndpointId,
  envKeyMarkerPath,
} from "../api-client.js";

const URL_A = "https://a.example";
const URL_B = "https://b.example";
const ENV_KEY = "mk_env_secret_aaaa";
const CREDS_KEY = "mk_creds_secret_bbbb";
const T0 = 1_800_000_000_000;

type Reply = { status: number; body?: string; headers?: Record<string, string> };
const res = (r: Reply): Response =>
  ({
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: new Headers(r.headers ?? {}),
    text: async () => r.body ?? "{}",
  }) as unknown as Response;

function connectError(code = "ECONNREFUSED"): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: { code } });
}

/** A fetch whose replies are scripted; a reply may be a function of (url, init). */
function scripted(...replies: Array<Reply | Error | ((url: string, init: RequestInit) => Promise<Response>)>) {
  let i = 0;
  return vi.fn(async (url: string, init: RequestInit) => {
    const r = replies[Math.min(i++, replies.length - 1)];
    if (typeof r === "function") return r(url, init);
    if (r instanceof Error) throw r;
    return res(r);
  });
}

/** Keyed fetch: answers by the bearer key sent. */
function byKey(map: Record<string, Reply[]>) {
  const seen: Record<string, number> = {};
  return vi.fn(async (_url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization ?? "";
    const key = auth.replace(/^Bearer /, "");
    const list = map[key] ?? [{ status: 500 }];
    const n = seen[key] ?? 0;
    seen[key] = n + 1;
    return res(list[Math.min(n, list.length - 1)]);
  });
}

/** A fetch that answers after `ms` (fake timers), honouring the abort signal, optionally slow in the body read. */
function slow(ms: number, reply: Reply = { status: 200 }, bodyMs = 0) {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init.signal as AbortSignal;
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        setTimeout(() => {
          resolve({
            status: reply.status,
            headers: new Headers(reply.headers ?? {}),
            text: () =>
              new Promise<string>((res2, rej2) => {
                if (signal.aborted) return rej2(new Error("aborted"));
                signal.addEventListener("abort", () => rej2(new Error("aborted")), { once: true });
                setTimeout(() => res2(reply.body ?? "{}"), bodyMs);
              }),
          } as unknown as Response);
        }, ms);
      }),
  );
}

let dir: string;
let credsPath: string;
let t: number;
let sleeps: number[];
let lines: string[];

function writeCreds(apiKey: string, apiUrl: string): void {
  writeFileSync(credsPath, JSON.stringify({ apiUrl, apiKey, email: "e@x", userId: "u", createdAt: "2026-01-01" }));
}

function creds(source: CredentialSource, apiKey = ENV_KEY, apiUrl = URL_A): ResolvedCredentials {
  return { apiKey, apiKeySource: source, apiUrl, apiUrlSource: source };
}

function client(fetchImpl: unknown, over: Partial<ApiClientOptions> = {}) {
  return createApiClient({
    credentials: creds("env"),
    credsPath,
    fetchImpl: fetchImpl as typeof fetch,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    log: (l) => lines.push(l),
    ...over,
  });
}

const keysSent = (f: ReturnType<typeof vi.fn>): string[] =>
  f.mock.calls.map((c) => ((c[1] as RequestInit).headers as Record<string, string>).authorization);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "api-client-policy-"));
  credsPath = join(dir, "credentials.json");
  t = T0;
  sleeps = [];
  lines = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
describe("ENDPOINTS rows", () => {
  const ids = Object.keys(ENDPOINTS) as EndpointId[];

  it("matches the §4 table: timeouts, budgets, buckets", () => {
    const row = (id: EndpointId) => {
      const p = ENDPOINTS[id];
      return [p.method, p.path, p.timeoutMs, p.attempts.network, p.attempts.server5xx, p.attempts.rateLimited, p.pace];
    };
    expect(row("upload")).toEqual(["POST", "/api/code-sessions", 135_000, 3, 3, 6, true]);
    expect(row("known")).toEqual(["POST", "/api/code-sessions/known", 30_000, 1, 1, 3, false]);
    expect(row("import")).toEqual(["POST", "/api/import", 310_000, 3, 3, 6, true]);
    expect(row("preamble")).toEqual(["GET", "/api/memory/preamble", 20_000, 1, 1, 1, false]);
    expect(row("promptRecall")).toEqual(["POST", "/api/memory/prompt-recall", 3_000, 1, 1, 1, false]);
    expect(row("kick")).toEqual(["POST", "/api/memory/extraction/kick", 10_000, 1, 1, 1, false]);
    expect(row("refs")).toEqual(["GET", "/api/memory/branch-state", 20_000, 1, 1, 1, false]);
    expect(row("branchState")).toEqual(["POST", "/api/memory/branch-state", 20_000, 1, 1, 1, false]);
    expect(row("servedUsed")).toEqual(["GET", "/api/memory/served-used", 4_000, 1, 1, 1, false]);
    expect(row("dogfood")).toEqual(["GET", "/api/memory/dogfood", 4_000, 1, 1, 1, false]);
    expect(row("questionnaire")).toEqual(["POST", "/api/memory/questionnaire", 10_000, 1, 1, 1, false]);
    expect(row("deviceStart")).toEqual(["POST", "/api/auth/device/start", 15_000, 1, 1, 1, false]);
    expect(row("devicePoll")).toEqual(["POST", "/api/auth/device/poll", 15_000, 1, 1, 1, false]);
    expect(row("validateKey")).toEqual(["GET", "/api/code-sessions/stats?days=1", 10_000, 1, 1, 1, false]);
    expect(ENDPOINTS.validateKey.bucket).toBeNull();
    expect(ENDPOINTS.upload.idempotent).toBe("unless-force");
    expect(ENDPOINTS.import.idempotent).toBe(false);
    expect(ENDPOINTS.validateKey.on401).toBe("answer");
  });

  for (const id of ids) {
    const p = ENDPOINTS[id];
    it(`${id}: ${p.attempts.server5xx} tries on 5xx, then http`, async () => {
      const f = scripted({ status: 503, body: "down" });
      const r = await client(f).call(id);
      expect(r).toEqual({ ok: false, kind: "http", status: 503, detail: "down" });
      expect(f).toHaveBeenCalledTimes(p.attempts.server5xx);
    });

    it(`${id}: ${p.attempts.rateLimited} tries on 429, never an immediate retry`, async () => {
      const f = scripted({ status: 429 });
      const r = await client(f).call(id);
      expect(r).toMatchObject({ ok: false, kind: "rate_limited", attempts: p.attempts.rateLimited });
      expect(f).toHaveBeenCalledTimes(p.attempts.rateLimited);
      expect(sleeps.length).toBe(p.attempts.rateLimited - 1);
      for (const s of sleeps) expect(s).toBeGreaterThanOrEqual(500);
    });

    it(`${id}: ${p.attempts.network} tries on a connect-phase failure`, async () => {
      const f = scripted(connectError());
      const r = await client(f).call(id);
      expect(r).toMatchObject({ ok: false, kind: "network", attempts: p.attempts.network });
      expect(f).toHaveBeenCalledTimes(p.attempts.network);
    });

    it(`${id}: other 4xx are terminal (400, 404, 409, 413, 422)`, async () => {
      for (const status of [400, 404, 409, 413, 422]) {
        const f = scripted({ status, body: "nope" });
        expect(await client(f).call(id)).toEqual({ ok: false, kind: "http", status, detail: "nope" });
        expect(f).toHaveBeenCalledTimes(1);
      }
    });

    it(`${id}: accept header ${p.accept ? "sent" : "absent"}; auth ${p.auth}`, async () => {
      const f = scripted({ status: 200 });
      await client(f).call(id, p.method === "POST" ? { json: { a: 1 } } : {});
      const h = (f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      if (id === "preamble") expect(h.accept).toBe("application/json");
      else expect(h.accept).toBeUndefined();
      if (p.auth === "key") expect(h.authorization).toBe(`Bearer ${ENV_KEY}`);
      else expect(h.authorization).toBeUndefined();
    });
  }

  it("408 counts as a 5xx", async () => {
    const f = scripted({ status: 408 }, { status: 200 });
    expect(await client(f).call("upload")).toMatchObject({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("total cap is max(budgets) + 2 across mixed classes", async () => {
    // upload: 6 + 2 = 8. 3 network would stop; mix 2 network, 2 5xx, then 429s.
    const f = scripted(connectError(), connectError(), { status: 502 }, { status: 502 }, { status: 429 });
    const r = await client(f).call("upload");
    expect(f).toHaveBeenCalledTimes(8);
    expect(r).toMatchObject({ kind: "rate_limited", attempts: 4 });
  });

  it("attempt cut at abortAt returns deferred, not timeout", async () => {
    vi.useFakeTimers({ now: T0 });
    const f = slow(10_000);
    const c = createApiClient({ credentials: creds("env"), credsPath, fetchImpl: f as unknown as typeof fetch });
    const p = c.call("refs", { startBy: Date.now() + 4000 });
    await vi.advanceTimersByTimeAsync(4001);
    expect(await p).toEqual({ ok: false, kind: "deferred", waitMs: 0, sent: true });
  });

  it("a deadline already passed returns deferred with sent false, and no request goes out", async () => {
    const f = scripted({ status: 200 });
    const r = await client(f).call("upload", { startBy: T0 - 1 });
    expect(r).toEqual({ ok: false, kind: "deferred", waitMs: 0, sent: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("per-attempt timeout returns timeout (no deadline set)", async () => {
    vi.useFakeTimers({ now: T0 });
    const f = slow(60_000);
    const c = createApiClient({ credentials: creds("env"), credsPath, fetchImpl: f as unknown as typeof fetch });
    const p = c.call("kick");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await p).toMatchObject({ ok: false, kind: "timeout", attempts: 1 });
  });

  it("body read stays under the signal: a slow body is cut at abortAt", async () => {
    vi.useFakeTimers({ now: T0 });
    const f = slow(100, { status: 200, body: '{"x":1}' }, 10_000);
    const c = createApiClient({ credentials: creds("env"), credsPath, fetchImpl: f as unknown as typeof fetch });
    const p = c.call("preamble", { startBy: Date.now() + 4000 });
    await vi.advanceTimersByTimeAsync(4001);
    expect(await p).toEqual({ ok: false, kind: "deferred", waitMs: 0, sent: true });
  });

  it("an attempt still running at startBy completes before abortAt", async () => {
    vi.useFakeTimers({ now: T0 });
    const f = slow(6000, { status: 200, body: '{"ok":true}' });
    const c = createApiClient({
      credentials: creds("env"),
      credsPath,
      fetchImpl: f as unknown as typeof fetch,
      startBy: T0 + 20_000,
      abortAt: T0 + 28_000,
    });
    vi.setSystemTime(T0 + 19_000);
    const p = c.call("upload", { json: [] });
    await vi.advanceTimersByTimeAsync(6001);
    expect(await p).toMatchObject({ ok: true, data: { ok: true } });
  });

  it("no wait begins that would end past startBy", async () => {
    const f = scripted({ status: 429, headers: { "retry-after": "10" } }, { status: 200 });
    const r = await client(f).call("upload", { startBy: T0 + 5000 });
    expect(r).toEqual({ ok: false, kind: "deferred", waitMs: 10_000, sent: true });
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("bad JSON on a 2xx: json -> bad_json, lenient -> ok with data undefined", async () => {
    expect(await client(scripted({ status: 200, body: "<html>" })).call("upload")).toEqual({
      ok: false,
      kind: "bad_json",
      status: 200,
    });
    expect(await client(scripted({ status: 200, body: "<html>" })).call("kick")).toEqual({
      ok: true,
      status: 200,
      data: undefined,
      keySource: "env",
    });
  });
});

// ---------------------------------------------------------------------------
describe("request shape (#218 lock gaps)", () => {
  it("exact headers: lowercase authorization, content-type only with a body, no GET method key", async () => {
    const f = scripted({ status: 200 });
    const c = client(f, { credentials: creds("env", ENV_KEY, `${URL_A}///`) });
    await c.call("upload", { json: [1] });
    await c.call("refs", { query: new URLSearchParams({ repo: "r" }) });
    const [u1, i1] = f.mock.calls[0] as [string, RequestInit];
    const [u2, i2] = f.mock.calls[1] as [string, RequestInit];
    expect(u1).toBe(`${URL_A}/api/code-sessions`);
    expect(i1.method).toBe("POST");
    expect(i1.headers).toEqual({ authorization: `Bearer ${ENV_KEY}`, "content-type": "application/json" });
    expect(i1.body).toBe("[1]");
    expect(u2).toBe(`${URL_A}/api/memory/branch-state?repo=r`);
    expect("method" in i2).toBe(false);
    expect(i2.headers).toEqual({ authorization: `Bearer ${ENV_KEY}` });
    expect("body" in i2).toBe(false);
  });

  it("a query on a path that already has one is joined with &", async () => {
    const f = scripted({ status: 200 });
    await client(f).call("validateKey", { query: new URLSearchParams({ x: "1" }) });
    expect(f.mock.calls[0]![0]).toBe(`${URL_A}/api/code-sessions/stats?days=1&x=1`);
  });

  it("globalThis.fetch undefined gives network, never throws", async () => {
    vi.stubGlobal("fetch", undefined);
    const c = createApiClient({ credentials: creds("env"), credsPath, sleep: async () => {} });
    expect(await c.call("preamble")).toMatchObject({ ok: false, kind: "network" });
  });

  it("globalThis.fetch is resolved per request", async () => {
    const c = createApiClient({ credentials: creds("credentials", CREDS_KEY), credsPath });
    const f = scripted({ status: 200 });
    vi.stubGlobal("fetch", f);
    expect(await c.call("preamble")).toMatchObject({ ok: true });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("env-key fallback", () => {
  it("env key 401, creds key on the same server works: swap, sticky, one log line without keys", async () => {
    writeCreds(CREDS_KEY, `${URL_A}/`);
    const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 200, body: '{"n":1}' }] });
    const c = client(f);
    expect(await c.call("upload", { json: [] })).toEqual({
      ok: true,
      status: 200,
      data: { n: 1 },
      keySource: "credentials",
    });
    expect(c.keySource).toBe("credentials");
    await c.call("known", { json: {} });
    expect(keysSent(f)).toEqual([`Bearer ${ENV_KEY}`, `Bearer ${CREDS_KEY}`, `Bearer ${CREDS_KEY}`]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("MEMBRAL_API_KEY");
    expect(lines[0]).not.toContain(ENV_KEY);
    expect(lines[0]).not.toContain(CREDS_KEY);
  });

  it("flag key: never falls back", async () => {
    writeCreds(CREDS_KEY, URL_A);
    const f = byKey({ [ENV_KEY]: [{ status: 401 }] });
    const r = await client(f, { credentials: creds("flag") }).call("upload");
    expect(r).toEqual({ ok: false, kind: "auth", status: 401, fellBack: false, detail: expect.any(String) });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("creds key: never falls back", async () => {
    writeCreds(CREDS_KEY, URL_A);
    const f = byKey({ [CREDS_KEY]: [{ status: 401 }] });
    const r = await client(f, { credentials: creds("credentials", CREDS_KEY) }).call("upload");
    expect(r).toEqual({ ok: false, kind: "auth", status: 401, fellBack: false, detail: expect.any(String) });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("same key in env and creds: no fallback", async () => {
    writeCreds(ENV_KEY, URL_A);
    const f = byKey({ [ENV_KEY]: [{ status: 401 }] });
    expect(await client(f).call("upload")).toMatchObject({ kind: "auth", fellBack: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a flag or env URL that differs from creds' URL: zero requests to the creds URL, creds key never sent", async () => {
    writeCreds(CREDS_KEY, URL_B);
    const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 200 }] });
    for (const src of ["env", "flag"] as const) {
      const c = client(f, { credentials: { ...creds("env"), apiUrlSource: src } });
      expect(await c.call("preamble")).toMatchObject({ kind: "auth", status: 401, fellBack: false });
    }
    expect(f.mock.calls.every((c) => String(c[0]).startsWith(URL_A))).toBe(true);
    expect(keysSent(f)).not.toContain(`Bearer ${CREDS_KEY}`);
  });

  it("a route 429 on a valid env key never falls back (zero creds-key requests)", async () => {
    writeCreds(CREDS_KEY, URL_A);
    const f = byKey({ [ENV_KEY]: [{ status: 429 }, { status: 200 }], [CREDS_KEY]: [{ status: 200 }] });
    expect(await client(f).call("upload")).toMatchObject({ ok: true, keySource: "env" });
    expect(keysSent(f)).toEqual([`Bearer ${ENV_KEY}`, `Bearer ${ENV_KEY}`]);
  });

  it("a second 401 (creds key rejected too) returns auth with fellBack true", async () => {
    writeCreds(CREDS_KEY, URL_A);
    const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 401 }] });
    expect(await client(f).call("upload")).toEqual({
      ok: false,
      kind: "auth",
      status: 401,
      fellBack: true,
      detail: expect.any(String),
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("three concurrent 401s: one fallback, all three succeed", async () => {
    writeCreds(CREDS_KEY, URL_A);
    const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 200 }] });
    const c = client(f);
    const rs = await Promise.all([c.call("upload"), c.call("upload"), c.call("known")]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(keysSent(f).filter((k) => k === `Bearer ${CREDS_KEY}`)).toHaveLength(3);
  });

  it("a fallback past a 4 s deadline returns deferred", async () => {
    writeCreds(CREDS_KEY, URL_A);
    const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 200 }] });
    const fetchAndAge = vi.fn(async (url: string, init: RequestInit) => {
      const r = await f(url, init);
      t += 4500; // the env attempt alone used the whole budget
      return r;
    });
    const c2 = client(fetchAndAge, { startBy: T0 + 4000 });
    expect(await c2.call("preamble")).toEqual({ ok: false, kind: "deferred", waitMs: 0, sent: true });
    expect(fetchAndAge).toHaveBeenCalledTimes(1);
  });

  it("validateKey answers a 401 itself (no fallback)", async () => {
    writeCreds(CREDS_KEY, URL_A);
    const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 200 }] });
    expect(await client(f).call("validateKey")).toEqual({
      ok: false,
      kind: "auth",
      status: 401,
      fellBack: false,
      detail: expect.any(String),
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  describe("marker", () => {
    const markerFile = () => envKeyMarkerPath(dir, ENV_KEY, URL_A);

    it("env 401 then creds success writes it atomically, mode 600, no key material", async () => {
      writeCreds(CREDS_KEY, URL_A);
      const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 200 }] });
      await client(f).call("upload");
      expect(existsSync(markerFile())).toBe(true);
      expect(statSync(markerFile()).mode & 0o777).toBe(0o600);
      const body = readFileSync(markerFile(), "utf8");
      expect(JSON.parse(body)).toEqual({ at: new Date(T0).toISOString(), url: URL_A });
      expect(body).not.toContain(ENV_KEY);
      expect(body).not.toContain(CREDS_KEY);
    });

    it("401 then creds 401: no marker", async () => {
      writeCreds(CREDS_KEY, URL_A);
      await client(byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 401 }] })).call("upload");
      expect(existsSync(markerFile())).toBe(false);
    });

    it("a fresh marker starts the next process on the creds key (zero env-key requests)", async () => {
      writeCreds(CREDS_KEY, URL_A);
      writeFileSync(markerFile(), JSON.stringify({ at: new Date(T0 - 60_000).toISOString(), url: URL_A }));
      const f = byKey({ [ENV_KEY]: [{ status: 200 }], [CREDS_KEY]: [{ status: 200 }] });
      const c = client(f);
      expect(c.keySource).toBe("credentials");
      await c.call("preamble");
      expect(keysSent(f)).toEqual([`Bearer ${CREDS_KEY}`]);
    });

    it("expired marker: exactly one env-key attempt across the run", async () => {
      writeCreds(CREDS_KEY, URL_A);
      writeFileSync(
        markerFile(),
        JSON.stringify({ at: new Date(T0 - ENV_KEY_MARKER_TTL_MS - 1).toISOString(), url: URL_A }),
      );
      const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 200 }] });
      const c = client(f);
      await c.call("upload");
      await c.call("upload");
      expect(keysSent(f).filter((k) => k === `Bearer ${ENV_KEY}`)).toHaveLength(1);
    });

    it("an env 2xx deletes it", async () => {
      writeCreds(CREDS_KEY, URL_A);
      writeFileSync(
        markerFile(),
        JSON.stringify({ at: new Date(T0 - ENV_KEY_MARKER_TTL_MS - 1).toISOString(), url: URL_A }),
      );
      await client(byKey({ [ENV_KEY]: [{ status: 200 }] })).call("preamble");
      expect(existsSync(markerFile())).toBe(false);
    });

    it("an unreadable marker reads as absent", async () => {
      writeCreds(CREDS_KEY, URL_A);
      writeFileSync(markerFile(), "{not json");
      const f = byKey({ [ENV_KEY]: [{ status: 200 }] });
      const c = client(f);
      expect(c.keySource).toBe("env");
      await c.call("preamble");
      expect(keysSent(f)).toEqual([`Bearer ${ENV_KEY}`]);
    });

    it("a marker for another URL does not apply (name is keyed by key + url)", () => {
      expect(envKeyMarkerPath(dir, ENV_KEY, URL_A)).not.toBe(envKeyMarkerPath(dir, ENV_KEY, URL_B));
      expect(envKeyMarkerPath(dir, ENV_KEY, URL_A)).not.toBe(envKeyMarkerPath(dir, `${ENV_KEY}x`, URL_A));
      expect(envKeyMarkerPath(dir, ENV_KEY, `${URL_A}/`)).toBe(envKeyMarkerPath(dir, ENV_KEY, URL_A));
    });
  });
});

// ---------------------------------------------------------------------------
describe("rule-4 backoff on the client", () => {
  const ra = (v: string): Reply => ({ status: 429, headers: { "retry-after": v } });

  it("Retry-After delta-seconds wins over the delay", async () => {
    await client(scripted(ra("2"), { status: 200 })).call("upload");
    expect(sleeps).toEqual([2000]);
  });

  it("Retry-After as an HTTP date", async () => {
    await client(scripted(ra(new Date(T0 + 7000).toUTCString()), { status: 200 })).call("upload");
    expect(sleeps).toEqual([7000]);
  });

  it("Retry-After 0 still waits 500 ms (never immediate)", async () => {
    await client(scripted(ra("0"), { status: 200 })).call("upload");
    expect(sleeps).toEqual([500]);
  });

  it("garbage Retry-After is absent: the state delay is used", async () => {
    await client(scripted(ra("soon"), ra("soon"), { status: 200 })).call("upload");
    expect(sleeps).toEqual([500, 2500]);
  });

  it("Retry-After 3600: in-process wait clamped to 120 s, result carries the raw value", async () => {
    await client(scripted(ra("3600"), { status: 200 })).call("upload");
    expect(sleeps).toEqual([120_000]);
    const r = await client(scripted(ra("3600"))).call("kick");
    expect(r).toEqual({ ok: false, kind: "rate_limited", attempts: 1, retryAfterMs: 3_600_000 });
  });

  it("three concurrent 429s grow the state once (x5, not x125)", async () => {
    let gate!: () => void;
    const held = new Promise<void>((r) => {
      gate = r;
    });
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n <= 3) {
        if (n === 3) gate();
        await held;
        return res({ status: 429 });
      }
      return res({ status: n === 7 ? 429 : 200 });
    });
    const c = client(f);
    const rs = await Promise.all([c.call("known"), c.call("known"), c.call("known")]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(Math.max(...sleeps)).toBe(2500);
    // After the burst and three decays (2500 -> 2250 -> 2025 -> 1823), a header-less 429 waits 1823.
    sleeps = [];
    expect(await c.call("known")).toMatchObject({ ok: true });
    expect(sleeps).toEqual([1823]);
  });

  it("decay, not reset: the next 429 on the same client waits the decayed delay", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      return res({ status: n === 1 ? 429 : 200 });
    });
    const c = client(f);
    await c.call("known"); // 429 (wait 500, delay -> 2500), then 200 (delay -> 2250)
    n = 0;
    sleeps = [];
    await c.call("known"); // 429 waits 2250, not 500
    expect(sleeps).toEqual([2250]);
  });

  it("#170: one client across two import batches keeps the grown delay (decayed)", async () => {
    const f = scripted({ status: 429 }, { status: 429 }, { status: 200 }, { status: 429 }, { status: 200 });
    const c = client(f);
    await c.call("import", { json: { batch: 1 } }); // waits 500, 2500; delay 7500 -> decays to 6750
    sleeps = [];
    await c.call("import", { json: { batch: 2 } });
    // pace (grown on each 429: 1000 -> 2000, decayed to 1800) then the 429 waits 6750, not 500.
    expect(sleeps).toEqual([1800, 6750]);
  });

  it("pace applies only to pacing endpoints", async () => {
    const f = scripted({ status: 429 }, { status: 200 });
    const c = client(f);
    await c.call("known");
    sleeps = [];
    await c.call("known");
    expect(sleeps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("no retry after a timeout unless idempotent; connect-phase always retries", () => {
  const timeoutThenOk = () => {
    let n = 0;
    return vi.fn((_u: string, init: RequestInit) => {
      n++;
      if (n === 1) {
        return new Promise<Response>((_res, rej) =>
          (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted"))),
        );
      }
      return Promise.resolve(res({ status: 200 }));
    });
  };

  async function run(id: EndpointId, force: boolean): Promise<[ApiResult<unknown>, number]> {
    vi.useFakeTimers({ now: T0 });
    const f = timeoutThenOk();
    const c = createApiClient({
      credentials: creds("env"),
      credsPath,
      fetchImpl: f as unknown as typeof fetch,
      sleep: async () => {},
    });
    const p = c.call(id, { force });
    await vi.advanceTimersByTimeAsync(ENDPOINTS[id].timeoutMs + 1);
    const r = await p;
    return [r, f.mock.calls.length];
  }

  it("import: a timeout is not retried", async () => {
    const [r, n] = await run("import", false);
    expect(r).toMatchObject({ ok: false, kind: "timeout", attempts: 1 });
    expect(n).toBe(1);
  });

  it("upload with force: a timeout is not retried", async () => {
    const [r, n] = await run("upload", true);
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
    expect(n).toBe(1);
  });

  it("upload without force: a timeout is retried", async () => {
    const [r, n] = await run("upload", false);
    expect(r).toMatchObject({ ok: true });
    expect(n).toBe(2);
  });

  it("import and forced upload: a connect-phase failure is retried", async () => {
    for (const [id, force] of [
      ["import", false],
      ["upload", true],
    ] as const) {
      for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]) {
        const f = scripted(connectError(code), { status: 200 });
        expect(await client(f).call(id, { force })).toMatchObject({ ok: true });
        expect(f).toHaveBeenCalledTimes(2);
      }
    }
  });

  it("import: a mid-request error (no connect code) is not retried", async () => {
    const f = scripted(new TypeError("socket hang up"), { status: 200 });
    expect(await client(f).call("import")).toMatchObject({ ok: false, kind: "network", attempts: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("ADV 4.2 fixes", () => {
  it("1. a throwing logger does not poison the fallback or later calls; a throwing body becomes network", async () => {
    writeCreds(CREDS_KEY, URL_A);
    const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 200 }] });
    const c = client(f, {
      log: () => {
        throw new Error("EPIPE");
      },
    });
    expect(await c.call("upload")).toMatchObject({ ok: true, keySource: "credentials" });
    expect(await c.call("known")).toMatchObject({ ok: true });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await c.call("upload", { json: cyclic })).toMatchObject({ ok: false, kind: "network" });
    expect(await c.call("upload", { json: { big: 1n } })).toMatchObject({ ok: false, kind: "network" });
  });

  it("2. a marker-start swap logs one line (no key) on the first call only", async () => {
    writeCreds(CREDS_KEY, URL_A);
    writeFileSync(
      envKeyMarkerPath(dir, ENV_KEY, URL_A),
      JSON.stringify({ at: new Date(T0 - 30 * 60_000).toISOString(), url: URL_A }),
    );
    const c = client(byKey({ [CREDS_KEY]: [{ status: 200 }] }));
    expect(lines).toEqual([]);
    await c.call("preamble");
    await c.call("preamble");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("MEMBRAL_API_KEY was rejected by https://a.example 30 min ago");
    expect(lines[0]).not.toContain(ENV_KEY);
    expect(lines[0]).not.toContain(CREDS_KEY);
  });

  it("3. a 504 is not retried for import or a forced upload; it is for an idempotent upload", async () => {
    for (const [id, force, tries] of [
      ["import", false, 1],
      ["upload", true, 1],
      ["upload", false, 3],
    ] as const) {
      const f = scripted({ status: 504, body: "gw" });
      expect(await client(f).call(id, { force })).toEqual({ ok: false, kind: "http", status: 504, detail: "gw" });
      expect(f).toHaveBeenCalledTimes(tries);
    }
    const f502 = scripted({ status: 502 }, { status: 200 });
    expect(await client(f502).call("import")).toMatchObject({ ok: true });
  });

  it("4. an env 2xx after the marker was written in the same run deletes it", async () => {
    writeCreds(CREDS_KEY, URL_A);
    let releaseEnv!: () => void;
    const envHeld = new Promise<void>((r) => {
      releaseEnv = r;
    });
    let envCalls = 0;
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth === `Bearer ${ENV_KEY}`) {
        envCalls++;
        if (envCalls === 1) {
          await envHeld; // a lane that sent with the env key before the swap
          return res({ status: 200 });
        }
        return res({ status: 401 });
      }
      return res({ status: 200 });
    });
    const c = client(f);
    const slowEnvLane = c.call("known"); // sends first with the env key, held
    await new Promise((r) => setTimeout(r, 0));
    const marker = envKeyMarkerPath(dir, ENV_KEY, URL_A);
    expect(await c.call("upload")).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(true);
    releaseEnv();
    expect(await slowEnvLane).toMatchObject({ ok: true, keySource: "env" });
    expect(existsSync(marker)).toBe(false);
  });

  it("5. a per-call startBy keeps the client's abortAt", async () => {
    vi.useFakeTimers({ now: T0 });
    const f = slow(6000, { status: 200 });
    const c = createApiClient({
      credentials: creds("env"),
      credsPath,
      fetchImpl: f as unknown as typeof fetch,
      abortAt: T0 + 28_000,
    });
    const p = c.call("upload", { startBy: T0 + 1000 });
    await vi.advanceTimersByTimeAsync(6001);
    expect(await p).toMatchObject({ ok: true });
  });

  it("6. keySource reports the key the request carried, not the client's current one", async () => {
    writeCreds(CREDS_KEY, URL_A);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let envCalls = 0;
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth === `Bearer ${ENV_KEY}`) {
        envCalls++;
        if (envCalls === 1) {
          await held;
          return res({ status: 200 });
        }
        return res({ status: 401 });
      }
      return res({ status: 200 });
    });
    const c = client(f);
    const envLane = c.call("known");
    await new Promise((r) => setTimeout(r, 0));
    expect(await c.call("upload")).toMatchObject({ ok: true, keySource: "credentials" });
    expect(c.keySource).toBe("credentials");
    release();
    expect(await envLane).toMatchObject({ ok: true, keySource: "env" });
  });

  it("7. a marker dated in the future (beyond 5 min skew) is rejected; a write makes the dir 700 and leaves no tmp", async () => {
    writeCreds(CREDS_KEY, URL_A);
    const marker = envKeyMarkerPath(dir, ENV_KEY, URL_A);
    writeFileSync(marker, JSON.stringify({ at: new Date(T0 + 10 * 60_000).toISOString(), url: URL_A }));
    expect(client(byKey({})).keySource).toBe("env");
    writeFileSync(marker, JSON.stringify({ at: new Date(T0 + 60_000).toISOString(), url: URL_A }));
    expect(client(byKey({})).keySource).toBe("credentials");

    const sub = join(dir, "fresh");
    const f = byKey({ [ENV_KEY]: [{ status: 401 }], [CREDS_KEY]: [{ status: 200 }] });
    await client(f, { markerDir: sub }).call("upload");
    expect(statSync(sub).mode & 0o777).toBe(0o700);
    expect(readdirSync(sub).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(sub)).toHaveLength(1);
  });
});
