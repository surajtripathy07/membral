import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { isoWeek } from "../dogfood-signals";
import {
  buildQuestionnaireJudgePrompt,
  jaccard,
  judgeQuestionnaire,
  normalizeInjectedLine,
  parseQuestionnaireAnswers,
  QUESTIONNAIRE_JUDGE_SYSTEM_PROMPT,
  QUESTIONS,
  QuestionnairePostSchema,
  questionnaireAgreement,
  summarizeAgreement,
} from "../questionnaire";

const L1 = "- [decision] Queue retries use exponential backoff capped at 30 s";
const L2 = "- [outcome] The import route returns 504 after 10 s on large files";

describe("questions", () => {
  it("match the CLI's text and stay neutral", () => {
    const cli = readFileSync(join(__dirname, "../../../../../../packages/cli/src/questionnaire.ts"), "utf8");
    for (const q of Object.values(QUESTIONS)) expect(cli).toContain(JSON.stringify(q));
    for (const q of Object.values(QUESTIONS)) expect(q).not.toMatch(/membral|useful/i);
  });
});

describe("parseQuestionnaireAnswers (turn-pointer rule)", () => {
  it("drops items without a turn pointer, keeps the rest", () => {
    const a = parseQuestionnaireAnswers({
      q1: [{ line: L1, turn: "switching retries to backoff" }, { line: L2 }, { line: L2, turn: "ok" }],
      q2: [],
    });
    expect(a?.q1).toHaveLength(1);
    expect(a?.q3).toEqual([]);
  });
  it("is null for a malformed shape", () => {
    expect(parseQuestionnaireAnswers("x")).toBeNull();
    expect(parseQuestionnaireAnswers({ q1: {} })).toBeNull();
  });
  it("upload body requires each question once in the order", () => {
    expect(
      QuestionnairePostSchema.safeParse({ session: "s1", order: ["q2", "q1", "q4", "q3"], answers: {} }).success,
    ).toBe(true);
    expect(
      QuestionnairePostSchema.safeParse({ session: "s1", order: ["q1", "q1", "q4", "q3"], answers: {} }).success,
    ).toBe(false);
  });
});

describe("judge", () => {
  it("prompt carries the injected lines and transcript only — never a self-report", () => {
    const prompt = buildQuestionnaireJudgePrompt([L1], ["1. user: fix the queue"]);
    expect(prompt).toContain(L1);
    expect(QUESTIONNAIRE_JUDGE_SYSTEM_PROMPT).not.toMatch(/self-report|the session's own answer/i);
    // The signature has no slot for one.
    expect(judgeQuestionnaire.length).toBe(5);
  });

  it("validates the reply, resolves turn pointers, never throws", async () => {
    const callJson = vi.fn(
      async (): Promise<{ data: unknown; record: { cost_usd: number } }> => ({
        data: { q1: [{ line: L1, turn: "switching retries to backoff" }, { line: L2 }], q2: "bad-but-ignored-not" },
        record: { cost_usd: 0 },
      }),
    );
    const llm = { callJson } as unknown as LlmClient;
    const turns = [{ idx: 7, text: "Ok, switching retries to backoff now." }];
    const malformed = await judgeQuestionnaire(llm, [L1], ["l"], turns, "c1");
    expect(malformed.answers).toBeNull();
    callJson.mockResolvedValueOnce({
      data: { q1: [{ line: L1, turn: "switching retries to backoff" }, { line: L2 }] },
      record: { cost_usd: 0 },
    });
    const ok = await judgeQuestionnaire(llm, [L1], ["l"], turns, "c1");
    expect(ok.answers?.q1).toEqual([{ line: L1, turn: "switching retries to backoff", turn_idx: 7 }]);
    callJson.mockRejectedValueOnce(new Error("boom"));
    expect((await judgeQuestionnaire(llm, [L1], ["l"], turns, "c1")).failed).toBe(true);
    expect((await judgeQuestionnaire(llm, [], ["l"], turns, "c1")).answers).toBeNull();
  });
});

describe("agreement math", () => {
  it("normalises markers, case, punctuation and URLs", () => {
    expect(normalizeInjectedLine("1. [Decision] Queue retries! https://x.y/z")).toBe("decision queue retries");
  });
  it("Jaccard over quoted lines, partial quotes match", () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard([L1], [])).toBe(0);
    expect(jaccard([L1], ["Queue retries use exponential backoff capped at 30 s"])).toBe(1);
    expect(jaccard([L1, L2], [L1])).toBe(0.5);
    expect(jaccard([L1], [L2])).toBe(0);
  });
  it("per question, and summarised per week over sessions with both answers", () => {
    const self = { q1: [{ line: L1, turn: "xxxxxxxx" }], q2: [], q3: [{ line: L2, turn: "xxxxxxxx" }], q4: [] };
    const judge = { q1: [{ line: L1, turn: "yyyyyyyy" }], q2: [{ line: L2, turn: "yyyyyyyy" }], q3: [], q4: [] };
    expect(questionnaireAgreement(self, judge)).toEqual({ q1: 1, q2: 0, q3: 0, q4: 1 });
    const s = summarizeAgreement(
      [
        { source_session_id: "a", source: "self", answers: self, created_at: "2026-10-06T10:00:00Z" },
        { source_session_id: "a", source: "judge", answers: judge, created_at: "2026-10-06T11:00:00Z" },
        { source_session_id: "b", source: "self", answers: self, created_at: "2026-10-07T10:00:00Z" },
      ],
      isoWeek,
    );
    expect(s.totals).toEqual({ sessions: 1, q1: 1, q2: 0, q3: 0, q4: 1 });
    expect(s.weeks).toEqual([{ week: "2026-W41", sessions: 1, q1: 1, q2: 0, q3: 0, q4: 1 }]);
    expect(summarizeAgreement([], isoWeek).totals.q1).toBeNull();
  });
});
