// Prompt v20: both extraction passes say a memory records what the session
// did, in past tense, never the current state of a forge item (D-074), and
// that a record about one MR/PR or issue carries it as ref. Review fixes 3a/3b/5a:
// the tense rule is scoped by kind and a signed ref needs its sign in the quote. Read from the
// request the LLM actually receives.
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { extractUserTurnPass, extractWindow, refQuotedOrDropped } from "../extract";
import { renderTurnLines, type TurnRow } from "../render";
import type { MemoryRecordParsed } from "../schema";
import { buildWindows } from "../windows";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function capturingLlm() {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ records: [], issues: [] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return { llm: new LlmClient(CONFIG, { client }), create };
}

function window() {
  const turns: TurnRow[] = [
    {
      idx: 0,
      role: "user",
      kind: "prose",
      text: "open a draft MR for this",
      tool_name: null,
      file_path: null,
      ts: null,
      props: null,
    },
  ];
  return buildWindows(renderTurnLines(turns))[0];
}

async function prompts(): Promise<Record<string, string>> {
  const main = capturingLlm();
  await extractWindow(main.llm, "header", [], window(), "s1");
  const user = capturingLlm();
  await extractUserTurnPass(user.llm, "header", window(), "s1");
  return {
    window: main.create.mock.calls[0][0].messages[0].content as string,
    "user-turn": user.create.mock.calls[0][0].messages[0].content as string,
  };
}

// The rule lines as the model must see them (extract.ts keeps them private).
const PAST_ACTION = [
  "For a decision or outcome about a forge action or item (an MR/PR, issue, or pipeline), write what happened",
  'good: "Closed issue #12 after the fix shipped."',
  'Bad: "MR !14 is open." / "Issue #12 is closed." / "The pipeline is green."',
  "A learning keeps present tense.",
];
const BLOCKER_TENSE = [
  "A blocker may describe its waiting state in present tense, but must name what it waits on",
  'good: "Migration 120 waits on a prod backup by the maintainer."',
];
const REF_FILL = [
  "When a record is about one specific MR/PR or issue",
  "Pick a quote that proves the record AND contains the item's number",
  "if no such quote exists, leave ref out — never shorten a quote to fit the number",
  'quote "opened draft MR !14 to split the per-user usage totals by day", ref "!14", ref_kind "mr". Bad: the same record with no ref.',
];

describe("extraction prompts: past-tense actions and ref filling (v20)", () => {
  it.each([
    "window",
    "user-turn",
  ])("the %s pass prompt states the ref rule and the blocker tense rule", async (pass) => {
    const system = (await prompts())[pass];
    for (const line of [...BLOCKER_TENSE, ...REF_FILL]) expect(system).toContain(line);
  });

  it("only the window pass carries the past-tense rule, scoped to decisions and outcomes", async () => {
    const p = await prompts();
    for (const line of PAST_ACTION) expect(p.window).toContain(line);
    expect(p["user-turn"]).not.toContain("write what happened");
    expect(p["user-turn"]).toContain("A preference's statement stays an imperative or declarative rule.");
  });

  it("the Good ref example quote is a full sentence (>= 8 words, >= 40 chars)", () => {
    const quote = "opened draft MR !14 to split the per-user usage totals by day";
    expect(quote.split(/\s+/).length).toBeGreaterThanOrEqual(8);
    expect(quote.length).toBeGreaterThanOrEqual(40);
  });
});

describe("refQuotedOrDropped: a signed ref needs its signed form in the quote (review 3a)", () => {
  const decision = (quote: string, ref: string, ref_kind: "mr" | "pr" | "issue" = "mr"): MemoryRecordParsed => ({
    kind: "decision",
    text: "Per-user usage totals are split by day.",
    quote,
    ref,
    ref_kind,
    turn_idx: 3,
    turn_role: "assistant",
    durable: true,
    paths: [],
    scope: "project",
    confidence: 0.8,
  });

  it("drops ref !14 (keeps the record) when the quote has #14", () => {
    const kept = refQuotedOrDropped(decision("#14 tracks the per-user usage split", "!14"));
    expect(kept).not.toBeNull();
    expect(kept?.ref).toBeUndefined();
    expect(kept?.ref_kind).toBeUndefined();
  });

  it("drops ref !14 when the quote has only a bare 14", () => {
    const kept = refQuotedOrDropped(decision("14 tests failed after the usage split", "!14"));
    expect(kept).not.toBeNull();
    expect(kept?.ref).toBeUndefined();
  });

  it("keeps ref !14 when the quote has !14", () => {
    expect(refQuotedOrDropped(decision("opened !14 to split the per-user usage totals", "!14"))?.ref).toBe("!14");
  });

  it("keeps a URL ref when the quote carries its path, or the matching sign", () => {
    const url = "https://codehub.example/g/p/-/merge_requests/14";
    expect(refQuotedOrDropped(decision(`pushed to ${url} with the split`, url))?.ref).toBe(url);
    expect(refQuotedOrDropped(decision("pushed to !14 with the split", url))?.ref).toBe(url);
    expect(refQuotedOrDropped(decision("14 tests failed after the split", url))?.ref).toBeUndefined();
    const issueUrl = "https://codehub.example/o/r/issues/12";
    expect(refQuotedOrDropped(decision("see #12 for the split", issueUrl, "issue"))?.ref).toBe(issueUrl);
  });

  it("a qualified ref needs its #N; an unsigned ref keeps bare-number matching", () => {
    expect(refQuotedOrDropped(decision("fixed g/p#123 in the split", "g/p#123", "issue"))?.ref).toBe("g/p#123");
    expect(refQuotedOrDropped(decision("fixed 123 rows in the split", "g/p#123", "issue"))?.ref).toBeUndefined();
    expect(refQuotedOrDropped(decision("issue 14 tracks the split", "14", "issue"))?.ref).toBe("14");
  });

  it("a forge noun before a bare number carries the sign: CLI commands and prose", () => {
    expect(refQuotedOrDropped(decision("gh pr merge 45 --squash", "#45", "pr"))?.ref).toBe("#45");
    expect(refQuotedOrDropped(decision("glab mr merge 14", "!14"))?.ref).toBe("!14");
    expect(refQuotedOrDropped(decision("gh issue close 12", "#12", "issue"))?.ref).toBe("#12");
    expect(refQuotedOrDropped(decision("gh pr comment 45 with the plan", "#45", "pr"))?.ref).toBe("#45");
    expect(refQuotedOrDropped(decision("reviewed merge request 14 today", "!14"))?.ref).toBe("!14");
    expect(refQuotedOrDropped(decision("PR 45 adds the split", "#45", "pr"))?.ref).toBe("#45");
    // The noun says MR, so "#14" mismatches: a non-outcome loses the ref.
    expect(refQuotedOrDropped(decision("glab mr merge 14", "#14", "issue"))?.ref).toBeUndefined();
  });

  it("an outcome keeps its ref on sign_absent (grounding checks it) and is dropped on number_absent", () => {
    const outcome = (quote: string, ref: string) => ({ ...decision(quote, ref), kind: "outcome" as const });
    expect(refQuotedOrDropped(outcome("gh pr merge 45 --squash", "#45"))?.ref).toBe("#45");
    expect(refQuotedOrDropped(outcome("glab mr merge 14", "!14"))?.ref).toBe("!14");
    expect(refQuotedOrDropped(outcome("glab mr merge 14", "#14"))?.ref).toBe("#14");
    expect(refQuotedOrDropped(outcome("#14 tracks the split", "!14"))?.ref).toBe("!14");
    expect(refQuotedOrDropped(outcome("merged the usage split", "!14"))).toBeNull();
    expect(refQuotedOrDropped(outcome("", "!14"))).toBeNull();
  });
});
