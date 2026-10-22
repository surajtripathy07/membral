import { describe, expect, it } from "vitest";
import { type RankableRecord, rankRecords, selectPushRecords } from "../rank";

function rec(overrides: Partial<RankableRecord> & { id: string }): RankableRecord {
  return {
    kind: "decision",
    source: "hook",
    turn_role: "assistant",
    agent_id: null,
    verified: true,
    paths: [],
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("rankRecords", () => {
  it("ranks an unverified record last regardless of kind (rule 3)", () => {
    const a = rec({ id: "a", kind: "preference", turn_role: "user", verified: false });
    const b = rec({ id: "b", kind: "learning", verified: true });
    const [first, second] = rankRecords([a, b], "tool");
    expect(first.id).toBe("b");
    expect(second.id).toBe("a");
  });

  it("relevance, when both records carry it, leads right after verified; ties fall back to kind", () => {
    const rows = [
      rec({ id: "out-lo", kind: "outcome", relevance: 0.01 }),
      rec({ id: "pref-hi", kind: "preference", relevance: 0.03 }),
      rec({ id: "dec-lo", kind: "decision", relevance: 0.01 }),
      rec({ id: "unverified-top", kind: "outcome", relevance: 0.09, verified: false }),
    ];
    expect(rankRecords(rows, "tool").map((r) => r.id)).toEqual(["pref-hi", "out-lo", "dec-lo", "unverified-top"]);
  });

  it("tool mode orders outcome > decision > blocker > learning > preference", () => {
    const rows = [
      rec({ id: "pref", kind: "preference", turn_role: "user" }),
      rec({ id: "learn", kind: "learning" }),
      rec({ id: "block", kind: "blocker" }),
      rec({ id: "dec", kind: "decision" }),
      rec({ id: "out", kind: "outcome" }),
    ];
    const ranked = rankRecords(rows, "tool").map((r) => r.id);
    expect(ranked).toEqual(["out", "dec", "block", "learn", "pref"]);
  });

  it("push mode orders blocker > learning > preference > decision, outcome last (2026-09-13 decision)", () => {
    const rows = [
      rec({ id: "learn", kind: "learning" }),
      rec({ id: "block", kind: "blocker" }),
      rec({ id: "dec", kind: "decision" }),
      rec({ id: "pref", kind: "preference", turn_role: "user" }),
      rec({ id: "out", kind: "outcome" }),
    ];
    const ranked = rankRecords(rows, "push").map((r) => r.id);
    expect(ranked).toEqual(["block", "learn", "pref", "dec", "out"]);
  });

  it("rule 5: user-voiced verified > main-transcript assistant verified > sub-agent, within the same kind", () => {
    const userVoiced = rec({ id: "user", kind: "decision", turn_role: "user" });
    const mainAssistant = rec({ id: "main", kind: "decision", turn_role: "assistant", agent_id: null });
    const subAgent = rec({ id: "sub", kind: "decision", turn_role: "assistant", agent_id: "agent-1" });
    const ranked = rankRecords([subAgent, mainAssistant, userVoiced], "tool").map((r) => r.id);
    expect(ranked).toEqual(["user", "main", "sub"]);
  });

  it("breaks a voice tie by recency (newest first)", () => {
    const older = rec({ id: "older", created_at: "2026-01-01T00:00:00Z" });
    const newer = rec({ id: "newer", created_at: "2026-02-01T00:00:00Z" });
    const ranked = rankRecords([older, newer], "tool").map((r) => r.id);
    expect(ranked).toEqual(["newer", "older"]);
  });

  it("breaks a recency tie by paths overlap with the repo's recently edited files", () => {
    const noOverlap = rec({ id: "no-overlap", paths: ["src/other.ts"] });
    const overlap = rec({ id: "overlap", paths: ["src/hot.ts"] });
    const ranked = rankRecords([noOverlap, overlap], "tool", ["src/hot.ts"]).map((r) => r.id);
    expect(ranked).toEqual(["overlap", "no-overlap"]);
  });

  it("falls to source as the very last tiebreak (hook > agent > extractor)", () => {
    const extractor = rec({ id: "extractor", source: "extractor" });
    const agent = rec({ id: "agent", source: "agent" });
    const hook = rec({ id: "hook", source: "hook" });
    const ranked = rankRecords([extractor, agent, hook], "tool").map((r) => r.id);
    expect(ranked).toEqual(["hook", "agent", "extractor"]);
  });

  it("never uses confidence as a tiebreak (identical records but for a confidence-like field sort stably by id)", () => {
    // rankRecords's RankableRecord type doesn't even accept `confidence` --
    // this test proves two otherwise-identical records fall through to the
    // deterministic id tiebreak rather than any hidden confidence read.
    const a = rec({ id: "a" });
    const b = rec({ id: "b" });
    expect(rankRecords([b, a], "tool").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("push mode ranks a live-and-current-branch record first within its kind tier (rule 6)", () => {
    const plain = rec({ id: "plain", kind: "decision", branchLive: false });
    const live = rec({ id: "live", kind: "decision", branchLive: true, created_at: "2025-01-01T00:00:00Z" });
    const ranked = rankRecords([plain, live], "push").map((r) => r.id);
    expect(ranked).toEqual(["live", "plain"]);
  });

  it("branchLive is inert in tool mode (§4's tool-ranking paragraph omits rule 6)", () => {
    const newer = rec({ id: "newer", branchLive: false, created_at: "2026-02-01T00:00:00Z" });
    const olderLive = rec({ id: "older-live", branchLive: true, created_at: "2026-01-01T00:00:00Z" });
    const ranked = rankRecords([olderLive, newer], "tool").map((r) => r.id);
    expect(ranked).toEqual(["newer", "older-live"]); // recency wins, branchLive never consulted
  });

  it("is pure: does not mutate its input array", () => {
    const rows = [
      rec({ id: "b", created_at: "2026-01-01T00:00:00Z" }),
      rec({ id: "a", created_at: "2026-02-01T00:00:00Z" }),
    ];
    const copy = [...rows];
    rankRecords(rows, "tool");
    expect(rows).toEqual(copy);
  });
});

describe("selectPushRecords", () => {
  it("caps agent-sourced records at 2 of the 8 push lines, keeping the next-best non-agent record instead", () => {
    const ranked = [
      rec({ id: "agent-1", source: "agent" }),
      rec({ id: "agent-2", source: "agent" }),
      rec({ id: "agent-3", source: "agent" }), // should be skipped -- 3rd agent record
      rec({ id: "hook-1", source: "hook" }),
    ];
    const selected = selectPushRecords(ranked, 8).map((r) => r.id);
    expect(selected).toEqual(["agent-1", "agent-2", "hook-1"]);
  });

  it("never selects more than maxLines records", () => {
    const ranked = Array.from({ length: 20 }, (_, i) => rec({ id: `r${i}`, source: "hook" }));
    expect(selectPushRecords(ranked, 8)).toHaveLength(8);
  });

  it("caps preference-kind records at 2 of the 8 push lines (2026-09-13 decision), independent of the agent-source cap", () => {
    const ranked = [
      rec({ id: "pref-1", kind: "preference", turn_role: "user", source: "hook" }),
      rec({ id: "pref-2", kind: "preference", turn_role: "user", source: "hook" }),
      rec({ id: "pref-3", kind: "preference", turn_role: "user", source: "hook" }), // should be skipped -- 3rd preference
      rec({ id: "block-1", kind: "blocker", source: "hook" }),
    ];
    const selected = selectPushRecords(ranked, 8).map((r) => r.id);
    expect(selected).toEqual(["pref-1", "pref-2", "block-1"]);
  });

  it("applies the preference cap and the agent-source cap independently, both skipping in the same pass", () => {
    const ranked = [
      rec({ id: "agent-pref-1", kind: "preference", turn_role: "user", source: "agent" }),
      rec({ id: "agent-pref-2", kind: "preference", turn_role: "user", source: "agent" }),
      rec({ id: "agent-pref-3", kind: "preference", turn_role: "user", source: "agent" }), // 3rd of BOTH caps
      rec({ id: "hook-1", kind: "blocker", source: "hook" }),
    ];
    const selected = selectPushRecords(ranked, 8).map((r) => r.id);
    expect(selected).toEqual(["agent-pref-1", "agent-pref-2", "hook-1"]);
  });
});
