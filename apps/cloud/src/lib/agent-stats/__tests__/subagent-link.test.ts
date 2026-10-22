// Maintainer rule: a link lands on the turn that SHOWS the action. Work done
// inside a sub-agent links to the CHILD session's action turn, never to the
// parent's spawn turn (real shape from the local DB: #145, parent turn 182 =
// Agent spawn, child turn 132 = `gh issue comment 145`).
import { describe, expect, it } from "vitest";
import type { AgentStatsSessionInput } from "@/lib/agent-stats/aggregate";
import {
  actionTurnKeys,
  aggregateIssueAttribution,
  type SessionIssueRow,
  subAgentParents,
  withIssueSessionRefs,
} from "@/lib/agent-stats/attribution";

const ISS = "github.com/acme/billing#145";
const s = (id: string, extra: Partial<AgentStatsSessionInput> = {}): AgentStatsSessionInput =>
  ({
    id,
    started_at: "2026-09-12T09:40:00Z",
    turn_count: 200,
    user_turn_count: 5,
    props: {},
    ...extra,
  }) as AgentStatsSessionInput;
const row = (session_id: string, turn_idx: number): SessionIssueRow => ({
  session_id,
  ref: ISS,
  number: 145,
  kind: "issue",
  role: "worked_on",
  review_verb: "commented",
  tier: "observed",
  turn_share: 0,
  turn_idx,
});

describe("Issues page: sub-agent work links to the child's action turn", () => {
  it("parent row on the spawn turn → link opens the child at its comment turn", () => {
    const sessions = [
      s("p", { source: "claude-code", source_session_id: "src-p" } as Partial<AgentStatsSessionInput>),
      s("c", {
        source: "claude-code",
        source_session_id: "src-c",
        parent_source_session_id: "src-p",
      } as Partial<AgentStatsSessionInput>),
    ];
    const turns = [
      {
        session_id: "p",
        idx: 182,
        role: "assistant",
        kind: "tool_use",
        text: null,
        tool_name: "Agent",
        ts: null,
        props: {},
      },
      {
        session_id: "c",
        idx: 132,
        role: "assistant",
        kind: "tool_use",
        text: null,
        tool_name: "Bash",
        ts: null,
        props: { action: { verb: "commented", ref: "#145", refKind: "issue" } },
      },
      {
        session_id: "v",
        idx: 27,
        role: "assistant",
        kind: "tool_use",
        text: null,
        tool_name: "Bash",
        ts: null,
        props: { action: { verb: "viewed", ref: "#145", refKind: "issue" } },
      },
    ];
    const agg = aggregateIssueAttribution(
      sessions,
      [],
      [row("p", 182), { ...row("v", 27), role: "referenced", review_verb: "viewed" }, row("c", 132)],
      {
        parentOf: subAgentParents(sessions as never),
        actionTurns: actionTurnKeys(turns),
      },
    );
    const item = agg.issues.find((i) => i.issue === ISS);
    expect(item?.linkBySession).toEqual({ p: { session_id: "c", turn_idx: 132 } });
    const titles = new Map([["p", { title: "Parent work", started_at: "2026-09-12T09:40:00Z" }]]);
    const withRefs = withIssueSessionRefs(agg, titles as never);
    expect(withRefs.issues.find((i) => i.issue === ISS)?.sessionRefs).toEqual([
      { id: "p", title: "Parent work", started_at: "2026-09-12T09:40:00Z", turn_idx: 132, target_session_id: "c" },
    ]);
  });
});
