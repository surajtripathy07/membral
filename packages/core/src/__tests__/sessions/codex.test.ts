import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SessionRootUnreadableError } from "../../sessions/claude-code.js";
import { codexParser, codexThreadIdFromFileName, stripRemoteCredentials } from "../../sessions/codex.js";
import { FORGE_ACTIONS_VERSION } from "../../sessions/forge-actions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo-root `fixtures/sessions/codex/` laid out as a Codex home
// (`sessions/YYYY/MM/DD/rollout-*.jsonl`), so detect() runs on it unchanged.
// Fictional content only.
const ROOT = join(__dirname, "..", "..", "..", "..", "..", "fixtures", "sessions", "codex");
const SMALL_ID = "5b1e9c2a-7d40-4f8e-a3b6-0c9d2e4f6a11";
const SMALL_PATH = join(ROOT, "sessions", "2026", "05", "14", `rollout-2026-05-14T09-12-01-${SMALL_ID}.jsonl`);

function parseSmall() {
  return codexParser.parse({ source: "codex", sourceSessionId: SMALL_ID, path: SMALL_PATH }, readFileSync(SMALL_PATH));
}

function line(type: string, payload: unknown, timestamp = "2026-05-14T10:00:00.000Z"): string {
  return JSON.stringify({ timestamp, type, payload });
}

describe("codexParser.detect", () => {
  const tmp = mkdtempSync(join(tmpdir(), "codex-detect-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("finds every sessions/**/rollout-*.jsonl under the Codex home", async () => {
    expect(await codexParser.detect(ROOT)).toEqual([{ source: "codex", sourceSessionId: SMALL_ID, path: SMALL_PATH }]);
  });

  it("skips .jsonl.zst rollouts with one warning, and non-rollout files silently", async () => {
    const day = join(tmp, "zst", "sessions", "2026", "06", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-06-01T08-00-00-aaaa.jsonl.zst"), "");
    writeFileSync(join(day, "notes.jsonl"), "");
    writeFileSync(join(day, "rollout-2026-06-01T09-00-00-bbbb_cccc.jsonl"), "");
    const warnings: string[] = [];
    const refs = await codexParser.detect(join(tmp, "zst"), (m) => warnings.push(m));
    expect(refs.map((r) => r.sourceSessionId)).toEqual(["bbbb"]);
    expect(warnings).toEqual(["skipping 1 compressed Codex rollout(s) (.jsonl.zst) — not supported yet"]);
  });

  it("returns [] for a Codex home with no sessions/ yet", async () => {
    mkdirSync(join(tmp, "fresh"), { recursive: true });
    expect(await codexParser.detect(join(tmp, "fresh"))).toEqual([]);
  });

  it("throws SessionRootUnreadableError for a missing root", async () => {
    await expect(codexParser.detect(join(tmp, "nope"))).rejects.toBeInstanceOf(SessionRootUnreadableError);
  });

  it("keeps only the newest rollout of a reverted thread (file-name timestamp, then rollout id — not mtime)", async () => {
    const small = readFileSync(SMALL_PATH);
    const thread = SMALL_ID;
    const d1 = join(tmp, "revert", "sessions", "2026", "05", "14");
    const d2 = join(tmp, "revert", "sessions", "2026", "05", "15");
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    const original = join(d1, `rollout-2026-05-14T09-12-01-${thread}.jsonl`);
    const sameSecondLow = join(d2, `rollout-2026-05-15T08-00-00-${thread}_0199a000-0000-7000-8000-000000000001.jsonl`);
    const reverted = join(d2, `rollout-2026-05-15T08-00-00-${thread}_0199a000-0000-7000-8000-000000000002.jsonl`);
    // Written newest-first so mtime order is the reverse of Codex's choice.
    for (const f of [reverted, sameSecondLow, original]) writeFileSync(f, small);
    writeFileSync(join(d1, "rollout-2026-05-14T10-00-00-other-thread.jsonl"), small);

    const refs = await codexParser.detect(join(tmp, "revert"));
    expect(refs.filter((r) => r.sourceSessionId === thread)).toEqual([
      { source: "codex", sourceSessionId: thread, path: reverted },
    ]);
    expect(refs.map((r) => r.sourceSessionId).sort()).toEqual(["other-thread", thread].sort());
  });

  it("reads the thread id out of a rollout file name", () => {
    expect(codexThreadIdFromFileName(`rollout-2026-05-14T09-12-01-${SMALL_ID}.jsonl`)).toBe(SMALL_ID);
    expect(codexThreadIdFromFileName(`rollout-2026-05-14T09-12-01-${SMALL_ID}_r2.jsonl`)).toBe(SMALL_ID);
  });
});

describe("codexParser.parse — fixture", () => {
  const s = parseSmall();

  it("takes id, cwd, git and model from session_meta and turn_context", () => {
    expect(s.source).toBe("codex");
    expect(s.sourceSessionId).toBe(SMALL_ID);
    expect(s.repo).toEqual({
      path: "/Users/dev/codehub-api",
      branch: "feat/upload-rate-limit",
      remoteUrl: "https://github.com/codehub/codehub-api.git",
    });
    expect(s.model).toBe("gpt-5.4");
    expect(s.models).toEqual(["gpt-5.4"]);
    expect(s.actionsVersion).toBe(FORGE_ACTIONS_VERSION);
  });

  it("skips developer and injected user messages, and never doubles event_msg duplicates", () => {
    const prose = s.turns.filter((t) => t.kind === "prose");
    expect(prose.map((t) => t.role)).toEqual(["user", "assistant", "assistant"]);
    expect(prose[0].text).toContain("per-key rate limit");
    expect(s.turns.some((t) => t.text?.includes("<environment_context>"))).toBe(false);
    expect(s.turns.some((t) => t.text?.includes("AGENTS.md"))).toBe(false);
    // Encrypted reasoning yields no thinking turn.
    expect(s.turns.some((t) => t.kind === "thinking")).toBe(false);
  });

  it("pairs every tool call with its output and maps shell, patch and MCP calls", () => {
    expect(s.toolCounts).toEqual({ mcp__membral__memory_search: 1, exec_command: 2, apply_patch: 1 });
    expect(s.turns.filter((t) => t.kind === "tool_result")).toHaveLength(4);
    const mcp = s.turns.find((t) => t.toolName === "mcp__membral__memory_search");
    expect(mcp).toMatchObject({ mcpServer: "membral", mcpTool: "memory_search", toolUseId: "call_mcp_01" });
    const patch = s.turns.find((t) => t.toolName === "apply_patch");
    expect(patch).toMatchObject({ filePath: "src/lib/rate-limit.ts", resultType: "update", editHunks: 1 });
    expect(s.filesTouched).toEqual(["src/lib/rate-limit.ts", "src/routes/upload.ts"]);
    const pr = s.turns.find((t) => t.toolUseId === "call_exec_02");
    expect(pr?.action).toMatchObject({ refKind: "merge_request" });
  });

  it("takes the last cumulative token_count total, split into cached and uncached input", () => {
    expect(s.usage).toEqual({
      inputTokens: 6100,
      outputTokens: 1010,
      cacheReadInputTokens: 34000,
      cacheCreationInputTokens: 0,
    });
  });

  it("spans the first to last envelope timestamp", () => {
    expect(s.startedAt < s.endedAt).toBe(true);
  });
});

describe("codexParser.parse — tolerance", () => {
  const ref = { source: "codex", sourceSessionId: "file-id", path: "n/a" };

  it("skips malformed, typeless and unknown lines without throwing", () => {
    const raw = [
      "{not json",
      JSON.stringify({ id: "pre-envelope", instructions: "x" }),
      line("session_meta", { id: "thread-1", cwd: "/Users/dev/codehub-web" }),
      line("mystery_type", { a: 1 }),
      line("response_item", { type: "mystery_item" }),
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }),
      '{"timestamp":"2026-05-14T10:00:01.000Z","type":"response_item","payload":{"type":"mess',
    ].join("\n");
    const s = codexParser.parse(ref, raw);
    expect(s.sourceSessionId).toBe("thread-1");
    expect(s.turns).toHaveLength(1);
    expect(s.usage).toBeUndefined();
    expect(s.model).toBeUndefined();
  });

  it("prefers token_usage_record thread totals and keeps the first session_meta", () => {
    const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, total_tokens: 110 };
    const raw = [
      line("session_meta", { id: "thread-1", parent_thread_id: "thread-0" }),
      line("session_meta", { id: "thread-2" }),
      line("event_msg", { type: "token_count", info: { total_token_usage: { ...usage, input_tokens: 5 } } }),
      line("token_usage_record", { thread_token_usage: usage }),
    ].join("\n");
    const s = codexParser.parse(ref, raw);
    expect(s.sourceSessionId).toBe("thread-1");
    expect(s.parentSessionId).toBe("thread-0");
    expect(s.usage).toEqual({
      inputTokens: 60,
      outputTokens: 10,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 0,
    });
  });

  it("falls back to session_id, then the file's id, and strips credentials from the remote URL", () => {
    const raw = line("session_meta", {
      session_id: "root-1",
      git: { repository_url: "https://bot:secret@github.com/codehub/codehub-web.git" },
    });
    const s = codexParser.parse(ref, raw);
    expect(s.sourceSessionId).toBe("root-1");
    expect(s.repo.remoteUrl).toBe("https://github.com/codehub/codehub-web.git");
    expect(codexParser.parse(ref, "").sourceSessionId).toBe("file-id");
  });

  it("strips credentials by URL parsing, even an un-encoded @ in the password; scp-style remotes are kept", () => {
    expect(stripRemoteCredentials("https://u:p@ss@host/x.git")).toBe("https://host/x.git");
    expect(stripRemoteCredentials("ssh://git@host:2222/org/x.git")).toBe("ssh://host:2222/org/x.git");
    expect(stripRemoteCredentials("https://github.com/codehub/x.git")).toBe("https://github.com/codehub/x.git");
    expect(stripRemoteCredentials("git@github.com:codehub/x.git")).toBe("git@github.com:codehub/x.git");
  });

  it("marks a non-zero exit as an error and reads local_shell_call argv", () => {
    const raw = [
      line("response_item", {
        type: "local_shell_call",
        call_id: "c1",
        status: "completed",
        action: { type: "exec", command: ["bash", "-lc", "git push origin main"], working_directory: "/w" },
      }),
      line("response_item", {
        type: "function_call_output",
        call_id: "c1",
        output: "Process exited with code 1\nOutput:\nrejected\n",
      }),
    ].join("\n");
    const s = codexParser.parse(ref, raw);
    expect(s.turns[0]).toMatchObject({ toolName: "local_shell", kind: "tool_use" });
    expect(s.turns[1].text).toBe("[tool_result elided: error]");
  });
});
