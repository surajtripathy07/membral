// W6: GitHub Copilot CLI hooks — the camelCase hook runtime (preamble
// --format copilot, session-end-hook --source copilot-cli), the standalone
// ~/.copilot/hooks/membral.json installer, and the setup-wizard scan.
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const importSessionMock = vi.fn();
vi.mock("../import-session.js", () => ({
  importSession: (...a: unknown[]) => importSessionMock(...a),
  SUB_AGENT_WARN_PREFIX: "sub-agent ",
}));

const { buildCopilotHooksFile, copilotHooksPath, installCopilotCliHooks } = await import("../copilot-cli-hooks.js");
const { buildHookOutput, preambleHook } = await import("../preamble-hook.js");
const { copilotTranscriptPath, hasShutdownEvent, sessionEndHook } = await import("../session-end-hook.js");
const { scanCopilotCli, scanHarnesses } = await import("../harness-scan.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_HOME = join(__dirname, "..", "..", "..", "..", "fixtures", "sessions", "copilot-cli");

const invocation = { argv: ["/usr/local/bin/node", "/opt/membral/dist/index.js"] };

let root: string;
// Restore keys in place: reassigning process.env detaches it from the real
// environment that os.homedir() reads.
const ENV_KEYS = ["HOME", "COPILOT_HOME", "MEMBRAL_API_KEY"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const spawnMock = vi.fn();
/** The --deferred-path the hook handed its detached child on spawn call `i`. */
const deferredPathOf = (i = 0) => {
  const args = spawnMock.mock.calls[i][0] as string[];
  return args[args.indexOf("--deferred-path") + 1];
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "membral-copilot-cli-"));
  spawnMock.mockReset();
  process.env.HOME = root;
  delete process.env.MEMBRAL_API_KEY;
  delete process.env.COPILOT_HOME;
  importSessionMock.mockReset();
  importSessionMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("preamble --hook --format copilot", () => {
  it("reads camelCase stdin and prints a flat {additionalContext}", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ lines: ["line one", "- [blocker] two"], recall_token: "t", open_blockers: [] }),
      text: async () =>
        JSON.stringify({ lines: ["line one", "- [blocker] two"], recall_token: "t", open_blockers: [] }),
    } as Response);
    const stdin = Readable.from([
      JSON.stringify({ sessionId: "abc", timestamp: 1759300000000, cwd: "/tmp/no-such-repo", source: "startup" }),
    ]);

    await preambleHook({ stdin, apiKey: "lls_x", fetchImpl: fetchMock, format: "copilot" });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`repo=${encodeURIComponent("/tmp/no-such-repo")}`);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(JSON.parse(out)).toEqual({ additionalContext: "line one\n- [blocker] two" });
  });

  it("keeps Claude Code's hookSpecificOutput shape as the default", () => {
    expect(buildHookOutput("x")).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "x" },
    });
    expect(buildHookOutput("x", "copilot")).toEqual({ additionalContext: "x" });
  });

  it("stops waiting for a stdin that never closes after the deadline and behaves as no payload", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetchMock = vi.fn();
    const hung = new Readable({ read() {} }); // never pushes, never ends
    await preambleHook({ stdin: hung, apiKey: "k", fetchImpl: fetchMock, stdinDeadlineMs: 20 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("prints nothing for a non-object payload", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetchMock = vi.fn();
    await preambleHook({ stdin: Readable.from(["[1,2]"]), apiKey: "k", fetchImpl: fetchMock, format: "copilot" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("copilotTranscriptPath", () => {
  it("uses transcriptPath when it is <home>/session-state/**/events.jsonl", () => {
    const p = "/home/c/session-state/s1/events.jsonl";
    expect(copilotTranscriptPath({ sessionId: "s1", transcriptPath: p }, "/home/c")).toBe(p);
  });

  it("ignores a payload transcriptPath outside session-state or not named events.jsonl", () => {
    const fallback = join("/home/c", "session-state", "s1", "events.jsonl");
    for (const bad of [
      "/x/events.jsonl",
      "/home/c/session-state/s1/other.jsonl",
      "/home/c/session-state/../secrets/events.jsonl",
      "/home/c/session-state-evil/s1/events.jsonl",
    ]) {
      expect(copilotTranscriptPath({ sessionId: "s1", transcriptPath: bad }, "/home/c")).toBe(fallback);
    }
    expect(copilotTranscriptPath({ transcriptPath: "/etc/passwd" }, "/home/c")).toBeUndefined();
  });

  it("derives session-state/<id>/events.jsonl under the given home", () => {
    expect(copilotTranscriptPath({ sessionId: "s1" }, "/home/c")).toBe(
      join("/home/c", "session-state", "s1", "events.jsonl"),
    );
  });

  it("honours COPILOT_HOME, else ~/.copilot", () => {
    process.env.COPILOT_HOME = "/custom/copilot";
    expect(copilotTranscriptPath({ sessionId: "s1" })).toBe(
      join("/custom/copilot", "session-state", "s1", "events.jsonl"),
    );
    delete process.env.COPILOT_HOME;
    expect(copilotTranscriptPath({ sessionId: "s1" })).toBe(
      join(root, ".copilot", "session-state", "s1", "events.jsonl"),
    );
  });

  it("rejects ids that would leave session-state/", () => {
    expect(copilotTranscriptPath({ sessionId: "../etc" }, "/h")).toBeUndefined();
    expect(copilotTranscriptPath({ sessionId: "a/b" }, "/h")).toBeUndefined();
    expect(copilotTranscriptPath({}, "/h")).toBeUndefined();
  });
});

describe("session-end-hook --source copilot-cli", () => {
  async function readLog(path: string) {
    const raw = await readFile(path, "utf8");
    return raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }

  it("spawns a deferred child for the derived events.jsonl and returns before any import", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hookLogPath = join(root, "hook.log");
    const copilotHome = join(root, "copilot");
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath,
      apiUrl: "http://localhost:3000",
      spawnDeferred: spawnMock,
      stdin: Readable.from([JSON.stringify({ sessionId: "sess-1", timestamp: 1, cwd: "/r", reason: "complete" })]),
    });
    expect(importSessionMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toEqual([
      "session-end-hook",
      "--source",
      "copilot-cli",
      "--deferred-path",
      join(copilotHome, "session-state", "sess-1", "events.jsonl"),
      "--deferred-offset",
      "0",
      "--api-url",
      "http://localhost:3000",
    ]);
    // The parent logs only that it deferred; the child writes the real outcome.
    const log = await readLog(hookLogPath);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "deferred", transcript: "sess-1/events.jsonl" });
  });

  it("passes the transcript size as --deferred-offset and the API key via env, never argv", async () => {
    const copilotHome = join(root, "copilot");
    const dir = join(copilotHome, "session-state", "sess-9");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.jsonl"), "x".repeat(123));
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath: join(root, "hook.log"),
      apiKey: "secret-key",
      spawnDeferred: spawnMock,
      stdin: Readable.from([JSON.stringify({ sessionId: "sess-9" })]),
    });
    const [args, env] = spawnMock.mock.calls[0] as [string[], Record<string, string>];
    expect(args[args.indexOf("--deferred-offset") + 1]).toBe("123");
    expect(args).not.toContain("--api-key");
    expect(args.join(" ")).not.toContain("secret-key");
    expect(env).toEqual({ MEMBRAL_API_KEY: "secret-key" });
  });

  it("imports inline when the deferred child cannot be spawned", async () => {
    const hookLogPath = join(root, "hook.log");
    const copilotHome = join(root, "copilot");
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath,
      spawnDeferred: () => {
        throw new Error("EAGAIN");
      },
      stdin: Readable.from([JSON.stringify({ sessionId: "sess-1" })]),
    });
    expect(importSessionMock.mock.calls[0][0]).toMatchObject({
      transcript: join(copilotHome, "session-state", "sess-1", "events.jsonl"),
      source: "copilot-cli",
    });
    const log = await readLog(hookLogPath);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "ok", transcript: "sess-1/events.jsonl" });
  });

  it("prefers an in-session-state transcriptPath, ignores one outside it", async () => {
    const hookLogPath = join(root, "hook.log");
    const copilotHome = join(root, "copilot");
    const inside = join(copilotHome, "session-state", "s", "events.jsonl");
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath,
      spawnDeferred: spawnMock,
      stdin: Readable.from([JSON.stringify({ sessionId: "s", transcriptPath: inside })]),
    });
    expect(deferredPathOf(0)).toBe(inside);
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath,
      spawnDeferred: spawnMock,
      stdin: Readable.from([JSON.stringify({ sessionId: "s", transcriptPath: "/elsewhere/s/events.jsonl" })]),
    });
    expect(deferredPathOf(1)).toBe(inside);
  });

  describe("cwd fallback when sessionId is missing or invalid", () => {
    const start = (cwd: string) =>
      `${JSON.stringify({ type: "session.start", data: { sessionId: "x", context: { cwd } } })}\n`;
    async function seed(home: string, id: string, cwd: string, ageMs: number) {
      const dir = join(home, "session-state", id);
      await mkdir(dir, { recursive: true });
      const f = join(dir, "events.jsonl");
      await writeFile(f, start(cwd));
      const t = new Date(Date.now() - ageMs);
      await utimes(f, t, t);
      return f;
    }
    const run = (copilotHome: string, payload: object) =>
      sessionEndHook({
        source: "copilot-cli",
        copilotHome,
        hookLogPath: join(root, "hook.log"),
        spawnDeferred: spawnMock,
        stdin: Readable.from([JSON.stringify(payload)]),
      });

    it("picks the newest recent session whose start cwd matches", async () => {
      const home = join(root, "copilot");
      await seed(home, "old", "/work/a", 2 * 3600_000);
      const newest = await seed(home, "new", "/work/a", 60_000);
      await seed(home, "other", "/work/b", 1000);
      await run(home, { sessionId: "../bad", cwd: "/work/a" });
      expect(deferredPathOf(0)).toBe(newest);
      await run(home, { cwd: "/work/a" });
      expect(deferredPathOf(1)).toBe(newest);
    });

    it("ignores sessions older than 6 hours and logs the skip when nothing matches", async () => {
      const home = join(root, "copilot");
      await seed(home, "stale", "/work/a", 7 * 3600_000);
      await seed(home, "wrongcwd", "/work/b", 1000);
      await run(home, { cwd: "/work/a" });
      expect(importSessionMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      const log = await readLog(join(root, "hook.log"));
      expect(log[0]).toMatchObject({ outcome: "skipped", reason: "missing sessionId" });
    });
  });

  it("malformed or id-less input logs skipped, never imports, never throws", async () => {
    const hookLogPath = join(root, "hook.log");
    await sessionEndHook({ source: "copilot-cli", hookLogPath, stdin: Readable.from(["{not json"]) });
    await sessionEndHook({ source: "copilot-cli", hookLogPath, stdin: Readable.from([JSON.stringify({ cwd: "/r" })]) });
    expect(importSessionMock).not.toHaveBeenCalled();
    const log = await readLog(hookLogPath);
    expect(log.map((l) => l.outcome)).toEqual(["skipped", "skipped"]);
    expect(log[1].reason).toBe("missing sessionId");
  });
});

describe("session-end-hook --source copilot-cli --deferred-path (the detached child)", () => {
  const line = (type: string, data: object = {}) => `${JSON.stringify({ type, data })}\n`;
  async function seedSession(copilotHome: string, id: string, content: string) {
    const dir = join(copilotHome, "session-state", id);
    await mkdir(dir, { recursive: true });
    const f = join(dir, "events.jsonl");
    await writeFile(f, content);
    return f;
  }
  async function readLog(path: string) {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }
  const fast = { deferredPollMs: 10, deferredStableMs: 30 };

  it("waits for session.shutdown to be appended, then imports and logs waited_ms + shutdown: true", async () => {
    const copilotHome = join(root, "copilot");
    const hookLogPath = join(root, "hook.log");
    const f = await seedSession(copilotHome, "s1", line("session.start") + line("assistant.message"));
    let sawShutdownAtImport: boolean | undefined;
    importSessionMock.mockImplementation(async () => {
      sawShutdownAtImport = (await readFile(f, "utf8")).includes("session.shutdown");
    });
    const appended = new Promise<void>((r) =>
      setTimeout(async () => {
        await writeFile(f, line("session.start") + line("assistant.message") + line("session.shutdown"));
        r();
      }, 120),
    );
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath,
      deferredPath: f,
      deferredMaxWaitMs: 5_000,
      ...fast,
    });
    await appended;
    expect(importSessionMock).toHaveBeenCalledTimes(1);
    expect(importSessionMock.mock.calls[0][0]).toMatchObject({ transcript: f, source: "copilot-cli" });
    expect(sawShutdownAtImport).toBe(true);
    const log = await readLog(hookLogPath);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "ok", transcript: "s1/events.jsonl", shutdown: true });
    expect(log[0].waited_ms).toBeGreaterThanOrEqual(100);
  });

  it("imports anyway after the max wait when no session.shutdown ever lands", async () => {
    const copilotHome = join(root, "copilot");
    const hookLogPath = join(root, "hook.log");
    const f = await seedSession(copilotHome, "s2", line("session.start") + line("assistant.message"));
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath,
      deferredPath: f,
      deferredMaxWaitMs: 150,
      ...fast,
    });
    expect(importSessionMock).toHaveBeenCalledTimes(1);
    const log = await readLog(hookLogPath);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "ok", transcript: "s2/events.jsonl", shutdown: false });
    expect(log[0].waited_ms).toBeGreaterThanOrEqual(150);
  });

  it("does not wait when the shutdown line is already there", async () => {
    const copilotHome = join(root, "copilot");
    const hookLogPath = join(root, "hook.log");
    const f = await seedSession(copilotHome, "s3", line("session.start") + line("session.shutdown"));
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath,
      deferredPath: f,
      deferredMaxWaitMs: 5_000,
      ...fast,
    });
    const log = await readLog(hookLogPath);
    expect(log[0]).toMatchObject({ outcome: "ok", shutdown: true });
    expect(log[0].waited_ms).toBeLessThan(1_000);
  });

  it("rejects a deferred path outside session-state or not named events.jsonl", async () => {
    const copilotHome = join(root, "copilot");
    const hookLogPath = join(root, "hook.log");
    const outside = join(root, "elsewhere", "events.jsonl");
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, line("session.shutdown"));
    const wrongName = await seedSession(copilotHome, "s4", "");
    const renamed = join(dirname(wrongName), "other.jsonl");
    await writeFile(renamed, line("session.shutdown"));
    const traversal = join(copilotHome, "session-state", "..", "..", "elsewhere", "events.jsonl");
    for (const deferredPath of [outside, renamed, traversal]) {
      await sessionEndHook({
        source: "copilot-cli",
        copilotHome,
        hookLogPath,
        deferredPath,
        deferredMaxWaitMs: 50,
        ...fast,
      });
    }
    expect(importSessionMock).not.toHaveBeenCalled();
    const log = await readLog(hookLogPath);
    expect(log).toHaveLength(3);
    for (const l of log) expect(l).toMatchObject({ outcome: "skipped", reason: "deferred path outside session-state" });
  });

  it("resume safety: an earlier shutdown before --deferred-offset does not count; waits for the second", async () => {
    const copilotHome = join(root, "copilot");
    const hookLogPath = join(root, "hook.log");
    const before = line("session.start") + line("session.shutdown");
    const f = await seedSession(copilotHome, "s6", before);
    const offset = Buffer.byteLength(before);
    expect(await hasShutdownEvent(f)).toBe(true);
    expect(await hasShutdownEvent(f, offset)).toBe(false);
    const appended = new Promise<void>((r) =>
      setTimeout(async () => {
        await writeFile(f, before + line("assistant.message") + line("session.shutdown"));
        r();
      }, 150),
    );
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath,
      deferredPath: f,
      deferredOffset: offset,
      deferredMaxWaitMs: 5_000,
      ...fast,
    });
    await appended;
    const log = await readLog(hookLogPath);
    expect(log[0]).toMatchObject({ outcome: "ok", shutdown: true });
    expect(log[0].waited_ms).toBeGreaterThanOrEqual(100);
  });

  it("VS Code session (copilotVersion 0.0.0): skips the shutdown wait, only settles", async () => {
    const copilotHome = join(root, "copilot");
    const hookLogPath = join(root, "hook.log");
    const f = await seedSession(
      copilotHome,
      "s7",
      line("session.start", { copilotVersion: "0.0.0" }) + line("assistant.message"),
    );
    await sessionEndHook({
      source: "copilot-cli",
      copilotHome,
      hookLogPath,
      deferredPath: f,
      deferredMaxWaitMs: 5_000,
      ...fast,
    });
    expect(importSessionMock).toHaveBeenCalledTimes(1);
    const log = await readLog(hookLogPath);
    expect(log[0]).toMatchObject({ outcome: "ok", shutdown: false });
    expect(log[0].waited_ms).toBeLessThan(1_000);
  });

  describe("dedupe lock", () => {
    const lockOf = () => join(root, "deferred", "s8.lock");
    async function run(f: string, copilotHome: string) {
      await sessionEndHook({
        source: "copilot-cli",
        copilotHome,
        hookLogPath: join(root, "hook.log"),
        deferredPath: f,
        deferredMaxWaitMs: 50,
        ...fast,
      });
    }

    it("skips when a fresh lock exists, and leaves that lock alone", async () => {
      const copilotHome = join(root, "copilot");
      const f = await seedSession(copilotHome, "s8", line("session.start") + line("session.shutdown"));
      await mkdir(dirname(lockOf()), { recursive: true });
      await writeFile(lockOf(), String(process.pid)); // a live owner
      await run(f, copilotHome);
      expect(importSessionMock).not.toHaveBeenCalled();
      const log = await readLog(join(root, "hook.log"));
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ outcome: "skipped", reason: "already uploading" });
      await expect(readFile(lockOf(), "utf8")).resolves.toBe(String(process.pid));
    });

    it("takes over a lock older than 10 minutes, and removes its own lock when done", async () => {
      const copilotHome = join(root, "copilot");
      const f = await seedSession(copilotHome, "s8", line("session.start") + line("session.shutdown"));
      await mkdir(dirname(lockOf()), { recursive: true });
      await writeFile(lockOf(), "999");
      const old = new Date(Date.now() - 11 * 60 * 1000);
      await utimes(lockOf(), old, old);
      await run(f, copilotHome);
      expect(importSessionMock).toHaveBeenCalledTimes(1);
      await expect(readFile(lockOf(), "utf8")).rejects.toThrow();
    });

    it("removes the lock even when the import throws", async () => {
      const copilotHome = join(root, "copilot");
      const f = await seedSession(copilotHome, "s8", line("session.start") + line("session.shutdown"));
      importSessionMock.mockRejectedValue(new Error("boom"));
      await run(f, copilotHome);
      await expect(readFile(lockOf(), "utf8")).rejects.toThrow();
      const log = await readLog(join(root, "hook.log"));
      expect(log[0]).toMatchObject({ outcome: "error" });
    });
  });

  it("hasShutdownEvent ignores a quoted mention inside message content and a partial last line", async () => {
    const copilotHome = join(root, "copilot");
    const f = await seedSession(
      copilotHome,
      "s5",
      line("user.message", { content: 'grep for "session.shutdown"' }) + '{"type":"session.shutdown","da',
    );
    expect(await hasShutdownEvent(f)).toBe(false);
    expect(await hasShutdownEvent(join(copilotHome, "missing", "events.jsonl"))).toBe(false);
  });
});

describe("installCopilotCliHooks", () => {
  it("writes a standalone membral.json with sessionStart + sessionEnd only", async () => {
    const home = join(root, "copilot");
    const res = await installCopilotCliHooks({ copilotHome: home, cliInvocation: invocation });
    expect(res).toMatchObject({ path: join(home, "hooks", "membral.json"), outcome: "created" });
    const parsed = JSON.parse(await readFile(res.path, "utf8"));
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.hooks)).toEqual(["sessionStart", "sessionEnd"]);
    expect(parsed.hooks.sessionStart[0]).toEqual({
      type: "command",
      bash: '"/usr/local/bin/node" "/opt/membral/dist/index.js" preamble --hook --format copilot',
      powershell: "& '/usr/local/bin/node' '/opt/membral/dist/index.js' preamble --hook --format copilot",
      timeoutSec: 25,
    });
    expect(parsed.hooks.sessionEnd[0].bash).toBe(
      '"/usr/local/bin/node" "/opt/membral/dist/index.js" session-end-hook --source copilot-cli',
    );
    expect(parsed.hooks.sessionEnd[0].timeoutSec).toBe(35);
  });

  it("is idempotent: a second run is byte-identical and leaves other hook files alone", async () => {
    const home = join(root, "copilot");
    const other = join(home, "hooks", "other-tool.json");
    await mkdir(dirname(other), { recursive: true });
    const otherContent = '{"version":1,"hooks":{"sessionStart":[{"type":"command","bash":"echo hi"}]}}';
    await writeFile(other, otherContent);

    const first = await installCopilotCliHooks({ copilotHome: home, cliInvocation: invocation });
    const firstBytes = await readFile(first.path);
    const second = await installCopilotCliHooks({ copilotHome: home, cliInvocation: invocation });
    const secondBytes = await readFile(second.path);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("unchanged");
    expect(secondBytes.equals(firstBytes)).toBe(true);
    expect(await readFile(other, "utf8")).toBe(otherContent);
  });

  it("rewrites a stale membral.json and dry-run writes nothing", async () => {
    const home = join(root, "copilot");
    const path = copilotHooksPath(home);
    expect((await installCopilotCliHooks({ copilotHome: home, cliInvocation: invocation, dryRun: true })).outcome).toBe(
      "would-write",
    );
    await expect(readFile(path)).rejects.toThrow();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{}\n");
    expect((await installCopilotCliHooks({ copilotHome: home, cliInvocation: invocation })).outcome).toBe("updated");
    expect(await readFile(path, "utf8")).toBe(buildCopilotHooksFile(invocation));
  });

  it("defaults to ${COPILOT_HOME:-~/.copilot}/hooks/membral.json", () => {
    expect(copilotHooksPath()).toBe(join(root, ".copilot", "hooks", "membral.json"));
    process.env.COPILOT_HOME = "/custom/copilot";
    expect(copilotHooksPath()).toBe(join("/custom/copilot", "hooks", "membral.json"));
  });
});

describe("scanCopilotCli", () => {
  it("counts the fixture session-state dirs as importable Copilot CLI sessions", async () => {
    const projects = await scanCopilotCli(FIXTURE_HOME, new Map());
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.every((p) => p.harness === "copilot-cli" && p.importable)).toBe(true);
    expect(projects.reduce((n, p) => n + p.sessions, 0)).toBe(3);
  });

  it("groups by session.start cwd and skips dirs with no events.jsonl", async () => {
    const home = join(root, "copilot");
    const start = (cwd: string) =>
      `${JSON.stringify({ type: "session.start", data: { sessionId: "x", context: { cwd } } })}\n`;
    for (const [id, cwd] of [
      ["a", "/work/alpha"],
      ["b", "/work/alpha"],
      ["c", "/work/beta"],
    ]) {
      await mkdir(join(home, "session-state", id), { recursive: true });
      await writeFile(join(home, "session-state", id, "events.jsonl"), start(cwd));
    }
    await mkdir(join(home, "session-state", "empty"), { recursive: true });

    const projects = await scanCopilotCli(home, new Map());
    const byPath = Object.fromEntries(projects.map((p) => [p.projectPath, p.sessions]));
    expect(byPath).toEqual({ "/work/alpha": 2, "/work/beta": 1 });
    expect(projects.find((p) => p.projectPath === "/work/alpha")?.displayName).toBe("alpha");
  });

  it("returns nothing when there is no session-state dir, and scanHarnesses includes copilot-cli", async () => {
    expect(await scanCopilotCli(join(root, "nope"), new Map())).toEqual([]);
    const all = await scanHarnesses({
      claudeCodeRoot: join(root, "none-cc"),
      codexRoot: join(root, "none-codex"),
      opencodeRoot: join(root, "none-oc"),
      copilotHome: FIXTURE_HOME,
    });
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((p) => p.harness === "copilot-cli")).toBe(true);
  });
});
