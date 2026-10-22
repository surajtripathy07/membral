// Session-page viewer-check fixes: session-wide sub-agent matching (D2),
// the opencode parent-side join (D3), prompt comment stripping (D4), the
// child breadcrumb and turn-count labels.
import { describe, expect, it } from "vitest";
import {
  type ChildSessionForMatch,
  matchChildSessionsToTurns,
  parentBreadcrumbLabel,
  parseSubAgentSpawnIndex,
  stripHtmlComments,
  type TurnRow,
  turnCountsLabel,
} from "../view";

function turn(idx: number, toolUseId: string | null = null): TurnRow {
  return {
    idx,
    role: "assistant",
    kind: toolUseId ? "tool_use" : "prose",
    text: null,
    tool_name: toolUseId ? "Task" : null,
    file_path: null,
    ts: null,
    toolUseId,
  };
}

function child(id: string, overrides: Partial<ChildSessionForMatch> = {}): ChildSessionForMatch {
  return {
    id,
    agentId: null,
    parentAgentId: null,
    agentType: "explore",
    description: null,
    toolUseId: null,
    turnCount: 3,
    ...overrides,
  };
}

describe("matchChildSessionsToTurns — session-wide (D2)", () => {
  it("puts a child whose spawn turn is outside the rendered window in `hidden`, not `unmatched`", () => {
    const rendered = [turn(1, "toolu_a"), turn(2)];
    const allToolUses = [
      { idx: 1, toolUseId: "toolu_a" },
      { idx: 640, toolUseId: "toolu_z" },
      { idx: 600, toolUseId: "toolu_y" },
    ];
    const a = child("a", { toolUseId: "toolu_a" });
    const y = child("y", { toolUseId: "toolu_y" });
    const z = child("z", { toolUseId: "toolu_z" });
    const lost = child("lost", { toolUseId: "toolu_nowhere" });
    const res = matchChildSessionsToTurns(rendered, [z, lost, a, y], { allToolUses });
    expect(res.byTurnIdx.get(1)).toBe(a);
    expect(res.hidden).toEqual([
      { child: y, turnIdx: 600 },
      { child: z, turnIdx: 640 },
    ]);
    expect(res.unmatched).toEqual([lost]);
  });

  it("without the whole-session index, behaves as before (no hidden)", () => {
    const res = matchChildSessionsToTurns([turn(1, "toolu_a")], [child("z", { toolUseId: "toolu_z" })]);
    expect(res.hidden).toEqual([]);
    expect(res.unmatched.map((c) => c.id)).toEqual(["z"]);
  });
});

describe("matchChildSessionsToTurns — opencode parent-side join (D3)", () => {
  it("joins a child with no toolUseId via the parent's props.subAgents[] agentId -> toolUseId", () => {
    const index = parseSubAgentSpawnIndex({
      subAgents: [{ agentId: "ses_child1", toolUseId: "toolu_01" }, { agentId: "ses_child2" }, null, "junk"],
    });
    expect([...index]).toEqual([["ses_child1", "toolu_01"]]);
    const c1 = child("c1", { agentId: "ses_child1" });
    const c2 = child("c2", { agentId: "ses_child2" });
    const res = matchChildSessionsToTurns([turn(17, "toolu_01")], [c1, c2], { toolUseIdByAgentId: index });
    expect(res.byTurnIdx.get(17)).toBe(c1);
    expect(res.unmatched).toEqual([c2]);
  });

  it("tolerates missing or malformed props", () => {
    expect(parseSubAgentSpawnIndex(null).size).toBe(0);
    expect(parseSubAgentSpawnIndex({ subAgents: "x" }).size).toBe(0);
  });
});

describe("stripHtmlComments (D4)", () => {
  it("drops HTML comments, including multi-line ones, and trims", () => {
    expect(stripHtmlComments("Do the audit. <!-- OMO_INTERNAL_INITIATOR -->")).toBe("Do the audit.");
    expect(stripHtmlComments("a <!-- x\ny --> b")).toBe("a  b");
    expect(stripHtmlComments("plain <b>tag</b>")).toBe("plain <b>tag</b>");
  });
});

describe("parentBreadcrumbLabel", () => {
  const base = { title: null, summary: null, gitBranch: "main", turnCount: 12, startedAt: "2026-09-25T10:00:00Z" };

  it("uses the parent's first prompt rather than the branch fallback", () => {
    expect(parentBreadcrumbLabel({ ...base, firstPrompt: "Fix the   login\nredirect <!-- M -->" })).toBe(
      "Fix the login redirect",
    );
  });

  it("prefers a title or a real summary; falls back to branch · turns · date without a prompt", () => {
    expect(parentBreadcrumbLabel({ ...base, title: "Auth work", firstPrompt: "x" })).toBe("Auth work");
    expect(parentBreadcrumbLabel({ ...base, summary: "Refactored auth", firstPrompt: "x" })).toBe("Refactored auth");
    expect(parentBreadcrumbLabel({ ...base, firstPrompt: null })).toBe("main · 12 turns · 2026-09-25");
  });

  it("truncates a long prompt", () => {
    const label = parentBreadcrumbLabel({ ...base, firstPrompt: "w".repeat(300) });
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBe(121);
  });
});

describe("turnCountsLabel", () => {
  it("counts the person's prompts as theirs on a normal session", () => {
    expect(turnCountsLabel({ turnCount: 14, userTurnCount: 3, toolCount: 6, isSubAgent: false })).toBe(
      "14 turns (3 yours, 6 tool calls)",
    );
  });

  it("attributes a sub-agent session's prompt to the parent agent", () => {
    expect(turnCountsLabel({ turnCount: 14, userTurnCount: 1, toolCount: 6, isSubAgent: true })).toBe(
      "14 turns (1 prompt from the parent agent, 6 tool calls)",
    );
  });
});
