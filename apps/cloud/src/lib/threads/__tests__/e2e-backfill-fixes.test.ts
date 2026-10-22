// Backfill diagnosis (Q2) fixes: sub-agent test activity must not read as the
// parent's delivery.
//   1 a VIEW (any repo) is never build focus: a ref-less push after it lands nowhere
//   2 branch/closure evidence comes only from the session that acted on the ref,
//     never from a sibling child's commits on a branch that later merged
//   3 a child folded into its parent is priced by its own cost x its own share,
//     never by a share of the whole parent session's cost
import { describe, expect, it } from "vitest";
import { buildProfile, type ProfileTurnInput } from "@/lib/code-sessions/profile";
import { computeThreads, type ThreadIssueRow, type ThreadSessionRow, type ThreadTurnRow } from "../open-threads";

const REF = "codehub.example/acme/billing#1";

function t(idx: number, extra: Partial<ProfileTurnInput> = {}): ProfileTurnInput {
  return { idx, role: "assistant", kind: "prose", ...extra };
}
function act(idx: number, action: Record<string, unknown>): ProfileTurnInput {
  return t(idx, { kind: "tool_use", tool_name: "Bash", props: { action } });
}

describe("1: a view of another repo's item is not build focus", () => {
  it("child views anthropics/claude-code#2000, then pushes to a local bare repo → no build rung on #2000", () => {
    const parent = [
      t(0, { role: "user", kind: "prose" }),
      t(1, { kind: "tool_use", tool_name: "Agent", props: { toolUseId: "toolu_c" } }),
    ];
    const child = {
      id: "child-c",
      spawnToolUseId: "toolu_c",
      turns: [
        t(0, { role: "user", kind: "prose" }),
        act(1, { verb: "viewed", ref: "anthropics/claude-code#2000", refKind: "issue", source: "cli" }),
        t(2, { kind: "tool_result" }),
        act(3, { verb: "committed", refKind: "commit", sha: "abc1234", branch: "main", source: "cli" }),
        act(4, { verb: "pushed", refKind: "branch", ref: "main", branch: "main", source: "cli" }),
      ],
    };
    const p = buildProfile(parent, { childSessions: [child] });
    const r = p.refs.find((x) => x.ref === "anthropics/claude-code#2000");
    expect(r?.review_verb).toBe("viewed");
    expect(r?.build_verb).toBeNull();
    // B16: the child's turns are not the parent's share.
    expect(r?.turn_share).toBe(0);
  });

  it("an explicit-ref action still sets build focus (control)", () => {
    const turns = [
      act(0, { verb: "checked_out", ref: REF, refKind: "merge_request", branch: "feat/x", source: "cli" }),
      act(1, { verb: "committed", refKind: "commit", sha: "abc1234", branch: "feat/x", source: "cli" }),
    ];
    expect(buildProfile(turns).refs.find((x) => x.ref === REF)?.build_verb).toBe("committed");
  });
});

const session = (id: string, cost: number, extra: Partial<ThreadSessionRow> = {}): ThreadSessionRow => ({
  id,
  code_project_id: "proj-1",
  started_at: "2026-09-26T09:00:00Z",
  git_branch: "main",
  turn_count: 20,
  parent_source_session_id: null,
  source: "claude-code",
  source_session_id: `src-${id}`,
  cost_usd: cost,
  ...extra,
});
const row = (session_id: string, over: Partial<ThreadIssueRow> = {}): ThreadIssueRow => ({
  session_id,
  ref: REF,
  number: 1,
  kind: "merge_request",
  role: "worked_on",
  evidence_quote: null,
  turn_idx: 3,
  review_verb: null,
  build_verb: "opened_mr",
  tier: "observed",
  turn_share: 1,
  related_to: [],
  ...over,
});
const turn = (session_id: string, idx: number, action: Record<string, unknown>, ts?: string): ThreadTurnRow => ({
  session_id,
  idx,
  ...(ts ? { ts } : {}),
  props: { action },
});
const child = (id: string) => session(id, 0.3, { parent_source_session_id: "src-P" });

describe("2: branch evidence is keyed to the acting session", () => {
  it("a sibling child's commits on e2e-fixes (merged) do not close acme/billing#1 opened by another child", () => {
    const sessions = [session("P", 10), child("A"), child("B")];
    const issues = [row("P", { turn_share: 0 }), row("A")];
    const turns = [
      turn("A", 1, { verb: "committed", refKind: "commit", sha: "aaa1111", branch: "15178-debits", source: "cli" }),
      turn("A", 2, { verb: "pushed", refKind: "branch", ref: "15178-debits", branch: "15178-debits", source: "cli" }),
      turn("A", 3, { verb: "opened_mr", ref: REF, refKind: "merge_request", branch: "15178-debits", source: "cli" }),
      turn("B", 1, { verb: "committed", refKind: "commit", sha: "bbb2222", branch: "e2e-fixes", source: "cli" }),
      turn("B", 2, { verb: "merged", refKind: "branch", ref: "e2e-fixes", branch: "e2e-fixes", source: "cli" }),
    ];
    const branchState = [
      {
        code_project_id: "proj-1",
        branch: "e2e-fixes",
        last_seen_sha: "bbb2222",
        merged_into: "main",
        merged_at: "2026-09-26T10:00:00Z",
        branch_gone_at: null,
      },
    ];
    const res = computeThreads({ issues, sessions, turns, branchState });
    const th = res.recent.find((x) => x.ref === REF);
    expect(th?.closure).toBeNull();
  });

  it("the acting child's own branch merged still closes it (control)", () => {
    const sessions = [session("P", 10), child("A")];
    const issues = [row("P", { turn_share: 0 }), row("A")];
    const turns = [
      turn("A", 1, { verb: "committed", refKind: "commit", sha: "aaa1111", branch: "15178-debits", source: "cli" }),
      turn("A", 3, { verb: "opened_mr", ref: REF, refKind: "merge_request", branch: "15178-debits", source: "cli" }),
    ];
    const branchState = [
      {
        code_project_id: "proj-1",
        branch: "15178-debits",
        last_seen_sha: "aaa1111",
        merged_into: "main",
        merged_at: "2026-09-26T10:00:00Z",
        branch_gone_at: null,
      },
    ];
    const res = computeThreads({ issues, sessions, turns, branchState });
    expect(res.recent.find((x) => x.ref === REF)?.closure).not.toBeNull();
  });
});

describe("3: a child's fold does not take a share of the whole parent's cost", () => {
  it("parent $10 orchestration, child $0.30 acting on acme/billing#1 → the ref gets ≤ $0.30", () => {
    // The parent's profile row on the ref: the child's rungs folded in, share 0
    // of the parent's own turns (buildProfile counts only the main session's turns).
    const parentTurns = [
      t(0, { role: "user", kind: "prose" }),
      t(1, { kind: "tool_use", tool_name: "Agent", props: { toolUseId: "toolu_a" } }),
      t(2),
      t(3),
    ];
    const kid = {
      id: "A",
      spawnToolUseId: "toolu_a",
      turns: [act(0, { verb: "opened_mr", ref: REF, refKind: "merge_request", branch: "x", source: "cli" }), t(1)],
    };
    const p = buildProfile(parentTurns, { childSessions: [kid] });
    const pr = p.refs.find((x) => x.ref === REF);
    expect(pr?.build_verb).toBe("opened_mr");
    const sessions = [session("P", 10), child("A")];
    const issues = [row("P", { turn_share: pr?.turn_share ?? 0 }), row("A", { turn_share: 1 })];
    const res = computeThreads({ issues, sessions, turns: [] });
    const th = res.recent.find((x) => x.ref === REF);
    expect(th?.cost_est_total).not.toBeNull();
    expect(th?.cost_est_total as number).toBeLessThanOrEqual(0.3 + 1e-9);
  });
});
