// Goal 2026-09-26 W5 / P3 (D-051): recurrence is a count, not a merge (B7),
// and a blocker the tool calls observably closed is retired without an LLM
// call (B2, B6). Same fake supabase + real LlmClient over a fake OpenAILike
// transport as subagent-and-later-resolution.test.ts; the transport routes
// by system prompt so the test can assert which passes were called.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import {
  CROSS_SESSION_DUP_COSINE_THRESHOLD,
  dropCrossSessionDuplicates,
  type InsertableRecord,
  insertMemoryRecords,
  mergeSemanticDuplicates,
  RECURRENCE_COSINE_THRESHOLD,
  RESOLVED_LATER_RETIRE_REASON,
} from "@/lib/memory/write";
import {
  actionNamesRef,
  collectObservedActions,
  findObservedRetirements,
  type ObservedRetirementTurn,
  RESOLVED_OBSERVED_RETIRE_REASON,
  stripRepoHost,
} from "../observed-retirement";
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

/** Unit vector in 8 dims at a chosen cosine to e0 = [1,0,...]. */
const at = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0, 0, 0, 0, 0, 0];
const E0 = "[1,0,0,0,0,0,0,0]";

/**
 * A real LlmClient whose chat transport answers per pass and whose embedder
 * returns `embedFor(text)` when given, else a one-hot per input.
 */
function makeRoutedLlm(replies: Partial<Record<Pass, string>>, embedFor?: (text: string) => number[] | undefined) {
  const calls: Array<{ pass: Pass; user: string }> = [];
  const chatCreate = vi.fn().mockImplementation((body: { messages: Array<{ role: string; content: string }> }) => {
    const pass = passOf(body.messages[0].content);
    calls.push({ pass, user: body.messages[1]?.content ?? "" });
    const fallback = pass === "reask" || pass === "later" ? JSON.stringify({ resolutions: [] }) : '{"records":[]}';
    return Promise.resolve({
      choices: [{ message: { content: replies[pass] ?? fallback } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
  });
  const embedCreate = vi.fn().mockImplementation((body: { input: string | string[] }) => {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return Promise.resolve({
      data: inputs.map((text, i) => ({
        embedding: embedFor?.(text) ?? Array.from({ length: 8 }, (_, j) => (j === i % 8 ? 1 : 0)),
      })),
      usage: { prompt_tokens: 5 },
    });
  });
  const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: embedCreate } };
  return { llm: new LlmClient(CONFIG, { client }), calls };
}

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function sessionRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "s1",
    user_id: "u1",
    code_project_id: "p1",
    source: "claude-code",
    git_branch: "main",
    model: "claude-sonnet-5",
    started_at: iso(3 * DAY),
    ended_at: iso(3 * DAY - 600_000),
    duration_seconds: 600,
    files_touched: [],
    props: {},
    cwd: "/repo",
    parent_source_session_id: null,
    code_projects: { display_name: "Test Repo", repo_identity: "github.com/acme/billing" },
    ...overrides,
  };
}

function turnRow(overrides: Partial<Row> & Pick<Row, "idx" | "role" | "kind">): Row {
  return {
    session_id: "s2",
    user_id: "u1",
    text: null,
    tool_name: null,
    file_path: null,
    ts: iso(DAY - 60_000 * (overrides.idx as number)),
    props: {},
    ...overrides,
  };
}

const OLD_BLOCKER_TEXT = "The leaked CodeHub deploy key in src/deploy/keys.ts still needs rotation.";

function oldBlocker(over: Partial<Row> = {}): Row {
  return {
    id: "m-old",
    user_id: "u1",
    code_session_id: "s-old",
    code_project_id: "p1",
    kind: "blocker",
    text: OLD_BLOCKER_TEXT,
    quote: OLD_BLOCKER_TEXT,
    turn_idx: 0,
    turn_role: "assistant",
    supersedes: null,
    retired_at: null,
    retire_reason: null,
    recurs_of: null,
    recurrence_count: 1,
    ref: null,
    paths: ["src/deploy/keys.ts"],
    created_at: iso(2 * DAY),
    embedding: E0,
    content_hash: "h-m-old",
    scope: "project",
    ...over,
  };
}

/** Session s2 (yesterday) with the given turns; s-old (three days ago) owns the open blocker. */
function tables(turns: Row[], blocker: Row | null = oldBlocker()) {
  return {
    code_sessions: [
      sessionRow({ id: "s2", started_at: iso(DAY), ended_at: iso(DAY - 3_600_000) }),
      sessionRow({ id: "s-old" }),
    ],
    code_session_turns: turns,
    session_memories: blocker ? [blocker] : ([] as Row[]),
  };
}

const commitTurn = (idx: number, extra: Record<string, unknown> = {}): Row =>
  turnRow({
    idx,
    role: "assistant",
    kind: "tool_use",
    tool_name: "Bash",
    props: {
      inputDigest: "git commit -m 'rotate key'",
      action: { verb: "committed", sha: "abc1234def", branch: "main", source: "cli", ...extra },
    },
  });

const editTurn = (idx: number, filePath: string): Row =>
  turnRow({ idx, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: filePath });

// ---------------------------------------------------------------------------
// B7: recurrence is a count, not a merge.

describe("recurrence band (B7)", () => {
  it("the band sits just below the exact-duplicate drop threshold", () => {
    expect(RECURRENCE_COSINE_THRESHOLD).toBe(0.8);
    expect(RECURRENCE_COSINE_THRESHOLD).toBeLessThan(CROSS_SESSION_DUP_COSINE_THRESHOLD);
  });

  it("a blocker seen in two sessions counts 2 and is not merged", async () => {
    const NEW_TEXT = "Rotation of the leaked CodeHub deploy key is still pending in the org console.";
    const rows = tables([
      turnRow({ idx: 0, role: "user", kind: "prose", text: "is the key rotated yet?" }),
      turnRow({ idx: 1, role: "assistant", kind: "prose", text: `Not yet. ${NEW_TEXT}` }),
    ]);
    const { llm } = makeRoutedLlm(
      {
        main: JSON.stringify({
          records: [
            {
              kind: "blocker",
              text: NEW_TEXT,
              quote: NEW_TEXT,
              turn_idx: 1,
              turn_role: "assistant",
              durable: true,
              resolved_in_session: false,
              thread: "deploy key rotation",
            },
          ],
        }),
      },
      (text) => (text === NEW_TEXT ? at(0.85) : undefined),
    );
    // The Postgres semantic-dedup pass would pair the two at 0.85 — the
    // handler returns that pair no matter what ids it is asked about.
    const rpc = vi.fn().mockImplementation(() => {
      const fresh = rows.session_memories.find((r) => r.code_session_id === "s2");
      return {
        data: fresh
          ? [
              {
                new_id: fresh.id,
                existing_id: "m-old",
                sim: 0.85,
                kind: "blocker",
                new_created_at: iso(0),
                existing_created_at: iso(2 * DAY),
              },
            ]
          : [],
        error: null,
      };
    });

    await runTailCaptureForSession(
      { supabase: makeFakeSupabase(rows, { rpc: { memory_semantic_duplicates: rpc } }), llm },
      "u1",
      "s2",
      { runId: "r1" },
    );

    const blockers = rows.session_memories.filter((r) => r.kind === "blocker");
    expect(blockers).toHaveLength(2);
    const old = blockers.find((r) => r.id === "m-old");
    const fresh = blockers.find((r) => r.code_session_id === "s2");
    expect(old?.retired_at).toBeNull();
    // A live upsert never carries the `retired_at` key at all (column-homogeneous batches).
    expect(fresh?.retired_at ?? null).toBeNull();
    expect(fresh?.recurs_of).toBe("m-old");
    expect(old?.recurrence_count).toBe(2);
    expect(rows.code_sessions[0].props.memory_extraction.recurrences).toBe(1);
    expect(rows.code_sessions[0].props.memory_extraction.deduped).toBe(0);
  });

  it("dropCrossSessionDuplicates: >= 0.94 still drops, [0.80, 0.94) recurs against the chain's earliest row, < 0.80 is plain new", async () => {
    const live = (over: Record<string, unknown>) => ({
      user_id: "u1",
      code_project_id: "p1",
      code_session_id: "sess-old",
      kind: "blocker",
      retired_at: null,
      recurs_of: null,
      ...over,
    });
    const supabase = makeFakeSupabase({
      session_memories: [
        live({ id: "root", text: "root", embedding: E0, created_at: "2026-01-01T00:00:00Z" }),
        // A later recurrence of `root`: matching it must still point at `root`.
        live({ id: "child", text: "child", embedding: E0, created_at: "2026-01-05T00:00:00Z", recurs_of: "root" }),
        live({ id: "learning", kind: "learning", text: "l", embedding: E0, created_at: "2026-01-02T00:00:00Z" }),
        live({ id: "decision", kind: "decision", text: "d", embedding: E0, created_at: "2026-01-02T00:00:00Z" }),
      ],
    });
    const candidate = (over: Partial<InsertableRecord>) =>
      ({ kind: "blocker", text: "x", verified: true, embedding: null, contentHash: "h", ...over }) as InsertableRecord;
    const { kept, deduped, recurrences } = await dropCrossSessionDuplicates(supabase, "u1", "p1", "sess-new", [
      candidate({ text: "echo", embedding: at(0.97), contentHash: "a" }),
      candidate({ text: "again", embedding: at(0.85), contentHash: "b" }),
      candidate({ text: "learned again", kind: "learning", embedding: at(0.81), contentHash: "c" }),
      candidate({ text: "decided again", kind: "decision", embedding: at(0.85), contentHash: "d" }),
      candidate({ text: "different", embedding: at(0.7), contentHash: "e" }),
      candidate({ text: "headed retired", embedding: at(0.85), verified: false, contentHash: "f" }),
    ]);
    expect(deduped).toBe(1);
    // B7 names blockers only: the learning at 0.81 is a plain new row, never a recurrence.
    expect(recurrences).toBe(1);
    expect(kept.map((r) => [r.contentHash, r.recursOf ?? null])).toEqual([
      ["b", "root"],
      ["c", null],
      ["d", null],
      ["e", null],
      ["f", null],
    ]);
  });

  it("insertMemoryRecords writes recurs_of and bumps the root's count once per new fact, never for a re-derived one", async () => {
    const rows: Record<string, Row[]> = {
      session_memories: [
        { id: "root", user_id: "u1", code_session_id: "s-old", recurrence_count: 1, content_hash: "h-root" },
        // This session already stored `seen` in an earlier run (any state).
        { id: "prior", user_id: "u1", code_session_id: "s2", content_hash: "seen", retired_at: null },
      ],
    };
    const rec = (contentHash: string): InsertableRecord =>
      ({
        kind: "blocker",
        text: contentHash,
        quote: null,
        turn_idx: 0,
        turn_role: "assistant",
        ref: null,
        ref_kind: null,
        thread: null,
        paths: [],
        verified: true,
        durable: true,
        scope: "project",
        confidence: 1,
        contentHash,
        embedding: null,
        windowIndex: 0,
        recursOf: "root",
      }) as unknown as InsertableRecord;
    await insertMemoryRecords(makeFakeSupabase(rows), "u1", "p1", "s2", "main", [rec("fresh"), rec("seen")]);
    expect(rows.session_memories.find((r) => r.content_hash === "fresh")?.recurs_of).toBe("root");
    expect(rows.session_memories.find((r) => r.id === "root")?.recurrence_count).toBe(2);
  });

  it("mergeSemanticDuplicates leaves a recurrence row alone on either side of a pair", async () => {
    const rows: Record<string, Row[]> = {
      session_memories: [
        { id: "old", user_id: "u1", retired_at: null, supersedes: null },
        { id: "rec", user_id: "u1", retired_at: null, supersedes: null, recurs_of: "old" },
        { id: "twin-a", user_id: "u1", retired_at: null, supersedes: null, created_at: "2026-01-01T00:00:00Z" },
        { id: "twin-b", user_id: "u1", retired_at: null, supersedes: null, created_at: "2026-01-02T00:00:00Z" },
      ],
      memory_merges: [],
    };
    const pair = (new_id: string, existing_id: string) => ({
      new_id,
      existing_id,
      sim: 0.9,
      kind: "blocker",
      new_created_at: "2026-01-02T00:00:00Z",
      existing_created_at: "2026-01-01T00:00:00Z",
    });
    const rpc = vi
      .fn()
      .mockReturnValue({ data: [pair("rec", "old"), pair("twin-b", "rec"), pair("twin-b", "twin-a")], error: null });
    const retired = await mergeSemanticDuplicates(
      makeFakeSupabase(rows, { rpc: { memory_semantic_duplicates: rpc } }),
      "u1",
      ["rec", "twin-b"],
      0.8,
      ["blocker"],
      new Set(["rec"]),
    );
    expect(rpc.mock.calls[0][0].p_record_ids).toEqual(["twin-b"]);
    expect(retired).toBe(1);
    expect(rows.session_memories.find((r) => r.id === "rec")?.retired_at).toBeNull();
    expect(rows.session_memories.find((r) => r.id === "old")?.retired_at).toBeNull();
    expect(rows.session_memories.find((r) => r.id === "twin-a")?.retired_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P3: observed retirement before the LLM check.

describe("observed blocker retirement (P3, B2, B6)", () => {
  it("closure evidence only: an edit + commit on the blocker's file does not retire it — the LLM check decides", async () => {
    const rows = tables([
      turnRow({ idx: 0, role: "user", kind: "prose", text: "please rotate the leaked key" }),
      editTurn(1, "/repo/src/deploy/keys.ts"),
      commitTurn(2),
      turnRow({ idx: 3, role: "assistant", kind: "prose", text: "Rotated and committed." }),
    ]);
    const { llm, calls } = makeRoutedLlm({});

    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s2", { runId: "r1" });

    expect(calls.filter((c) => c.pass === "later")).toHaveLength(1);
    const old = rows.session_memories.find((r) => r.id === "m-old");
    expect(old?.retired_at).toBeNull();
    expect(rows.code_sessions[0].props.memory_extraction.blockers_resolved_observed).toBe(0);
  });

  it("a blocker with no later action still goes to the LLM check as before", async () => {
    const rows = tables(
      [
        turnRow({ idx: 0, role: "user", kind: "prose", text: "look at the deploy key issue" }),
        // A `viewed` on the ref is not closure; an edit of another file plus a commit is not this blocker's path.
        turnRow({
          idx: 1,
          role: "assistant",
          kind: "tool_use",
          tool_name: "Bash",
          props: { action: { verb: "viewed", ref: "acme/billing#42", refKind: "issue", source: "cli" } },
        }),
        editTurn(2, "/repo/src/other.ts"),
        commitTurn(3),
        turnRow({ idx: 4, role: "assistant", kind: "prose", text: "Looked at it; nothing changed on the key yet." }),
      ],
      oldBlocker({ ref: "#42" }),
    );
    const { llm, calls } = makeRoutedLlm({});

    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s2", { runId: "r1" });

    const later = calls.filter((c) => c.pass === "later");
    expect(later).toHaveLength(1);
    expect(later[0].user).toContain(OLD_BLOCKER_TEXT);
    const old = rows.session_memories.find((r) => r.id === "m-old");
    expect(old?.retired_at).toBeNull();
    expect(rows.code_sessions[0].props.memory_extraction.blockers_resolved_observed).toBe(0);
  });

  it("an observed closure on the blocker's ref retires it and only the remaining blockers reach the model", async () => {
    const other = oldBlocker({
      id: "m-other",
      text: "The CodeHub release pipeline is waiting on a signing certificate.",
      quote: "The CodeHub release pipeline is waiting on a signing certificate.",
      paths: [],
      content_hash: "h-m-other",
    });
    const rows = tables(
      [
        turnRow({ idx: 0, role: "user", kind: "prose", text: "merge the key rotation MR" }),
        turnRow({
          idx: 1,
          role: "assistant",
          kind: "tool_use",
          tool_name: "Bash",
          props: {
            action: {
              verb: "merged",
              ref: "acme/billing!17",
              refKind: "merge_request",
              state: "merged",
              source: "cli",
            },
          },
        }),
        turnRow({ idx: 2, role: "assistant", kind: "prose", text: "Merged the rotation MR." }),
      ],
      oldBlocker({ ref: "!17", paths: [] }),
    );
    rows.session_memories.push(other);
    const { llm, calls } = makeRoutedLlm({});

    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s2", { runId: "r1" });

    const later = calls.filter((c) => c.pass === "later");
    expect(later).toHaveLength(1);
    expect(later[0].user).not.toContain(OLD_BLOCKER_TEXT);
    expect(later[0].user).toContain("signing certificate");
    const old = rows.session_memories.find((r) => r.id === "m-old");
    expect(old?.retire_reason).toBe(RESOLVED_OBSERVED_RETIRE_REASON);
    expect(old?.resolution_quote).toBe("merged !17");
    expect(old?.resolution_turn_idx).toBe(1);
    expect(rows.session_memories.find((r) => r.id === "m-other")?.retired_at).toBeNull();
    expect(RESOLVED_OBSERVED_RETIRE_REASON).not.toBe(RESOLVED_LATER_RETIRE_REASON);
  });
});

describe("observed-retirement.ts (pure)", () => {
  const cand = (over: Partial<{ ref: string | null; paths: string[] | null }> = {}) => ({
    id: "b1",
    ref: null,
    paths: null,
    ...over,
  });
  const bash = (idx: number, action: unknown, extra: Record<string, unknown> = {}): ObservedRetirementTurn => ({
    idx,
    tool_name: "Bash",
    file_path: null,
    props: { action, ...extra },
  });

  const REPO = "github.com/acme/app";

  it("actionNamesRef: same ref means same repo — a bare ref is the session's own repo", () => {
    expect(actionNamesRef({ ref: "acme/app#42" }, "#42", REPO)).toBe(true);
    expect(actionNamesRef({ ref: "#42" }, "acme/app#42", REPO)).toBe(true);
    expect(actionNamesRef({ ref: "github.com/acme/app#42" }, "acme/app#42", REPO)).toBe(true);
    expect(actionNamesRef({ ref: "other/lib#42" }, "#42", REPO)).toBe(false);
    expect(actionNamesRef({ ref: "other/repo#42" }, "acme/app#42", REPO)).toBe(false);
    expect(actionNamesRef({ ref: "acme/app!42" }, "#42", REPO)).toBe(false);
    // No known repo: bare matches bare only.
    expect(actionNamesRef({ ref: "#42" }, "#42", null)).toBe(true);
    expect(actionNamesRef({ ref: "acme/app#42" }, "#42", null)).toBe(false);
    expect(actionNamesRef({ ref: "#42" }, "#42", "code-project:p1")).toBe(true);
    expect(actionNamesRef({ sha: "abc1234def5678" }, "abc1234d")).toBe(true);
    expect(actionNamesRef({ sha: "abc1234def5678" }, "abc12")).toBe(false);
    expect(actionNamesRef({ branch: "fix/rotate-key" }, "fix/rotate-key")).toBe(true);
    expect(actionNamesRef({ ref: "fix/rotate-key" }, "fix/other")).toBe(false);
    expect(actionNamesRef({}, "")).toBe(false);
    expect(stripRepoHost("github.com/Acme/App")).toBe("acme/app");
    expect(stripRepoHost("gitlab.example.com/group/sub/repo")).toBe("group/sub/repo");
    expect(stripRepoHost("acme/app")).toBe("acme/app");
  });

  it("closure only: a WIP commit that refs #42 leaves the blocker on #42 open", () => {
    const turns = [
      bash(1, { verb: "committed", ref: "#42", sha: "abc1234", source: "cli" }),
      bash(2, { verb: "pushed", ref: "acme/app#42", branch: "wip", source: "cli" }),
      bash(3, { verb: "opened_mr", ref: "acme/app!43", source: "cli" }),
      { idx: 4, tool_name: "Edit", file_path: "/repo/src/index.ts", props: {} },
    ];
    expect(findObservedRetirements([cand({ ref: "#42", paths: ["index.ts"] })], turns, { repoIdentity: REPO })).toEqual(
      [],
    );
  });

  it("closure only: other/lib#42 merged leaves this repo's #42 blocker open", () => {
    const turns = [bash(1, { verb: "merged", ref: "other/lib#42", state: "merged", source: "cli" })];
    expect(findObservedRetirements([cand({ ref: "#42" })], turns, { repoIdentity: REPO })).toEqual([]);
  });

  it("closure only: this repo's !42 merged retires the blocker on !42", () => {
    const turns = [bash(5, { verb: "merged", ref: "acme/app!42", source: "cli" })];
    expect(findObservedRetirements([cand({ ref: "!42" })], turns, { repoIdentity: REPO })).toEqual([
      { memoryId: "b1", turnIdx: 5, evidence: "merged !42" },
    ]);
    // A forge state on a view counts as closure too; a plain view does not.
    expect(
      findObservedRetirements([cand({ ref: "#7" })], [bash(1, { verb: "viewed", ref: "#7", state: "closed" })], {
        repoIdentity: REPO,
      }),
    ).toEqual([{ memoryId: "b1", turnIdx: 1, evidence: "closed #7" }]);
    expect(
      findObservedRetirements([cand({ ref: "#7" })], [bash(1, { verb: "viewed", ref: "#7" })], { repoIdentity: REPO }),
    ).toEqual([]);
  });

  it("paths alone never retire: an edit + commit on the named file is not closure", () => {
    const edit: ObservedRetirementTurn = { idx: 2, tool_name: "Write", file_path: "src/a.ts", props: {} };
    const commit = bash(3, { verb: "committed", sha: "abc1234", source: "cli" });
    expect(findObservedRetirements([cand({ paths: ["src/a.ts"] })], [edit, commit], { repoIdentity: REPO })).toEqual(
      [],
    );
  });

  it("branch closure: a blocker on a branch merged AND gone retires on the session's last turn; merged-only does not", () => {
    const turns = [
      bash(1, { verb: "viewed", ref: "#1", source: "cli" }),
      bash(9, { verb: "committed", sha: "abc1234" }),
    ];
    const merged = { branch: "fix/rotate-key", merged_at: "2026-09-01T00:00:00Z", branch_gone_at: null };
    expect(findObservedRetirements([cand({ ref: "fix/rotate-key" })], turns, { branchStates: [merged] })).toEqual([]);
    expect(
      findObservedRetirements([cand({ ref: "fix/rotate-key" })], turns, {
        branchStates: [{ ...merged, branch_gone_at: "2026-09-02T00:00:00Z" }],
      }),
    ).toEqual([{ memoryId: "b1", turnIdx: 9, evidence: "branch fix/rotate-key merged, then deleted" }]);
    // A pushed branch is not closure; a merge on it is.
    expect(findObservedRetirements([cand({ ref: "fix/x" })], [bash(2, { verb: "pushed", branch: "fix/x" })])).toEqual(
      [],
    );
    expect(findObservedRetirements([cand({ ref: "fix/x" })], [bash(2, { verb: "merged", branch: "fix/x" })])).toEqual([
      { memoryId: "b1", turnIdx: 2, evidence: "merged fix/x" },
    ]);
  });

  it("chained `actions[]` are read too, without double-counting the headline action", () => {
    const turn = bash(
      4,
      { verb: "pushed", branch: "main", source: "cli" },
      {
        actions: [
          { verb: "merged", ref: "acme/app!9", source: "cli" },
          { verb: "pushed", branch: "main", source: "cli" },
        ],
      },
    );
    expect(collectObservedActions([turn]).map((a) => a.verb)).toEqual(["pushed", "merged"]);
    expect(findObservedRetirements([cand({ ref: "!9" })], [turn], { repoIdentity: REPO })).toEqual([
      { memoryId: "b1", turnIdx: 4, evidence: "merged !9" },
    ]);
  });

  it("B12: malformed action props never throw and yield no retirement", () => {
    const turns: ObservedRetirementTurn[] = [
      bash(0, "committed"),
      bash(1, { verb: 42, ref: "#7" }),
      bash(2, { ref: "#7" }),
      bash(3, ["committed"]),
      bash(4, null, { actions: "nope" }),
      bash(5, { verb: "committed", ref: 7, sha: {} }),
      { idx: 6, tool_name: "Bash", file_path: null, props: null },
      { idx: 7, tool_name: "Bash", file_path: null, props: "string props" },
      { idx: 8, tool_name: "Edit", file_path: "src/a.ts", props: undefined },
    ];
    const candidates = [
      cand({ ref: "#7", paths: ["src/a.ts"] }),
      cand({ paths: [null, 3, "src/a.ts"] as unknown as string[] }),
    ];
    expect(() => findObservedRetirements(candidates, turns)).not.toThrow();
    expect(findObservedRetirements(candidates, turns)).toEqual([]);
    expect(collectObservedActions(turns).map((a) => a.verb)).toEqual(["committed"]);
  });
});
