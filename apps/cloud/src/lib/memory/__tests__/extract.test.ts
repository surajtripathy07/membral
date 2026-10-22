import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import {
  buildBlockerReaskPrompt,
  buildUserPrompt,
  extractWindow,
  groundSessionIssues,
  issueRefNumber,
  PROMPT_VERSION,
  qualifyIssueRef,
  reaskBlockerResolutions,
  selectBlockerReaskLines,
} from "../extract";
import { renderTurnLines, type TurnRow } from "../render";
import { parseSessionIssues } from "../schema";
import { buildWindows } from "../windows";
import {
  BLOCKER_OPEN_LINE,
  BLOCKER_RESOLVED_LINE,
  LATE_BLOCKER_FOLLOW_LINE,
  LATE_BLOCKER_OPEN_IDX,
  RESOLVED_BLOCKER_OPEN_IDX,
  resolvedBlockerSessionLines,
} from "./fixtures/resolved-blocker-session";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function makeLlm(content: string): LlmClient {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return new LlmClient(CONFIG, { client });
}

/** Issue #162 (retry-on-empty): a sequence of responses, one per call, plus an optional hard USD cap. */
function llmReturning(contents: string[], opts?: { capUsd?: number }) {
  const create = vi.fn();
  for (const c of contents) {
    create.mockResolvedValueOnce({
      choices: [{ message: { content: c } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  }
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return { llm: new LlmClient(CONFIG, { client, capUsd: opts?.capUsd }), create };
}

function oneWindow() {
  const turns: TurnRow[] = [
    {
      idx: 0,
      role: "user",
      kind: "prose",
      text: "please fix the flaky retry test",
      tool_name: null,
      file_path: null,
      ts: null,
      props: null,
    },
  ];
  return buildWindows(renderTurnLines(turns))[0];
}

describe("extractWindow", () => {
  it("returns validated records on a well-formed response", async () => {
    const llm = makeLlm(
      JSON.stringify({
        records: [
          {
            kind: "decision",
            text: "Switched retry backoff to exponential",
            quote: "please fix the flaky retry test",
            turn_idx: 0,
            turn_role: "user",
            durable: true,
          },
        ],
      }),
    );
    const { result, costUsd, failed } = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(result.records).toHaveLength(1);
    expect(result.records[0].kind).toBe("decision");
    expect(costUsd).toBeGreaterThan(0);
    expect(failed).toBe(false);
  });

  it("yields zero records, never throws, on malformed JSON — and reports failed:true (finding 6)", async () => {
    const llm = makeLlm("this is not { valid json");
    const { result, costUsd, failed } = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(result.records).toEqual([]);
    expect(costUsd).toBe(0);
    expect(failed).toBe(true);
  });

  it("drops just the one bad record on a per-record schema violation (missing required outcome ref) — failed:false, siblings unaffected (step2e finding 6)", async () => {
    const llm = makeLlm(
      JSON.stringify({
        records: [
          { kind: "outcome", text: "Filed an issue", turn_idx: 0, turn_role: "user", durable: false },
          {
            kind: "decision",
            text: "Switched retry backoff to exponential",
            quote: "please fix the flaky retry test",
            turn_idx: 0,
            turn_role: "user",
            durable: true,
          },
        ],
      }),
    );
    const { result, failed, droppedNarration } = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    // The invalid outcome (no ref) is dropped; the valid decision survives —
    // a single bad record no longer fails the whole window's Zod parse.
    expect(result.records).toHaveLength(1);
    expect(result.records[0].kind).toBe("decision");
    expect(failed).toBe(false);
    expect(droppedNarration).toBe(0); // a missing ref is not a narration failure
  });

  it("drops a narrated preference (statement opens with a narration opener) as dropped_narration, siblings unaffected (step2e finding 6)", async () => {
    const llm = makeLlm(
      JSON.stringify({
        records: [
          {
            kind: "preference",
            statement: "The owner prefers dark mode by default",
            owner_quote: "please fix the flaky retry test",
            turn_idx: 0,
            turn_role: "user",
            durable: true,
            thread: "prefs",
          },
          {
            kind: "decision",
            text: "Switched retry backoff to exponential",
            quote: "please fix the flaky retry test",
            turn_idx: 0,
            turn_role: "user",
            durable: true,
          },
        ],
      }),
    );
    const { result, failed, droppedNarration } = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(result.records).toHaveLength(1);
    expect(result.records[0].kind).toBe("decision");
    expect(failed).toBe(false);
    expect(droppedNarration).toBe(1);
  });

  it("maps a well-formed preference's statement/owner_quote onto the common text/quote shape", async () => {
    const llm = makeLlm(
      JSON.stringify({
        records: [
          {
            kind: "preference",
            statement: "Setup should stay clean, with no extra background services.",
            owner_quote: "please fix the flaky retry test",
            turn_idx: 0,
            turn_role: "user",
            durable: true,
            thread: "prefs",
          },
        ],
      }),
    );
    const { result, droppedNarration } = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(result.records).toHaveLength(1);
    expect(result.records[0].text).toBe("Setup should stay clean, with no extra background services.");
    expect(result.records[0].quote).toBe("please fix the flaky retry test");
    expect(droppedNarration).toBe(0);
  });

  it("a record missing durable is kept (not dropped) and counted as durableDefaulted (step2f fix 1)", async () => {
    const llm = makeLlm(
      JSON.stringify({
        records: [
          {
            kind: "blocker",
            text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration",
            quote: "please fix the flaky retry test",
            turn_idx: 0,
            turn_role: "user",
            resolved_in_session: false,
            // durable intentionally omitted
          },
        ],
      }),
    );
    const { result, failed, durableDefaulted } = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(result.records).toHaveLength(1);
    expect(result.records[0].durable).toBe(true); // !resolved_in_session
    expect(failed).toBe(false);
    expect(durableDefaulted).toBe(1);
  });

  it("a record with durable present is not counted as durableDefaulted", async () => {
    const llm = makeLlm(
      JSON.stringify({
        records: [
          {
            kind: "decision",
            text: "Switched retry backoff to exponential",
            quote: "please fix the flaky retry test",
            turn_idx: 0,
            turn_role: "user",
            durable: true,
          },
        ],
      }),
    );
    const { durableDefaulted } = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(durableDefaulted).toBe(0);
  });

  it("yields zero records, never throws, on an empty response — failed:true (finding 6)", async () => {
    const llm = makeLlm("");
    const { result, failed } = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(result.records).toEqual([]);
    expect(failed).toBe(true);
  });
});

describe("extractWindow retry-on-empty (issue #162)", () => {
  const EMPTY = JSON.stringify({ records: [] });
  const ONE_RECORD = JSON.stringify({
    records: [
      {
        kind: "decision",
        text: "Switched retry backoff to exponential",
        quote: "please fix the flaky retry test",
        turn_idx: 0,
        turn_role: "user",
        durable: true,
      },
    ],
  });

  it("empty -> non-empty: uses the second (recovered) result", async () => {
    const { llm, create } = llmReturning([EMPTY, ONE_RECORD]);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.result.records).toHaveLength(1);
    expect(out.retriedEmpty).toBe(1);
    expect(out.retryRecovered).toBe(1);
    expect(out.retrySkippedBudget).toBe(0);
  });

  it("empty -> empty: makes exactly 2 calls, uses the (still empty) second result", async () => {
    const { llm, create } = llmReturning([EMPTY, EMPTY]);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.result.records).toEqual([]);
    expect(out.retriedEmpty).toBe(1);
    expect(out.retryRecovered).toBe(0);
  });

  it("non-empty: makes exactly 1 call, never retries", async () => {
    const { llm, create } = llmReturning([ONE_RECORD, ONE_RECORD]);
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.retriedEmpty).toBe(0);
  });

  it("skips the retry when already over budget, counting retrySkippedBudget", async () => {
    const { llm, create } = llmReturning([EMPTY, ONE_RECORD], { capUsd: 1e-9 });
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.result.records).toEqual([]);
    expect(out.retriedEmpty).toBe(0);
    expect(out.retrySkippedBudget).toBe(1);
  });

  it("RR-S1: skips the retry when canAffordRetry returns false, without needing overBudget", async () => {
    const { llm, create } = llmReturning([EMPTY, ONE_RECORD]);
    const canAffordRetry = () => false;
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1", false, canAffordRetry);
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.result.records).toEqual([]);
    expect(out.retriedEmpty).toBe(0);
    expect(out.retrySkippedBudget).toBe(1);
    expect(llm.overBudget()).toBe(false);
  });

  it("RR-S2: a retry that throws keeps the first (empty) result, failed:false, counts retryFailed", async () => {
    const create = vi.fn();
    create.mockResolvedValueOnce({
      choices: [{ message: { content: EMPTY } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    create.mockRejectedValueOnce(new Error("network error"));
    const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
    const llm = new LlmClient(CONFIG, { client });
    const out = await extractWindow(llm, "header", [], oneWindow(), "session-1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.result.records).toEqual([]);
    expect(out.failed).toBe(false);
    expect(out.retriedEmpty).toBe(1);
    expect(out.retryRecovered).toBe(0);
    expect(out.retryFailed).toBe(1);
    expect(out.costUsd).toBeGreaterThan(0);
  });
});

describe("buildUserPrompt (finding B)", () => {
  it("does not append the off-repo-strict note by default", () => {
    const prompt = buildUserPrompt("header text", [], oneWindow());
    expect(prompt).not.toContain("no files under this repo were touched");
  });

  it("appends a strict-mode note when offRepoStrict is true", () => {
    const prompt = buildUserPrompt("header text", [], oneWindow(), true);
    expect(prompt).toContain("no files under this repo were touched");
    expect(prompt.indexOf("header text")).toBeLessThan(prompt.indexOf("no files under this repo were touched"));
  });
});

describe("selectBlockerReaskLines (P8: the re-ask must see where a blocker gets resolved)", () => {
  const MAX = 400;

  it("regression: a resolution past the old first-400-lines horizon is in the re-ask excerpt", () => {
    const rendered = resolvedBlockerSessionLines();
    // The old selection (first MAX lines after the earliest blocker) never reached the resolution.
    const oldSelection = rendered
      .filter((t) => t.idx > RESOLVED_BLOCKER_OPEN_IDX)
      .slice(0, MAX)
      .map((t) => t.line);
    expect(oldSelection).not.toContain(BLOCKER_RESOLVED_LINE);

    const lines = selectBlockerReaskLines(rendered, [RESOLVED_BLOCKER_OPEN_IDX], MAX);
    expect(lines).toContain(BLOCKER_RESOLVED_LINE);
    expect(lines[lines.length - 1]).toBe(BLOCKER_RESOLVED_LINE); // the session's end is always shown
    expect(lines.filter((l) => !l.startsWith("[… ")).length).toBeLessThanOrEqual(MAX);
    expect(lines.some((l) => /^\[… \d+ lines omitted …\]$/.test(l))).toBe(true);
    expect(lines).not.toContain(BLOCKER_OPEN_LINE); // only lines AFTER the blocker
  });

  it("a later blocker gets the lines right after its own turn, not just the earliest blocker's", () => {
    const rendered = resolvedBlockerSessionLines();
    const lines = selectBlockerReaskLines(rendered, [RESOLVED_BLOCKER_OPEN_IDX, LATE_BLOCKER_OPEN_IDX], MAX);
    expect(lines).toContain(LATE_BLOCKER_FOLLOW_LINE);
  });

  it("a short tail is passed through whole, with no gap markers", () => {
    const rendered = resolvedBlockerSessionLines().slice(0, 10);
    const lines = selectBlockerReaskLines(rendered, [RESOLVED_BLOCKER_OPEN_IDX], MAX);
    expect(lines).toEqual(rendered.slice(2).map((t) => t.line));
  });

  it("no blockers or nothing after them yields no lines (the caller then skips the call)", () => {
    const rendered = resolvedBlockerSessionLines().slice(0, 3);
    expect(selectBlockerReaskLines(rendered, [], MAX)).toEqual([]);
    expect(selectBlockerReaskLines(rendered, [2], MAX)).toEqual([]);
  });

  it("the re-ask prompt says where each blocker was raised", () => {
    const prompt = buildBlockerReaskPrompt(
      [{ index: 0, text: "deploy token missing", quote: null, turn_idx: 1 }],
      ["x"],
    );
    expect(prompt).toContain("(raised at #1)");
  });
});

describe("reaskBlockerResolutions (M4, P10 review: verdicts must be keyed by a validated index set)", () => {
  const TWO_BLOCKERS = [
    { index: 0, text: "blocker A", quote: null, turn_idx: 1 },
    { index: 1, text: "blocker B", quote: null, turn_idx: 2 },
  ];

  it("a 1-based response (not the exact {0..N-1} set) is malformed — resolutions empty, cost still charged, failed:false", async () => {
    const llm = makeLlm(
      JSON.stringify({
        resolutions: [{ index: 1, resolved_in_session: true }],
      }),
    );
    const result = await reaskBlockerResolutions(
      llm,
      [{ index: 0, text: "blocker A", quote: null, turn_idx: 1 }],
      ["x"],
      "c1",
    );
    expect(result.failed).toBe(false);
    expect(result.resolutions.size).toBe(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("a duplicate index (indices not distinct) is malformed — resolutions empty", async () => {
    const llm = makeLlm(
      JSON.stringify({
        resolutions: [
          { index: 0, resolved_in_session: true },
          { index: 0, resolved_in_session: false },
        ],
      }),
    );
    const result = await reaskBlockerResolutions(
      llm,
      [{ index: 0, text: "blocker A", quote: null, turn_idx: 1 }],
      ["x"],
      "c1",
    );
    expect(result.resolutions.size).toBe(0);
  });

  it("an extra index beyond N-1 is malformed even if 0..N-1 are also present", async () => {
    const llm = makeLlm(
      JSON.stringify({
        resolutions: [
          { index: 0, resolved_in_session: true },
          { index: 1, resolved_in_session: false },
          { index: 2, resolved_in_session: false },
        ],
      }),
    );
    const result = await reaskBlockerResolutions(llm, TWO_BLOCKERS, ["x"], "c1");
    expect(result.resolutions.size).toBe(0);
  });

  it("the exact {0..N-1} set with one resolved is accepted and mapped back by index", async () => {
    const llm = makeLlm(
      JSON.stringify({
        resolutions: [
          { index: 0, resolved_in_session: true },
          { index: 1, resolved_in_session: false },
        ],
      }),
    );
    const result = await reaskBlockerResolutions(llm, TWO_BLOCKERS, ["x"], "c1");
    expect(result.resolutions.size).toBe(2);
    expect(result.resolutions.get(0)).toBe(true);
    expect(result.resolutions.get(1)).toBe(false);
  });
});

// ---- Session issues (code_session_issues, migration 099) --------------------

describe("session issues: schema fallback", () => {
  it("a missing, non-array, or malformed issues value yields [] and never costs the window's records", async () => {
    const record = {
      kind: "decision",
      text: "Retry backoff is exponential, not linear.",
      quote: "make the backoff exponential",
      turn_idx: 0,
      turn_role: "user",
      durable: true,
      thread: "retry backoff",
      scope: "project",
      confidence: 0.8,
    };
    const turns: TurnRow[] = [
      {
        idx: 0,
        role: "user",
        kind: "prose",
        text: "make the backoff exponential",
        tool_name: null,
        file_path: null,
        ts: null,
        props: null,
      },
    ];
    const [window] = buildWindows(renderTurnLines(turns));
    for (const issues of [undefined, "not a list", [{ ref: "#1" }, 42, null]]) {
      const res = await extractWindow(makeLlm(JSON.stringify({ records: [record], issues })), "h", [], window, "c1");
      expect(res.failed).toBe(false);
      expect(res.result.records).toHaveLength(1);
      expect(res.result.issues).toEqual([]);
    }
  });

  it("parseSessionIssues keeps valid elements and drops only the malformed ones", () => {
    const good = { ref: "#12", kind: "issue", role: "worked_on", evidence_quote: "fixes #12 for the retry path" };
    // An unknown role drops only the role (prompt v10: role is a hint), never the issue.
    const { role: _dropped, ...roleless } = good;
    expect(parseSessionIssues([good, { ...good, kind: "ticket" }, { ...good, role: "fixed" }, "x"])).toEqual([
      good,
      roleless,
    ]);
    expect(parseSessionIssues(null)).toEqual([]);
  });
});

describe("session issues: grounding", () => {
  const PROJECT = "codehub.example/codehub/parade-planner";
  const turns = [
    { idx: 3, role: "user", kind: "prose", text: "Starting on #123 — the float route overlaps the permit zone." },
    { idx: 7, role: "user", kind: "prose", text: "Unrelated, but group/other-project#9 has the same bug." },
    {
      idx: 9,
      role: "assistant",
      kind: "tool_use",
      text: null,
      props: { inputDigest: "codehub issue view 456 --comments" },
    },
  ];
  // These turns carry NO structured action at all (a pre-W3 CLI import): the
  // row is `inferred` — v4 item 7: no verb, so `referenced` whatever the model
  // said, and no share (no cost).
  const modelOnly = {
    review_verb: null,
    build_verb: null,
    tier: "inferred",
    turn_share: 0,
    related_to: [],
    role_source: "default",
  };

  it("keeps an entry whose quote is in the transcript and contains the number, with its turn_idx", () => {
    const out = groundSessionIssues(
      [{ ref: "#123", kind: "issue", evidence_quote: "Starting on #123 — the float route" }],
      turns,
      PROJECT,
    );
    expect(out).toEqual([
      {
        ref: `${PROJECT}#123`,
        number: 123,
        kind: "issue",
        role: "referenced",
        evidence_quote: "Starting on #123 — the float route",
        turn_idx: 3,
        ...modelOnly,
      },
    ]);
  });

  it("drops a quote that is not in the transcript", () => {
    const out = groundSessionIssues(
      [{ ref: "#123", kind: "issue", evidence_quote: "Closing #123 after the permit fix" }],
      turns,
      PROJECT,
    );
    expect(out).toEqual([]);
  });

  it("drops a quote that is in the transcript but lacks the ref's number", () => {
    const out = groundSessionIssues(
      [{ ref: "#124", kind: "issue", evidence_quote: "Starting on #123 — the float route" }],
      turns,
      PROJECT,
    );
    expect(out).toEqual([]);
    // 12 is a digit prefix of 123, not a standalone number.
    expect(
      groundSessionIssues(
        [{ ref: "#12", kind: "issue", evidence_quote: "Starting on #123 — the float route" }],
        turns,
        PROJECT,
      ),
    ).toEqual([]);
  });

  it("grounds against a tool call's input digest, and keeps a qualified ref as written", () => {
    const out = groundSessionIssues(
      [
        { ref: "456", kind: "issue", evidence_quote: "codehub issue view 456" },
        {
          ref: "group/other-project#9",
          kind: "issue",
          evidence_quote: "group/other-project#9 has the same bug",
        },
      ],
      turns,
      PROJECT,
    );
    expect(out.map((i) => [i.ref, i.turn_idx, i.role])).toEqual([
      [`${PROJECT}#456`, 9, "referenced"],
      ["group/other-project#9", 7, "referenced"],
    ]);
  });

  // ---- goal 2026-09-26 W4: observed beats inferred (B2), roles derived (B3/B5) ----

  /** Turn rows as tail-capture reads them (code_session_turns), with W3 actions on the tool_use rows. */
  const sessionTurns = [
    {
      idx: 0,
      role: "user",
      kind: "prose",
      tool_name: null,
      text: "fix https://codehub.example/codehub/parade-planner/-/issues/42 and mention #7 to the team",
      props: {
        action: {
          verb: "referenced",
          ref: "codehub/parade-planner#42",
          refKind: "issue",
          url: "https://codehub.example/codehub/parade-planner/-/issues/42",
          source: "paste",
        },
      },
    },
    { idx: 1, role: "assistant", kind: "tool_use", tool_name: "Edit", text: null, props: {} },
    { idx: 2, role: "user", kind: "tool_result", tool_name: "Edit", text: "[tool_result elided: ok]", props: {} },
    {
      idx: 3,
      role: "assistant",
      kind: "tool_use",
      tool_name: "Bash",
      text: null,
      props: {
        inputDigest: "git commit -am 'fix the float route'",
        action: { verb: "committed", refKind: "commit", sha: "abc1234", subject: "fix the float route", source: "cli" },
      },
    },
    { idx: 4, role: "user", kind: "tool_result", tool_name: "Bash", text: "[tool_result elided: ok]", props: {} },
    {
      idx: 5,
      role: "assistant",
      kind: "prose",
      tool_name: null,
      text: "Committed. #7 is the tracking epic.",
      props: {},
    },
  ];

  it("B2: the extractor's role is ignored — a model ref with no observed action is stored `discussed` with share 0, whatever the model said", () => {
    const out = groundSessionIssues(
      [{ ref: "#7", kind: "issue", role: "worked_on", evidence_quote: "mention #7 to the team" }],
      sessionTurns,
      PROJECT,
    );
    const seven = out.find((i) => i.ref === `${PROJECT}#7`);
    expect(seven).toMatchObject({
      role: "referenced",
      tier: "discussed",
      turn_share: 0,
      review_verb: null,
      build_verb: null,
    });
  });

  it("an observed ref is a row even when the model never named it, with the proving turn's own text as its receipt", () => {
    const out = groundSessionIssues([], sessionTurns, PROJECT);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      ref: `${PROJECT}#42`,
      number: 42,
      kind: "issue",
      role: "worked_on",
      build_verb: "committed",
      review_verb: null,
      tier: "observed",
      // v4 B1: an issue labels a commit; cost comes only from PR/branch evidence.
      turn_share: 0,
      turn_idx: 3,
    });
    expect(out[0].evidence_quote).toBe("git commit -am 'fix the float route'");
  });

  it("a ref both offered and observed is one row: the model's quote, the observed ladders, the derived role", () => {
    const out = groundSessionIssues(
      [
        {
          ref: "#42",
          kind: "issue",
          role: "referenced",
          evidence_quote: "fix https://codehub.example/codehub/parade-planner/-/issues/42",
        },
        { ref: "#7", kind: "issue", role: "worked_on", evidence_quote: "mention #7 to the team" },
      ],
      sessionTurns,
      PROJECT,
    );
    expect(out.map((i) => [i.ref, i.role, i.build_verb, i.turn_share])).toEqual([
      [`${PROJECT}#42`, "worked_on", "committed", 0],
      [`${PROJECT}#7`, "referenced", null, 0],
    ]);
    expect(out[0].evidence_quote).toBe("fix https://codehub.example/codehub/parade-planner/-/issues/42");
    expect(out[0].turn_idx).toBe(0);
  });

  it("B5: a discussion-only ref is discussed and never worked_on, even if the model calls it worked_on", () => {
    const discussion = [
      {
        idx: 0,
        role: "user",
        kind: "prose",
        tool_name: null,
        text: "thinking about https://codehub.example/codehub/parade-planner/-/issues/254 the epic",
        props: {
          action: { verb: "referenced", ref: "codehub/parade-planner#254", refKind: "issue", source: "paste" },
        },
      },
      {
        idx: 1,
        role: "assistant",
        kind: "prose",
        tool_name: null,
        text: "The epic #254 splits three ways.",
        props: {},
      },
      { idx: 2, role: "user", kind: "prose", tool_name: null, text: "agreed", props: {} },
    ];
    const out = groundSessionIssues(
      [{ ref: "#254", kind: "issue", role: "worked_on", evidence_quote: "The epic #254 splits three ways." }],
      discussion,
      PROJECT,
    );
    expect(out).toHaveLength(1);
    // v4 items 1+7: no verb → referenced, and a discussion carries no share (no cost).
    expect(out[0]).toMatchObject({ ref: `${PROJECT}#254`, role: "referenced", tier: "discussed", turn_share: 0 });
  });

  it("B3: a review reaching `reviewed` or a triage is worked_on; a viewed-only ref is discussed", () => {
    const review = [
      {
        idx: 0,
        role: "user",
        kind: "prose",
        tool_name: null,
        text: "/review-mr https://codehub.example/codehub/parade-planner/-/merge_requests/17",
        props: {
          action: {
            verb: "referenced",
            ref: "codehub/parade-planner!17",
            refKind: "merge_request",
            skill: "review-mr",
            source: "command",
          },
        },
      },
      {
        idx: 1,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        text: null,
        props: {
          inputDigest: "glab mr checkout 17",
          action: { verb: "checked_out", ref: "!17", refKind: "merge_request", source: "cli" },
        },
      },
      { idx: 2, role: "user", kind: "tool_result", tool_name: "Bash", text: "[tool_result elided: ok]", props: {} },
      {
        idx: 3,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        text: null,
        props: { inputDigest: "npm test", action: { verb: "tested", source: "cli" } },
      },
      { idx: 4, role: "user", kind: "tool_result", tool_name: "Bash", text: "[tool_result elided: ok]", props: {} },
      {
        idx: 5,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        text: null,
        props: {
          inputDigest: "glab issue view 9",
          action: { verb: "viewed", ref: "#9", refKind: "issue", state: "opened", source: "cli" },
        },
      },
      { idx: 6, role: "user", kind: "tool_result", tool_name: "Bash", text: "[tool_result elided: ok]", props: {} },
      {
        idx: 7,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        text: null,
        props: {
          inputDigest: "glab issue update 16002 --label needs-design",
          action: { verb: "triaged", ref: "#16002", refKind: "issue", source: "cli" },
        },
      },
      { idx: 8, role: "user", kind: "tool_result", tool_name: "Bash", text: "[tool_result elided: ok]", props: {} },
    ];
    const out = groundSessionIssues([], review, PROJECT);
    const byRef = Object.fromEntries(out.map((i) => [i.ref, i]));
    expect(byRef[`${PROJECT}#17`]).toMatchObject({
      kind: "merge_request",
      role: "worked_on",
      review_verb: "reviewed",
      build_verb: null,
    });
    expect(byRef[`${PROJECT}#9`]).toMatchObject({
      role: "referenced",
      review_verb: "viewed",
      turn_share: 0,
      related_to: [`${PROJECT}#17`],
    });
    // v4: triage alone is no verb on either ladder → referenced, and never a turn or a share.
    expect(byRef[`${PROJECT}#16002`]).toMatchObject({
      role: "referenced",
      review_verb: null,
      build_verb: null,
      turn_share: 0,
    });
    // v4 B2: the derived `reviewed` (checkout + reads/tests) is no review command — no share.
    expect(byRef[`${PROJECT}#17`].turn_share ?? 0).toBe(0);
  });
});

describe("session issues: ref qualification", () => {
  const PROJECT = "codehub.example/codehub/parade-planner";
  it("qualifies a bare ref with the session's project, so the same number in two repos never merges", () => {
    expect(qualifyIssueRef("#123", PROJECT, 123)).toBe(`${PROJECT}#123`);
    expect(qualifyIssueRef("123", "codehub.example/codehub/float-builder", 123)).toBe(
      "codehub.example/codehub/float-builder#123",
    );
    expect(qualifyIssueRef("!45", PROJECT, 45)).toBe(`${PROJECT}#45`);
  });

  it("maps a short owner/repo ref and a forge URL for this project onto the same key", () => {
    expect(qualifyIssueRef("codehub/parade-planner#7", PROJECT, 7)).toBe(`${PROJECT}#7`);
    expect(qualifyIssueRef("https://codehub.example/codehub/parade-planner/-/issues/7", PROJECT, 7)).toBe(
      `${PROJECT}#7`,
    );
    expect(qualifyIssueRef("https://codehub.example/codehub/parade-planner/pull/7#discussion", PROJECT, 7)).toBe(
      `${PROJECT}#7`,
    );
  });

  it("reads the number from a URL's item segment, not from its fragment", () => {
    expect(issueRefNumber("https://codehub.example/g/p/-/merge_requests/31#note_998")).toBe(31);
    expect(issueRefNumber("group/project#123")).toBe(123);
    expect(issueRefNumber("no number here")).toBeNull();
  });
});

describe("session issues: the prompt asks for role as a hint only (v10+)", () => {
  it("PROMPT_VERSION is v14 and the issues section names ref, kind, evidence_quote, a role hint and mentions", async () => {
    expect(PROMPT_VERSION).toBe("memory-extract-v26");
    const { llm, create } = llmReturning([JSON.stringify({ records: [], issues: [] })]);
    await extractWindow(llm, "h", [], oneWindow(), "c1");
    const sent = JSON.stringify(create.mock.calls[0][0]);
    const issuesSection = sent.slice(sent.indexOf('under \\"issues\\"'));
    expect(issuesSection).toContain("evidence_quote");
    expect(issuesSection).toContain("merge_request");
    expect(issuesSection).toMatch(/- role:/);
    // D-053 (v13): per-ref user mentions; pasted/relayed text and list positions are not mentions.
    expect(issuesSection).toMatch(/- mentions:/);
    expect(issuesSection).toContain("pasted or relays from someone else");
    expect(issuesSection).toContain("list position");
    // Review B1: banter or liking is not a decision (prompt-level), and agent lines may carry one.
    expect(sent).toContain("growing on me");
    expect(sent).toContain('an \\"assistant\\" line (the agent makes the call and acts on it)');
  });
});

describe("prompt v12: recurs_of in context, and deadline priorities", () => {
  const OFFERED = [
    { id: "11111111-aaaa-4aaa-8aaa-111111111111", text: "npm test hangs on the FX-rates fixture download" },
    { id: "22222222-bbbb-4bbb-8bbb-222222222222", text: "Migration 092 must be applied to the hosted database" },
  ];
  function windowOf(text: string) {
    const turns: TurnRow[] = [
      { idx: 0, role: "user", kind: "prose", text, tool_name: null, file_path: null, ts: null, props: null },
    ];
    return buildWindows(renderTurnLines(turns))[0];
  }

  it("offers the open blockers by label and maps a valid recurs_of back to the offered id; an unknown label is ignored", async () => {
    const quote = "die Tests hängen immer noch beim Download der Wechselkurs-Daten";
    const blocker = (recurs_of: unknown) => ({
      kind: "blocker",
      text: "Die Testsuite hängt beim Download der Wechselkurs-Testdaten.",
      quote,
      turn_idx: 0,
      turn_role: "user",
      resolved_in_session: false,
      thread: "fx fixture",
      recurs_of,
    });
    const { llm, create } = llmReturning([
      JSON.stringify({ records: [blocker("b1"), { ...blocker("b9"), text: "Ein zweiter Blocker ohne Verbindung." }] }),
    ]);
    const { result } = await extractWindow(llm, "header", [], windowOf(quote), "s1", false, () => true, OFFERED);
    const user = create.mock.calls[0][0].messages[1].content as string;
    expect(user).toContain("[b1] npm test hangs on the FX-rates fixture download");
    expect(user).toContain("[b2] Migration 092");
    expect(user).not.toContain(OFFERED[0].id);
    expect(result.records.map((r) => r.recurs_of)).toEqual([OFFERED[0].id, undefined]);
  });

  it("no offered list: recurs_of is never set, and the prompt carries no list", async () => {
    const quote = "npm test still hangs on the fixture download";
    const { llm, create } = llmReturning([
      JSON.stringify({
        records: [
          {
            kind: "blocker",
            text: "npm test hangs on the fixture download.",
            quote,
            turn_idx: 0,
            turn_role: "user",
            resolved_in_session: false,
            thread: "fx",
            recurs_of: "b1",
          },
        ],
      }),
    ]);
    const { result } = await extractWindow(llm, "header", [], windowOf(quote), "s1");
    expect(create.mock.calls[0][0].messages[1].content).not.toContain("Open blockers already recorded");
    expect(result.records[0].recurs_of).toBeUndefined();
  });

  it("a 'Friday's demo' commitment is a priority decision, never a blocker (S23)", async () => {
    const quote = "Friday's demo comes first, everything else waits";
    const { llm, create } = llmReturning([
      JSON.stringify({
        records: [
          {
            kind: "decision",
            text: "Friday's demo comes before all other work.",
            quote,
            turn_idx: 0,
            turn_role: "user",
            durable: false,
            priority: true,
            thread: "demo priority",
          },
        ],
      }),
    ]);
    const { result } = await extractWindow(llm, "header", [], windowOf(quote), "s1");
    const system = create.mock.calls[0][0].messages[0].content as string;
    expect(system).toMatch(/deadline or priority the OWNER sets[^\n]*is NOT a blocker/);
    expect(system).toMatch(/a named day, date, demo, or release as a deadline/);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ kind: "decision", priority: true });
  });
});
