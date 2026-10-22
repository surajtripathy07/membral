import { FakeSupabase } from "@membral/test-kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "../../llm/client";
import type { ModelConfig } from "../../llm/config";
import { composeSessionTitle } from "../session-titles";
import {
  backfillShortTitles,
  decayPaceMs,
  nextPaceMs,
  renderTitlePrompt,
  TitleLlmSchema,
  validateShortTitle,
} from "../short-title";
import { SummaryLlmSchema, summarizeCodeSessions } from "../summarize";
import { sessionDisplayTitle } from "../view";

const USER_ID = "user-1";
const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test-key",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function makeLlm(contents: Array<string | Error>, capUsd?: number) {
  let i = 0;
  const chatCreate = vi.fn().mockImplementation(() => {
    const c = contents[Math.min(i++, contents.length - 1)];
    if (c instanceof Error) return Promise.reject(c);
    return Promise.resolve({
      choices: [{ message: { content: c } }],
      usage: { prompt_tokens: 300, completion_tokens: 12 },
    });
  });
  const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: vi.fn() } };
  return { llm: new LlmClient(CONFIG, { client, capUsd }), chatCreate };
}

describe("validateShortTitle", () => {
  it("accepts 3-8 word titles and strips quotes and a trailing period", () => {
    expect(validateShortTitle("Review and merge checkout MR")).toBe("Review and merge checkout MR");
    expect(validateShortTitle('"Attribution v4: cost from PR evidence."')).toBe(
      "Attribution v4: cost from PR evidence",
    );
    expect(validateShortTitle("  Fix   login redirect loop ")).toBe("Fix login redirect loop");
    // A standalone dash is not a word: 8 words, not 9.
    expect(validateShortTitle("Record D3 gate result — FAIL on prompt v5")).toBe(
      "Record D3 gate result — FAIL on prompt v5",
    );
  });

  it("rejects narration, placeholders, bad lengths, multi-line, and non-strings", () => {
    expect(validateShortTitle("The user requested a login fix")).toBeNull();
    expect(validateShortTitle("User asked for login fix")).toBeNull();
    expect(validateShortTitle("This session fixed the login")).toBeNull();
    expect(validateShortTitle("A short session with no recorded prose")).toBeNull();
    expect(validateShortTitle("Fix login")).toBeNull(); // 2 words
    expect(validateShortTitle("one two three four five six seven eight nine")).toBeNull(); // 9 words
    expect(validateShortTitle(`Refactor ${"x".repeat(70)} module`)).toBeNull(); // > 70 chars
    expect(validateShortTitle("Fix login redirect\nand more")).toBeNull();
    expect(validateShortTitle("")).toBeNull();
    expect(validateShortTitle(undefined)).toBeNull();
    expect(validateShortTitle(42)).toBeNull();
  });
});

describe("LLM schemas", () => {
  it("title falls back to empty string on a missing or non-string field, never throws", () => {
    expect(TitleLlmSchema.parse({})).toEqual({ title: "" });
    expect(TitleLlmSchema.parse({ title: 5 })).toEqual({ title: "" });
    expect(SummaryLlmSchema.parse({ summary: "Did a thing." })).toEqual({ summary: "Did a thing.", title: "" });
    expect(SummaryLlmSchema.parse({ summary: null, title: ["x"] })).toEqual({ summary: "", title: "" });
  });
});

describe("summarizeCodeSessions writes short_title", () => {
  function seed(db: FakeSupabase) {
    db.seed("code_sessions", [
      { id: "s-1", user_id: USER_ID, summary: null, title: null, files_touched: [], started_at: "2026-07-01" },
    ]);
    db.seed(
      "code_session_turns",
      ["Fix the login bug", "Add a test", "Update the docs"].map((text, idx) => ({
        id: `t${idx}`,
        session_id: "s-1",
        idx,
        role: "user",
        kind: "prose",
        text,
      })),
    );
  }

  it("stores a valid title next to the summary", async () => {
    const db = new FakeSupabase();
    seed(db);
    const { llm } = makeLlm([JSON.stringify({ summary: "Fixed login.", title: "Fix login redirect bug." })]);
    await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID });
    const row = db.getRows("code_sessions")[0];
    expect(row.summary).toBe("Fixed login.");
    expect(row.short_title).toBe("Fix login redirect bug");
  });

  it("drops a narrated title (summary still written, short_title untouched)", async () => {
    const db = new FakeSupabase();
    seed(db);
    const { llm } = makeLlm([JSON.stringify({ summary: "Fixed login.", title: "The user wanted a login fix" })]);
    await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID });
    const row = db.getRows("code_sessions")[0];
    expect(row.summary).toBe("Fixed login.");
    expect(row.short_title).toBeUndefined();
  });
});

// ---- backfill ----------------------------------------------------------------

interface Call {
  table: string;
  ops: Array<[string, unknown[]]>;
}

/** Chainable PostgREST stand-in that records every call and answers reads from `respond`. */
function recordingSupabase(respond: (table: string, ops: Call["ops"]) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const rpcCalls: unknown[] = [];
  const from = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    const proxy: unknown = new Proxy(builder, {
      get(_t, prop: string) {
        if (prop === "then") {
          const result = respond(table, call.ops);
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
        }
        return (...args: unknown[]) => {
          call.ops.push([prop, args]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  const client = { from, rpc: (...a: unknown[]) => rpcCalls.push(a) } as unknown as SupabaseClient;
  const writes = () =>
    calls.filter((c) => c.ops.some(([m]) => m === "update" || m === "insert" || m === "upsert" || m === "delete"));
  return { client, calls, rpcCalls, writes };
}

const SESSIONS = [
  { id: "a", started_at: "2026-09-26T10:00:00Z", summary: "Reviewed and merged the checkout MR.", title: null },
  { id: "b", started_at: "2026-09-26T11:00:00Z", summary: "A short session with no recorded prose.", title: null },
];

function respond(table: string, ops: Call["ops"]) {
  if (table === "code_sessions") return { data: SESSIONS, error: null };
  if (table === "code_session_issues")
    return { data: [{ session_id: "a", ref: "acme/shop!4", kind: "merge_request", role: "worked_on" }], error: null };
  if (table === "code_session_turns") {
    const isFirstPrompt = ops.some(([m, a]) => m === "eq" && a[0] === "role");
    if (isFirstPrompt)
      return { data: [{ id: "t1", session_id: "a", idx: 0, text: "review the checkout MR" }], error: null };
    return {
      data: [
        {
          session_id: "a",
          idx: 3,
          props: { action: { verb: "merged", ref: "acme/shop!4", refKind: "merge_request", source: "cli" } },
        },
        {
          session_id: "a",
          idx: 2,
          props: { action: { verb: "committed", subject: "fix: checkout total rounding", source: "cli" } },
        },
      ],
      error: null,
    };
  }
  return { data: [], error: null };
}

describe("backfillShortTitles", () => {
  it("dry run makes no writes of any kind and reports titles", async () => {
    const sb = recordingSupabase(respond);
    const { llm, chatCreate } = makeLlm([JSON.stringify({ title: "Review and merge checkout MR" })]);
    const out = await backfillShortTitles({ supabase: sb.client, llm, userId: USER_ID, limit: 10, dryRun: true });
    expect(sb.writes()).toEqual([]);
    expect(sb.rpcCalls).toEqual([]);
    expect(out.written).toBe(0);
    expect(out.titled).toBe(1);
    // "b" has only a placeholder summary and no other facts: skipped, no call spent.
    expect(out.skipped).toBe(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    const prompt = chatCreate.mock.calls[0][0].messages.map((m: { content: string }) => m.content).join("\n");
    expect(prompt).toContain("merged acme/shop!4");
    expect(prompt).toContain("fix: checkout total rounding");
    expect(prompt).toContain("worked_on merge_request acme/shop!4");
  });

  it("real run writes only validated titles, guarded by short_title IS NULL", async () => {
    const sb = recordingSupabase(respond);
    const { llm } = makeLlm([JSON.stringify({ title: "Review and merge checkout MR" })]);
    const out = await backfillShortTitles({ supabase: sb.client, llm, userId: USER_ID, limit: 10, dryRun: false });
    const writes = sb.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0].ops).toContainEqual(["update", [{ short_title: "Review and merge checkout MR" }]]);
    expect(writes[0].ops).toContainEqual(["is", ["short_title", null]]);
    expect(out.written).toBe(1);
  });

  it("a rejected title writes nothing", async () => {
    const sb = recordingSupabase(respond);
    const { llm } = makeLlm([JSON.stringify({ title: "The user merged an MR" })]);
    const out = await backfillShortTitles({ supabase: sb.client, llm, userId: USER_ID, limit: 10, dryRun: false });
    expect(sb.writes()).toEqual([]);
    expect(out.rejected).toBe(1);
    expect(out.results[0].rejected).toBe("The user merged an MR");
  });

  it("a 429 is re-queued after a grown pace, never retried immediately", async () => {
    const sb = recordingSupabase(respond);
    const rateLimited = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    const { llm, chatCreate } = makeLlm([rateLimited, JSON.stringify({ title: "Review and merge checkout MR" })]);
    const sleeps: number[] = [];
    const out = await backfillShortTitles({
      supabase: sb.client,
      llm,
      userId: USER_ID,
      limit: 10,
      dryRun: true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(out.titled).toBe(1);
  });

  it("an out-of-credits 429 stops the run instead of re-queueing", async () => {
    const sb = recordingSupabase(respond);
    const noCredits = Object.assign(new Error("429 You have no credits remaining."), {
      status: 429,
      code: "insufficient_quota",
    });
    const { llm, chatCreate } = makeLlm([noCredits]);
    await expect(
      backfillShortTitles({
        supabase: sb.client,
        llm,
        userId: USER_ID,
        limit: 10,
        dryRun: true,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/no credits/);
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });

  it("stops on the cost cap", async () => {
    const sb = recordingSupabase(respond);
    const { llm, chatCreate } = makeLlm([JSON.stringify({ title: "Review and merge checkout MR" })], 0);
    const out = await backfillShortTitles({ supabase: sb.client, llm, userId: USER_ID, limit: 10, dryRun: true });
    expect(chatCreate).not.toHaveBeenCalled();
    expect(out.capped).toBe(true);
  });

  it("dry run tolerates a database without migration 110", async () => {
    let first = true;
    const sb = recordingSupabase((table, ops) => {
      if (table === "code_sessions" && first && ops.some(([m, a]) => m === "is" && a[0] === "short_title")) {
        first = false;
        return { data: null, error: { code: "42703", message: "column code_sessions.short_title does not exist" } };
      }
      return respond(table, ops);
    });
    const { llm } = makeLlm([JSON.stringify({ title: "Review and merge checkout MR" })]);
    const out = await backfillShortTitles({ supabase: sb.client, llm, userId: USER_ID, limit: 10, dryRun: true });
    expect(out.columnMissing).toBe(true);
    expect(out.titled).toBe(1);
    await expect(
      backfillShortTitles({
        supabase: recordingSupabase((t, o) =>
          t === "code_sessions" && o.some(([m, a]) => m === "is" && a[0] === "short_title")
            ? { data: null, error: { code: "42703", message: "column code_sessions.short_title does not exist" } }
            : respond(t, o),
        ).client,
        llm,
        userId: USER_ID,
        limit: 10,
        dryRun: false,
      }),
    ).rejects.toThrow(/migration 110/);
  });
});

describe("pace", () => {
  it("grows proportionally and decays 0.9x toward the floor, never reset", () => {
    expect(nextPaceMs(0)).toBe(1000);
    expect(nextPaceMs(1000)).toBe(3000);
    expect(nextPaceMs(9000)).toBe(13500);
    expect(decayPaceMs(3000, 0)).toBe(2700);
    expect(decayPaceMs(100, 500)).toBe(500);
  });

  it("renders only the facts present; a placeholder summary is never sent", () => {
    const p = renderTitlePrompt({
      sessionId: "x",
      startedAt: null,
      summary: "A short session with no recorded prose. Touched 1 file: a.ts.",
      firstUserMessage: "y".repeat(400),
      actions: [],
      commitSubjects: [],
      issueRefs: [],
    });
    expect(p).not.toContain("SUMMARY");
    expect(p).toContain(`FIRST USER PROMPT: ${"y".repeat(300)}…`);
  });
});

describe("display order", () => {
  it("short_title wins over title, summary and first message", () => {
    expect(
      sessionDisplayTitle({
        short_title: "Review and merge checkout MR",
        title: "stored title",
        summary: "The user requested a review.",
        firstUserMessage: "hi",
      }),
    ).toBe("Review and merge checkout MR");
  });

  it("with short_title set, a placeholder summary is never the title", () => {
    expect(
      sessionDisplayTitle({
        short_title: "Tidy build scripts",
        title: null,
        summary: "A short session with no recorded prose. Touched 2 files: a.ts, b.ts.",
      }),
    ).toBe("Tidy build scripts");
  });

  it("without short_title the old order holds: title, then summary, then first message", () => {
    expect(sessionDisplayTitle({ short_title: null, title: "T", summary: "S" })).toBe("T");
    expect(sessionDisplayTitle({ short_title: "  ", title: null, summary: "S" })).toBe("S");
    expect(sessionDisplayTitle({ title: null, summary: null, firstUserMessage: "Fix it" })).toBe("Fix it");
  });

  it("the batched lookup's composed title prefers the row's short_title", () => {
    const row = {
      id: "a",
      short_title: "Review and merge checkout MR",
      title: null,
      summary: "long",
      started_at: null,
    };
    expect(composeSessionTitle(row, null, new Map())).toBe("Review and merge checkout MR");
  });
});
