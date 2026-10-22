// listOpenThreads / writeThreadDismissal over the memory tests' fake Supabase
// double (CLAUDE.md: the Supabase client is mocked in cloud tests).

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { listOpenThreads, writeThreadDismissal } from "../queries";

const USER = "user-1";
const ISSUE = "codehub.example/acme/billing#15178";
const NOW = new Date("2026-09-26T12:00:00Z");
// 1M input tokens on a Sonnet-tier model: a known, non-zero price.
const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function tables(extra: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    code_sessions: [
      {
        id: "s1",
        user_id: USER,
        code_project_id: "p1",
        started_at: "2026-09-25T09:00:00Z",
        git_branch: "15178-5-idempotent-debits",
        turn_count: 40,
        parent_source_session_id: null,
        props: { usage, models: ["claude-sonnet-4-5"] },
        // F18: the query selects `usage:props->usage, models:props->models`; the fake returns these aliases as keys.
        usage,
        models: ["claude-sonnet-4-5"],
      },
      {
        id: "old",
        user_id: USER,
        code_project_id: "p1",
        started_at: "2026-07-01T09:00:00Z",
        git_branch: null,
        turn_count: 4,
        parent_source_session_id: null,
        props: { usage, models: ["claude-sonnet-4-5"] },
        // F18: the query selects `usage:props->usage, models:props->models`; the fake returns these aliases as keys.
        usage,
        models: ["claude-sonnet-4-5"],
      },
    ],
    code_session_issues: [
      {
        session_id: "s1",
        user_id: USER,
        ref: ISSUE,
        number: 15178,
        kind: "issue",
        role: "worked_on",
        evidence_quote: "the debits fix",
        turn_idx: 3,
        review_verb: null,
        build_verb: "committed",
        tier: "observed",
        turn_share: "1",
        related_to: [],
        created_at: "2026-09-25T10:00:00Z",
      },
      {
        session_id: "old",
        user_id: USER,
        ref: "codehub.example/acme/billing#1",
        number: 1,
        kind: "issue",
        role: "worked_on",
        evidence_quote: "old",
        turn_idx: 1,
        build_verb: "committed",
        turn_share: "1",
        created_at: "2026-07-01T10:00:00Z",
      },
    ],
    // The fake's `.not("props->action", "is", null)` reads a literal key, so the
    // fixture carries it beside the real `props` the query selects.
    code_session_turns: [
      {
        session_id: "s1",
        user_id: USER,
        idx: 12,
        props: { action: { verb: "committed", sha: "d7e5977", branch: "15178-5-idempotent-debits", source: "cli" } },
        "props->action": true,
      },
    ],
    memory_branch_state: [],
    session_memories: [],
    thread_dismissals: [],
    ...extra,
  };
}

describe("listOpenThreads", () => {
  it("reads only sessions in the window, prices them from props.usage and returns the P5 shape", async () => {
    const supabase = makeFakeSupabase(tables());
    const res = await listOpenThreads(supabase, USER, { days: 30, limit: 5, now: NOW });
    expect(res.window_days).toBe(30);
    expect(res.estimated).toBe(true);
    expect(res.recent.map((t) => t.ref)).toEqual([ISSUE]);
    expect(res.open).toHaveLength(1);
    const t = res.open[0];
    expect(t.open).toBe(true);
    // C-9/B7: never the evidence quote; no commit subject or forge title here, so the ref itself.
    expect(t.title).toBe(ISSUE);
    // v4 B1: pricing still runs from props.usage, but an issue row carries no share of it.
    expect(t.sessions[0].cost_est).toBe(0);
    expect(t.cost_est_total).toBe(t.sessions[0].cost_est);
    expect(res.recurring_blockers).toEqual([]);
  });

  it("#436: Today's blockers panel shows blockers from the last 7 days only, even in a 30-day window", async () => {
    const blocker = (id: string, created_at: string): Row => ({
      id,
      user_id: USER,
      code_project_id: "p1",
      code_session_id: "s1",
      kind: "blocker",
      text: `blocked: ${id}`,
      quote: null,
      turn_role: "assistant",
      turn_idx: 1,
      recurrence_count: 1,
      priority: null,
      ref: null,
      ref_kind: null,
      recurs_of: null,
      retired_at: null,
      created_at,
    });
    const supabase = makeFakeSupabase(
      tables({ session_memories: [blocker("fresh", "2026-09-20T12:00:00Z"), blocker("old", "2026-09-18T12:00:00Z")] }),
    );
    const res = await listOpenThreads(supabase, USER, { days: 30, now: NOW });
    expect(res.recurring_blockers.map((b) => b.id)).toEqual(["fresh"]);
  });

  it("a branch-state merge proof closes it, and a dismissal hides it", async () => {
    const merged = makeFakeSupabase(
      tables({
        memory_branch_state: [
          {
            user_id: USER,
            code_project_id: "p1",
            branch: "15178-5-idempotent-debits",
            last_seen_sha: "d7e5977",
            merged_into: "main",
            merged_at: "2026-09-26T02:00:00Z",
            branch_gone_at: null,
          },
        ],
      }),
    );
    const a = await listOpenThreads(merged, USER, { now: NOW });
    expect(a.open).toEqual([]);
    expect(a.recent[0].closure?.kind).toBe("branch_state");

    const dismissed = makeFakeSupabase(
      tables({
        thread_dismissals: [
          {
            user_id: USER,
            ref: ISSUE,
            kind: "issue",
            reason: "resolved_elsewhere",
            created_at: "2026-09-25T20:00:00Z",
          },
        ],
      }),
    );
    const b = await listOpenThreads(dismissed, USER, { now: NOW });
    expect(b.open).toEqual([]);
    expect(b.recent[0].dismissed).toBe(true);
  });

  it("returns empty lists for a user with no sessions in the window", async () => {
    const supabase = makeFakeSupabase({ code_sessions: [] });
    const res = await listOpenThreads(supabase, USER, { now: NOW });
    expect(res).toEqual({
      open: [],
      recent: [],
      recurring_blockers: [],
      estimated: true,
      window_days: 30,
    });
  });

  it("F8: dismissals are read past the 1000-row page, never silently truncated", async () => {
    const filler = Array.from({ length: 1200 }, (_, i) => ({
      user_id: USER,
      ref: `codehub.example/acme/other#${i}`,
      kind: "issue",
      reason: "resolved_elsewhere",
      created_at: "2026-01-01T00:00:00Z",
    }));
    const supabase = makeFakeSupabase(
      tables({
        thread_dismissals: [
          ...filler,
          { user_id: USER, ref: ISSUE, kind: "issue", reason: "not_delivery_item", created_at: "2026-09-25T20:00:00Z" },
        ],
      }),
    );
    const res = await listOpenThreads(supabase, USER, { now: NOW });
    expect(res.open).toEqual([]);
    expect(res.recent[0]).toMatchObject({ dismissed: true, dismiss_reason: "not_delivery_item" });
  });
});

describe("writeThreadDismissal", () => {
  it("writes one thread_dismissals row keyed by (kind, ref), never a memory, and is idempotent", async () => {
    const data = tables();
    const supabase = makeFakeSupabase(data);

    const first = await writeThreadDismissal(supabase, USER, { ref: ISSUE, kind: "issue" }, "not_delivery_item");
    expect(first).toMatchObject({ ok: true, already: false });
    expect(data.thread_dismissals).toHaveLength(1);
    expect(data.thread_dismissals[0]).toMatchObject({
      user_id: USER,
      ref: ISSUE,
      kind: "issue",
      reason: "not_delivery_item",
    });
    // D-051: nothing lands where a memory/MCP path could serve it.
    expect(data.session_memories).toEqual([]);

    const second = await writeThreadDismissal(supabase, USER, { ref: ISSUE, kind: "issue" }, "resolved_elsewhere");
    expect(second).toMatchObject({ ok: true, already: true });
    expect(data.thread_dismissals).toHaveLength(1);

    const gone = await listOpenThreads(supabase, USER, { now: NOW });
    expect(gone.open).toEqual([]);
  });

  it("dismiss, then a later commit re-opens it, then dismiss again hides it again", async () => {
    const data = tables();
    const supabase = makeFakeSupabase(data);
    const beforeCommit = new Date("2026-09-24T09:00:00Z");

    await writeThreadDismissal(supabase, USER, { ref: ISSUE, kind: "issue" }, "resolved_elsewhere", {
      now: beforeCommit,
    });
    const reopened = await listOpenThreads(supabase, USER, { now: NOW });
    expect(reopened.open.map((t) => t.ref)).toEqual([ISSUE]);

    const again = await writeThreadDismissal(supabase, USER, { ref: ISSUE, kind: "issue" }, "not_delivery_item", {
      now: NOW,
    });
    expect(again).toMatchObject({ ok: true, already: true });
    expect(data.thread_dismissals).toHaveLength(1);
    expect(data.thread_dismissals[0]).toMatchObject({ reason: "not_delivery_item", created_at: NOW.toISOString() });

    const hidden = await listOpenThreads(supabase, USER, { now: NOW });
    expect(hidden.open).toEqual([]);
  });

  it("refuses a (kind, ref) no session of the caller's acted on — the MR twin of a known issue included", async () => {
    const supabase = makeFakeSupabase(tables());
    expect(
      await writeThreadDismissal(
        supabase,
        USER,
        { ref: "codehub.example/acme/billing#404", kind: "issue" },
        "resolved_elsewhere",
      ),
    ).toEqual({ ok: false, reason: "unknown_ref" });
    expect(
      await writeThreadDismissal(supabase, USER, { ref: ISSUE, kind: "merge_request" }, "resolved_elsewhere"),
    ).toEqual({
      ok: false,
      reason: "unknown_ref",
    });
  });
});
