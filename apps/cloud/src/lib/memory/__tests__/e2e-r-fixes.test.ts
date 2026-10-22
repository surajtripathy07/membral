// E2E run R (2026-09-27) fixes on the extraction side, from trimmed real transcripts of that run
// (owner names replaced with a fictional one):
//   R-4 a recurring blocker the USER pass finds is linked through its recurs_of (the main pass, offered
//       the open blockers, returned nothing in the live run); a hint on either copy survives the collapse
//   R-7 an owner/repo the model mistyped is re-qualified to the project, never a second row
//   R-3 S05 "For #53: …": a too-short evidence quote no longer drops the entry when a mention grounds
//   R-1/R-9 the prompts define priority and preference the way the maintainer asked

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { groundSessionIssues } from "../extract";
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

function makeRoutedLlm(replies: Partial<Record<Pass, string>>, embedFor: (text: string) => number[] | undefined) {
  const calls: Array<{ pass: Pass; system: string; user: string }> = [];
  const chatCreate = vi.fn().mockImplementation((body: { messages: Array<{ role: string; content: string }> }) => {
    const pass = passOf(body.messages[0].content);
    calls.push({ pass, system: body.messages[0].content, user: body.messages[1]?.content ?? "" });
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
        embedding: embedFor(text) ?? Array.from({ length: 8 }, (_, j) => (j === (i % 7) + 1 ? 1 : 0)),
      })),
      usage: { prompt_tokens: 5 },
    });
  });
  const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: embedCreate } };
  return { llm: new LlmClient(CONFIG, { client }), calls };
}

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// Real rows of e2e2-glab's S09: the −3 d session's blocker, then the −1 d session's user line.
const FIRST_FX = "FX fixture download timeout in tests is blocking progress";
const AGAIN_QUOTE = "npm test hangs on the FX-rates fixture download, again";
const AGAIN_TEXT = "npm test is hanging on the FX-rates fixture download";

function fxTables(): Record<string, Row[]> {
  const sessionRow = (id: string, startedAgo: number): Row => ({
    id,
    user_id: "u1",
    code_project_id: "p1",
    source: "claude-code",
    git_branch: "main",
    model: "claude-haiku-4-5",
    started_at: iso(startedAgo),
    ended_at: iso(startedAgo - 600_000),
    duration_seconds: 600,
    files_touched: [],
    props: {},
    cwd: "/repo",
    parent_source_session_id: null,
    code_projects: { display_name: "acme/billing", repo_identity: "codehub.example/acme/billing" },
  });
  return {
    code_sessions: [sessionRow("s-1d", DAY), sessionRow("s-3d", 3 * DAY)],
    code_session_turns: [
      { session_id: "s-1d", user_id: "u1", idx: 0, role: "user", kind: "prose", text: AGAIN_QUOTE, ts: iso(DAY) },
      {
        session_id: "s-1d",
        user_id: "u1",
        idx: 1,
        role: "assistant",
        kind: "prose",
        text: "Let me look at the fixture loader.",
        ts: iso(DAY - 60_000),
      },
    ],
    session_memories: [
      {
        id: "m-fx",
        user_id: "u1",
        code_session_id: "s-3d",
        code_project_id: "p1",
        kind: "blocker",
        text: FIRST_FX,
        quote: "FX fixture download timeout in tests is still blocking",
        turn_idx: 0,
        turn_role: "user",
        supersedes: null,
        retired_at: null,
        retire_reason: null,
        recurs_of: null,
        recurrence_count: 1,
        ref: null,
        paths: [],
        created_at: iso(2 * DAY),
        embedding: "[1,0,0,0,0,0,0,0]",
        content_hash: "h-m-fx",
        scope: "project",
      },
    ],
  };
}

const userPassBlocker = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    records: [
      {
        kind: "blocker",
        text: AGAIN_TEXT,
        quote: AGAIN_QUOTE,
        turn_idx: 0,
        turn_role: "user",
        durable: true,
        resolved_in_session: false,
        thread: "FX fixture hang",
        ...extra,
      },
    ],
  });

describe("R-4: a recurring blocker found by the user-turn pass is linked", () => {
  // Real cosine between the two rows' embeddings: 0.663 — below the 0.80 band.
  const embed = (t: string) => (t === AGAIN_TEXT ? at(0.663) : undefined);
  const rpc = { memory_semantic_duplicates: vi.fn().mockResolvedValue({ data: [], error: null }) };

  it("live order: the main pass (offered b1) returns nothing, the user pass says recurs_of b1 → one chain, seen 2×", async () => {
    const rows = fxTables();
    const { llm, calls } = makeRoutedLlm(
      { main: '{"records":[],"issues":[]}', user: userPassBlocker({ recurs_of: "b1" }) },
      embed,
    );
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows, { rpc }), llm }, "u1", "s-1d", { runId: "r" });

    const userCall = calls.find((c) => c.pass === "user");
    expect(userCall?.user).toContain(`[b1] ${FIRST_FX}`);
    const fresh = rows.session_memories.find((r) => r.code_session_id === "s-1d" && r.kind === "blocker");
    expect(fresh?.recurs_of).toBe("m-fx");
    expect(rows.session_memories.find((r) => r.id === "m-fx")?.recurrence_count).toBe(2);
  });

  it("both passes find it and only the main pass links it: the kept copy keeps the link", async () => {
    const rows = fxTables();
    const mainRecord = JSON.parse(userPassBlocker({ recurs_of: "b1" })) as { records: unknown[] };
    const { llm } = makeRoutedLlm(
      { main: JSON.stringify({ records: mainRecord.records, issues: [] }), user: userPassBlocker() },
      embed,
    );
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows, { rpc }), llm }, "u1", "s-1d", { runId: "r" });
    const fresh = rows.session_memories.filter((r) => r.code_session_id === "s-1d" && r.kind === "blocker");
    expect(fresh).toHaveLength(1);
    expect(fresh[0].recurs_of).toBe("m-fx");
  });

  it("R-1/R-9: both prompts define priority as stated importance and preference as a lasting way of working", async () => {
    const rows = fxTables();
    const { llm, calls } = makeRoutedLlm({}, embed);
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows, { rpc }), llm }, "u1", "s-1d", { runId: "r" });
    for (const pass of ["main", "user"] as const) {
      const system = calls.find((c) => c.pass === pass)?.system ?? "";
      expect(system).toContain("is an instruction");
      expect(system).toContain("that's the priority");
      expect(system).toContain("should still hold in a future session on OTHER tasks");
    }
  });
});

// ---- grounding (pure) ----------------------------------------------------------

type T = Parameters<typeof groundSessionIssues>[1][number];

// Run R BFLOW (trimmed): the model's reply typo'd the owner in a URL, and one issue entry took it.
const PROJECT = "github.com/acmedev/audiobooks";
const BFLOW: T[] = [
  {
    idx: 0,
    role: "user",
    kind: "prose",
    text: "Issue #21 on this repo says run.sh is a zsh script and the README doesn't say so. Check it and fix the README.",
  },
  {
    idx: 10,
    role: "user",
    kind: "prose",
    text: "Put it on a branch e2e/r-zsh-note (reset local main back to origin/main), commit referencing #21, push the branch, and open a PR titled '[e2e] README: run.sh needs zsh' with 'Fixes #21' in the body and the e2e label.",
  },
  {
    idx: 15,
    role: "assistant",
    kind: "tool_use",
    tool_name: "Bash",
    text: null,
    props: {
      action: { sha: "3e75bf3", verb: "committed", branch: "e2e/r-zsh-note", source: "cli", refKind: "commit" },
      inputDigest: "git add README.md && git commit -m ‹text› && git log --oneline -1",
    },
  },
  {
    idx: 17,
    role: "assistant",
    kind: "tool_use",
    tool_name: "Bash",
    text: null,
    props: {
      action: { ref: "e2e/r-zsh-note", verb: "pushed", branch: "e2e/r-zsh-note", source: "cli", refKind: "branch" },
      inputDigest: "git push -u origin e2e/r-zsh-note",
    },
  },
  {
    idx: 23,
    role: "assistant",
    kind: "prose",
    text: "Done! PR created: https://github.com/acmedevv/audiobooks/pull/23\n\n- Branch `e2e/r-zsh-note` pushed with commit referencing #21",
  },
];

describe("R-7: a model-typed owner/repo is re-qualified to the project, never a second row", () => {
  it("BFLOW: the typo'd #21 and the project's #21 are one row", () => {
    const out = groundSessionIssues(
      [
        {
          ref: "#21",
          kind: "issue",
          role: "worked_on",
          evidence_quote: "Issue #21 on this repo",
          mentions: [{ turn_idx: 0, quote: "Issue #21 on this repo" }],
        },
        {
          ref: "acmedevv/audiobooks#21",
          kind: "issue",
          role: "worked_on",
          evidence_quote: "commit referencing #21",
          mentions: [{ turn_idx: 10, quote: "commit referencing #21" }],
        },
      ],
      BFLOW,
      PROJECT,
      { actionsVersion: 1, inferRef: true },
    );
    const rows21 = out.filter((r) => r.number === 21);
    expect(rows21.map((r) => r.ref)).toEqual([`${PROJECT}#21`]);
    expect(rows21[0].build_verb).toBe("pushed");
  });

  it("a foreign repo the receipt line itself names stays that repo", () => {
    const turns: T[] = [{ idx: 0, role: "user", kind: "prose", text: "compare with other/lib#5 before you start" }];
    const out = groundSessionIssues(
      [{ ref: "other/lib#5", kind: "issue", role: "referenced", evidence_quote: "compare with other/lib#5" }],
      turns,
      PROJECT,
      { actionsVersion: 1 },
    );
    expect(out.map((r) => r.ref)).toEqual(["other/lib#5"]);
  });
});

// Run R S05E (trimmed, real): the commit names no ref; the developer named #53 in the first line.
const S05E: T[] = [
  { idx: 0, role: "user", kind: "prose", text: "For #53: fix the heading levels in docs/ (only docs/), commit." },
  { idx: 9, role: "assistant", kind: "tool_use", tool_name: "Edit", text: null },
  {
    idx: 12,
    role: "assistant",
    kind: "tool_use",
    tool_name: "Bash",
    text: null,
    props: {
      action: { verb: "committed", source: "cli", refKind: "commit" },
      inputDigest: "git add docs/guide.md && git commit -q -m ‹text›",
    },
  },
];

describe("R-3: a short evidence quote no longer drops an issue whose mention grounds", () => {
  it('S05 "For #53": the row exists and carries the commit (D-053 on)', () => {
    const out = groundSessionIssues(
      [
        {
          ref: "#53",
          kind: "issue",
          role: "worked_on",
          evidence_quote: "For #53",
          mentions: [{ turn_idx: 0, quote: "For #53" }],
        },
      ],
      S05E,
      "codehub.example/acme/billing",
      { actionsVersion: 1, inferRef: true },
    );
    expect(out.map((r) => [r.ref, r.build_verb, r.tier])).toEqual([
      ["codehub.example/acme/billing#53", "committed", "inferred_ref"],
    ]);
  });

  it("with no grounded mention the too-short quote still drops the entry", () => {
    const out = groundSessionIssues(
      [{ ref: "#53", kind: "issue", role: "worked_on", evidence_quote: "For #53" }],
      S05E,
      "codehub.example/acme/billing",
      { actionsVersion: 1, inferRef: true },
    );
    expect(out).toEqual([]);
  });
});

describe("backfill Q1: a life rule stated in passing is the owner's preference (v16)", () => {
  // Shape of the real t34 line (names and details fictional): one sentence of a
  // standing rule inside a longer status update.
  const T34 =
    "quick update: the vendor approved the quote, the review is on Saturday, and we agree we should build something we would be okay maintaining, so skip the throwaway prototypes";
  const T36 = "commit quietly with -q";
  const QUOTE = "we should build something we would be okay maintaining";

  function tables(): Record<string, Row[]> {
    const base = fxTables();
    const turn = (idx: number, role: string, text: string): Row => ({
      session_id: "s-1d",
      user_id: "u1",
      idx,
      role,
      kind: "prose",
      text,
      ts: iso(DAY - idx * 1000),
    });
    return {
      ...base,
      session_memories: [],
      code_session_turns: [
        turn(33, "assistant", "Noted. Anything else on the vendor search?"),
        turn(34, "user", T34),
        turn(35, "assistant", "Got it. Shall I commit the listing filter?"),
        turn(36, "user", T36),
        turn(37, "assistant", "Committed."),
      ],
    };
  }

  it("the user pass proposes the preference from t34; it survives grounding and the owner gate; the one-off leaves nothing", async () => {
    const rows = tables();
    const user = JSON.stringify({
      records: [
        {
          kind: "preference",
          statement: "Buy only a home we would be okay living in ourselves.",
          owner_quote: QUOTE,
          turn_idx: 34,
          turn_role: "user",
          durable: true,
          thread: "home purchase rule",
          scope: "global",
          confidence: 0.9,
        },
      ],
    });
    const { llm, calls } = makeRoutedLlm({ main: '{"records":[],"issues":[]}', user }, () => undefined);
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows, { rpc: {} }), llm }, "u1", "s-1d", {
      runId: "r",
    });

    for (const pass of ["main", "user"] as const) {
      const system = calls.find((c) => c.pass === pass)?.system ?? "";
      expect(system).toContain("in work OR life");
      expect(system).toContain("is an instruction");
    }
    const prefs = rows.session_memories.filter((r) => r.kind === "preference" && !r.retired_at);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({ turn_idx: 34, turn_role: "user" });
    expect(String(prefs[0].quote)).toContain("build something we would be okay maintaining");
    expect(rows.session_memories.some((r) => r.turn_idx === 36)).toBe(false);
  });
});
