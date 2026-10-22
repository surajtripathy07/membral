import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { chatCostUsd, LlmClient, type OpenAILike } from "../../llm/client";
import type { ModelConfig } from "../../llm/config";
import { MAX_ROLLUP_ATTEMPTS, rollupCodeProjects } from "../rollup";

const USER_ID = "user-1";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test-key",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

const GOOD_ROLLUP = JSON.stringify({
  summary: "Built the checkout flow across several sessions with Stripe integration.",
  what_built: "A working checkout flow with Stripe payments.",
  key_decisions: "Switched from PayPal to Stripe midway through.",
  recurring_files_tools: ["src/checkout.ts", "stripe"],
  people: ["Alex Rivera"],
  open_threads: "Still need to add refund support.",
});

function makeLlm(content: string | null): { llm: LlmClient; chatCreate: ReturnType<typeof vi.fn> } {
  const chatCreate = vi.fn().mockImplementation(() =>
    Promise.resolve({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 400, completion_tokens: 200 },
    }),
  );
  const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: vi.fn() } };
  return { llm: new LlmClient(CONFIG, { client }), chatCreate };
}

function seedProject(db: FakeSupabase, id: string, overrides: Record<string, unknown> = {}) {
  db.seed("code_projects", [
    {
      id,
      user_id: USER_ID,
      display_name: "webapp",
      repo_identity: "github.com/acme/webapp",
      summary: null,
      props: { portrait_dirty: true },
      ...overrides,
    },
  ]);
}

function seedSessions(db: FakeSupabase, projectId: string, sessions: Record<string, unknown>[]) {
  db.seed(
    "code_sessions",
    sessions.map((s, i) => ({
      id: `${projectId}-s${i}`,
      user_id: USER_ID,
      code_project_id: projectId,
      started_at: `2026-07-0${i + 1}T10:00:00.000Z`,
      files_touched: [],
      ...s,
    })),
  );
}

describe("rollupCodeProjects", () => {
  it("only processes projects with props.portrait_dirty === true (a truly clean, already-rolled-up project is skipped)", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-dirty", { props: { portrait_dirty: true } });
    seedProject(db, "proj-clean", {
      props: { portrait_dirty: false, rollup_status: "ok", rollup: { summary: "Already rolled up." } },
    });
    seedSessions(db, "proj-dirty", [{ summary: "Did some work." }]);
    seedSessions(db, "proj-clean", [{ summary: "Did other work." }]);

    const { llm, chatCreate } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    const clean = db.getRows("code_projects").find((p) => p.id === "proj-clean");
    expect(clean?.summary).toBeNull(); // untouched
  });

  it("COST BOUND: makes exactly ONE LLM call per dirty project regardless of session count", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1");
    seedProject(db, "proj-2");
    seedSessions(
      db,
      "proj-1",
      Array.from({ length: 12 }, (_, i) => ({ summary: `Session ${i} summary.` })),
    );
    seedSessions(
      db,
      "proj-2",
      Array.from({ length: 3 }, (_, i) => ({ summary: `Session ${i} summary.` })),
    );

    const { llm, chatCreate } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(2);
    expect(chatCreate).toHaveBeenCalledTimes(2); // ONE call per project, not per session
    expect(result.llmCalls).toBe(2);
  });

  it("skips the LLM call entirely for a dirty project with zero sessions", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-empty");

    const { llm, chatCreate } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(chatCreate).not.toHaveBeenCalled();
    expect(result.llmCalls).toBe(0);
    expect(result.processed).toBe(1);
    const project = db.getRows("code_projects").find((p) => p.id === "proj-empty");
    expect(project?.summary).toBe("0 sessions on webapp.");
  });

  it("clears portrait_dirty on success", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1");
    seedSessions(db, "proj-1", [{ summary: "Did some work." }]);

    const { llm } = makeLlm(GOOD_ROLLUP);
    await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    const project = db.getRows("code_projects").find((p) => p.id === "proj-1");
    expect((project?.props as Record<string, unknown>).portrait_dirty).toBe(false);
    expect(project?.summary).toBe("Built the checkout flow across several sessions with Stripe integration.");
    const rollup = (project?.props as Record<string, unknown>).rollup as Record<string, unknown>;
    expect(rollup.what_built).toBe("A working checkout flow with Stripe payments.");
    expect(rollup.people).toEqual(["Alex Rivera"]);
  });

  it("LOCKED FIELDS: never overwrites a field named in props.locked_fields", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", {
      props: {
        portrait_dirty: true,
        locked_fields: ["what_built", "summary"],
        rollup: {
          summary: "User-edited summary — must survive.",
          what_built: "User-edited what_built — must survive.",
          key_decisions: "old decisions",
          recurring_files_tools: ["old.ts"],
          people: ["Old Person"],
          open_threads: "old threads",
        },
      },
    });
    seedSessions(db, "proj-1", [{ summary: "New session summary." }]);

    const { llm } = makeLlm(GOOD_ROLLUP);
    await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    const project = db.getRows("code_projects").find((p) => p.id === "proj-1");
    const rollup = (project?.props as Record<string, unknown>).rollup as Record<string, unknown>;
    // Locked fields keep their old value...
    expect(rollup.summary).toBe("User-edited summary — must survive.");
    expect(rollup.what_built).toBe("User-edited what_built — must survive.");
    expect(project?.summary).toBe("User-edited summary — must survive."); // top-level column mirrors rollup.summary
    // ...unlocked fields still regenerate from the new LLM output.
    expect(rollup.key_decisions).toBe("Switched from PayPal to Stripe midway through.");
    expect(rollup.people).toEqual(["Alex Rivera"]);
  });

  it("LLM FAILURE: leaves the project dirty and records rollup_last_error, WITHOUT overwriting it with the placeholder", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1");
    seedSessions(db, "proj-1", [
      { summary: "Fixed the bug.", files_touched: ["src/a.ts", "src/a.ts", "src/b.ts"] },
      { summary: "Added tests.", files_touched: ["src/a.ts"] },
    ]);

    const { llm } = makeLlm("not valid json {{{");
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(1);
    const project = db.getRows("code_projects").find((p) => p.id === "proj-1");
    // The load-bearing fix: a failure must NOT write the "N sessions on X."
    // placeholder over a project's summary/rollup, and must NOT clear
    // portrait_dirty — both would permanently mask the failure.
    expect(project?.summary).toBeNull();
    expect((project?.props as Record<string, unknown>).rollup).toBeUndefined();
    expect((project?.props as Record<string, unknown>).portrait_dirty).toBe(true);
    expect((project?.props as Record<string, unknown>).rollup_status).toBe("pending");
    const lastError = (project?.props as Record<string, unknown>).rollup_last_error as Record<string, unknown>;
    expect(lastError.attempts).toBe(1);
    expect(typeof lastError.message).toBe("string");
    expect(typeof lastError.at).toBe("string");
  });

  it("LLM FAILURE on a project with an existing rollup: leaves the prior real rollup untouched", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", {
      summary: "Real prior summary.",
      props: {
        portrait_dirty: true, // e.g. a new session just arrived
        rollup_status: "ok",
        rollup: {
          summary: "Real prior summary.",
          what_built: "Real prior what_built.",
          key_decisions: "",
          recurring_files_tools: [],
          people: [],
          open_threads: "",
        },
      },
    });
    seedSessions(db, "proj-1", [{ summary: "New session." }]);

    const { llm } = makeLlm("not valid json {{{");
    await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    const project = db.getRows("code_projects").find((p) => p.id === "proj-1");
    expect(project?.summary).toBe("Real prior summary.");
    const rollup = (project?.props as Record<string, unknown>).rollup as Record<string, unknown>;
    expect(rollup.summary).toBe("Real prior summary.");
    expect((project?.props as Record<string, unknown>).portrait_dirty).toBe(true);
  });

  it("CAP: after MAX_ROLLUP_ATTEMPTS consecutive failures, gives up and writes the fallback with rollup_status 'failed'", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", {
      props: {
        portrait_dirty: true,
        rollup_status: "pending",
        rollup_last_error: {
          at: "2026-01-01T00:00:00.000Z",
          message: "prior failure",
          attempts: MAX_ROLLUP_ATTEMPTS - 1,
        },
      },
    });
    seedSessions(db, "proj-1", [{ summary: "Did some work." }]);

    const { llm } = makeLlm("not valid json {{{");
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(1);
    const project = db.getRows("code_projects").find((p) => p.id === "proj-1");
    expect(project?.summary).toBe("1 session on webapp.");
    // P0c (goal 2026-09-26): the fallback never repeats the summary as what_built
    const fallbackRollup = (project?.props as Record<string, unknown>).rollup as Record<string, unknown>;
    expect(fallbackRollup.what_built).toBe("");
    expect((project?.props as Record<string, unknown>).portrait_dirty).toBe(false);
    expect((project?.props as Record<string, unknown>).rollup_status).toBe("failed");
    const lastError = (project?.props as Record<string, unknown>).rollup_last_error as Record<string, unknown>;
    expect(lastError.attempts).toBe(MAX_ROLLUP_ATTEMPTS);
  });

  it("SUCCESS after prior failures: clears rollup_last_error and sets rollup_status 'ok'", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", {
      props: {
        portrait_dirty: true,
        rollup_status: "pending",
        rollup_last_error: { at: "2026-01-01T00:00:00.000Z", message: "prior failure", attempts: 2 },
      },
    });
    seedSessions(db, "proj-1", [{ summary: "Did some work." }]);

    const { llm } = makeLlm(GOOD_ROLLUP);
    await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    const project = db.getRows("code_projects").find((p) => p.id === "proj-1");
    expect((project?.props as Record<string, unknown>).rollup_status).toBe("ok");
    expect((project?.props as Record<string, unknown>).rollup_last_error).toBeUndefined();
    expect((project?.props as Record<string, unknown>).portrait_dirty).toBe(false);
  });

  it("respects the limit cap", async () => {
    const db = new FakeSupabase();
    for (let i = 0; i < 4; i++) {
      seedProject(db, `proj-${i}`);
      seedSessions(db, `proj-${i}`, [{ summary: "work" }]);
    }
    const { llm, chatCreate } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID, limit: 2 });

    expect(result.processed).toBe(2);
    expect(chatCreate).toHaveBeenCalledTimes(2);
  });
});

describe("rollupCodeProjects — fetchDirtyProjects picks up never-rolled-up / retryable projects", () => {
  it("processes a project with portrait_dirty=false but no props.rollup at all (never rolled up)", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-never", { props: { portrait_dirty: false } });
    seedSessions(db, "proj-never", [{ summary: "Did some work." }]);

    const { llm, chatCreate } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    const project = db.getRows("code_projects").find((p) => p.id === "proj-never");
    expect((project?.props as Record<string, unknown>).rollup_status).toBe("ok");
  });

  it("processes a project with rollup_status 'pending' even though portrait_dirty is false", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-pending", {
      props: { portrait_dirty: false, rollup_status: "pending", rollup_last_error: { attempts: 1 } },
    });
    seedSessions(db, "proj-pending", [{ summary: "Did some work." }]);

    const { chatCreate, llm } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-process a project that gave up (rollup_status 'failed' with attempts at the cap)", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-gave-up", {
      props: {
        portrait_dirty: false,
        rollup_status: "failed",
        // The cap-exceeded write path always leaves a (fallback) rollup in
        // place — a real "gave up" project is never rollup-less.
        rollup: { summary: "1 session on webapp." },
        rollup_last_error: { attempts: MAX_ROLLUP_ATTEMPTS },
      },
    });
    seedSessions(db, "proj-gave-up", [{ summary: "Did some work." }]);

    const { chatCreate, llm } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(0);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("does NOT re-process a clean, already-rolled-up project (portrait_dirty=false, rollup_status 'ok')", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-clean", {
      props: { portrait_dirty: false, rollup_status: "ok", rollup: { summary: "done" } },
    });
    seedSessions(db, "proj-clean", [{ summary: "Did some work." }]);

    const { chatCreate, llm } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(result.processed).toBe(0);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("processes actually-dirty projects ahead of never-rolled-up/retry stragglers when the limit truncates", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-never", { props: { portrait_dirty: false } });
    seedProject(db, "proj-dirty", { props: { portrait_dirty: true } });
    seedSessions(db, "proj-never", [{ summary: "work" }]);
    seedSessions(db, "proj-dirty", [{ summary: "work" }]);

    const { llm } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID, limit: 1 });

    expect(result.processed).toBe(1);
    const dirty = db.getRows("code_projects").find((p) => p.id === "proj-dirty");
    const never = db.getRows("code_projects").find((p) => p.id === "proj-never");
    expect((dirty?.props as Record<string, unknown>).rollup_status).toBe("ok");
    expect((never?.props as Record<string, unknown>).rollup_status).toBeUndefined();
  });
});

describe("rollupCodeProjects — cost-cap halt (issue #21)", () => {
  it("halts cleanly on a cap breach: no project is left rolled-up-but-dirty (portrait_dirty stays true, resumable)", async () => {
    const db = new FakeSupabase();
    for (let i = 0; i < 3; i++) {
      seedProject(db, `proj-${i}`);
      seedSessions(db, `proj-${i}`, [{ summary: `Session summary ${i}.` }]);
    }

    const chatCreate = vi.fn().mockImplementation(() =>
      Promise.resolve({
        choices: [{ message: { content: GOOD_ROLLUP } }],
        usage: { prompt_tokens: 400, completion_tokens: 200 },
      }),
    );
    const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: vi.fn() } };
    // Exact reuse of one call's cost — deterministic: rollup's loop is
    // sequential (no concurrency), so the overshoot bound here is exactly 0 —
    // project 2's preamble check sees `capped` before doing anything.
    const capUsd = chatCostUsd("gpt-4o-mini", 400, 200) ?? 0;
    const llm = new LlmClient(CONFIG, { client, capUsd });

    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });

    expect(chatCreate).toHaveBeenCalledTimes(1); // only proj-0's rollup call
    expect(result.llmCalls).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.capped).toBe(true);

    const projects = db.getRows("code_projects");
    const rolled = projects.find((p) => p.id === "proj-0");
    const untouched1 = projects.find((p) => p.id === "proj-1");
    const untouched2 = projects.find((p) => p.id === "proj-2");
    expect((rolled?.props as Record<string, unknown>).portrait_dirty).toBe(false);
    // The load-bearing assertion: projects NOT actually rolled up must stay
    // portrait_dirty=true — never flipped false just because the cap was hit.
    // fetchDirtyProjects only selects portrait_dirty===true, so flipping it
    // would permanently hide these from a future, higher-cap re-run.
    expect((untouched1?.props as Record<string, unknown>).portrait_dirty).toBe(true);
    expect((untouched2?.props as Record<string, unknown>).portrait_dirty).toBe(true);
    expect(untouched1?.summary).toBeNull();
    expect(untouched2?.summary).toBeNull();
  });

  it("does not halt when no cap is configured", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1");
    seedSessions(db, "proj-1", [{ summary: "Did some work." }]);
    const { llm } = makeLlm(GOOD_ROLLUP);
    const result = await rollupCodeProjects({ supabase: db.asClient(), llm, userId: USER_ID });
    expect(result.capped).toBe(false);
  });
});
