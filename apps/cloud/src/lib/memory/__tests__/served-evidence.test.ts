import { describe, expect, it } from "vitest";
import type { TurnRow } from "../render";
import {
  capEvidenceLines,
  SERVED_EVIDENCE_LINE_MAX_CHARS,
  SERVED_EVIDENCE_TOOL_RESULT_BUDGET_CHARS,
  SERVED_EVIDENCE_TOOL_RESULT_MAX_CHARS,
  SERVED_EVIDENCE_TOTAL_MAX_CHARS,
  servedVerdictEvidence,
  servedVerdictsEnabled,
  shouldRunQuestionnaireJudge,
} from "../tail-capture";

const turn = (
  idx: number,
  kind: TurnRow["kind"],
  text: string | null,
  role: TurnRow["role"] = "assistant",
): TurnRow => ({
  idx,
  role,
  kind,
  text,
  tool_name: kind === "prose" ? null : "Bash",
  file_path: null,
  ts: null,
  props: null,
});

describe("servedVerdictEvidence", () => {
  it("includes tool_result output, redacted and cut, and returns the same turns for receipts", () => {
    const long = `deploy target is sin1 — contact ops@example.com ${"x".repeat(1000)}`;
    const { lines, turns } = servedVerdictEvidence(
      [
        turn(0, "prose", "check the region", "user"),
        turn(1, "tool_use", "vercel inspect"),
        turn(2, "tool_result", long, "user"),
        turn(3, "thinking", "hmm"),
        turn(5, "tool_result", "[tool_result elided: ok]", "user"),
        turn(4, "prose", "the region is sin1"),
      ],
      false,
    );
    expect(lines.some((l) => l.startsWith("[#2 user tool_result] deploy target is sin1"))).toBe(true);
    expect(lines.join("\n")).not.toContain("ops@example.com");
    expect(lines.some((l) => l.includes("tool_use"))).toBe(false);
    const result = turns.find((t) => t.idx === 2);
    expect(result?.text?.length).toBeLessThanOrEqual(SERVED_EVIDENCE_TOOL_RESULT_MAX_CHARS);
    expect(result?.text).not.toContain("ops@example.com");
    expect(turns.map((t) => t.idx)).toEqual([0, 2, 4]);
    expect(lines.join("\n")).not.toContain("elided");
  });

  it("drops placeholder-only tool results so they never crowd out prose, and redacts secrets in kept text", () => {
    const all = [
      turn(0, "prose", "what failed", "user"),
      ...Array.from({ length: 40 }, (_, i) => turn(i + 1, "tool_result", "[tool_result elided: error]", "user")),
      turn(41, "tool_result", "[tool_result elided: ok]\nAPI_TOKEN=abcdef1234567890SECRET", "user"),
      turn(42, "prose", "it was the token"),
    ];
    const { lines, turns } = servedVerdictEvidence(all, false);
    expect(turns.map((t) => t.idx)).toEqual([0, 41, 42]);
    expect(lines.join("\n")).not.toContain("abcdef1234567890SECRET");
  });

  it("keeps tool_result lines within a total budget, latest first", () => {
    const n = Math.ceil(SERVED_EVIDENCE_TOOL_RESULT_BUDGET_CHARS / SERVED_EVIDENCE_TOOL_RESULT_MAX_CHARS) + 5;
    const all = Array.from({ length: n }, (_, i) => turn(i, "tool_result", "y".repeat(2000), "user"));
    const { turns } = servedVerdictEvidence(all, false);
    const total = turns.reduce((sum, t) => sum + (t.text?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(SERVED_EVIDENCE_TOOL_RESULT_BUDGET_CHARS);
    expect(turns.at(-1)?.idx).toBe(n - 1);
    expect(turns[0]?.idx).toBeGreaterThan(0);
  });
});

describe("shouldRunQuestionnaireJudge", () => {
  it("runs only on the local claude-code provider", () => {
    expect(shouldRunQuestionnaireJudge({ isClaudeCodeProvider: true })).toBe(true);
    expect(shouldRunQuestionnaireJudge({ isClaudeCodeProvider: false })).toBe(false);
  });
});

describe("evidence block caps", () => {
  it("cuts each line and keeps the newest whole lines within the total", () => {
    const long = "x".repeat(SERVED_EVIDENCE_LINE_MAX_CHARS + 500);
    expect(capEvidenceLines([long])[0]).toHaveLength(SERVED_EVIDENCE_LINE_MAX_CHARS);
    const many = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")}${"y".repeat(997)}`);
    const kept = capEvidenceLines(many);
    expect(kept.reduce((n, l) => n + l.length, 0)).toBeLessThanOrEqual(SERVED_EVIDENCE_TOTAL_MAX_CHARS);
    expect(kept.at(-1)?.startsWith("099")).toBe(true);
    expect(kept.every((l) => l.length === 1000)).toBe(true);
    expect(kept[0]?.startsWith("099")).toBe(false);
  });

  it("servedVerdictEvidence output stays under the total cap for a huge session", () => {
    const turns = Array.from({ length: 400 }, (_, i) => turn(i, "prose", "word ".repeat(400)));
    const { lines } = servedVerdictEvidence(turns, false);
    expect(lines.join("").length).toBeLessThanOrEqual(SERVED_EVIDENCE_TOTAL_MAX_CHARS);
  });
});

describe("servedVerdictsEnabled", () => {
  it("is off on hosted, on for a local stack or an explicit flag, and killable", () => {
    expect(servedVerdictsEnabled({})).toBe(false);
    expect(servedVerdictsEnabled({ VERCEL: "1" })).toBe(false);
    expect(servedVerdictsEnabled({ MEMBRAL_LOCAL: "1" })).toBe(true);
    expect(servedVerdictsEnabled({ MEMBRAL_SERVED_VERDICTS: "1" })).toBe(true);
    expect(servedVerdictsEnabled({ MEMBRAL_LOCAL: "1", MEMBRAL_SERVED_VERDICTS: "0" })).toBe(false);
  });
});
