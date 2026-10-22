import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGY_HOOK_NAME, configureAgyHooks, configureMCPServer } from "../configure.js";
import { detectTools } from "../detect.js";
import { installSessionHook } from "../install-session-hook.js";
import { agyTranscript, sessionEndHook } from "../session-end-hook.js";

const CONV = "4b5ca835-4d08-433f-bda8-9ddfcc19e8c4";
const INVOCATION = { argv: ["/usr/bin/node", "/opt/membral/dist/index.js"] };

describe("Antigravity (agy)", () => {
  let root: string;
  let agyHome: string;
  let hooksPath: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-agy-"));
    agyHome = join(root, ".gemini", "antigravity-cli");
    hooksPath = join(root, ".gemini", "config", "hooks.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  async function writeTranscripts(files: string[] = ["transcript.jsonl", "transcript_full.jsonl"]) {
    const logs = join(agyHome, "brain", CONV, ".system_generated", "logs");
    await mkdir(logs, { recursive: true });
    const line = JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: "2026-10-10T12:00:00Z",
      content: "Add a retry to the CodeHub client",
    });
    for (const f of files) await writeFile(join(logs, f), `${line}\n`);
    return logs;
  }

  describe("hooks.json writer", () => {
    it("installs under the membral key, twice with no change", async () => {
      const first = await configureAgyHooks(hooksPath, { cliInvocation: INVOCATION });
      expect(first.success).toBe(true);
      const once = await readFile(hooksPath, "utf8");
      const parsed = JSON.parse(once);
      expect(Object.keys(parsed)).toEqual([AGY_HOOK_NAME]);
      expect(parsed.membral.PreInvocation[0].command).toContain("preamble --hook --format agy");
      expect(parsed.membral.Stop[0].command).toContain("session-end-hook --source agy");
      const second = await configureAgyHooks(hooksPath, { cliInvocation: INVOCATION });
      expect(second.message).toContain("already configured");
      expect(await readFile(hooksPath, "utf8")).toBe(once);
      expect((await stat(hooksPath)).mode & 0o777).toBe(0o600);
    });

    it("keeps unrelated hooks, backs up the old file, and corrects a stale path", async () => {
      await mkdir(join(root, ".gemini", "config"), { recursive: true });
      const mine = { lint: { PreInvocation: [{ type: "command", command: "./lint.sh" }] } };
      await writeFile(
        hooksPath,
        JSON.stringify({
          ...mine,
          membral: { Stop: [{ type: "command", command: "/old/place session-end-hook --source agy" }] },
        }),
      );
      await configureAgyHooks(hooksPath, { cliInvocation: INVOCATION });
      const parsed = JSON.parse(await readFile(hooksPath, "utf8"));
      expect(parsed.lint).toEqual(mine.lint);
      expect(parsed.membral.Stop[0].command).toContain("/opt/membral/dist/index.js");
      expect(parsed.membral.Stop[0].command).not.toContain("/old/place");
      expect(await readFile(`${hooksPath}.membral.bak`, "utf8")).toContain("/old/place");
    });

    it("remove deletes only the membral key", async () => {
      await mkdir(join(root, ".gemini", "config"), { recursive: true });
      await writeFile(hooksPath, JSON.stringify({ lint: { Stop: [] } }));
      await configureAgyHooks(hooksPath, { cliInvocation: INVOCATION });
      const res = await configureAgyHooks(hooksPath, { remove: true });
      expect(res.success).toBe(true);
      expect(JSON.parse(await readFile(hooksPath, "utf8"))).toEqual({ lint: { Stop: [] } });
      const again = await configureAgyHooks(hooksPath, { remove: true });
      expect(again.message).toContain("nothing to remove");
    });

    it("leaves a malformed or non-object file untouched and reports failure", async () => {
      await mkdir(join(root, ".gemini", "config"), { recursive: true });
      await writeFile(hooksPath, "{ not json");
      const bad = await configureAgyHooks(hooksPath, { cliInvocation: INVOCATION });
      expect(bad.success).toBe(false);
      expect(await readFile(hooksPath, "utf8")).toBe("{ not json");
      await writeFile(hooksPath, "[]");
      expect((await configureAgyHooks(hooksPath, { cliInvocation: INVOCATION })).success).toBe(false);
      expect(await readFile(hooksPath, "utf8")).toBe("[]");
    });

    it("remove on a malformed or non-object file is a no-op success, file untouched", async () => {
      await mkdir(join(root, ".gemini", "config"), { recursive: true });
      await writeFile(hooksPath, "{ // jsonc\n}");
      const res = await configureAgyHooks(hooksPath, { remove: true });
      expect(res.success).toBe(true);
      expect(res.message).toContain("nothing to remove");
      expect(await readFile(hooksPath, "utf8")).toBe("{ // jsonc\n}");
      await writeFile(hooksPath, "[]");
      expect((await configureAgyHooks(hooksPath, { remove: true })).success).toBe(true);
      expect(await readFile(hooksPath, "utf8")).toBe("[]");
    });

    it("treats an empty file as an empty object", async () => {
      await mkdir(join(root, ".gemini", "config"), { recursive: true });
      await writeFile(hooksPath, "");
      expect((await configureAgyHooks(hooksPath, { cliInvocation: INVOCATION })).success).toBe(true);
    });
  });

  describe("MCP entry", () => {
    it("writes a stdio mcp-remote entry at mode 0600 into an empty mcp_config.json", async () => {
      const path = join(root, ".gemini", "config", "mcp_config.json");
      await mkdir(join(root, ".gemini", "config"), { recursive: true });
      await writeFile(path, "");
      const res = await configureMCPServer("agy", path, { apiUrl: "https://example.test", apiKey: "mk_fake_0000" });
      expect(res.success).toBe(true);
      const entry = JSON.parse(await readFile(path, "utf8")).mcpServers.membral;
      expect(entry.command).toBe("npx");
      expect(entry.args).toContain("https://example.test/api/mcp");
      expect(entry.env.MEMBRAL_AUTH_HEADER).toBe("Bearer mk_fake_0000");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  });

  describe("detection", () => {
    it("does not treat ~/.gemini/config alone as Antigravity", async () => {
      process.env.HOME = root;
      await mkdir(join(root, ".gemini", "config"), { recursive: true });
      const agy = (await detectTools()).find((t) => t.id === "agy");
      expect(agy?.detected).toBe(false);
      await mkdir(agyHome, { recursive: true });
      expect((await detectTools()).find((t) => t.id === "agy")?.detected).toBe(true);
    });

    it("install-session-hook with only ~/.gemini/config does not throw or create agy files", async () => {
      process.env.HOME = root;
      await mkdir(join(root, ".gemini", "config"), { recursive: true });
      await expect(
        installSessionHook({ settings: join(root, "settings.json"), cliInvocation: INVOCATION, promptRecall: false }),
      ).resolves.toBeUndefined();
      await expect(stat(hooksPath)).rejects.toThrow();
    });

    it("install-session-hook installs and removes the agy hooks only on request", async () => {
      process.env.HOME = root;
      await installSessionHook({
        settings: join(root, "settings.json"),
        cliInvocation: INVOCATION,
        promptRecall: false,
        agy: true,
      });
      expect(JSON.parse(await readFile(hooksPath, "utf8")).membral).toBeDefined();
      await installSessionHook({ settings: join(root, "settings.json"), cliInvocation: INVOCATION, remove: true });
      expect(JSON.parse(await readFile(hooksPath, "utf8"))).toEqual({});
    });
  });

  describe("session-end hook", () => {
    it("derives the conversation id from the brain directory and prefers the uncut transcript", async () => {
      const logs = await writeTranscripts();
      const display = join(logs, "transcript.jsonl");
      const viaPath = await agyTranscript({ transcriptPath: display }, agyHome);
      expect(viaPath).toEqual({ path: join(logs, "transcript_full.jsonl"), id: CONV });
      const viaId = await agyTranscript({ conversationId: CONV }, agyHome);
      expect(viaId?.id).toBe(CONV);
    });

    it("rejects a path outside the agy home, a relative path, and a traversing id", async () => {
      await writeTranscripts();
      expect(
        await agyTranscript({ transcriptPath: "relative/brain/x/.system_generated/logs/transcript.jsonl" }, agyHome),
      ).toBeUndefined();
      expect(
        await agyTranscript(
          { transcriptPath: `/elsewhere/brain/${CONV}/.system_generated/logs/transcript.jsonl` },
          agyHome,
        ),
      ).toBeUndefined();
      expect(await agyTranscript({ conversationId: "../etc" }, agyHome)).toBeUndefined();
      expect(await agyTranscript({}, agyHome)).toBeUndefined();
    });

    it("hands the import to a detached child with --source agy and the transcript path", async () => {
      const logs = await writeTranscripts();
      const spawnDeferred = vi.fn();
      const hookLogPath = join(root, "hook.log");
      await sessionEndHook({
        source: "agy",
        agyHome,
        stdin: Readable.from([
          JSON.stringify({ conversationId: CONV, transcriptPath: join(logs, "transcript.jsonl") }),
        ]),
        apiKey: "mk_fake_0000",
        hookLogPath,
        spawnDeferred,
      });
      expect(spawnDeferred).toHaveBeenCalledTimes(1);
      const [args] = spawnDeferred.mock.calls[0] as [string[]];
      expect(args).toEqual([
        "session-end-hook",
        "--source",
        "agy",
        "--deferred-path",
        join(logs, "transcript_full.jsonl"),
      ]);
      const log = JSON.parse((await readFile(hookLogPath, "utf8")).trim());
      expect(log).toMatchObject({ outcome: "deferred", transcript: `${CONV}/transcript_full.jsonl` });
    });

    it("the child parses with the agy parser and uploads the brain directory id as the session id", async () => {
      const logs = await writeTranscripts(["transcript_full.jsonl"]);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
        text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const hookLogPath = join(root, "hook.log");
      await sessionEndHook({
        source: "agy",
        deferredPath: join(logs, "transcript_full.jsonl"),
        apiKey: "mk_fake_0000",
        apiUrl: "https://cloud.example.com",
        hookLogPath,
        stdin: new Readable({ read() {} }),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.sessions[0]).toMatchObject({ source: "agy", sourceSessionId: CONV });
      expect(body.sessions[0].sourceSessionId).not.toBe("transcript_full");
      const log = JSON.parse((await readFile(hookLogPath, "utf8")).trim());
      expect(log.outcome).toBe("ok");
    });

    it("skips a payload with no usable transcript", async () => {
      const hookLogPath = join(root, "hook.log");
      const spawnDeferred = vi.fn();
      await sessionEndHook({
        source: "agy",
        agyHome,
        stdin: Readable.from([JSON.stringify({ conversationId: CONV })]),
        hookLogPath,
        spawnDeferred,
      });
      expect(spawnDeferred).not.toHaveBeenCalled();
      expect(JSON.parse((await readFile(hookLogPath, "utf8")).trim()).outcome).toBe("skipped");
    });
  });
});
