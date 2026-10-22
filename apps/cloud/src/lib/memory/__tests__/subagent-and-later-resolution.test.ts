// Sub-agent sessions (the parent agent's brief is not the owner's voice) and
// later-session blocker resolution (a session closes blockers from earlier
// sessions, with a verified evidence quote as the receipt). Same fake
// supabase + real LlmClient over a fake OpenAILike transport as
// tail-capture.test.ts; the transport routes by system prompt so each pass
// can answer differently.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { RESOLVED_LATER_RETIRE_REASON, selectSubagentBriefRows } from "@/lib/memory/write";
import { checkLaterBlockerResolutions, findResolutionEvidenceTurn, SUB_AGENT_NOTE } from "../extract";
import { renderTurnLines } from "../render";
import { runTailCaptureForSession } from "../tail-capture";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

type Pass = "main" | "user" | "reask" | "later";

function passOf(systemPrompt: string): Pass {
  if (systemPrompt.startsWith("You extract short")) return "main";
  if (systemPrompt.startsWith("You read the OWNER")) return "user";
  if (systemPrompt.startsWith("You are re-checking")) return "reask";
  if (systemPrompt.startsWith("You check whether a coding session resolved")) return "later";
  throw new Error(`unrouted system prompt: ${systemPrompt.slice(0, 40)}`);
}

/** A real LlmClient whose chat transport answers per pass (`replies[pass]` is the raw content string). */
function makeRoutedLlm(replies: Partial<Record<Pass, string>>) {
  const calls: Array<{ pass: Pass; user: string; system: string }> = [];
  const chatCreate = vi.fn().mockImplementation((body: { messages: Array<{ role: string; content: string }> }) => {
    const pass = passOf(body.messages[0].content);
    calls.push({ pass, user: body.messages[1]?.content ?? "", system: body.messages[0]?.content ?? "" });
    const fallback = pass === "reask" || pass === "later" ? JSON.stringify({ resolutions: [] }) : '{"records":[]}';
    return Promise.resolve({
      choices: [{ message: { content: replies[pass] ?? fallback } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
  });
  const embedCreate = vi.fn().mockImplementation((body: { input: string | string[] }) => {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    // One-hot per input so distinct records never collapse in cosine dedupe.
    return Promise.resolve({
      data: inputs.map((_, i) => ({ embedding: Array.from({ length: 8 }, (_, j) => (j === i % 8 ? 1 : 0)) })),
      usage: { prompt_tokens: 5 },
    });
  });
  const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: embedCreate } };
  return { llm: new LlmClient(CONFIG, { client }), calls };
}

function sessionRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "s1",
    user_id: "u1",
    code_project_id: "p1",
    source: "claude-code",
    git_branch: "main",
    model: "claude-sonnet-5",
    started_at: "2026-09-01T00:00:00Z",
    ended_at: "2026-09-01T00:10:00Z",
    duration_seconds: 600,
    files_touched: [],
    props: {},
    cwd: "/repo",
    parent_source_session_id: null,
    code_projects: { display_name: "Test Repo" },
    ...overrides,
  };
}

function turnRow(overrides: Partial<Row> & Pick<Row, "idx" | "role" | "kind">): Row {
  return {
    session_id: "s1",
    user_id: "u1",
    text: null,
    tool_name: null,
    file_path: null,
    ts: null,
    props: {},
    ...overrides,
  };
}

// --- Change 1: a sub-agent's role-"user" turns are the parent agent's brief.

const BRIEF_TURNS: Row[] = [
  turnRow({
    idx: 0,
    role: "user",
    kind: "prose",
    text: "Another builder is editing apps/cloud/src/lib/memory so keep your changes out of that folder and always run the linter before you report back.",
  }),
  turnRow({
    idx: 1,
    role: "assistant",
    kind: "prose",
    text: "Dark mode is now the default theme across the whole app.",
  }),
];

const BRIEF_REPLY = JSON.stringify({
  records: [
    {
      kind: "preference",
      statement: "Always run the linter before reporting back.",
      owner_quote: "always run the linter before you report back",
      turn_idx: 0,
      turn_role: "user",
      durable: true,
      thread: "linting",
    },
    {
      kind: "blocker",
      text: "Another builder is editing the memory folder, so edits there are blocked.",
      quote: "Another builder is editing apps/cloud/src/lib/memory so keep your changes out of that folder",
      turn_idx: 0,
      turn_role: "user",
      durable: true,
      resolved_in_session: false,
      thread: "memory folder lock",
    },
    {
      kind: "decision",
      text: "Dark mode is now the default theme",
      quote: "Dark mode is now the default theme across the whole app.",
      turn_idx: 1,
      turn_role: "assistant",
      durable: true,
      thread: "dark mode default",
    },
  ],
});

describe("sub-agent sessions: the parent agent's brief is not the owner", () => {
  it("drops a user-turn preference and blocker, keeps the assistant decision, labels parent_agent, skips the user pass", async () => {
    const rows = {
      code_sessions: [sessionRow({ parent_source_session_id: "parent-src-1" })],
      code_session_turns: [...BRIEF_TURNS],
      session_memories: [] as Row[],
    };
    const { llm, calls } = makeRoutedLlm({ main: BRIEF_REPLY });

    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r1",
    });

    expect(calls.map((c) => c.pass)).toEqual(["main"]); // no user pass, no re-ask (the blocker was dropped)
    expect(calls[0].user).toContain("[#0 parent_agent] Another builder is editing");
    expect(calls[0].user).toContain("[#1 assistant] Dark mode");
    expect(calls[0].user).toContain(SUB_AGENT_NOTE.trim());
    expect(rows.session_memories.map((r) => r.kind)).toEqual(["decision"]);
    expect(summary.droppedSubagentBrief).toBe(2);
    expect(rows.code_sessions[0].props.memory_extraction.dropped_subagent_brief).toBe(2);
    // Skipping the user pass for a sub-agent never holds the checkpoint back.
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(1);
  });

  it("main session: the same reply keeps the preference and blocker, and the user pass runs", async () => {
    const rows = {
      code_sessions: [sessionRow()],
      code_session_turns: [...BRIEF_TURNS],
      session_memories: [] as Row[],
    };
    const { llm, calls } = makeRoutedLlm({ main: BRIEF_REPLY });

    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r1",
    });

    expect(calls.some((c) => c.pass === "user")).toBe(true);
    expect(calls[0].user).toContain("[#0 user] Another builder is editing");
    expect(calls[0].user).not.toContain("parent_agent");
    // v13 (review B1): decisions may come from agent turns — the assistant-line decision is kept.
    expect(rows.session_memories.map((r) => r.kind).sort()).toEqual(["blocker", "decision", "preference"]);
    expect(summary.droppedSubagentBrief).toBe(0);
  });

  it("renderTurnLines labels only role-user turns as parent_agent, and only when asked", () => {
    const turns = [
      {
        idx: 0,
        role: "user" as const,
        kind: "prose" as const,
        text: "brief",
        tool_name: null,
        file_path: null,
        ts: null,
        props: null,
      },
      {
        idx: 1,
        role: "assistant" as const,
        kind: "prose" as const,
        text: "ok",
        tool_name: null,
        file_path: null,
        ts: null,
        props: null,
      },
    ];
    expect(renderTurnLines(turns, { subAgent: true }).map((t) => t.line)).toEqual([
      "[#0 parent_agent] brief",
      "[#1 assistant] ok",
    ]);
    expect(renderTurnLines(turns).map((t) => t.line)).toEqual(["[#0 user] brief", "[#1 assistant] ok"]);
    expect(renderTurnLines(turns, { subAgent: true })[0].role).toBe("user"); // stored role unchanged
  });
});

// --- Change 3: a later session closes an earlier session's blocker.

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const OLD_BLOCKER_TEXT = "A leaked CodeHub deploy key still needs rotation in the org console.";
const NEW_BLOCKER_TEXT = "The CodeHub release pipeline is waiting on a signing certificate.";
const EVIDENCE = "The leaked CodeHub deploy key was rotated in the org console";

function laterTables(opts: { blockers?: boolean } = {}) {
  const current = sessionRow({ id: "s2", started_at: iso(1 * DAY), ended_at: iso(1 * DAY - 3_600_000) });
  const turns = [
    turnRow({
      session_id: "s2",
      idx: 0,
      role: "user",
      kind: "prose",
      text: "please rotate the leaked key",
      ts: iso(DAY),
    }),
    turnRow({
      session_id: "s2",
      idx: 1,
      role: "assistant",
      kind: "prose",
      text: `${EVIDENCE} and the old key revoked.`,
      ts: iso(DAY - 3_600_000),
    }),
    // Review N3: the step that claims the rotation touched the blocker's own path.
    turnRow({
      session_id: "s2",
      idx: 2,
      role: "assistant",
      kind: "tool_use",
      tool_name: "Edit",
      file_path: "/repo/deploy/keys.yml",
      ts: iso(DAY - 3_500_000),
    }),
  ];
  const blockerRow = (id: string, sessionId: string, text: string, createdMsAgo: number): Row => ({
    id,
    user_id: "u1",
    code_session_id: sessionId,
    code_project_id: "p1",
    kind: "blocker",
    text,
    quote: text,
    turn_idx: 0,
    turn_role: "assistant",
    supersedes: null,
    retired_at: null,
    retire_reason: null,
    created_at: iso(createdMsAgo),
    embedding: null,
    content_hash: `h-${id}`,
    ref: null,
    paths: id === "m-old" ? ["deploy/keys.yml"] : null,
  });
  return {
    code_sessions: [
      current,
      sessionRow({ id: "s-old", started_at: iso(3 * DAY) }),
      // Started AFTER the current session's last turn: its blocker is out of reach.
      sessionRow({ id: "s-new", started_at: iso(0.5 * DAY) }),
      // Too old: the blocker is past BLOCKER_FRESH_DAYS (7, #436).
      sessionRow({ id: "s-stale", started_at: iso(40 * DAY) }),
    ],
    code_session_turns: turns,
    session_memories:
      opts.blockers === false
        ? ([] as Row[])
        : [
            blockerRow("m-old", "s-old", OLD_BLOCKER_TEXT, 2 * DAY),
            blockerRow("m-new", "s-new", NEW_BLOCKER_TEXT, 0.4 * DAY),
            blockerRow("m-stale", "s-stale", "A stale CodeHub blocker from long ago.", 30 * DAY),
            // #436: 8 days old — inside the old 21-day reach, outside BLOCKER_FRESH_DAYS.
            blockerRow("m-week", "s-stale", "A week-old CodeHub blocker past the fresh window.", 8 * DAY),
          ],
  };
}

describe("later-session blocker resolution", () => {
  it("retires an earlier session's blocker with a verified quote and stores the receipt; never offers newer or stale blockers", async () => {
    const rows = laterTables();
    const { llm, calls } = makeRoutedLlm({
      later: JSON.stringify({
        resolutions: [{ index: 0, resolved: true, same_problem: true, evidence_quote: EVIDENCE }],
      }),
    });

    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s2", {
      runId: "r1",
    });

    const later = calls.filter((c) => c.pass === "later");
    expect(later).toHaveLength(1);
    expect(later[0].user).toContain(OLD_BLOCKER_TEXT);
    expect(later[0].user).not.toContain(NEW_BLOCKER_TEXT);
    expect(later[0].user).not.toContain("stale CodeHub blocker");
    expect(later[0].user).not.toContain("week-old CodeHub blocker");
    const old = rows.session_memories.find((r) => r.id === "m-old");
    expect(old?.retired_at).toBeTruthy();
    expect(old?.retire_reason).toBe(RESOLVED_LATER_RETIRE_REASON);
    expect(old?.resolved_by_session_id).toBe("s2");
    expect(old?.resolution_quote).toBe(EVIDENCE);
    expect(old?.resolution_turn_idx).toBe(1);
    expect(rows.session_memories.find((r) => r.id === "m-new")?.retired_at).toBeNull();
    expect(summary.blockersResolvedLater).toBe(1);
    expect(rows.code_sessions[0].props.memory_extraction.blockers_resolved_later).toBe(1);
  });

  it("ignores a resolution whose evidence quote is not in this session's transcript", async () => {
    const rows = laterTables();
    const { llm } = makeRoutedLlm({
      later: JSON.stringify({
        resolutions: [
          {
            index: 0,
            resolved: true,
            same_problem: true,
            evidence_quote: "The leaked CodeHub deploy key was deleted by the security team",
          },
        ],
      }),
    });

    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s2", {
      runId: "r1",
    });

    expect(rows.session_memories.find((r) => r.id === "m-old")?.retired_at).toBeNull();
    expect(summary.blockersResolvedLater).toBe(0);
    expect(rows.code_sessions[0].props.memory_extraction.blockers_resolution_unverified).toBe(1);
  });

  it("makes no later-resolution call when there are no open blockers", async () => {
    const rows = laterTables({ blockers: false });
    const { llm, calls } = makeRoutedLlm({});

    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s2", { runId: "r1" });

    expect(calls.some((c) => c.pass === "later")).toBe(false);
  });

  it("malformed LLM output: no change, no throw", async () => {
    const rows = laterTables();
    const { llm } = makeRoutedLlm({ later: "this is not json at all" });

    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s2", {
      runId: "r1",
    });

    expect(rows.session_memories.every((r) => r.retired_at === null)).toBe(true);
    expect(summary.blockersResolvedLater).toBe(0);
    expect(summary.skipped).toBe(false);
  });

  it("checkLaterBlockerResolutions: a renumbered index set resolves nothing", async () => {
    const { llm } = makeRoutedLlm({
      later: JSON.stringify({
        resolutions: [{ index: 1, resolved: true, same_problem: true, evidence_quote: EVIDENCE }],
      }),
    });
    const result = await checkLaterBlockerResolutions(
      llm,
      [{ index: 0, text: OLD_BLOCKER_TEXT, quote: null }],
      [`[#1 assistant] ${EVIDENCE}`],
      [{ idx: 1, text: EVIDENCE }],
      "s2",
    );
    expect(result.resolutions).toEqual([]);
    expect(result.failed).toBe(false);
  });

  it("findResolutionEvidenceTurn: verbatim and specific only", () => {
    const turns = [
      { idx: 3, text: `${EVIDENCE}.` },
      { idx: 7, text: "done" },
    ];
    expect(findResolutionEvidenceTurn(EVIDENCE, OLD_BLOCKER_TEXT, turns)).toBe(3);
    expect(findResolutionEvidenceTurn("done", OLD_BLOCKER_TEXT, turns)).toBeNull(); // too generic
    expect(
      findResolutionEvidenceTurn("The deploy key was rotated by someone else entirely", OLD_BLOCKER_TEXT, turns),
    ).toBeNull();
    expect(findResolutionEvidenceTurn(null, OLD_BLOCKER_TEXT, turns)).toBeNull();
  });
});

// --- Cleanup script selection.

describe("selectSubagentBriefRows (retire-subagent-brief.ts)", () => {
  const base = { user_id: "u1", retired_at: null as string | null, turn_role: "user", kind: "preference" };
  it("picks live user-turn preferences/blockers from sub-agent sessions only", () => {
    const rows = [
      { ...base, id: "a", code_session_id: "sub" },
      { ...base, id: "b", code_session_id: "sub", kind: "blocker" },
      { ...base, id: "c", code_session_id: "sub", kind: "decision" },
      { ...base, id: "d", code_session_id: "sub", kind: "blocker", turn_role: "assistant" },
      { ...base, id: "e", code_session_id: "main" },
      { ...base, id: "f", code_session_id: "sub", retired_at: "2026-09-01T00:00:00Z" },
    ];
    expect(selectSubagentBriefRows(rows, new Set(["sub"])).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("S23: the later-resolution judge needs the SAME problem resolved", () => {
  it("a verified quote without same_problem: true retires nothing (a shared file or word is not resolution)", async () => {
    const rows = laterTables();
    const { llm, calls } = makeRoutedLlm({
      later: JSON.stringify({
        resolutions: [{ index: 0, resolved: true, same_problem: false, evidence_quote: EVIDENCE }],
      }),
    });
    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s2", {
      runId: "r1",
    });
    expect(rows.session_memories.find((r) => r.id === "m-old")?.retired_at).toBeNull();
    expect(summary.blockersResolvedLater).toBe(0);
    expect(rows.code_sessions[0].props.memory_extraction.blockers_resolution_unverified).toBe(1);
    const judge = calls.find((c) => c.pass === "later");
    expect(judge?.system).toMatch(/same underlying problem/);
    expect(judge?.system).toMatch(/README\.md/);
    expect(judge?.system).toMatch(/same_problem: true/);
  });
});
