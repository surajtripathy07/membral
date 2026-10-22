import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCredentialsPath, saveCredentials, setActiveProfile } from "../credentials.js";
import {
  agyTimeoutMs,
  MAX_INJECTED_LINES,
  MAX_LINE_CHARS,
  MAX_SELF_LINE_CHARS,
  MAX_SELF_LINES,
  preambleHook,
} from "../preamble-hook.js";

function stdinWith(text: string): Readable {
  return Readable.from([text]);
}

function hookInput(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ session_id: "s1", cwd: "/tmp/nonexistent-repo", source: "startup", ...overrides });
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

// The hook contract (P4, memory-on-prod-new-user goal; mirrors
// session-end-hook.ts's non-negotiables): preambleHook must NEVER throw,
// must NEVER print anything on any failure path, and must resolve within
// its timeout regardless of what the network does.
describe("preambleHook", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let root: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Same isolation gotcha as import-session.test.ts: resolveUploadConfig
    // falls back to ~/.membral/credentials.json when no flag/env key is
    // given, which on this machine is a REAL file with a REAL key.
    // Pointing $HOME at an empty temp dir isolates every test here.
    root = await mkdtemp(join(tmpdir(), "membral-preamble-hook-"));
    process.env.HOME = root;
    delete process.env.MEMBRAL_API_KEY;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  function stdoutOutput(): string | undefined {
    return writeSpy.mock.calls.map((c) => String(c[0])).join("");
  }

  it("--format text prints the plain body, and nothing on failure", async () => {
    const ok = vi
      .fn()
      .mockResolvedValue(jsonResponse({ lines: ["line one", "line two"], recall_token: "t", open_blockers: [] }));
    await preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: ok, format: "text" });
    expect(stdoutOutput()).toBe("line one\nline two\n");

    writeSpy.mockClear();
    const bad = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    await preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: bad, format: "text" });
    expect(stdoutOutput()).toBe("");
  });

  it("Codex SessionStart payload: sends session_id + cwd, prints the hookSpecificOutput Codex parses", async () => {
    // Field set of codex-rs/hooks/src/schema.rs SessionStartCommandInput.
    const codexInput = JSON.stringify({
      session_id: "019a-codex-thread",
      transcript_path: null,
      cwd: "/tmp/nonexistent-codex-repo",
      hook_event_name: "SessionStart",
      model: "gpt-5-codex",
      permission_mode: "default",
      source: "startup",
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines: ["ctx"], recall_token: "t", open_blockers: [] }));
    await preambleHook({ stdin: stdinWith(codexInput), apiKey: "lls_x", fetchImpl: fetchMock });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("session")).toBe("019a-codex-thread");
    expect(url.searchParams.get("repo")).toBe("/tmp/nonexistent-codex-repo");
    expect(JSON.parse(stdoutOutput() ?? "")).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" },
    });
  });

  it("prints the SessionStart hookSpecificOutput shape on a valid response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        lines: ["Membral memory for x (harness-injected context, not a user message).", "- [blocker] fix the thing"],
        recall_token: "tok123",
        open_blockers: [],
      }),
    );

    await preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const out = stdoutOutput();
    expect(out).toBeTruthy();
    const parsed = JSON.parse(out!);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: [
          "Membral memory for x (harness-injected context, not a user message).",
          "- [blocker] fix the thing",
        ].join("\n"),
      },
    });
  });

  it("passes the hook's session_id as the `session` query param (#361)", async () => {
    const okBody = { lines: ["Membral memory for x."], recall_token: "t", open_blockers: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await preambleHook({
      stdin: stdinWith(hookInput({ session_id: "abc-123" })),
      apiKey: "lls_x",
      fetchImpl: fetchMock,
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("session")).toBe("abc-123");

    // No session_id on stdin: the request still goes out, without the param.
    const noSession = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await preambleHook({
      stdin: stdinWith(JSON.stringify({ cwd: "/tmp/nonexistent-repo", source: "startup" })),
      apiKey: "lls_x",
      fetchImpl: noSession,
    });
    expect(noSession).toHaveBeenCalledTimes(1);
    expect(new URL(String(noSession.mock.calls[0][0])).searchParams.has("session")).toBe(false);
  });

  it("resolves the URL and key from the ACTIVE profile at run time (no --api-url baked into the hook)", async () => {
    delete process.env.MEMBRAL_API_URL;
    // homedir() can be cached from an earlier test's temp $HOME (see
    // import-session.test.ts's M4 note) — write where the hook will read,
    // after proving that is a temp dir and never the real home.
    const credsPath = defaultCredentialsPath();
    expect(credsPath).toContain("membral-preamble-hook-");
    const base = { email: "a@b.com", userId: "u1", createdAt: "now" };
    saveCredentials({ ...base, apiUrl: "https://membral.me", apiKey: "lls_prod" }, credsPath);
    saveCredentials({ ...base, apiUrl: "http://localhost:3000", apiKey: "lls_local" }, credsPath);
    const body = { lines: ["x"], recall_token: "t", open_blockers: [] };

    const localFetch = vi.fn().mockResolvedValue(jsonResponse(body));
    await preambleHook({ stdin: stdinWith(hookInput()), fetchImpl: localFetch });
    expect(String(localFetch.mock.calls[0][0])).toMatch(/^http:\/\/localhost:3000\/api\/memory\/preamble\?/);
    expect(localFetch.mock.calls[0][1].headers.authorization).toBe("Bearer lls_local");

    setActiveProfile("prod", credsPath);
    const prodFetch = vi.fn().mockResolvedValue(jsonResponse(body));
    await preambleHook({ stdin: stdinWith(hookInput()), fetchImpl: prodFetch });
    expect(String(prodFetch.mock.calls[0][0])).toMatch(/^https:\/\/membral\.me\/api\/memory\/preamble\?/);
    expect(prodFetch.mock.calls[0][1].headers.authorization).toBe("Bearer lls_prod");
    await rm(join(credsPath, ".."), { recursive: true, force: true });
  });

  it("caps injected lines at MAX_INJECTED_LINES, truncating longer server output", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines, recall_token: "tok", open_blockers: [] }));

    await preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: fetchMock });

    const parsed = JSON.parse(stdoutOutput()!);
    const injected = parsed.hookSpecificOutput.additionalContext.split("\n");
    expect(injected).toHaveLength(MAX_INJECTED_LINES);
    expect(injected).toEqual(lines.slice(0, MAX_INJECTED_LINES));
  });

  it("times out silently (no throw, no output) when the fetch hangs past timeoutMs", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

    await expect(
      preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: fetchMock, timeoutMs: 10 }),
    ).resolves.toBeUndefined();

    expect(stdoutOutput()).toBe("");
  });

  // P10 review finding m1: the timer used to be cleared right after fetch()
  // settled, so a slow res.json() had no bound from this hook at all.
  // Headers arrive fine here; the body read itself hangs until the same
  // AbortController fires.
  it("times out silently (no throw, no output) when the body read hangs past timeoutMs", async () => {
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      } as unknown as Response),
    );

    await expect(
      preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: fetchMock, timeoutMs: 10 }),
    ).resolves.toBeUndefined();

    expect(stdoutOutput()).toBe("");
  });

  it("caps each injected line at MAX_LINE_CHARS, marking a truncated line with an ellipsis", async () => {
    const longLine = "x".repeat(500);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ lines: [longLine, "short line"], recall_token: "tok", open_blockers: [] }));

    await preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: fetchMock });

    const parsed = JSON.parse(stdoutOutput()!);
    const injected: string[] = parsed.hookSpecificOutput.additionalContext.split("\n");
    expect(injected[0]).toHaveLength(MAX_LINE_CHARS);
    expect(injected[0]).toBe(`${"x".repeat(MAX_LINE_CHARS - 1)}…`);
    expect(injected[1]).toBe("short line");
  });

  it("stays silent on a non-200 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 500));

    await preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: fetchMock });

    expect(stdoutOutput()).toBe("");
  });

  it("stays silent on malformed/invalid-shape JSON in the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Response);

    await preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: fetchMock });

    expect(stdoutOutput()).toBe("");

    const fetchMock2 = vi.fn().mockResolvedValue(jsonResponse({ lines: "not-an-array" }));
    await preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: fetchMock2 });
    expect(stdoutOutput()).toBe("");
  });

  it("stays silent (never calls fetch) when no API key is resolvable", async () => {
    // An explicit empty-string flag (not undefined) deterministically forces
    // resolveUploadConfig's "no key" branch regardless of the machine's own
    // MEMBRAL_API_KEY env var or ~/.membral/credentials.json (`??` only
    // falls through on null/undefined, never on "").
    const fetchMock = vi.fn();

    await preambleHook({ stdin: stdinWith(hookInput()), apiKey: "", fetchImpl: fetchMock });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdoutOutput()).toBe("");
  });

  it("stays silent on malformed stdin JSON", async () => {
    const fetchMock = vi.fn();

    await preambleHook({ stdin: stdinWith("{ not json"), apiKey: "lls_x", fetchImpl: fetchMock });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdoutOutput()).toBe("");
  });

  it("never throws even if fetch itself rejects unexpectedly", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      preambleHook({ stdin: stdinWith(hookInput()), apiKey: "lls_x", fetchImpl: fetchMock }),
    ).resolves.toBeUndefined();
    expect(stdoutOutput()).toBe("");
  });
});

describe("preambleHook self-recall (source compact/resume)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let root: string;
  const originalEnv = { ...process.env };
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    root = await mkdtemp(join(tmpdir(), "membral-preamble-self-"));
    process.env.HOME = root;
    delete process.env.MEMBRAL_API_KEY;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });
  const output = () => writeSpy.mock.calls.map((c) => String(c[0])).join("");
  const run = (input: string, fetchImpl: typeof fetch, format?: "copilot" | "text") =>
    preambleHook({
      stdin: stdinWith(input),
      apiKey: "lls_x",
      fetchImpl,
      hookLogPath: join(root, "hook.log"),
      ...(format ? { format } : {}),
    });

  it("asks for self=compact and injects self_lines ahead of the preamble, logging the outcome", async () => {
    const selfLines = [
      "This session so far (from Membral; …):",
      "[decision · 1h ago · session s1] Keep the API",
      "x".repeat(900),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ lines: ["preamble"], recall_token: "t", open_blockers: [], self_lines: selfLines }),
      );
    await run(hookInput({ source: "compact" }), fetchMock);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("self")).toBe("compact");
    const ctx = JSON.parse(output()).hookSpecificOutput.additionalContext.split("\n");
    expect(ctx[0]).toBe(selfLines[0]);
    expect(ctx[2]).toHaveLength(MAX_SELF_LINE_CHARS);
    expect(ctx[3]).toBe("preamble");
    expect(await readFile(join(root, "hook.log"), "utf8")).toMatch(/preamble: self-recall compact served 3 lines/);
  });

  it("caps self lines at MAX_SELF_LINES and still injects them when the preamble itself is empty", async () => {
    const selfLines = Array.from({ length: 12 }, (_, i) => `self ${i}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ lines: [], recall_token: "t", open_blockers: [], self_lines: selfLines }));
    await run(hookInput({ source: "resume" }), fetchMock);
    const ctx = JSON.parse(output()).hookSpecificOutput.additionalContext.split("\n");
    expect(ctx).toEqual(selfLines.slice(0, MAX_SELF_LINES));
  });

  it("logs the server's skip reason when the store has nothing for the session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        lines: ["preamble"],
        recall_token: "t",
        open_blockers: [],
        self_lines: [],
        self_skipped: "no_session_records",
      }),
    );
    await run(hookInput({ source: "compact" }), fetchMock);
    expect(JSON.parse(output()).hookSpecificOutput.additionalContext).toBe("preamble");
    expect(await readFile(join(root, "hook.log"), "utf8")).toMatch(/preamble: self-recall compact no_session_records/);
  });

  it("startup/clear sources and the copilot/text formats never ask for self", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines: ["p"], recall_token: "t", open_blockers: [] }));
    await run(hookInput({ source: "startup" }), fetchMock);
    await run(hookInput({ source: "clear" }), fetchMock);
    await run(hookInput({ source: "compact" }), fetchMock, "copilot");
    await run(hookInput({ source: "resume" }), fetchMock, "text");
    for (const call of fetchMock.mock.calls) expect(new URL(String(call[0])).searchParams.has("self")).toBe(false);
  });
});

describe("preambleHook agy (once per conversation)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let root: string;
  let stateDir: string;
  const originalEnv = { ...process.env };
  const CONV = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
  const okBody = { lines: ["agy line"], recall_token: "t", open_blockers: [] };
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    root = await mkdtemp(join(tmpdir(), "membral-preamble-agy-"));
    stateDir = join(root, "state", "agy");
    process.env.HOME = root;
    delete process.env.MEMBRAL_API_KEY;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });
  const output = () => writeSpy.mock.calls.map((c) => String(c[0])).join("");
  const payload = (conversationId: unknown = CONV) =>
    JSON.stringify({ conversationId, workspacePaths: ["/tmp/nonexistent-agy-repo"] });
  const run = (fetchImpl: typeof fetch, input = payload(), extra: Record<string, unknown> = {}) =>
    preambleHook({
      stdin: stdinWith(input),
      apiKey: "lls_x",
      fetchImpl,
      format: "agy",
      hookLogPath: join(root, "hook.log"),
      agyStateDir: stateDir,
      startedAtMs: Date.now(),
      ...extra,
    });

  it("serves the first call, creates a private marker, and sends the conversation id as the session", async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await run(f);
    expect(JSON.parse(output())).toEqual({ injectSteps: [{ ephemeralMessage: "agy line" }] });
    expect(String(f.mock.calls[0][0])).toContain(`session=${CONV}`);
    expect((await stat(join(stateDir, CONV))).mode & 0o777).toBe(0o600);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
  });

  it("prints nothing and makes no request on a later call for the same conversation", async () => {
    await run(vi.fn().mockResolvedValue(jsonResponse(okBody)));
    writeSpy.mockClear();
    const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await run(f);
    expect(f).not.toHaveBeenCalled();
    expect(output()).toBe("");
  });

  it("serves a different conversation", async () => {
    await run(vi.fn().mockResolvedValue(jsonResponse(okBody)));
    writeSpy.mockClear();
    const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await run(f, payload("other-conversation"));
    expect(f).toHaveBeenCalledTimes(1);
    expect(output()).toContain("agy line");
  });

  it("lets exactly one of five concurrent calls serve", async () => {
    const f = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse(okBody);
    });
    await Promise.all([1, 2, 3, 4, 5].map(() => run(f)));
    expect(f).toHaveBeenCalledTimes(1);
    expect(output().match(/injectSteps/g)).toHaveLength(1);
  });

  it("removes the marker after a failed first call so the next call serves", async () => {
    await run(vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    expect(output()).toBe("");
    await expect(stat(join(stateDir, CONV))).rejects.toThrow();
    const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await run(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(output()).toContain("agy line");
  });

  it("fails open and serves when the state dir cannot be created", async () => {
    await writeFile(join(root, "blocker"), "x");
    const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await run(f, payload(), { agyStateDir: join(root, "blocker", "agy") });
    expect(f).toHaveBeenCalledTimes(1);
    expect(output()).toContain("agy line");
    expect(await readFile(join(root, "hook.log"), "utf8")).toContain("agy marker unavailable");
  });

  it("serves nothing and makes no request for a missing, unsafe or overlong conversation id", async () => {
    for (const id of [null, "../escape", "a/b", ".hidden", 42, "x".repeat(201)]) {
      const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
      await run(f, payload(id));
      expect(f).not.toHaveBeenCalled();
    }
    expect(output()).toBe("");
    await expect(stat(join(root, "state", "escape"))).rejects.toThrow();
  });

  it("marks the marker served after printing", async () => {
    await run(vi.fn().mockResolvedValue(jsonResponse(okBody)));
    expect(await readFile(join(stateDir, CONV), "utf8")).toBe("served");
  });

  it("re-claims a stale claiming marker and serves", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, CONV), "claiming");
    const old = new Date(Date.now() - 20_000);
    await utimes(join(stateDir, CONV), old, old);
    const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await run(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(output()).toContain("agy line");
    expect(await readFile(join(stateDir, CONV), "utf8")).toBe("served");
  });

  it("treats a stale empty marker like a stale claiming one", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, CONV), "");
    const old = new Date(Date.now() - 20_000);
    await utimes(join(stateDir, CONV), old, old);
    const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await run(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(output()).toContain("agy line");
  });

  it("treats a stale 'claiming' marker with a trailing newline as stale", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, CONV), "claiming\n");
    const old = new Date(Date.now() - 30_000);
    await utimes(join(stateDir, CONV), old, old);
    const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await run(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(output()).toContain("agy line");
  });

  it("lets exactly one of five concurrent takeovers of a stale marker serve", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, CONV), "claiming");
    const old = new Date(Date.now() - 20_000);
    await utimes(join(stateDir, CONV), old, old);
    const f = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse(okBody);
    });
    await Promise.all([1, 2, 3, 4, 5].map(() => run(f)));
    expect(f).toHaveBeenCalledTimes(1);
    expect(output().match(/injectSteps/g)).toHaveLength(1);
  });

  it("stays silent for a fresh claiming marker and for a served one", async () => {
    await mkdir(stateDir, { recursive: true });
    for (const content of ["claiming", "served"]) {
      await writeFile(join(stateDir, CONV), content);
      const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
      await run(f);
      expect(f).not.toHaveBeenCalled();
    }
    expect(output()).toBe("");
  });

  it("prunes markers older than 7 days and keeps fresh ones", async () => {
    await mkdir(stateDir, { recursive: true });
    const old = join(stateDir, "old-conv");
    const fresh = join(stateDir, "fresh-conv");
    await writeFile(old, "");
    await writeFile(fresh, "");
    const eightDays = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await utimes(old, eightDays, eightDays);
    await run(vi.fn().mockResolvedValue(jsonResponse(okBody)));
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeTruthy();
  });

  it("clamps the budget to 4.5 s and counts elapsed time", () => {
    expect(agyTimeoutMs(undefined)).toBe(4000);
    expect(agyTimeoutMs(60_000)).toBe(4500);
    expect(agyTimeoutMs(60_000, 1000)).toBe(3500);
    expect(agyTimeoutMs(2000, 500)).toBe(1500);
    expect(agyTimeoutMs(60_000, 9000)).toBeLessThanOrEqual(0);
  });

  it("serves nothing when the budget was already spent before the call", async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await run(f, payload(), { startedAtMs: Date.now() - 10_000 });
    expect(f).not.toHaveBeenCalled();
    expect(output()).toBe("");
    await expect(stat(join(stateDir, CONV))).rejects.toThrow();
  });

  it("leaves other formats untouched (conversationId ignored, no marker)", async () => {
    const g = vi.fn().mockResolvedValue(jsonResponse(okBody));
    const input = JSON.stringify({ session_id: "s1", cwd: "/tmp/nonexistent-repo", conversationId: CONV });
    for (let i = 0; i < 2; i++) {
      await preambleHook({ stdin: stdinWith(input), apiKey: "lls_x", fetchImpl: g, agyStateDir: stateDir });
    }
    expect(g).toHaveBeenCalledTimes(2);
    expect(String(g.mock.calls[0][0])).toContain("session=s1");
  });
});

describe("preambleHook resets the prompt-hook dedupe state (source compact/clear)", () => {
  let root: string;
  const originalEnv = { ...process.env };
  const ID_A = "0a1b2c3d-1111-4222-8333-444455556666";
  const stateFile = () => join(root, "hook-state", "prompt-recall", "s1.json");
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    root = await mkdtemp(join(tmpdir(), "membral-preamble-reset-"));
    process.env.HOME = root;
    delete process.env.MEMBRAL_API_KEY;
    await mkdir(join(root, "hook-state", "prompt-recall"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });
  // No API key: the reset is local and must happen before the credentials step.
  const run = (input: string, format?: "copilot" | "text") =>
    preambleHook({
      stdin: stdinWith(input),
      fetchImpl: vi.fn(),
      hookLogPath: join(root, "hook.log"),
      ...(format ? { format } : {}),
    });

  it.each(["compact", "clear"])("%s deletes that session's file and leaves another session's", async (source) => {
    await writeFile(stateFile(), JSON.stringify({ ids: [ID_A] }));
    const other = join(root, "hook-state", "prompt-recall", "s2.json");
    await writeFile(other, JSON.stringify({ ids: [ID_A] }));
    await run(hookInput({ source }));
    await expect(stat(stateFile())).rejects.toThrow();
    await expect(stat(other)).resolves.toBeTruthy();
  });

  it.each(["startup", "resume"])("%s keeps the file", async (source) => {
    await writeFile(stateFile(), JSON.stringify({ ids: [ID_A] }));
    await run(hookInput({ source }));
    await expect(stat(stateFile())).resolves.toBeTruthy();
  });

  it("the copilot format never resets", async () => {
    await writeFile(stateFile(), JSON.stringify({ ids: [ID_A] }));
    await run(hookInput({ source: "clear" }), "copilot");
    await expect(stat(stateFile())).resolves.toBeTruthy();
  });
});
