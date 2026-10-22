// P5's guard: "the preamble and the MCP tools are untouched (a test asserts
// the preamble output for a fixture is byte-identical before and after this
// goal)". Two assertions: (1) by construction — nothing under lib/memory,
// lib/mcp or the harness-facing API routes imports lib/threads; (2) by
// output — buildPreamble renders byte-identical lines for a fixture with and
// without every row open threads are built from (issue rows, actions, a
// branch-state merge proof, a thread_dismissals row); (3) D-051 for the MCP
// tools — session_summary and memory_recall(durable_only:false) return the
// same records with and without those rows, and never a thread's ref,
// dismissal or reason. Both fixtures carry a blocker with recurrence_count > 1
// (the preamble may say it recurs; the threads data must still never appear).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPreamble } from "@/lib/memory/preamble";
import { memoryRecall } from "@/lib/memory/recall";
import { sessionSummary } from "@/lib/memory/summary";

const SRC = resolve(__dirname, "../../..");
const HARNESS_FACING = ["lib/memory", "lib/mcp", "app/api/memory", "app/api/mcp", "app/api/code-sessions"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const USER = "user-1";
const PROJECT = "proj-a";
const REPO = "https://github.com/acme/repo";
const ISSUE = "github.com/acme/repo#42";
const RECEIPT = "was written down verbatim in this turn";

function baseTables(): Record<string, Row[]> {
  const decision = {
    id: "dec-1",
    user_id: USER,
    code_session_id: "sess-1",
    code_project_id: PROJECT,
    agent_id: null,
    source: "extractor",
    kind: "decision",
    text: "chose postgres for the ledger",
    quote: `chose postgres for the ledger ${RECEIPT}`,
    turn_idx: 0,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    branch: null,
    head_sha: null,
    thread: null,
    paths: [],
    durable: true,
    recurrence_count: 1,
    scope: "project",
    confidence: 0.5,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: "2026-09-10T00:00:00Z",
  };
  const blocker = {
    ...decision,
    id: "blk-1",
    kind: "blocker",
    text: "smoke job times out on cold compile",
    quote: `smoke job times out on cold compile ${RECEIPT}`,
    recurrence_count: 3,
    created_at: "2026-09-22T00:00:00Z",
  };
  return {
    thread_dismissals: [],
    code_projects: [{ id: PROJECT, user_id: USER, display_name: "acme/repo", repo_identity: "github.com/acme/repo" }],
    code_sessions: [
      {
        id: "sess-1",
        user_id: USER,
        code_project_id: PROJECT,
        started_at: "2026-09-12T00:00:00Z",
        ended_at: "2026-09-12T01:00:00Z",
        files_touched: [],
        git_branch: "42-ledger",
        parent_source_session_id: null,
        turn_count: 2,
      },
    ],
    memory_branch_state: [],
    session_memories: [decision, blocker],
    code_session_turns: [
      { session_id: "sess-1", idx: 0, role: "assistant", text: `chose postgres for the ledger ${RECEIPT}`, props: {} },
    ],
    conversations: [],
    code_session_issues: [],
  };
}

function withThreads(): Record<string, Row[]> {
  const t = baseTables();
  t.code_session_issues.push({
    session_id: "sess-1",
    user_id: USER,
    ref: ISSUE,
    number: 42,
    kind: "issue",
    role: "worked_on",
    evidence_quote: "the ledger issue",
    turn_idx: 1,
    review_verb: null,
    build_verb: "committed",
    tier: "observed",
    turn_share: "1",
    related_to: [],
  });
  t.code_session_turns.push({
    session_id: "sess-1",
    idx: 1,
    role: "assistant",
    kind: "tool_use",
    tool_name: "Bash",
    text: "[tool_result elided: ok]",
    props: { action: { verb: "committed", sha: "d7e5977", branch: "42-ledger", source: "cli" } },
    "props->action": true,
  });
  t.memory_branch_state.push({
    user_id: USER,
    code_project_id: PROJECT,
    branch: "42-ledger",
    last_seen_sha: "d7e5977",
    merged_into: "main",
    merged_at: "2026-09-13T00:00:00Z",
    branch_gone_at: null,
    last_seen_at: "2026-09-13T00:00:00Z",
  });
  t.thread_dismissals.push({
    id: "dismiss-1",
    user_id: USER,
    ref: ISSUE,
    kind: "issue",
    reason: "not_delivery_item",
    created_at: "2026-09-14T00:00:00Z",
  });
  return t;
}

describe("the preamble is unchanged by open threads", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("nothing harness-facing imports lib/threads", () => {
    const offenders: string[] = [];
    for (const dir of HARNESS_FACING) {
      for (const file of walk(join(SRC, dir))) {
        if (file.includes("__tests__")) continue;
        const text = readFileSync(file, "utf8");
        if (/from\s+["'](@\/lib\/threads|\.{1,2}\/(\.\.\/)*threads)(\/|["'])/.test(text)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
    // The threads modules exist and are imported by the pulse route only.
    const pulse = readFileSync(join(SRC, "app/api/pulse/route.ts"), "utf8");
    expect(pulse).toMatch(/@\/lib\/threads\/queries/);
  });

  it("buildPreamble renders byte-identical lines with and without open-thread rows", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";
    // The recall token carries its mint time; pin the clock so the two runs mint the same token.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
    // The redesigned preamble shows ref-less memories only as recent learnings ("Gotchas:").
    const onBranch = (t: Record<string, Row[]>) => {
      for (const m of t.session_memories)
        if (m.kind === "decision") Object.assign(m, { kind: "learning", created_at: "2026-09-25T00:00:00Z" });
      return t;
    };
    const without = await buildPreamble(makeFakeSupabase(onBranch(baseTables())), USER, {
      repo: REPO,
      branch: "42-ledger",
    });
    const withRows = await buildPreamble(makeFakeSupabase(onBranch(withThreads())), USER, {
      repo: REPO,
      branch: "42-ledger",
    });
    expect(without.lines.length).toBeGreaterThan(2);
    expect(without.lines.some((l) => l.includes("chose postgres"))).toBe(true);
    expect(withRows.lines.join("\n")).toBe(without.lines.join("\n"));
    expect(withRows.open_blockers).toEqual(without.open_blockers);
    expect(JSON.stringify(withRows.lines)).not.toMatch(/#42|Open thread|dismissed/);
  });

  it("MCP session_summary and memory_recall(durable_only:false) never carry threads data (D-051)", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
    const run = async (tables: Record<string, Row[]>) => ({
      summary: await sessionSummary(makeFakeSupabase(tables), USER, null, { session_id: "sess-1" }),
      recall: await memoryRecall(makeFakeSupabase(tables), USER, null, { durable_only: false, limit: 20 }),
    });
    const without = await run(baseTables());
    const withRows = await run(withThreads());
    expect(without.summary).not.toBeNull();
    expect(JSON.stringify(without.recall)).toMatch(/smoke job times out/);
    expect(JSON.stringify(withRows.summary)).toBe(JSON.stringify(without.summary));
    expect(JSON.stringify(withRows.recall)).toBe(JSON.stringify(without.recall));
    for (const out of [withRows.summary, withRows.recall]) {
      expect(JSON.stringify(out)).not.toMatch(/#42|Open thread|dismiss|not_delivery_item|resolved_elsewhere/);
    }
  });
});
