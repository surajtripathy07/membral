import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { log } from "@/lib/log";
import { extractUserTurnPass, extractWindow } from "../extract";
import { renderTurnLines, type TurnRow } from "../render";
import { buildWindows } from "../windows";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

const MARKER = "PARTIAL-MARKER-a91c";
const QUOTE = "please fix the flaky retry test";

function llmCutOff(content: string) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content }, finish_reason: "length" }],
    usage: { prompt_tokens: 9896, completion_tokens: 2000 },
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return { llm: new LlmClient(CONFIG, { client }), create };
}

function oneWindow() {
  const turns: TurnRow[] = [
    { idx: 0, role: "user", kind: "prose", text: QUOTE, tool_name: null, file_path: null, ts: null, props: null },
  ];
  return buildWindows(renderTurnLines(turns))[0];
}

function decision(text: string) {
  return { kind: "decision", text, quote: QUOTE, turn_idx: 0, turn_role: "user", durable: true };
}

function allLogCalls(spies: Array<ReturnType<typeof vi.spyOn>>): string {
  return JSON.stringify(spies.flatMap((s) => s.mock.calls));
}

afterEach(() => vi.restoreAllMocks());

describe("extractWindow: a reply cut off at the output limit (issue #339)", () => {
  it("3 complete records and a partial fourth: 3 validated records, window not failed, truncated flag set", async () => {
    const spies = [
      vi.spyOn(log, "info").mockImplementation(() => {}),
      vi.spyOn(log, "warn").mockImplementation(() => {}),
      vi.spyOn(log, "error").mockImplementation(() => {}),
    ];
    const complete = [
      decision("Use exponential backoff"),
      decision("Pin the retry seed"),
      decision("Cap retries at three"),
    ];
    const cut = `{"records": [${complete.map((r) => JSON.stringify(r)).join(", ")}, {"kind": "decision", "text": "${MARKER} and more`;
    const { llm, create } = llmCutOff(cut);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.failed).toBe(false);
    expect(out.failure).toBeUndefined();
    expect(out.result.records.map((r) => r.text)).toEqual(complete.map((r) => r.text));
    expect(out.truncated).toEqual({ recordsRecovered: 3, tokensOut: 2000 });
    expect(out.retriedEmpty).toBe(0);
    expect(out.costUsd).toBeGreaterThan(0);
    expect(allLogCalls(spies)).not.toContain(MARKER);
  });

  it("recovered records that fail the Zod schema are dropped, the rest kept", async () => {
    const bad = { kind: "outcome", text: "Filed an issue", turn_idx: 0, turn_role: "user", durable: false }; // no ref
    const narrated = {
      kind: "preference",
      statement: "The user prefers tabs",
      owner_quote: QUOTE,
      turn_idx: 0,
      turn_role: "user",
    };
    const cut = `{"records": [${JSON.stringify(bad)}, ${JSON.stringify(decision("Use exponential backoff"))}, ${JSON.stringify(narrated)}, {"kind": "dec`;
    const { llm } = llmCutOff(cut);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(out.failed).toBe(false);
    expect(out.result.records.map((r) => r.text)).toEqual(["Use exponential backoff"]);
    expect(out.truncated).toEqual({ recordsRecovered: 1, tokensOut: 2000 });
    expect(out.droppedNarration).toBe(1);
  });

  it("nothing recoverable: the window fails, classed OutputTruncated", async () => {
    const { llm, create } = llmCutOff(`{"records": [{"kind": "decision", "text": "${MARKER}`);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.failed).toBe(true);
    expect(out.truncated).toBeUndefined();
    expect(out.failure).toMatchObject({ errorClass: "OutputTruncated", message: "output_truncated", isTimeout: false });
    expect(JSON.stringify(out.failure)).not.toContain(MARKER);
  });

  it("salvaged records that ALL fail the checks: the window fails, classed OutputTruncated", async () => {
    const bad = { kind: "outcome", text: "Filed an issue", turn_idx: 0, turn_role: "user", durable: false };
    const { llm } = llmCutOff(`{"records": [${JSON.stringify(bad)}, {"kind`);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(out.failed).toBe(true);
    expect(out.failure?.errorClass).toBe("OutputTruncated");
  });

  it("the user-turn pass salvages the same way", async () => {
    const pref = {
      kind: "preference",
      statement: "Fix flaky tests first",
      owner_quote: QUOTE,
      turn_idx: 0,
      turn_role: "user",
    };
    const { llm, create } = llmCutOff(`{"records": [${JSON.stringify(pref)}, {"kind": "blocker", "text": "${MARKER}`);
    const out = await extractUserTurnPass(llm, "header", oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.failed).toBe(false);
    expect(out.records).toHaveLength(1);
    expect(out.truncated).toEqual({ recordsRecovered: 1, tokensOut: 2000 });
  });
});

describe("extractWindow: empty closed records + cut-off issues (issue #339, production shape)", () => {
  function issue(n: number) {
    return {
      ref: `codehub-org/app!${n}`,
      kind: "merge_request",
      role: "referenced",
      evidence_quote: QUOTE,
      mentions: [],
    };
  }

  it("records [] closed, issues cut mid-entry: salvaged with the complete issues, zero records, not failed", async () => {
    const complete = [issue(1), issue(2), issue(3)];
    const cut = `{"records": [], "issues": [${complete.map((i) => JSON.stringify(i)).join(", ")}, {"ref": "codehub-org/app!4", "kind": "merge_request", "worked_span`;
    const { llm, create } = llmCutOff(cut);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.failed).toBe(false);
    expect(out.failure).toBeUndefined();
    expect(out.result.records).toEqual([]);
    expect(out.result.issues.map((i) => i.ref)).toEqual(complete.map((i) => i.ref));
    expect(out.truncated).toEqual({ recordsRecovered: 0, tokensOut: 2000 });
  });

  it("records not closed and no complete record: still fails, even with complete issues before the cut", async () => {
    const { llm } = llmCutOff(
      `{"issues": [${JSON.stringify(issue(1))}], "records": [{"kind": "decision", "text": "${MARKER}`,
    );
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(out.failed).toBe(true);
    expect(out.failure?.errorClass).toBe("OutputTruncated");
  });

  it("no records key at all: still fails", async () => {
    const { llm } = llmCutOff(`{"issues": [${JSON.stringify(issue(1))}, {"ref": "x`);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(out.failed).toBe(true);
    expect(out.failure?.errorClass).toBe("OutputTruncated");
  });
});

describe("extractWindow: the captured production reply (fixture)", () => {
  // Same structure as the real reply: `{"records": [], "issues": [` + 29 complete
  // entries + a 30th cut inside the key "worked_span. Dummy values.
  const raw = readFileSync(join(__dirname, "fixtures", "cutoff-reply-empty-records.txt"), "utf8");

  it("is salvaged: zero records, not failed, issues carried (29 salvaged, 20 kept by parseSessionIssues)", async () => {
    const { llm, create } = llmCutOff(raw);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.failed).toBe(false);
    expect(out.failure).toBeUndefined();
    expect(out.result.records).toEqual([]);
    // 29 complete entries are salvaged (see truncated-reply.test.ts); extractWindow
    // returns them after parseSessionIssues, which keeps the first 20 (schema.ts cap).
    expect(out.result.issues).toHaveLength(20);
    expect(out.result.issues[0].ref).toBe("codehub-org/project-a!1001");
    expect(out.truncated).toEqual({ recordsRecovered: 0, tokensOut: 2000 });
  });
});
