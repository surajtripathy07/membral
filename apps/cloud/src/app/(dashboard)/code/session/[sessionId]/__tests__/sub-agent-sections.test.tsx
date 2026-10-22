// D2: sub-agents spawned in the hidden turns get their own, accurate group;
// the "no spawning tool call" caption is for the genuinely unmatched only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChildSessionForMatch } from "@/lib/code-sessions/view";
import { HiddenSubAgentsSection, SubAgentSection } from "../sub-agent-sections";

const child: ChildSessionForMatch = {
  id: "c1",
  agentId: null,
  parentAgentId: null,
  agentType: "Explore",
  description: "map the repo",
  toolUseId: "toolu_1",
  turnCount: 4,
};

describe("HiddenSubAgentsSection", () => {
  it("renders nothing when every spawn is visible", () => {
    expect(renderToStaticMarkup(<HiddenSubAgentsSection hidden={[]} sessionId="s1" />)).toBe("");
  });

  it("lists hidden spawns with their turn and a show-all link, not the unmatched caption", () => {
    const html = renderToStaticMarkup(<HiddenSubAgentsSection hidden={[{ child, turnIdx: 612 }]} sessionId="s1" />);
    expect(html).toContain("Sub-agents in the hidden turns");
    expect(html).toContain("turn 612");
    expect(html).toContain('href="/code/session/s1?all=1"');
    expect(html).toContain('href="/code/session/c1"');
    expect(html).not.toContain("no spawning tool call");
  });
});

describe("SubAgentSection", () => {
  it("captions genuinely unmatched children accurately", () => {
    const html = renderToStaticMarkup(<SubAgentSection tree={[{ child, children: [] }]} />);
    expect(html).toContain("no spawning tool call in this transcript");
  });
});
