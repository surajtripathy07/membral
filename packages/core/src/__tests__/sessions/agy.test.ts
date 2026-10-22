import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agyParser, agyTranscriptFor } from "../../sessions/agy.js";
import type { SessionRef } from "../../sessions/types.js";

// Structure copied from real Antigravity CLI transcripts; every value here is invented.
const ref: SessionRef = { source: "agy", sourceSessionId: "conv-1", path: "/x/transcript_full.jsonl" };
const line = (o: Record<string, unknown>) => JSON.stringify(o);
const FAKE_TOKEN = "sk-test-0000000000000000";

const session = [
  line({
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-10-10T12:00:00Z",
    content: `Add a retry to the CodeHub client. token ${FAKE_TOKEN}`,
  }),
  line({
    step_index: 1,
    source: "SYSTEM",
    type: "EPHEMERAL_MESSAGE",
    status: "DONE",
    created_at: "2026-10-10T12:00:00Z",
    content: "harness notice",
  }),
  line({
    step_index: 2,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-10-10T12:00:01Z",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 200,
    thinking: `Look around first ${FAKE_TOKEN}`,
    tool_calls: [
      { name: "run_command", args: { CommandLine: "git status", Cwd: "/work/codehub-client", toolSummary: "status" } },
      {
        name: "write_to_file",
        args: {
          TargetFile: "/work/codehub-client/retry.ts",
          CodeContent: `const k = "${FAKE_TOKEN}";\nexport const retry = 1;`,
          Overwrite: false,
        },
      },
    ],
  }),
  line({
    step_index: 3,
    source: "MODEL",
    type: "RUN_COMMAND",
    status: "DONE",
    created_at: "2026-10-10T12:00:02Z",
    content: `On branch main ${FAKE_TOKEN}`,
    exit_code: 0,
  }),
  line({
    step_index: 4,
    source: "MODEL",
    type: "CODE_ACTION",
    status: "ERROR",
    created_at: "2026-10-10T12:00:03Z",
    content: "denied",
  }),
  line({
    step_index: 5,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-10-10T12:00:04Z",
    input_tokens: 10,
    output_tokens: 5,
    content: "Done, retry added.",
  }),
].join("\n");

describe("agyParser", () => {
  it("maps user, thinking, tool_use, tool_result and final prose; skips SYSTEM steps", () => {
    const s = agyParser.parse(ref, session);
    expect(s.source).toBe("agy");
    expect(s.sourceSessionId).toBe("conv-1");
    expect(s.startedAt).toBe("2026-10-10T12:00:00Z");
    expect(s.endedAt).toBe("2026-10-10T12:00:04Z");
    expect(s.turns.map((t) => `${t.role}/${t.kind}`)).toEqual([
      "user/prose",
      "assistant/thinking",
      "assistant/tool_use",
      "assistant/tool_use",
      "user/tool_result",
      "user/tool_result",
      "assistant/prose",
    ]);
    expect(s.turns.every((t, i) => t.idx === i && t.ts !== "")).toBe(true);
    expect(s.usage).toEqual({
      inputTokens: 110,
      outputTokens: 55,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 0,
    });
    expect(s.toolCounts).toEqual({ run_command: 1, write_to_file: 1 });
    expect(s.repo.path).toBe("/work/codehub-client");
    expect(s.filesTouched).toEqual(["/work/codehub-client/retry.ts"]);
  });

  it("pairs results to calls first-in first-out and marks errors", () => {
    const s = agyParser.parse(ref, session);
    const uses = s.turns.filter((t) => t.kind === "tool_use");
    const results = s.turns.filter((t) => t.kind === "tool_result");
    expect(uses.map((t) => t.toolUseId)).toEqual(["2:0", "2:1"]);
    expect(results.map((t) => t.toolName)).toEqual(["run_command", "write_to_file"]);
    expect(results[0].text).toBe("[tool_result elided: ok]");
    expect(results[1].text).toBe("[tool_result elided: error]");
  });

  it("redacts secrets in user text, thinking and written text, and never stores tool output", () => {
    const s = agyParser.parse(ref, session);
    expect(JSON.stringify(s.turns)).not.toContain(FAKE_TOKEN);
    expect(s.turns[3].filePath).toBe("/work/codehub-client/retry.ts");
    expect(s.turns[3].resultType).toBe("create");
    expect(s.turns[3].text).toContain("export const retry");
  });

  it("keeps no written text for a secret-store target", () => {
    const raw = line({
      step_index: 0,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: "2026-10-10T12:00:00Z",
      tool_calls: [{ name: "write_to_file", args: { TargetFile: "/w/.env", CodeContent: "A=1" } }],
    });
    const s = agyParser.parse(ref, raw);
    expect(s.turns[0].text).toBeUndefined();
  });

  it("caps thinking, assistant prose and user prose at the cloud's per-turn limit", () => {
    const big = "word ".repeat(30_000); // 150k chars, fictional
    const raw = [
      line({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-10-10T12:00:00Z",
        content: big,
      }),
      line({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-10-10T12:00:01Z",
        thinking: big,
        content: big,
      }),
    ].join("\n");
    const s = agyParser.parse(ref, raw);
    expect(s.turns).toHaveLength(3);
    for (const turn of s.turns) {
      expect(turn.text.length).toBeLessThanOrEqual(100_000);
      expect(turn.text).toMatch(/…\[\+\d+ chars\]$/);
    }
    expect((s.turns[0].ownerText ?? "").length).toBeLessThanOrEqual(100_000);
  });

  it("caps long written text", () => {
    const raw = line({
      step_index: 0,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: "2026-10-10T12:00:00Z",
      tool_calls: [{ name: "write_to_file", args: { TargetFile: "/w/a.md", CodeContent: "x".repeat(20_000) } }],
    });
    expect(agyParser.parse(ref, raw).turns[0].text?.length).toBeLessThan(8_100);
  });

  it("skips malformed lines and handles empty input", () => {
    const s = agyParser.parse(ref, `not json\n{"half":\n${session}\n[1,2]\n`);
    expect(s.turns).toHaveLength(7);
    const empty = agyParser.parse(ref, "");
    expect(empty.turns).toEqual([]);
    expect(empty.startedAt).toBe("");
  });

  it("gives a step without created_at the previous step's time, never an empty ts", () => {
    const raw = [
      line({ step_index: 0, source: "USER_EXPLICIT", created_at: "2026-10-10T12:00:00Z", content: "hi" }),
      line({ step_index: 1, source: "USER_EXPLICIT", content: "again" }),
    ].join("\n");
    expect(agyParser.parse(ref, raw).turns.map((t) => t.ts)).toEqual(["2026-10-10T12:00:00Z", "2026-10-10T12:00:00Z"]);
  });

  it("strips a Membral context card from ownerText", () => {
    const raw = line({
      step_index: 0,
      source: "USER_EXPLICIT",
      created_at: "2026-10-10T12:00:00Z",
      content: "## About this user\nUser likes tests.\nUser's message:\nActual prompt here.",
    });
    expect(agyParser.parse(ref, raw).turns[0].ownerText).toBe("Actual prompt here.");
  });

  it("is deterministic: same bytes, same hash", () => {
    expect(agyParser.parse(ref, session).contentHash).toBe(agyParser.parse(ref, Buffer.from(session)).contentHash);
  });
});

describe("agyParser.detect", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function conv(id: string, files: string[]): Promise<string> {
    const logs = join(root as string, id, ".system_generated", "logs");
    await mkdir(logs, { recursive: true });
    for (const f of files) await writeFile(join(logs, f), "{}\n");
    return logs;
  }

  it("lists conversations, preferring the uncut transcript, skipping ones with none", async () => {
    root = await mkdtemp(join(tmpdir(), "agy-detect-"));
    await conv("a", ["transcript.jsonl", "transcript_full.jsonl"]);
    await conv("b", ["transcript.jsonl"]);
    await mkdir(join(root, "c"), { recursive: true });
    const refs = (await agyParser.detect(root)).sort((x, y) => x.sourceSessionId.localeCompare(y.sourceSessionId));
    expect(refs.map((r) => [r.sourceSessionId, r.path.split("/").pop()])).toEqual([
      ["a", "transcript_full.jsonl"],
      ["b", "transcript.jsonl"],
    ]);
    expect(await agyTranscriptFor(join(root, "c"))).toBeUndefined();
  });

  it("throws for an unreadable root", async () => {
    await expect(agyParser.detect("/nonexistent/agy-root")).rejects.toThrow();
  });
});
