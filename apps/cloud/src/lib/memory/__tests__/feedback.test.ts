// v24 / migration 125: feedback about Membral and served-record verdicts (feedback.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { extractWindow, PROMPT_VERSION } from "../extract";
import {
  applyServedVerdicts,
  FEEDBACK_RULE,
  groundFeedbackItems,
  judgeServedRecords,
  parseFeedbackItems,
  type ServedRecord,
} from "../feedback";
import type { TurnRow } from "../render";
import { ExtractionWire, MEMORY_KINDS, parseMemoryRecord } from "../schema";
import type { MemoryWindow } from "../windows";

function turn(idx: number, role: "user" | "assistant", text: string): TurnRow {
  return { idx, role, kind: "prose", text, tool_name: null, file_path: null, ts: null, props: null } as TurnRow;
}

const TURNS: TurnRow[] = [
  turn(0, "user", "where are we on the CodeHub rate limiter?"),
  turn(1, "assistant", "That recall was stale, the PR merged yesterday so the limiter is already on main."),
  turn(2, "user", "ok. also the memory hook was really slow before my prompt went through"),
];

const SERVED: ServedRecord[] = [
  {
    memoryId: "m1",
    recallEventId: "e1",
    surface: "preamble",
    kind: "outcome",
    text: "Opened PR #41 for the CodeHub rate limiter.",
    quote: "opened PR #41 for the rate limiter",
  },
  {
    memoryId: "m2",
    recallEventId: "e1",
    surface: "preamble",
    kind: "decision",
    text: "Retries use jitter.",
    quote: null,
  },
];

describe("prompt v24: feedback kind", () => {
  it("bumps the version and states the rule with both fictional examples", () => {
    expect(PROMPT_VERSION).toBe("memory-extract-v26");
    for (const s of ["wrong", "stale", "missing", "noise", "slow", "useful", "prompt_hook", "preamble"]) {
      expect(FEEDBACK_RULE).toContain(`"${s}"`);
    }
    expect(FEEDBACK_RULE).toContain("never a record of any kind");
    expect(FEEDBACK_RULE).toContain("Code work on Membral's own source");
  });

  it("feedback is never a memory kind: the schema rejects it, so no session_memories row can be one", () => {
    expect(MEMORY_KINDS as readonly string[]).not.toContain("feedback");
    const r = parseMemoryRecord({
      kind: "feedback",
      text: "That recall was stale.",
      quote: "That recall was stale",
      turn_idx: 1,
      turn_role: "assistant",
    });
    expect(r.success).toBe(false);
    expect(ExtractionWire.safeParse({ records: [], feedback: [{ any: 1 }] }).success).toBe(true);
  });

  it("parseFeedbackItems drops a malformed element alone and never throws", () => {
    expect(parseFeedbackItems(undefined)).toEqual([]);
    expect(parseFeedbackItems("x")).toEqual([]);
    const items = parseFeedbackItems([
      {
        sentiment: "stale",
        surface: "preamble",
        text: "A served PR line was out of date.",
        quote: "That recall was stale",
        turn_idx: 1,
      },
      { sentiment: "angry", text: "bad sentiment value here", quote: "bad sentiment quote", turn_idx: 1 },
      {
        sentiment: "slow",
        surface: "bogus",
        text: "The hook delayed the prompt.",
        quote: "memory hook was really slow",
        turn_idx: 2,
      },
    ]);
    expect(items.map((i) => i.sentiment)).toEqual(["stale", "slow"]);
    expect(items[1].surface).toBeNull();
  });

  it("grounds only verbatim quotes; turn and role come from the transcript, not the model", () => {
    const grounded = groundFeedbackItems(
      parseFeedbackItems([
        {
          sentiment: "stale",
          surface: "mcp",
          text: "A served PR line was out of date.",
          quote: "That recall was stale, the PR merged yesterday",
          turn_idx: 0,
          turn_role: "user",
        },
        {
          sentiment: "slow",
          surface: "prompt_hook",
          text: "The hook delayed the prompt.",
          quote: "the memory hook was really slow",
          turn_idx: 2,
        },
        {
          sentiment: "slow",
          surface: "prompt_hook",
          text: "The hook delayed the prompt.",
          quote: "the memory hook was really slow",
          turn_idx: 2,
        },
        {
          sentiment: "wrong",
          text: "Invented quote is never kept.",
          quote: "this line is nowhere in the session",
          turn_idx: 1,
        },
      ]),
      TURNS,
    );
    expect(grounded.map((g) => [g.sentiment, g.turn_idx, g.turn_role])).toEqual([
      ["stale", 1, "assistant"],
      ["slow", 2, "user"],
    ]);
  });

  it("extractWindow routes feedback (and a feedback element misfiled under records) out of records", async () => {
    const reply = {
      records: [
        {
          kind: "feedback",
          sentiment: "slow",
          text: "The hook delayed the prompt.",
          quote: "the memory hook was really slow",
          turn_idx: 2,
          turn_role: "user",
        },
      ],
      issues: [],
      feedback: [
        {
          sentiment: "stale",
          surface: "preamble",
          text: "A served PR line was out of date.",
          quote: "That recall was stale",
          turn_idx: 1,
        },
      ],
    };
    const llm = {
      callJson: vi.fn(async () => ({ data: reply, record: { cost_usd: 0 } })),
      overBudget: () => false,
    } as unknown as LlmClient;
    const window = { windowIndex: 0, turns: TURNS.map((t) => ({ ...t, line: `#${t.idx} ${t.role}: ${t.text}` })) };
    const r = await extractWindow(llm, "header", [], window as unknown as MemoryWindow, "s1");
    expect(r.failed).toBe(false);
    expect(r.result.records).toEqual([]);
    expect(r.result.feedback.map((f) => f.sentiment).sort()).toEqual(["slow", "stale"]);
    // A feedback-only window is not an empty reply: no retry-on-empty.
    expect(r.retriedEmpty).toBe(0);
  });
});

describe("served-record verdicts (D-021: no verdict without a receipt)", () => {
  it("keeps a contradicted verdict whose quote is verbatim; turn from the transcript", () => {
    const { verdicts, droppedNoReceipt } = applyServedVerdicts(
      SERVED,
      {
        verdicts: [
          {
            index: 0,
            verdict: "contradicted",
            evidence_quote: "the PR merged yesterday so the limiter is already on main",
          },
          { index: 1, verdict: "unused", evidence_quote: null },
        ],
      },
      TURNS,
    );
    expect(droppedNoReceipt).toBe(0);
    expect(verdicts).toEqual([
      {
        memoryId: "m1",
        recallEventId: "e1",
        surface: "preamble",
        verdict: "contradicted",
        quote: "the PR merged yesterday so the limiter is already on main",
        turn_idx: 1,
      },
      { memoryId: "m2", recallEventId: "e1", surface: "preamble", verdict: "unused", quote: null, turn_idx: null },
    ]);
  });

  it("drops to unused: no quote, an invented quote, an echo of the record, a missing index; bad elements alone", () => {
    const served = [...SERVED, { ...SERVED[1], memoryId: "m3" }, { ...SERVED[1], memoryId: "m4" }];
    const { verdicts, droppedNoReceipt } = applyServedVerdicts(
      served,
      {
        verdicts: [
          { index: 0, verdict: "confirmed", evidence_quote: "opened PR #41 for the rate limiter" },
          { index: 1, verdict: "contradicted", evidence_quote: null },
          { index: 2, verdict: "confirmed", evidence_quote: "a line nobody ever wrote in the session" },
          { index: 99, verdict: "confirmed", evidence_quote: "x" },
          "garbage",
        ],
      },
      TURNS,
    );
    expect(verdicts.map((v) => v.verdict)).toEqual(["unused", "unused", "unused", "unused"]);
    expect(droppedNoReceipt).toBe(3);
    expect(applyServedVerdicts(SERVED, "not json", TURNS).verdicts.every((v) => v.verdict === "unused")).toBe(true);
  });

  it("judgeServedRecords: no call when nothing was served; a failed call writes nothing and never throws", async () => {
    const callJson = vi.fn(async () => {
      throw new Error("boom");
    });
    const llm = { callJson } as unknown as LlmClient;
    expect((await judgeServedRecords(llm, [], ["#1 x"], TURNS, "s")).verdicts).toEqual([]);
    expect(callJson).not.toHaveBeenCalled();
    const failed = await judgeServedRecords(llm, SERVED, ["#1 x"], TURNS, "s");
    expect(failed).toMatchObject({ verdicts: [], failed: true });
  });
});

describe("no serving path reads the feedback tables (migration 125)", () => {
  const root = join(__dirname, "../../../..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("no source file that reads session_memories (or a memory_* RPC) touches the feedback tables", () => {
    // Enumerated from the code, not a fixed list: every non-test source file under src/ that reads
    // session_memories or calls a memory_* RPC is a serving/reading path.
    const files = readdirSync(join(root, "src"), { recursive: true })
      .map(String)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__") && !f.includes("__golden__") && !f.endsWith(".d.ts"))
      .map((f) => `src/${f}`);
    const readers = files.filter((f) => /from\(\s*["']session_memories["']\s*\)|\.rpc\(\s*["']memory_/.test(read(f)));
    // sanity: the enumeration finds the real serving paths
    for (const must of [
      "src/lib/memory/search.ts",
      "src/lib/memory/recall.ts",
      "src/lib/memory/prompt-recall.ts",
      "src/lib/memory/preamble.ts",
    ]) {
      expect(readers, must).toContain(must);
    }
    // Writers that insert session_memories next to the feedback rows are not serving paths.
    const WRITERS = new Set([
      "src/lib/memory/tail-capture.ts",
      "src/lib/memory/write/io.ts",
      "src/lib/memory/write/feedback.ts",
    ]);
    for (const f of readers) {
      if (WRITERS.has(f)) continue;
      expect(read(f), f).not.toMatch(/session_feedback|served_record_verdicts/);
    }
    // MCP tools and the browser memories list go through those readers; assert the MCP layer directly too.
    for (const f of files.filter((x) => x.startsWith("src/lib/mcp/"))) {
      expect(read(f), f).not.toMatch(/session_feedback|served_record_verdicts/);
    }
    const migrations = readdirSync(join(root, "supabase/migrations")).filter((f) => f < "125" && f.endsWith(".sql"));
    for (const f of migrations) expect(read(`supabase/migrations/${f}`), f).not.toMatch(/session_feedback/);
  });

  it("session_memories still rejects kind 'feedback' (084's check is unchanged); 125 holds the receipt rule", () => {
    const m084 = read("supabase/migrations/084_memory_v1.sql");
    expect(m084).toContain("kind in ('outcome','decision','learning','blocker','preference')");
    const m125 = read("supabase/migrations/125_session_feedback_and_served_verdicts.sql");
    expect(m125).toContain("check (verdict = 'unused' or (quote is not null and turn_idx is not null))");
    expect(m125).toContain("enable row level security");
    expect(m125).not.toMatch(/alter table public\.session_memories/);
  });
});
