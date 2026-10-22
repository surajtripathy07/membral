import { execSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeLogReason, sessionEndHook, uploadDeadlines } from "../session-end-hook.js";

function sessionLine(cwd: string, timestamp: string) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
    cwd,
    gitBranch: "main",
    timestamp,
  });
}

function stdinWith(text: string): Readable {
  return Readable.from([text]);
}

interface HookLogEntry {
  ts: string;
  outcome: "ok" | "skipped" | "error" | "deferred";
  reason?: string;
  transcript?: string;
}

async function readHookLog(path: string): Promise<HookLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as HookLogEntry);
}

// The hook contract (ADR 0021 P1b + 2026-07-26 capture-hardening pass) is
// non-negotiable: session-end-hook must NEVER throw or set a non-zero exit
// code, must be SILENT on the terminal unless MEMBRAL_DEBUG=1 (a hook's
// stderr can surface directly to the user), and must ALWAYS append exactly
// one JSON-line outcome to hook.log regardless of MEMBRAL_DEBUG (the sweep
// is primary; this hook's failures must still be diagnosable via the log).
describe("sessionEndHook", () => {
  let root: string;
  let hookLogPath: string;
  let errorSpy: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-session-end-hook-"));
    hookLogPath = join(root, "hook.log");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    process.exitCode = originalExitCode;
  });

  function warnings(): string {
    return errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
  }

  it("never throws and stays silent on malformed stdin JSON, and logs a skipped outcome", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sessionEndHook({ stdin: stdinWith("{ this is not json"), apiKey: "lls_x", hookLogPath }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()).toBe("");
    expect(process.exitCode).toBeUndefined();

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("skipped");
    expect(entries[0].reason).toContain("malformed hook JSON");
  });

  it("logs the malformed-JSON reason to the terminal only when MEMBRAL_DEBUG=1", async () => {
    process.env.MEMBRAL_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn());

    await sessionEndHook({ stdin: stdinWith("{ nope"), apiKey: "lls_x", hookLogPath });

    expect(warnings()).toContain("malformed hook JSON");
  });

  it("skips silently when transcript_path is missing from valid JSON, and logs the reason", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const input = JSON.stringify({ session_id: "abc", hook_event_name: "SessionEnd", reason: "other" });

    await expect(sessionEndHook({ stdin: stdinWith(input), apiKey: "lls_x", hookLogPath })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()).toBe("");
    expect(process.exitCode).toBeUndefined();

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "skipped", reason: "missing transcript_path" });
  });

  it("skips silently on empty stdin, and logs the reason", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sessionEndHook({ stdin: stdinWith(""), apiKey: "lls_x", hookLogPath })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()).toBe("");

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "skipped", reason: "empty stdin" });
  });

  it("Minor5/Note4 (round 2+3): a genuine stdin read error logs a DISTINCT outcome AND reason, not conflated with empty stdin", async () => {
    const badStream = new Readable({ read() {} });
    process.nextTick(() => badStream.emit("error", new Error("boom")));

    await expect(sessionEndHook({ stdin: badStream, apiKey: "lls_x", hookLogPath })).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    // Round 1 logged this identically to true empty stdin
    // ({outcome:"skipped", reason:"empty stdin"}) — indistinguishable from
    // a normal no-op. Round 2 fixed the reason; round 3 (Note 4) fixed the
    // outcome too — this is a genuine failure, not a routine skip.
    expect(entries[0].outcome).toBe("error");
    expect(entries[0].reason).toContain("stdin read error");
    expect(entries[0].reason).toContain("boom");
    expect(entries[0].reason).not.toBe("empty stdin");
  });

  it("M1: a throw deep in the handler (e.g. a non-string transcript_path, which makes basename() throw) still logs exactly one error line", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sessionEndHook({
        stdin: stdinWith(JSON.stringify({ transcript_path: 12345 })),
        apiKey: "lls_x",
        hookLogPath,
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()).toBe("");
    expect(process.exitCode).toBeUndefined();

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("error");
  });

  it("#334: the parent hands a valid SessionEnd payload to a detached child and returns without awaiting the upload", async () => {
    const transcript = join(root, "33333333-3333-4333-8333-333333333333.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    // An upload that never finishes: the parent must not be waiting on it.
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const spawnDeferred = vi.fn();

    const hookInput = JSON.stringify({
      session_id: "abc123",
      transcript_path: transcript,
      cwd: "/home/dev/acme-webapp",
      hook_event_name: "SessionEnd",
      reason: "prompt_input_exit",
      permission_mode: "default",
    });

    const started = performance.now();
    await sessionEndHook({
      stdin: stdinWith(hookInput),
      apiKey: "lls_test_key",
      apiUrl: "https://cloud.example.com",
      hookLogPath,
      spawnDeferred,
    });
    const elapsedMs = performance.now() - started;

    // Claude Code's SessionEnd budget is 1.5 s; the hand-off has no network I/O.
    expect(elapsedMs).toBeLessThan(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnDeferred).toHaveBeenCalledTimes(1);
    const [args, env] = spawnDeferred.mock.calls[0] as [string[], Record<string, string> | undefined];
    expect(args).toEqual(["session-end-hook", "--deferred-path", transcript, "--api-url", "https://cloud.example.com"]);
    // No --source: the child is a Claude Code import. The key rides env, never argv.
    expect(args).not.toContain("--source");
    expect(args.join(" ")).not.toContain("lls_test_key");
    expect(env).toEqual({ MEMBRAL_API_KEY: "lls_test_key" });
    expect(warnings()).toBe("");
    expect(process.exitCode).toBeUndefined();

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "deferred", transcript: "33333333-3333-4333-8333-333333333333.jsonl" });
    expect(JSON.stringify(entries[0])).not.toContain(root);
  });

  it("#334: passes no env to the child when no --api-key was given (the child inherits MEMBRAL_API_KEY / credentials.json)", async () => {
    const transcript = join(root, "s.jsonl");
    const spawnDeferred = vi.fn();
    await sessionEndHook({
      stdin: stdinWith(JSON.stringify({ transcript_path: transcript })),
      hookLogPath,
      spawnDeferred,
    });
    expect(spawnDeferred).toHaveBeenCalledWith(["session-end-hook", "--deferred-path", transcript], undefined);
  });

  it("#334: a failed spawn imports inline, so the session still uploads and logs ok", async () => {
    const transcript = join(root, "77777777-7777-4777-8777-777777777777.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await sessionEndHook({
      stdin: stdinWith(JSON.stringify({ transcript_path: transcript })),
      apiKey: "lls_test_key",
      apiUrl: "https://cloud.example.com",
      hookLogPath,
      spawnDeferred: () => {
        throw new Error("EAGAIN");
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("ok");
  });

  it("#334: the child (--deferred-path, no source) uploads exactly one session at once and logs an ok outcome with the transcript basename only", async () => {
    const transcript = join(root, "33333333-3333-4333-8333-333333333333.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const stdinRead = vi.fn();
    const stdin = new Readable({ read: stdinRead });

    await sessionEndHook({
      deferredPath: transcript,
      apiKey: "lls_test_key",
      apiUrl: "https://cloud.example.com",
      hookLogPath,
      stdin,
    });

    expect(stdinRead).not.toHaveBeenCalled(); // the child never reads stdin
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cloud.example.com/api/code-sessions");
    const body = JSON.parse(init.body as string) as { sessions: Array<{ sourceSessionId: string }> };
    expect(body.sessions[0].sourceSessionId).toBe("33333333-3333-4333-8333-333333333333");
    expect(warnings()).toBe("");
    expect(process.exitCode).toBeUndefined();

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("ok");
    // Basename only — never the full path (would leak the user's home dir layout).
    expect(entries[0].transcript).toBe("33333333-3333-4333-8333-333333333333.jsonl");
    expect(JSON.stringify(entries[0])).not.toContain(root);
    // The lock is released after the upload.
    await expect(readFile(join(root, "deferred", "33333333-3333-4333-8333-333333333333.lock"))).rejects.toThrow();
  });

  function okFetch() {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    });
  }

  async function writeLock(id: string, pid: number): Promise<string> {
    await mkdir(join(root, "deferred"), { recursive: true });
    const lockPath = join(root, "deferred", `${id}.lock`);
    await writeFile(lockPath, String(pid));
    return lockPath;
  }

  it("#334 F2: past the lock wait, a child leaves a session a live child still holds to the sweep", async () => {
    const id = "88888888-8888-4888-8888-888888888888";
    const transcript = join(root, `${id}.jsonl`);
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    await writeLock(id, process.pid); // alive
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await sessionEndHook({
      deferredPath: transcript,
      apiKey: "lls_x",
      hookLogPath,
      deferredLockWaitMs: 60,
      deferredPollMs: 10,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "skipped", reason: "already uploading", transcript: `${id}.jsonl` });
  });

  it("#334 F2: a resumed session's child waits for the earlier child's lock to clear, then imports", async () => {
    const id = "abababab-abab-4bab-8bab-abababababab";
    const transcript = join(root, `${id}.jsonl`);
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    const lockPath = await writeLock(id, process.pid);
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    setTimeout(() => void rm(lockPath, { force: true }), 80);

    await sessionEndHook({
      deferredPath: transcript,
      apiKey: "lls_x",
      apiUrl: "https://cloud.example.com",
      hookLogPath,
      deferredLockWaitMs: 5_000,
      deferredPollMs: 10,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("ok");
    await expect(readFile(lockPath)).rejects.toThrow(); // released after the upload
  });

  it("#334 F1: a fresh lock whose pid is dead is stale at once, so the child imports", async () => {
    const id = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const transcript = join(root, `${id}.jsonl`);
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid as number;
    await writeLock(id, deadPid);
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await sessionEndHook({
      deferredPath: transcript,
      apiKey: "lls_x",
      apiUrl: "https://cloud.example.com",
      hookLogPath,
      deferredLockWaitMs: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await readHookLog(hookLogPath))[0].outcome).toBe("ok");
  });

  it("#334 F1: a child that times out removes its lock before returning (index.ts exits right after)", async () => {
    const id = "efefefef-efef-4fef-8fef-efefefefefef";
    const transcript = join(root, `${id}.jsonl`);
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    // Held until the end of the test, then settled, so the abandoned upload
    // never reaches the next test's fetch stub.
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const fetchMock = vi.fn(() => gate);
    vi.stubGlobal("fetch", fetchMock);

    await sessionEndHook({
      deferredPath: transcript,
      apiKey: "lls_x",
      apiUrl: "https://cloud.example.com",
      hookLogPath,
      timeoutMs: 100,
      deferredLockWaitMs: 0,
    });

    await expect(readFile(join(root, "deferred", `${id}.lock`))).rejects.toThrow();
    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "error", transcript: `${id}.jsonl` });
    expect(entries[0].reason).toContain("timed out");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2_000 });
    release({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    });
    await new Promise((r) => setTimeout(r, 50));
  });

  it.each([
    ["a relative path", "session.jsonl"],
    ["a flag-like value", "--api-key"],
  ])("#334 F4: never hands off %s as transcript_path; logs a skip", async (_label, bad) => {
    const spawnDeferred = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await sessionEndHook({ stdin: stdinWith(JSON.stringify({ transcript_path: bad })), hookLogPath, spawnDeferred });

    expect(spawnDeferred).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "skipped", reason: "transcript_path is not absolute" });
  });

  it("uploads each sub-agent transcript as its own session after the parent, and a child 500 never fails the hook", async () => {
    const parentId = "44444444-4444-4444-8444-444444444444";
    const transcript = join(root, `${parentId}.jsonl`);
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    const subDir = join(root, parentId, "subagents");
    await mkdir(subDir, { recursive: true });
    for (const agentId of ["good", "bad"]) {
      await writeFile(join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "Explore" }));
      await writeFile(
        join(subDir, `agent-${agentId}.jsonl`),
        `${JSON.stringify({
          type: "user",
          isSidechain: true,
          message: { role: "user", content: `task for ${agentId}` },
          timestamp: "2026-01-01T00:00:01.000Z",
        })}\n`,
      );
    }

    // Retries back off with real timers — shrink only the short retry
    // sleeps so the test doesn't wait seconds; the 30 s hook cap stays.
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms !== undefined && ms < 10_000 ? 0 : ms)) as typeof setTimeout);

    const bodies: Array<{ sessions: Array<{ sourceSessionId: string; parentSessionId?: string; turns: unknown[] }> }> =
      [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      if (body.sessions[0].sourceSessionId.endsWith(":agent-bad")) {
        return { ok: false, status: 500, text: async () => "boom" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
        text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sessionEndHook({
        deferredPath: transcript,
        apiKey: "lls_test_key",
        apiUrl: "https://cloud.example.com",
        hookLogPath,
      }),
    ).resolves.toBeUndefined();

    // One POST per session: parent first, then each child (the bad one retried).
    expect(bodies.every((b) => b.sessions.length === 1)).toBe(true);
    expect(bodies[0].sessions[0].sourceSessionId).toBe(parentId);
    expect(bodies[0].sessions[0].parentSessionId).toBeUndefined();
    const childIds = [...new Set(bodies.slice(1).map((b) => b.sessions[0].sourceSessionId))].sort();
    expect(childIds).toEqual([`${parentId}:agent-bad`, `${parentId}:agent-good`]);
    const good = bodies.find((b) => b.sessions[0].sourceSessionId === `${parentId}:agent-good`);
    expect(good?.sessions[0].parentSessionId).toBe(parentId);
    expect(good?.sessions[0].turns).toHaveLength(1);

    expect(warnings()).toBe("");
    expect(process.exitCode).toBeUndefined();
    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("ok");
    expect(entries[0].reason).toContain("sub-agent upload failed");
  });

  async function writeParentWithChildren(parentId: string, n: number): Promise<string> {
    const transcript = join(root, `${parentId}.jsonl`);
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    const subDir = join(root, parentId, "subagents");
    await mkdir(subDir, { recursive: true });
    for (let i = 0; i < n; i++) {
      await writeFile(join(subDir, `agent-a${i}.meta.json`), JSON.stringify({ agentType: "Explore" }));
      await writeFile(
        join(subDir, `agent-a${i}.jsonl`),
        `${JSON.stringify({
          type: "user",
          isSidechain: true,
          message: { role: "user", content: `task ${i}` },
          timestamp: "2026-01-01T00:00:01.000Z",
        })}\n`,
      );
    }
    return transcript;
  }

  it("uploads sub-agents at most 3 at a time and logs the parent's outcome apart from the children's", async () => {
    const parentId = "55555555-5555-4555-8555-555555555555";
    const transcript = await writeParentWithChildren(parentId, 7);
    let inFlight = 0;
    let maxChildInFlight = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const isChild = JSON.parse(init.body as string).sessions[0].sourceSessionId.includes(":agent-");
      if (isChild) {
        inFlight++;
        maxChildInFlight = Math.max(maxChildInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
        text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await sessionEndHook({
      deferredPath: transcript,
      apiKey: "lls_test_key",
      apiUrl: "https://cloud.example.com",
      hookLogPath,
    });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(maxChildInFlight).toBe(3);
    const [entry] = (await readHookLog(hookLogPath)) as Array<HookLogEntry & { parent?: string; children?: unknown }>;
    expect(entry.outcome).toBe("ok");
    expect(entry.parent).toBe("ok");
    expect(entry.children).toEqual({ total: 7, uploaded: 7, failed: 0, deferred: 0 });
  });

  it("past the child budget, uploads the parent, defers the remaining sub-agents to the sweep, and logs ok", async () => {
    const parentId = "66666666-6666-4666-8666-666666666666";
    const transcript = await writeParentWithChildren(parentId, 4);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await sessionEndHook({
      deferredPath: transcript,
      apiKey: "lls_test_key",
      apiUrl: "https://cloud.example.com",
      hookLogPath,
      childBudgetMs: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // the parent only
    const [entry] = (await readHookLog(hookLogPath)) as Array<HookLogEntry & { children?: unknown }>;
    expect(entry.outcome).toBe("ok");
    expect(entry.children).toEqual({ total: 4, uploaded: 0, failed: 0, deferred: 4 });
    expect(entry.reason).toBe("4 sub-agents deferred to sweep");
  });

  it("stays silent on the terminal (no throw) when the upload fails outright, e.g. a scoped key, but logs an error outcome", async () => {
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sessionEndHook({
        deferredPath: transcript,
        apiKey: "lls_scoped",
        hookLogPath,
      }),
    ).resolves.toBeUndefined();

    expect(warnings()).toBe("");
    expect(process.exitCode).toBeUndefined();

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("error");
    expect(entries[0].reason).toContain("upload failed");
    expect(entries[0].transcript).toBe("session.jsonl");
  });

  it("M2: sanitizes a full transcript path out of the logged reason on a missing-transcript path", async () => {
    // Point at a transcript that doesn't exist under the test's own tmp
    // root — import-session.ts's readFile failure interpolates the FULL
    // path into its warn() message (`failed to read transcript "<path>"`),
    // which is exactly the leak vector M2 fixes. The existing "ok" path
    // test can't exercise this: it never has a full path in its reason to
    // begin with.
    //
    // Q2 (P6 local rehearsal): a missing transcript_path (ENOENT) means this
    // SessionEnd was never a capturable session (e.g. `claude mcp list`) —
    // classified "skipped", not "error" (see isMissingTranscript's comment
    // in session-end-hook.ts). Sanitization still applies to a skipped
    // reason exactly as it did to an error one.
    const missingTranscript = join(root, "nonexistent-session.jsonl");
    vi.stubGlobal("fetch", vi.fn());

    await sessionEndHook({
      deferredPath: missingTranscript,
      apiKey: "lls_x",
      hookLogPath,
    });

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("skipped");
    expect(entries[0].reason).toContain("nonexistent-session.jsonl");
    // The tmp root itself (this test's whole point) must never appear.
    expect(entries[0].reason).not.toContain(root);
    expect(JSON.stringify(entries[0])).not.toContain(root);
  });

  it("surfaces the upload failure reason on the terminal when MEMBRAL_DEBUG=1, and still logs an error outcome", async () => {
    process.env.MEMBRAL_DEBUG = "1";
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    await sessionEndHook({
      deferredPath: transcript,
      apiKey: "lls_scoped",
      hookLogPath,
    });

    expect(warnings()).toContain("upload failed");

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("error");
  });

  it("bounds total wall-clock time via timeoutMs, even when stdin never ends, and logs a timeout outcome", async () => {
    const neverEnds = new Readable({ read() {} });

    const start = Date.now();
    await expect(
      sessionEndHook({ stdin: neverEnds, apiKey: "lls_x", timeoutMs: 50, hookLogPath }),
    ).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(process.exitCode).toBeUndefined();

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("error");
    expect(entries[0].reason).toContain("timed out");
  });

  it("Minor4 (round 4): sessionEndHook does not resolve before an ALREADY-IN-FLIGHT write finishes, even after the timeout branch also races to log", async () => {
    // Round 4's bug: appendHookLogOnce used to guard with a plain boolean
    // flag, flipped to `true` SYNCHRONOUSLY before the write's own `await`
    // even started. That stopped a second write from happening, but gave
    // the SECOND caller (sessionEndHook's timeout branch) nothing to await
    // — it would see `logged === true` and return immediately, letting
    // sessionEndHook resolve (and index.ts's immediate `process.exit(0)`
    // run) while the FIRST caller's write was still physically in flight.
    // Reproduced here with a real blocking write via a FIFO — no fs
    // mocking needed, and this doesn't depend on network/subprocess
    // timing: use a missing-transcript_path payload, the fastest possible
    // path to a SINGLE appendHookLogOnce call, so it reliably starts (and
    // blocks on the FIFO's open) well before the short timeout fires.
    const fifoPath = join(root, "hook.fifo");
    execSync(`mkfifo "${fifoPath}"`);

    let resolved = false;
    const hookPromise = sessionEndHook({
      stdin: stdinWith(JSON.stringify({ session_id: "abc" })), // no transcript_path
      apiKey: "lls_x",
      timeoutMs: 20,
      hookLogPath: fifoPath,
    }).then(() => {
      resolved = true;
    });

    // Give the fast path time to reach appendFile(fifoPath, ...) and block
    // on the open (no reader yet), and give the 20ms timeout plenty of time
    // to fire and reach the SAME already-in-flight write.
    await new Promise((r) => setTimeout(r, 150));
    expect(resolved).toBe(false);

    // Release the write by opening the FIFO's other end for reading.
    const written = await readFile(fifoPath, "utf8");
    await hookPromise;

    expect(resolved).toBe(true);
    const lines = written.trim().split("\n");
    expect(lines).toHaveLength(1); // exactly one line — not zero, not two
    expect(JSON.parse(lines[0])).toMatchObject({ outcome: "skipped", reason: "missing transcript_path" });
  });

  it("never throws even if the log write itself fails", async () => {
    // Point hookLogPath at a location where mkdir/appendFile cannot possibly
    // succeed — a path segment that is itself a plain file — and confirm the
    // hook still resolves cleanly instead of throwing.
    const blockerFile = join(root, "not-a-directory");
    await writeFile(blockerFile, "x");
    const badLogPath = join(blockerFile, "nested", "hook.log");

    vi.stubGlobal("fetch", vi.fn());

    await expect(
      sessionEndHook({ stdin: stdinWith(""), apiKey: "lls_x", hookLogPath: badLogPath }),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });

  it("Minor3 (round 2): sanitizes a transcript path containing SPACES out of the logged reason (real end-to-end path)", async () => {
    // Round 1's whitespace-token-only sanitizer split a spaced path at each
    // space and only cleaned up the FIRST token — everything after the
    // first space leaked verbatim. Use a real project directory name with a
    // space in it (a real-world shape: "Client Alpha", "Secret Co", etc.)
    // and a transcript that doesn't exist, so import-session.ts's own
    // `failed to read transcript "<full path>"` message — quoted, exactly
    // like production — carries the full spaced path into the reason.
    const spacedDir = join(root, "Secret Co", "Client Alpha");
    await mkdir(spacedDir, { recursive: true });
    const missingTranscript = join(spacedDir, "nope.jsonl");
    vi.stubGlobal("fetch", vi.fn());

    await sessionEndHook({
      deferredPath: missingTranscript,
      apiKey: "lls_x",
      hookLogPath,
    });

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    // Q2: a missing transcript_path is "skipped" (not a capturable session),
    // not "error" — see the M2 test's comment above.
    expect(entries[0].outcome).toBe("skipped");
    expect(entries[0].reason).toContain("nope.jsonl");
    // The whole point: the spaced directory segments must never leak.
    expect(entries[0].reason).not.toContain("Secret Co");
    expect(entries[0].reason).not.toContain("Client Alpha");
    expect(JSON.stringify(entries[0])).not.toContain(root);
  });

  it("Q2: classifies a missing-transcript SessionEnd (e.g. from `claude mcp list`, a non-session invocation) as skipped, not error", async () => {
    const missingTranscript = join(root, "not-a-real-session.jsonl");
    vi.stubGlobal("fetch", vi.fn());

    await sessionEndHook({
      deferredPath: missingTranscript,
      apiKey: "lls_x",
      hookLogPath,
    });

    expect(warnings()).toEqual(""); // still silent on the terminal by default
    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("skipped");
    expect(entries[0].reason).toMatch(/failed to read transcript .*: ENOENT/);
  });

  it("Q2: a genuine (non-ENOENT) upload failure for a REAL transcript still logs error, not skipped", async () => {
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));

    await sessionEndHook({
      deferredPath: transcript,
      apiKey: "lls_x",
      hookLogPath,
    });

    const entries = await readHookLog(hookLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("error");
  });
});

describe("sanitizeLogReason (round 2/3 adversarial review: Minor 3, Minor 1)", () => {
  it("collapses a HOME-ROOTED quoted path FULLY to its basename, not just prefix-replaced to ~ (round 3, Minor 1)", () => {
    const home = homedir();
    const reason = `failed to read transcript "${home}/projects/foo/bar.jsonl": ENOENT`;
    const out = sanitizeLogReason(reason);
    // Full collapse, NOT "~/projects/foo/bar.jsonl" — round 1/2's
    // homedir-first ordering only replaced the home prefix, leaving the
    // "projects/foo" directory structure exposed underneath it. Since
    // every real Claude Code transcript path is home-rooted, that had to
    // become the dominant, fully-collapsed case.
    expect(out).toBe('failed to read transcript "bar.jsonl": ENOENT');
    expect(out).not.toContain("projects");
    expect(out).not.toContain("foo");
    expect(out).not.toContain(home);
  });

  it("Minor1 (round 3): collapses a REAL Claude Code transcript path (slugified project dir with a space) to just the basename", () => {
    // Claude Code's own directory naming: ~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl,
    // where slugified-cwd is the ENTIRE original cwd with every "/" turned
    // into "-" — so a project at "/Users/me/dev/Secret Co/Client Alpha"
    // becomes the literal directory name "-Users-me-dev-Secret Co-Client
    // Alpha", embedding the client name (with a space in it) directly into
    // what round 1/2 treated as an already-safe home-relative segment.
    // This is the reviewer's production-shaped reproduction of MINOR 1.
    const home = homedir();
    const reason =
      `failed to read transcript "${home}/.claude/projects/-Users-me-dev-Secret Co-Client Alpha/` +
      `abc123-def4-4567-8901-234567890abc.jsonl": ENOENT`;
    const out = sanitizeLogReason(reason);
    expect(out).toBe('failed to read transcript "abc123-def4-4567-8901-234567890abc.jsonl": ENOENT');
    expect(out).not.toContain("Secret Co");
    expect(out).not.toContain("Client Alpha");
    expect(out).not.toContain(home);
  });

  it("collapses a TRAILING-SLASH directory path to a single last segment, not two (round 3)", () => {
    const reason = "upload failed for [/private/var/Secret Co/Client Alpha/]: 500";
    const out = sanitizeLogReason(reason);
    expect(out).toBe("upload failed for [Client Alpha/]: 500");
    expect(out).not.toContain("Secret Co");
  });

  it("also collapses an already-tilde-prefixed path directly, preserving the harmless ~/ prefix (defense in depth, round 3)", () => {
    const reason = 'see "~/.claude/projects/-Users-me-dev-Secret Co/abc.jsonl"';
    const out = sanitizeLogReason(reason);
    // The "~/" prefix itself is kept (it reveals nothing beyond "under the
    // user's home") — everything else collapses to the basename.
    expect(out).toBe('see "~/abc.jsonl"');
    expect(out).not.toContain("Secret Co");
  });

  it("collapses a DOUBLE-QUOTED absolute path containing spaces to its basename", () => {
    const reason = 'failed to read transcript "/private/var/Secret Co/Client Alpha/nope.jsonl": ENOENT';
    const out = sanitizeLogReason(reason);
    expect(out).toBe('failed to read transcript "nope.jsonl": ENOENT');
    expect(out).not.toContain("Secret Co");
    expect(out).not.toContain("Client Alpha");
  });

  it("collapses a SINGLE-QUOTED absolute path containing spaces to its basename (Node fs error shape)", () => {
    const reason = "ENOENT: no such file or directory, open '/private/var/Secret Co/nope.jsonl'";
    const out = sanitizeLogReason(reason);
    expect(out).toBe("ENOENT: no such file or directory, open 'nope.jsonl'");
    expect(out).not.toContain("Secret Co");
  });

  it("collapses a BRACKET-delimited absolute path containing spaces to its basename", () => {
    const reason = "upload failed for [/private/var/Secret Co/nope.jsonl]: 500";
    const out = sanitizeLogReason(reason);
    expect(out).toBe("upload failed for [nope.jsonl]: 500");
    expect(out).not.toContain("Secret Co");
  });

  it("collapses an ANGLE-BRACKET-delimited absolute path containing spaces to its basename", () => {
    const reason = "see </private/var/Secret Co/nope.jsonl>";
    const out = sanitizeLogReason(reason);
    expect(out).toBe("see <nope.jsonl>");
    expect(out).not.toContain("Secret Co");
  });

  it("still collapses a bare, undelimited absolute path with no spaces (round 1 regression check)", () => {
    const reason = "failed to read transcript /var/folders/abc123/nonexistent.jsonl: ENOENT";
    const out = sanitizeLogReason(reason);
    expect(out).toBe("failed to read transcript nonexistent.jsonl: ENOENT");
  });

  it("never mangles a URL, quoted or bare", () => {
    const quoted = 'Network error uploading to "https://cloud.example.com/api/code-sessions": timeout';
    expect(sanitizeLogReason(quoted)).toBe(quoted);

    const bare = "Network error uploading to https://cloud.example.com/api/code-sessions: timeout";
    expect(sanitizeLogReason(bare)).toBe(bare);
  });

  it("Minor2 (round 4): exempts ONLY http(s) — a file:// URI's path portion still gets collapsed", () => {
    // Round 1-3's `includes("://")` check exempted ANYTHING containing
    // "://", including a "file://" URI — whose path portion is exactly as
    // sensitive as a bare filesystem path, but sailed through completely
    // unsanitized. Only real http(s) URLs may bypass sanitization now.
    const quoted = 'see "file:///private/var/Secret Co/Client Alpha/nope.jsonl"';
    const outQuoted = sanitizeLogReason(quoted);
    expect(outQuoted).toBe('see "file://nope.jsonl"');
    expect(outQuoted).not.toContain("Secret Co");
    expect(outQuoted).not.toContain("Client Alpha");

    // Bare (undelimited, whitespace-bounded) token — same known scope as
    // every other bare-path case: reliable for a path with no spaces in it
    // (a spaced bare path, quote/bracket-free, is the pre-existing
    // token-fallback limitation documented on sanitizePathToken/
    // collapseDelimitedPaths, not something this file:// fix changes).
    const bare = "see file:///private/var/nonexistent.jsonl";
    const outBare = sanitizeLogReason(bare);
    expect(outBare).toBe("see file://nonexistent.jsonl");
    expect(outBare).not.toContain("private");

    // http(s) is still fully exempt, scheme-checked (not just "contains ://").
    const httpUrl = 'fetch "https://cloud.example.com/api/code-sessions" failed';
    expect(sanitizeLogReason(httpUrl)).toBe(httpUrl);
  });

  it("Minor3 (round 4): collapses a PAREN-delimited absolute path containing spaces to its basename", () => {
    // import-sessions.ts (and other call sites) format a wrapped cause as
    // `(${errMessage(cause)})` — a spaced path inside plain parens wasn't
    // covered by any delimiter pair and leaked past the whitespace-only
    // token fallback, same class of bug as the quote/bracket cases.
    const reason = "upload failed (/private/var/Secret Co/Client Alpha/nope.jsonl)";
    const out = sanitizeLogReason(reason);
    expect(out).toBe("upload failed (nope.jsonl)");
    expect(out).not.toContain("Secret Co");
    expect(out).not.toContain("Client Alpha");
  });

  it("leaves a reason with no paths untouched", () => {
    const reason = "server reported an error for s-1: db exploded";
    expect(sanitizeLogReason(reason)).toBe(reason);
  });
});

// R4 4.3 site 1, design note §4: both upload deadlines anchor at t0, the
// moment the upload phase starts (inline: hook start; Claude Code child: after
// the lock wait; Copilot: after the shutdown wait — each passes its own t0).
describe("uploadDeadlines", () => {
  it("defaults: startBy = t0 + 20 s, abortAt = t0 + 28 s", () => {
    expect(uploadDeadlines({}, 1_000_000)).toEqual({ childDeadlineAt: 1_020_000, uploadAbortAt: 1_028_000 });
  });

  it("a t0 taken after a 15 s lock wait or a 60 s shutdown wait moves both deadlines with it", () => {
    const hookStart = 1_000_000;
    expect(uploadDeadlines({}, hookStart + 15_000)).toEqual({
      childDeadlineAt: hookStart + 35_000,
      uploadAbortAt: hookStart + 43_000,
    });
    expect(uploadDeadlines({}, hookStart + 60_000).uploadAbortAt).toBe(hookStart + 88_000);
  });

  it("abortAt is never earlier than startBy", () => {
    expect(uploadDeadlines({ timeoutMs: 50 }, 0)).toEqual({ childDeadlineAt: 20_000, uploadAbortAt: 20_000 });
    expect(uploadDeadlines({ childBudgetMs: 0 }, 0)).toEqual({ childDeadlineAt: 0, uploadAbortAt: 28_000 });
  });
});
