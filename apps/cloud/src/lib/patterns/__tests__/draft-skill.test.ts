// Goal 2026-09-26 P9 / W10 — the LLM draft is Zod-validated with a heuristic fallback (CLAUDE.md rule 3).
import { describe, expect, it, vi } from "vitest";
import { draftSkill, heuristicSkill, renderSkillBody, type SkillDraftLlm, SkillDraftSchema } from "../draft-skill";
import type { Pattern } from "../mine";

const pattern: Pattern = {
  key: "npm test → Edit ts → git commit",
  steps: ["npm test", "Edit ts", "git commit"],
  sessionCount: 9,
  sessionIds: ["s9", "s8", "s1", "s2"],
  lastSeenAt: "2026-09-25T10:00:00Z",
};

/** A fake LlmClient.callJson that behaves like the real one: runs the schema on the model's JSON and throws on mismatch. */
function fakeLlm(raw: unknown): SkillDraftLlm & { calls: number } {
  const llm = {
    calls: 0,
    async callJson<T>(opts: { schema?: { parse: (d: unknown) => T } }) {
      llm.calls++;
      const data = opts.schema ? opts.schema.parse(raw) : (raw as T);
      return { data, record: {} as never, callCostUsd: 0.001 };
    },
  };
  return llm as unknown as SkillDraftLlm & { calls: number };
}

describe("draftSkill", () => {
  it("a malformed LLM draft falls back to the heuristic steps and never throws", async () => {
    const malformed = fakeLlm({ name: "", steps: "not an array" });
    const draft = await draftSkill(pattern, malformed, { projectId: "p1" });
    expect(malformed.calls).toBe(1);
    expect(draft.source).toBe("heuristic");
    expect(draft.steps).toEqual(["Run `npm test`", "Edit the .ts files", "Run `git commit`"]);
    expect(draft).toEqual(heuristicSkill(pattern));
  });

  it("an LLM that throws (cap, timeout) also yields the heuristic draft", async () => {
    const failing = {
      callJson: vi.fn().mockRejectedValue(new Error("KG cost cap exceeded")),
    } as unknown as SkillDraftLlm;
    const draft = await draftSkill(pattern, failing, { projectId: "p1" });
    expect(draft.source).toBe("heuristic");
    expect(draft.steps).toHaveLength(3);
  });

  it("a well-formed LLM draft is used, its name slugified", async () => {
    const good = fakeLlm({
      name: "Test Edit Commit",
      description: "Run the tests, fix, commit.",
      steps: ["Run npm test", "Fix the .ts files", "Commit"],
    });
    const draft = await draftSkill(pattern, good, { projectId: "p1", projectName: "codehub/billing" });
    expect(draft).toEqual({
      name: "test-edit-commit",
      description: "Run the tests, fix, commit.",
      steps: ["Run npm test", "Fix the .ts files", "Commit"],
      source: "llm",
      sources: [],
    });
  });

  it("no LLM → heuristic without any call", async () => {
    const draft = await draftSkill(pattern, null, { projectId: "p1" });
    expect(draft.source).toBe("heuristic");
    expect(draft.name).toBe("test-edit-commit");
    expect(draft.description).toContain("9 sessions");
  });

  it("the schema rejects an empty steps list and over-long fields", () => {
    expect(SkillDraftSchema.safeParse({ name: "x", description: "y", steps: [] }).success).toBe(false);
    expect(SkillDraftSchema.safeParse({ name: "x", description: "y".repeat(401), steps: ["a"] }).success).toBe(false);
    expect(SkillDraftSchema.safeParse({ name: "x", description: "y", steps: ["a"] }).success).toBe(true);
  });

  it("renderSkillBody is a SKILL.md with frontmatter, the observed sequence and numbered steps", () => {
    const body = renderSkillBody(heuristicSkill(pattern), pattern);
    expect(body.startsWith('---\nname: "test-edit-commit"\ndescription: "')).toBe(true);
    expect(body).toContain("Observed in 9 sessions as `npm test → Edit ts → git commit`.");
    expect(body).toContain("1. Run `npm test`\n2. Edit the .ts files\n3. Run `git commit`");
  });

  it("F14: a model description with `: ` and `#` stays one quoted YAML scalar", () => {
    const draft = { ...heuristicSkill(pattern), description: 'Note: run tests # then "commit"\nnow' };
    const body = renderSkillBody(draft, pattern);
    const line = body.split("\n")[2];
    expect(line).toBe('description: "Note: run tests # then \\"commit\\" now"');
    expect(JSON.parse(line.slice("description: ".length))).toBe('Note: run tests # then "commit" now');
  });

  it("P9 chain: pattern → sessions → quotes — the draft is asked from, and cites, only the pattern's own sessions", async () => {
    const quotes = [
      { session_id: "s9", turn_idx: 0, quote: "make the debits idempotent" },
      { session_id: "elsewhere", turn_idx: 0, quote: "not one of the pattern's sessions" },
      { session_id: "s8", turn_idx: 2, quote: "fix the flaky test   and commit" },
    ];
    const callJson = vi.fn().mockResolvedValue({
      data: { name: "Test Edit Commit", description: "d", steps: ["a"] },
    });
    const draft = await draftSkill(pattern, { callJson } as unknown as SkillDraftLlm, { projectId: "p1", quotes });
    expect(draft.sources).toEqual([
      { session_id: "s9", turn_idx: 0, quote: "make the debits idempotent" },
      { session_id: "s8", turn_idx: 2, quote: "fix the flaky test and commit" },
    ]);
    for (const q of draft.sources) expect(pattern.sessionIds).toContain(q.session_id);
    const prompt = callJson.mock.calls[0][0].userPrompt as string;
    expect(prompt).toContain('"make the debits idempotent"');
    expect(prompt).not.toContain("not one of the pattern's sessions");
    const body = renderSkillBody(draft, pattern);
    expect(body).toContain("## Mined from");
    expect(body).toContain('- session s9, turn 0: "make the debits idempotent"');
    // The heuristic fallback carries the same chain.
    expect(heuristicSkill(pattern, quotes).sources.map((q) => q.session_id)).toEqual(["s9", "s8"]);
  });
});
