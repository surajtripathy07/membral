// Issue #339: a main-pass window whose reply was cut off at the output token
// limit but salvaged counts as extracted for its records and the checkpoint,
// but NOT as a full run for the session's issue rows: a cut inside "records"
// always loses that window's "issues", so the stored model rows are carried.
import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { runTailCaptureForSession } from "../tail-capture";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};
const PROJECT = "github.com/acme/app";

// Each turn is over the window target on its own, so each is its own window.
const FILLER = " the build output scrolled past while the tests kept running quietly".repeat(420);
const SENTENCES = [
  "Dark mode is now the default theme across the whole app.",
  "Retry backoff is now exponential across every network client.",
  "Session tokens now expire after twelve hours across all devices.",
];
const TOPICS = ["dark mode", "retry backoff", "session tokens"];
const ISSUE_LINE = "look at #9 before lunch please";

function turnRow(idx: number, role: string, text: string): Row {
  return {
    session_id: "s1",
    user_id: "u1",
    idx,
    role,
    kind: "prose",
    text,
    tool_name: null,
    file_path: null,
    ts: null,
    props: {},
  };
}

function record(i: number) {
  const words = SENTENCES[i].replace(/\.$/, "");
  return {
    kind: "learning",
    text: words,
    quote: SENTENCES[i],
    turn_idx: i,
    turn_role: "assistant",
    durable: true,
    thread: TOPICS[i],
  };
}

function world(): Record<string, Row[]> {
  return {
    code_sessions: [
      {
        id: "s1",
        user_id: "u1",
        code_project_id: "p1",
        source: "claude-code",
        source_session_id: "src-s1",
        parent_source_session_id: null,
        git_branch: "main",
        model: "claude-sonnet-5",
        started_at: "2026-09-01T00:00:00Z",
        ended_at: "2026-09-01T00:10:00Z",
        duration_seconds: 600,
        files_touched: [],
        props: {},
        cwd: "/repo",
        code_projects: { display_name: "app", repo_identity: PROJECT },
      },
    ],
    code_session_turns: [
      turnRow(0, "assistant", `${SENTENCES[0]}${FILLER}`),
      turnRow(1, "assistant", `${SENTENCES[1]}${FILLER}`),
      turnRow(2, "assistant", `${SENTENCES[2]}${FILLER}`),
      turnRow(3, "user", ISSUE_LINE),
    ],
    session_memories: [],
    code_session_issues: [
      // A model row from an earlier run, grounded on the owner's line.
      {
        id: "s1:#9",
        session_id: "s1",
        user_id: "u1",
        ref: `${PROJECT}#9`,
        number: 9,
        kind: "issue",
        role: "referenced",
        tier: "discussed",
        turn_idx: 3,
        evidence_quote: ISSUE_LINE,
        review_verb: null,
        build_verb: null,
        turn_share: 0,
        related_to: [],
        created_at: "2026-09-26T10:00:00.000Z",
      },
    ],
  };
}

/** Main-pass replies by window content; `cutMiddle` cuts window 1's reply after its one record. */
function llmFor(cutMiddle: boolean) {
  const create = vi.fn().mockImplementation((body: { messages: Array<{ content: string }> }) => {
    const [system, user] = body.messages.map((m) => m.content);
    const reply = (content: string, finish = "stop") =>
      Promise.resolve({
        choices: [{ message: { content }, finish_reason: finish }],
        usage: { prompt_tokens: 9896, completion_tokens: finish === "length" ? 2000 : 40 },
      });
    if (!system.startsWith("You extract short")) return reply('{"records": []}'); // the user-turn pass
    const i = SENTENCES.findIndex((s) => user.includes(s));
    if (i < 0) return reply('{"records": []}');
    if (i === 1 && cutMiddle) {
      return reply(
        `{"records": [${JSON.stringify(record(1))}, {"kind": "learning", "text": "CUT-MARKER-0d4 half`,
        "length",
      );
    }
    return reply(JSON.stringify({ records: [record(i)], issues: [] }));
  });
  const embed = vi.fn().mockImplementation((b: { input: string | string[] }) => {
    const inputs = Array.isArray(b.input) ? b.input : [b.input];
    // Orthogonal vectors per topic, so the three records never dedupe against each other.
    const vec = (t: string) => [0, 1, 2].map((k) => (t.includes(SENTENCES[k].split(" ")[0]) ? 1 : 0));
    return Promise.resolve({ data: inputs.map((t) => ({ embedding: vec(t) })), usage: { prompt_tokens: 5 } });
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: embed } };
  return new LlmClient(CONFIG, { client });
}

const issueRefs = (tables: Record<string, Row[]>) =>
  tables.code_session_issues
    .filter((r) => r.session_id === "s1" && !r.retired_at)
    .map((r) => r.ref)
    .sort();

describe("tail-capture: a salvaged window is not a full run (issue #339)", () => {
  it("control: every window whole, a full run replaces the stored model issue rows", async () => {
    const tables = world();
    const summary = await runTailCaptureForSession(
      { supabase: makeFakeSupabase(tables), llm: llmFor(false) },
      "u1",
      "s1",
      {
        runId: "r1",
        sessionBudgetUsd: 10,
      },
    );
    expect(summary.windowsTotal).toBe(4);
    expect(summary.windowsFailed).toBe(0);
    expect(issueRefs(tables)).not.toContain(`${PROJECT}#9`);
  });

  it("the middle window salvaged: stored issue rows kept, every record written, checkpoint past the window", async () => {
    const tables = world();
    const summary = await runTailCaptureForSession(
      { supabase: makeFakeSupabase(tables), llm: llmFor(true) },
      "u1",
      "s1",
      {
        runId: "r1",
        sessionBudgetUsd: 10,
      },
    );
    expect(summary.windowsTotal).toBe(4);
    expect(summary.windowsFailed).toBe(0);
    // Not a full run: the stored model row is carried and grounded again, not replaced.
    expect(issueRefs(tables)).toContain(`${PROJECT}#9`);
    // Both whole windows' records and the salvaged one are written.
    const texts = tables.session_memories.map((m) => m.text).sort();
    expect(texts).toEqual(SENTENCES.map((s) => s.replace(/\.$/, "")).sort());
    // The salvaged window counts as covered: the checkpoint moves past it to the last turn.
    expect(tables.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(3);
    expect(tables.code_sessions[0].props.memory_extraction?.tail_turns_uncovered ?? 0).toBe(0);
    expect(JSON.stringify(tables.session_memories)).not.toContain("CUT-MARKER-0d4");
  });
});
