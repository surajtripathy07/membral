import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { chatCostUsd, LlmClient, type OpenAILike } from "../../llm/client";
import type { ModelConfig } from "../../llm/config";
import { summarizeCodeSessions } from "../summarize";

const USER_ID = "user-1";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test-key",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function makeLlm(content: string | null): { llm: LlmClient; chatCreate: ReturnType<typeof vi.fn> } {
  const chatCreate = vi.fn().mockImplementation(() =>
    Promise.resolve({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 200, completion_tokens: 50 },
    }),
  );
  const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: vi.fn() } };
  return { llm: new LlmClient(CONFIG, { client }), chatCreate };
}

function seedSession(
  db: FakeSupabase,
  id: string,
  overrides: { summary?: string | null; files_touched?: string[]; started_at?: string } = {},
) {
  db.seed("code_sessions", [
    {
      id,
      user_id: USER_ID,
      code_project_id: "proj-1",
      summary: overrides.summary ?? null,
      title: null,
      files_touched: overrides.files_touched ?? [],
      started_at: overrides.started_at ?? "2026-07-01T10:00:00.000Z",
    },
  ]);
}

function seedTurns(db: FakeSupabase, sessionId: string, turns: Record<string, unknown>[]) {
  db.seed(
    "code_session_turns",
    turns.map((t, i) => ({ id: `${sessionId}-t${i}`, session_id: sessionId, ...t })),
  );
}

describe("summarizeCodeSessions", () => {
  it("only processes sessions with summary IS NULL", async () => {
    const db = new FakeSupabase();
    seedSession(db, "s-null", { summary: null });
    seedSession(db, "s-has-one", { summary: "already summarized" });
    seedTurns(db, "s-null", [
      { idx: 0, role: "user", kind: "prose", text: "Fix the login bug" },
      { idx: 1, role: "user", kind: "prose", text: "Also update the tests" },
      { idx: 2, role: "user", kind: "prose", text: "One more: update docs" },
    ]);

    const { llm } = makeLlm(JSON.stringify({ summary: "Fixed the login bug and updated tests and docs." }));
    const result = await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(1);
    const sessions = db.getRows("code_sessions");
    expect(sessions.find((s) => s.id === "s-has-one")?.summary).toBe("already summarized"); // untouched
    expect(sessions.find((s) => s.id === "s-null")?.summary).toBe("Fixed the login bug and updated tests and docs.");
  });

  it("SPINE WEIGHTING: the prompt foregrounds user turns and only sends tool_use metadata for assistant turns", async () => {
    const db = new FakeSupabase();
    seedSession(db, "s-1");
    seedTurns(db, "s-1", [
      { idx: 0, role: "user", kind: "prose", text: "Add a rate limiter to the API" },
      { idx: 1, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: "src/rate-limit.ts" },
      { idx: 2, role: "user", kind: "prose", text: "Actually use a token bucket, not fixed window" },
      { idx: 3, role: "assistant", kind: "tool_result" }, // must be elided entirely, never sent
      { idx: 4, role: "user", kind: "prose", text: "Looks good, ship it" },
    ]);

    const { llm, chatCreate } = makeLlm(JSON.stringify({ summary: "Added a token-bucket rate limiter." }));
    await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(chatCreate).toHaveBeenCalledTimes(1);
    const userPrompt = chatCreate.mock.calls[0][0].messages[1].content as string;
    expect(userPrompt).toContain("USER: Add a rate limiter to the API");
    expect(userPrompt).toContain("USER: Actually use a token bucket, not fixed window");
    expect(userPrompt).toContain("USER: Looks good, ship it");
    expect(userPrompt).toContain("[assistant used Edit on src/rate-limit.ts]");
    expect(userPrompt).not.toContain("tool_result");

    const systemPrompt = chatCreate.mock.calls[0][0].messages[0].content as string;
    expect(systemPrompt.toLowerCase()).toContain("spine");
  });

  it("HEURISTIC FALLBACK: a trivially short session (< 3 user prose turns) never calls the LLM", async () => {
    const db = new FakeSupabase();
    seedSession(db, "s-short", { files_touched: ["src/a.ts", "src/b.ts"] });
    seedTurns(db, "s-short", [
      { idx: 0, role: "user", kind: "prose", text: "Quick typo fix in the README" },
      { idx: 1, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: "README.md" },
    ]);

    const { llm, chatCreate } = makeLlm(JSON.stringify({ summary: "should not be used" }));
    const result = await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(chatCreate).not.toHaveBeenCalled();
    expect(result.llmCalls).toBe(0);
    expect(result.heuristicCount).toBe(1);
    const session = db.getRows("code_sessions").find((s) => s.id === "s-short");
    expect(session?.summary).toContain("Quick typo fix in the README");
    expect(session?.summary).toContain("2 files");
  });

  it("MALFORMED JSON FALLBACK: an unparseable LLM response falls back to the heuristic, never throws", async () => {
    const db = new FakeSupabase();
    seedSession(db, "s-1");
    seedTurns(db, "s-1", [
      { idx: 0, role: "user", kind: "prose", text: "Refactor the auth module" },
      { idx: 1, role: "user", kind: "prose", text: "Split it into two files" },
      { idx: 2, role: "user", kind: "prose", text: "Add unit tests for both" },
    ]);

    const { llm } = makeLlm("not valid json {{{");
    const result = await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(1);
    const session = db.getRows("code_sessions").find((s) => s.id === "s-1");
    expect(session?.summary).toContain("Refactor the auth module"); // heuristic, derived from first user turn
    expect(result.costUsd).toBe(0);
  });

  it("EMPTY-CONTENT FALLBACK: an empty summary field falls back to the heuristic", async () => {
    const db = new FakeSupabase();
    seedSession(db, "s-1");
    seedTurns(db, "s-1", [
      { idx: 0, role: "user", kind: "prose", text: "Wire up the webhook handler" },
      { idx: 1, role: "user", kind: "prose", text: "Validate the signature too" },
      { idx: 2, role: "user", kind: "prose", text: "Add a retry on 5xx" },
    ]);

    const { llm } = makeLlm(JSON.stringify({ summary: "" }));
    const result = await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID });

    const session = db.getRows("code_sessions").find((s) => s.id === "s-1");
    expect(session?.summary).toContain("Wire up the webhook handler");
    expect(result.llmCalls).toBe(1); // it WAS attempted — just fell back on empty output
  });

  it("respects the limit cap and reports cost", async () => {
    const db = new FakeSupabase();
    for (let i = 0; i < 5; i++) {
      seedSession(db, `s-${i}`);
      seedTurns(db, `s-${i}`, [
        { idx: 0, role: "user", kind: "prose", text: `Task ${i} step one` },
        { idx: 1, role: "user", kind: "prose", text: `Task ${i} step two` },
        { idx: 2, role: "user", kind: "prose", text: `Task ${i} step three` },
      ]);
    }
    const { llm } = makeLlm(JSON.stringify({ summary: "Did the task." }));
    const result = await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID, limit: 2 });

    expect(result.processed).toBe(2);
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

describe("summarizeCodeSessions — cost-cap halt (issue #21)", () => {
  it("halts cleanly on a cap breach: no session is left done-but-unsummarized (summary stays NULL, resumable)", async () => {
    const db = new FakeSupabase();
    const N = 6;
    for (let i = 0; i < N; i++) {
      seedSession(db, `s-${i}`);
      seedTurns(db, `s-${i}`, [
        { idx: 0, role: "user", kind: "prose", text: `Task ${i} step one` },
        { idx: 1, role: "user", kind: "prose", text: `Task ${i} step two` },
        { idx: 2, role: "user", kind: "prose", text: `Task ${i} step three` },
      ]);
    }

    const chatCreate = vi.fn().mockImplementation(() =>
      Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ summary: "Did the task." }) } }],
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      }),
    );
    const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: vi.fn() } };
    // Exact reuse of one call's cost — deterministic: after 1 call, totalCostUsd
    // == capUsd, so the 2nd call's pre-check trips before its network call.
    const capUsd = chatCostUsd("gpt-4o-mini", 200, 50) ?? 0;
    const llm = new LlmClient(CONFIG, { client, capUsd });

    const result = await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.capped).toBe(true);
    // Overshoot bound: CONCURRENCY (summarize.ts, not exported) is 4, so up to
    // 3 extra in-flight workers may have already started before the flag flips.
    expect(chatCreate.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(chatCreate.mock.calls.length).toBeLessThanOrEqual(1 + 3);

    // The load-bearing assertion: every session NOT actually summarized must
    // stay summary=NULL — never heuristic-filled just because the cap was hit.
    // A heuristic write there would permanently hide it from a future,
    // higher-cap re-run (fetchSessionsNeedingSummary only selects summary IS NULL).
    const rows = db.getRows("code_sessions");
    const summarizedCount = rows.filter((r) => r.summary !== null).length;
    expect(summarizedCount).toBe(chatCreate.mock.calls.length);
    for (const r of rows) {
      if (r.summary === null) continue;
      expect(r.summary).toBe("Did the task.");
    }
  });

  it("does not halt when no cap is configured", async () => {
    const db = new FakeSupabase();
    seedSession(db, "s-1");
    seedTurns(db, "s-1", [
      { idx: 0, role: "user", kind: "prose", text: "Fix the bug" },
      { idx: 1, role: "user", kind: "prose", text: "Add a test" },
      { idx: 2, role: "user", kind: "prose", text: "Ship it" },
    ]);
    const { llm } = makeLlm(JSON.stringify({ summary: "Did the task." }));
    const result = await summarizeCodeSessions({ supabase: db.asClient(), llm, userId: USER_ID });
    expect(result.capped).toBe(false);
  });
});
