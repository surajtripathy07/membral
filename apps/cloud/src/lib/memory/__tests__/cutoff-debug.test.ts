// Issue #339: cut-off reply debugging. Shape is always logged (no text); the
// full text only for users named in MEMBRAL_DEBUG_CUTOFF_REPLY_USER_IDS.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { log } from "@/lib/log";
import { chunkCutoffReply, makeCutoffReply, parseCutoffDebugUserIds, recordCutoffReply } from "../cutoff-debug";
import { extractUserTurnPass, extractWindow } from "../extract";
import {
  buildMemoryExtractionLogPayload,
  logMemoryExtraction,
  type MemoryExtractionLogFields,
} from "../extraction-log";
import { renderTurnLines, type TurnRow } from "../render";
import { describeTruncatedReply, salvageArrayElements } from "../truncated-reply";
import { buildWindows } from "../windows";

const ENV = "MEMBRAL_DEBUG_CUTOFF_REPLY_USER_IDS";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const MARKER = "SECRET-MARKER-7f3a";
const QUOTE = "please fix the flaky retry test";
const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

describe("describeTruncatedReply", () => {
  const rec = '{"kind": "decision", "text": "a"}';
  const cases: Array<[string, string]> = [
    ["complete then partial element", `{"records": [${rec}, ${rec}, {"kind": "dec`],
    ["fenced reply", `\`\`\`json\n{"records": [${rec}, {"kind"`],
    ["leading prose", `Here you go: {"records": [${rec}, {"k`],
    ["cut mid-string", `{"records": [${rec}, {"kind": "decision", "text": "unfini`],
    ["cut mid-key", `{"records": [${rec}], "iss`],
    ["cut after comma", `{"records": [${rec},`],
    ["one giant unfinished element", `{"records": [{"kind": "decision", "text": "${"x".repeat(5000)}`],
    ["array closed", `{"records": [${rec}], "issues": []}`],
    ["no records key", `{"issues": [${rec}]`],
    ["empty", ""],
    ["whitespace only", "  \n\t "],
    ["garbage", '}}]]"\\'],
  ];

  it.each(cases)("%s: never throws and complete_elements matches salvageArrayElements", (_n, text) => {
    const shape = describeTruncatedReply(text, "records");
    expect(shape.chars).toBe(text.length);
    expect(shape.completeElements).toBe(salvageArrayElements(text, "records").length);
  });

  it("agrees with salvage for every prefix of a reply", () => {
    const full = `{"records": [${'{"a": "x\\"y]"}'}, ["n", {"b": 1}], "s", 4, {"c": {"d": [1]}}], "issues": []}`;
    for (let i = 0; i <= full.length; i++) {
      const t = full.slice(0, i);
      expect(describeTruncatedReply(t, "records").completeElements).toBe(salvageArrayElements(t, "records").length);
    }
  });

  it("reports structure", () => {
    expect(describeTruncatedReply(`{"records": [${rec}, {"kind": "dec`, "records")).toMatchObject({
      firstCharClass: "brace",
      hasRecordsKey: true,
      completeElements: 1,
      depthAtCut: 3,
      inStringAtCut: true,
      lastElementChars: 13,
    });
    expect(describeTruncatedReply(`\`\`\`json\n{"records": [`, "records")).toMatchObject({
      firstCharClass: "fence",
      hasRecordsKey: false, // salvage only looks inside a reply that starts with "{"
      depthAtCut: 2,
      lastElementChars: 0,
    });
    expect(describeTruncatedReply("", "records")).toMatchObject({ firstCharClass: "empty", chars: 0 });
    expect(describeTruncatedReply(" \n", "records").firstCharClass).toBe("whitespace_only");
    expect(describeTruncatedReply("[1", "records").firstCharClass).toBe("bracket");
    expect(describeTruncatedReply('"x', "records").firstCharClass).toBe("quote");
    expect(describeTruncatedReply("Sure", "records").firstCharClass).toBe("letter");
    expect(describeTruncatedReply("42", "records").firstCharClass).toBe("digit");
    expect(describeTruncatedReply("-", "records").firstCharClass).toBe("other");
    expect(describeTruncatedReply({} as unknown as string, "records").firstCharClass).toBe("empty");
  });
});

describe("parseCutoffDebugUserIds", () => {
  it("is OFF for unset, empty, wildcard and word values", () => {
    expect(parseCutoffDebugUserIds(undefined).size).toBe(0);
    expect(parseCutoffDebugUserIds("").size).toBe(0);
    expect(parseCutoffDebugUserIds("*").size).toBe(0);
    expect(parseCutoffDebugUserIds("all").size).toBe(0);
  });
  it("accepts valid UUIDs, trimming spaces", () => {
    expect([...parseCutoffDebugUserIds(U1)]).toEqual([U1]);
    expect([...parseCutoffDebugUserIds(` ${U1} , ${U2} `)]).toEqual([U1, U2]);
  });
  it("ignores invalid entries next to a valid one", () => {
    expect([...parseCutoffDebugUserIds(`${U1},not-a-uuid,*`)]).toEqual([U1]);
  });
  it("rejects truthy words, quoted, prefixed and nil values; tolerates a trailing comma and uppercase", () => {
    for (const bad of ["true", "1", `"${U1}"`, U1.slice(0, 30), "00000000-0000-0000-0000-000000000000"]) {
      expect(parseCutoffDebugUserIds(bad).size).toBe(0);
    }
    expect([...parseCutoffDebugUserIds(`${U1},`)]).toEqual([U1]);
    expect([...parseCutoffDebugUserIds(U1.toUpperCase())]).toEqual([U1]);
  });
});

describe("chunkCutoffReply", () => {
  it("never splits a surrogate pair at a chunk boundary, and rejoins exactly", () => {
    const text = `${"a".repeat(1499)}\u{1F600}${"b".repeat(10)}`;
    const { chunks } = chunkCutoffReply(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(1499));
    expect(chunks[1].startsWith("\u{1F600}")).toBe(true);
  });

  it("7000 chars gives 5 chunks that rejoin exactly", () => {
    const text = "abcdefg".repeat(1000);
    const { chunks, capped } = chunkCutoffReply(text);
    expect(chunks.map((c) => c.length)).toEqual([1500, 1500, 1500, 1500, 1000]);
    expect(chunks.join("")).toBe(text);
    expect(capped).toBe(false);
  });
});

function turns(): TurnRow[] {
  return [
    { idx: 0, role: "user", kind: "prose", text: QUOTE, tool_name: null, file_path: null, ts: null, props: null },
  ];
}
function oneWindow() {
  return buildWindows(renderTurnLines(turns()))[0];
}
function llmCutOff(content: string) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content }, finish_reason: "length" }],
    usage: { prompt_tokens: 9896, completion_tokens: 2000 },
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return new LlmClient(CONFIG, { client });
}

type Line = Record<string, unknown>;
let lines: Line[];
let all: string;

beforeEach(() => {
  lines = [];
  const grab = (_msg: string, fields?: Record<string, unknown>) => {
    if (fields) lines.push(fields);
  };
  vi.spyOn(log, "info").mockImplementation(grab);
  vi.spyOn(log, "warn").mockImplementation(grab);
  vi.spyOn(log, "error").mockImplementation(grab);
  all = "";
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function runCutoff(reply: string, userId = U1, pass: "main" | "user" = "main") {
  const llm = llmCutOff(reply);
  const out =
    pass === "main"
      ? await extractWindow(llm, "header", [], oneWindow(), "session-1")
      : await extractUserTurnPass(llm, "header", oneWindow(), "session-1");
  recordCutoffReply({ userId, sessionId: "session-1", opts: { attempt: 1 } }, pass, 0, out.cutoffReply);
  all = JSON.stringify(lines);
  return out;
}

const partial = (text: string) => `{"records": [{"kind": "decision", "text": "${text}`;
const debugLines = () => lines.filter((l) => l.event === "cutoff_reply_debug");
const shapeLines = () => lines.filter((l) => l.event === "cutoff_shape");

describe("cut-off reply logging in extraction", () => {
  it("env unset: shape logged, no debug line, marker nowhere", async () => {
    vi.stubEnv(ENV, "");
    const out = await runCutoff(partial(MARKER));
    expect(out.failed).toBe(true);
    expect(debugLines()).toHaveLength(0);
    expect(shapeLines()).toHaveLength(1);
    expect(shapeLines()[0]).toMatchObject({
      first_char_class: "brace",
      has_records_key: true,
      complete_elements: 0,
      in_string_at_cut: true,
      records_recovered: 0,
      window_index: 0,
      pass: "main",
      tokens_out: 2000,
    });
    expect(all).not.toContain(MARKER);
  });

  it("logs shape for a salvaged reply too, and for the user pass", async () => {
    vi.stubEnv(ENV, "");
    const good = JSON.stringify({
      kind: "decision",
      text: "Use backoff",
      quote: QUOTE,
      turn_idx: 0,
      turn_role: "user",
      durable: true,
    });
    await runCutoff(`{"records": [${good}, {"kind": "dec ${MARKER}`);
    expect(shapeLines()[0]).toMatchObject({ complete_elements: 1, records_recovered: 1 });
    lines = [];
    await runCutoff(partial(MARKER), U1, "user");
    expect(shapeLines()[0]).toMatchObject({ pass: "user" });
    expect(all).not.toContain(MARKER);
  });

  it("user in list: chunks rejoin to the raw reply, marker only in debug lines", async () => {
    vi.stubEnv(ENV, `${U2}, ${U1}`);
    const reply = partial(MARKER) + "y".repeat(6000);
    await runCutoff(reply);
    const dbg = debugLines();
    expect(dbg).toHaveLength(5);
    expect(dbg.map((l) => l.chunk_index)).toEqual([0, 1, 2, 3, 4]);
    expect(dbg.every((l) => l.chunk_chars === String(l.debug_text).length && l.user_id === U1)).toBe(true);
    expect(
      dbg.every(
        (l) => l.chunk_total === 5 && l.session_id === "session-1" && l.window_index === 0 && l.pass === "main",
      ),
    ).toBe(true);
    expect(dbg.map((l) => l.debug_text).join("")).toBe(reply);
    expect(dbg.every((l) => l.capped === false)).toBe(true);
    const others = lines.filter((l) => l.event !== "cutoff_reply_debug");
    expect(JSON.stringify(others)).not.toContain(MARKER);
  });

  it("user not in list: no debug line", async () => {
    vi.stubEnv(ENV, U2);
    await runCutoff(partial(MARKER));
    expect(debugLines()).toHaveLength(0);
    expect(shapeLines()).toHaveLength(1);
    expect(all).not.toContain(MARKER);
  });

  it("a wildcard value logs no debug lines", async () => {
    vi.stubEnv(ENV, "*");
    await runCutoff(partial(MARKER));
    expect(debugLines()).toHaveLength(0);
  });

  it("a 7000 character reply gives 5 chunks", async () => {
    vi.stubEnv(ENV, U1);
    await runCutoff(`{"records": [${"z".repeat(7000 - 13)}`);
    expect(debugLines()).toHaveLength(5);
  });

  it("a 50,000 character reply is capped at 40,000 with capped=true on every chunk", async () => {
    vi.stubEnv(ENV, U1);
    const reply = `{"records": [${"z".repeat(50_000)}`;
    await runCutoff(reply);
    const dbg = debugLines();
    expect(dbg.map((l) => l.debug_text).join("")).toBe(reply.slice(0, 40_000));
    expect(dbg).toHaveLength(27);
    expect(dbg.every((l) => l.capped === true)).toBe(true);
    expect(shapeLines()[0]).toMatchObject({ chars: reply.length });
  });
});

describe("window result never carries reply text", () => {
  it("rawText is non-enumerable, survives to recordCutoffReply, and is absent from JSON", async () => {
    vi.stubEnv(ENV, U1);
    const out = await extractWindow(llmCutOff(partial(MARKER)), "header", [], oneWindow(), "session-1");
    expect(out.cutoffReply).toBeDefined();
    expect(Object.keys(out.cutoffReply as object)).not.toContain("rawText");
    expect(JSON.stringify(out)).not.toContain(MARKER);
    expect(JSON.stringify({ ...out, cutoffReply: { ...out.cutoffReply } })).not.toContain(MARKER);
    recordCutoffReply({ userId: U1, sessionId: "session-1", opts: {} }, "main", 0, out.cutoffReply);
    expect(
      debugLines()
        .map((l) => l.debug_text)
        .join(""),
    ).toBe(partial(MARKER));
  });

  it("a user not in the list logs no debug line from the emitter path", () => {
    vi.stubEnv(ENV, U2);
    recordCutoffReply(
      { userId: U1, sessionId: "s", opts: {} },
      "main",
      0,
      makeCutoffReply({ rawText: MARKER, tokensOut: 1 }, 0),
    );
    expect(debugLines()).toHaveLength(0);
    expect(JSON.stringify(lines)).not.toContain(MARKER);
  });
});

describe("a retry-on-empty call that is itself cut off", () => {
  it("logs cutoff_shape (and the text for an opted-in user) without changing the outcome", async () => {
    vi.stubEnv(ENV, U1);
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"records": []}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: partial(MARKER) }, finish_reason: "length" }],
        usage: { prompt_tokens: 100, completion_tokens: 2000 },
      });
    const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
    const out = await extractWindow(new LlmClient(CONFIG, { client }), "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.failed).toBe(false);
    expect(out.retryFailed).toBe(1);
    recordCutoffReply({ userId: U1, sessionId: "session-1", opts: {} }, "main", 0, out.cutoffReply);
    expect(shapeLines()).toHaveLength(1);
    expect(
      debugLines()
        .map((l) => l.debug_text)
        .join(""),
    ).toBe(partial(MARKER));
  });
});

describe("debug_text is restricted to cutoff_reply_debug", () => {
  it("is dropped from every other event", () => {
    for (const event of [
      "queued",
      "run",
      "skip",
      "fail",
      "done",
      "kick",
      "invocation",
      "salvage",
      "cutoff_shape",
    ] as const) {
      const fields = {
        event,
        userId: U1,
        debug_text: MARKER,
        debugText: MARKER,
      } as unknown as MemoryExtractionLogFields;
      const payload = buildMemoryExtractionLogPayload(fields);
      expect(JSON.stringify(payload)).not.toContain(MARKER);
      expect(payload).not.toHaveProperty("debug_text");
    }
    // Even claiming the debug event name through the general helper.
    const spoof = {
      event: "cutoff_reply_debug",
      userId: U1,
      debug_text: MARKER,
    } as unknown as MemoryExtractionLogFields;
    expect(JSON.stringify(buildMemoryExtractionLogPayload(spoof))).not.toContain(MARKER);
    logMemoryExtraction(spoof);
    expect(JSON.stringify(lines)).not.toContain(MARKER);
  });
});
