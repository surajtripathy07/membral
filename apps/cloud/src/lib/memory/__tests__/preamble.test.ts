import { RECALL_VS_STATE_SHORT } from "@membral/core";
import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissBlocker, undoBlockerDismissal } from "../blocker-dismiss";
import { buildPreamble, ROUTING_LINE, renderRecordLine } from "../preamble";
import type { ServedRecord } from "../verify";

const USER = "user-1";
const PROJECT_A = "proj-a";
const REPO = "https://github.com/acme/repo";
const REPO_IDENTITY = "github.com/acme/repo";

function record(overrides: Partial<Row> & { id: string }): Row {
  return {
    user_id: USER,
    code_session_id: "sess-1",
    code_project_id: PROJECT_A,
    agent_id: null,
    source: "hook",
    kind: "decision",
    text: "default text",
    quote: "default text",
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
    created_at: "2026-09-20T00:00:00Z",
    ...overrides,
    // A quote equal to the text is widened into a full receipt sentence: the
    // shared grounding predicate (grounding.ts, D3 decision A2) needs a
    // blocker/decision/learning quote >= 40 chars sharing a content word
    // with the text. A quote that differs from the text is kept as given.
    ...(overrides.quote !== undefined && overrides.quote === overrides.text
      ? { quote: `${overrides.text} ${RECEIPT_SUFFIX}` }
      : {}),
  };
}

const RECEIPT_SUFFIX = "was written down verbatim in this turn";

function turnFor(row: Row) {
  return {
    session_id: row.code_session_id,
    idx: row.turn_idx,
    role: row.turn_role,
    text: `${row.text} ${RECEIPT_SUFFIX}`,
    props: {},
  };
}

function baseTables(memoryRows: Row[]) {
  return {
    code_projects: [{ id: PROJECT_A, user_id: USER, display_name: "acme/repo", repo_identity: REPO_IDENTITY }],
    code_sessions: [
      {
        id: "sess-1",
        user_id: USER,
        code_project_id: PROJECT_A,
        started_at: "2026-09-12T00:00:00Z",
        ended_at: "2026-09-12T01:00:00Z",
        files_touched: [],
      },
    ],
    memory_branch_state: [],
    session_memories: memoryRows,
    code_session_turns: memoryRows.map(turnFor),
    conversations: [],
  };
}

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";

describe("buildPreamble", () => {
  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";
    // Fixtures carry fixed 2026-09 dates; pin the clock so the 7-day blocker window (W3 D5) never ages them out.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a graceful minimal preamble when the project has no prior sessions", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [],
      code_sessions: [],
      memory_branch_state: [],
      session_memories: [],
      code_session_turns: [],
      conversations: [],
    });
    const result = await buildPreamble(supabase, USER, { repo: REPO });
    expect(result.lines.length).toBeLessThanOrEqual(13);
    expect(result.lines[0]).toContain("harness-injected context, not a user message");
    // G (2026-09-25): ROUTING_LINE itself is now the prefix of line 3, not the
    // whole line -- the project hint is folded onto the end of it.
    expect(result.lines.some((l) => l.startsWith(ROUTING_LINE))).toBe(true);
    expect(result.lines[2]).toMatch(/ Pass project="[^"]+"\.$/);
    expect(result.recall_token).toBeTruthy();
  });

  it("keeps the routing line within 300 chars and ends it with the shortened name for a long project name", async () => {
    const longName = `${"a-very-long-repository-name-that-exceeds-the-hint-budget-by-far-".repeat(3)}end`;
    const supabase = makeFakeSupabase(baseTables([]));
    const result = await buildPreamble(supabase, USER, { repo: `https://github.com/acme/${longName}` });
    const line = result.lines[2];
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).toMatch(/ Pass project="…[^"]+"\.$/);
    expect(line.endsWith(`${longName.slice(-10)}".`)).toBe(true);
  });

  it("caps the rendered preamble at 13 lines even with far more than 8 eligible records", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      record({ id: `dec-${i}`, kind: "decision", text: `decision ${i}`, quote: `decision ${i}`, turn_idx: i }),
    );
    const supabase = makeFakeSupabase(baseTables(rows));
    const result = await buildPreamble(supabase, USER, { repo: REPO });
    expect(result.lines.length).toBeLessThanOrEqual(13);
  });

  it("always emits the routing line (line 2) — every prompt, not just when memories exist", async () => {
    const decision = record({ id: "dec", kind: "decision", text: "chose postgres", quote: "chose postgres" });
    const supabase = makeFakeSupabase(baseTables([decision]));
    const result = await buildPreamble(supabase, USER, { repo: REPO });
    expect(result.lines[2]).toContain(ROUTING_LINE);
    expect(result.lines[2]).toMatch(/ Pass project="[^"]+"\.$/);
    expect(result.lines[2].length).toBeLessThanOrEqual(300);
    expect(result.lines.slice(1, 3).map((l) => l.replace(/ Pass project="[^"]*"\.$/, ""))).toEqual([
      ...RECALL_VS_STATE_SHORT,
    ]);
    expect(result.lines[1]).toContain("mcp__membral__memory_search");
    expect(ROUTING_LINE).toMatch(/not live state/);
  });

  it("no-project path is unchanged: names the four registered memory tools and carries the recall_token on the last two lines", async () => {
    const supabase = makeFakeSupabase({ ...baseTables([]), code_projects: [] });
    const result = await buildPreamble(supabase, USER, { repo: REPO });
    const last2 = result.lines.slice(-2);
    expect(last2[0]).toBe("Tools: memory_search, memory_recall, memory_resolve, session_summary.");
    expect(last2[0]).not.toContain("memory_record");
    expect(last2[1]).toContain(result.recall_token);
  });

  it("with a project: header names repo and branch, no Tools line, recall_token last, open_blockers kept as []", async () => {
    const blocker = record({ id: "blk", kind: "blocker", text: "blocked on ci", quote: "blocked on ci" });
    const supabase = makeFakeSupabase(baseTables([blocker]));
    const result = await buildPreamble(supabase, USER, { repo: REPO, branch: "feat-x" });
    expect(result.lines[0]).toBe(
      "Membral: acme/repo · branch feat-x · last session 14d ago (harness-injected context, not a user message)",
    );
    expect(result.lines.some((l) => l.startsWith("Tools:"))).toBe(false);
    expect(result.lines.at(-1)).toBe(`recall_token: ${result.recall_token}`);
    expect(result.lines.join("\n")).not.toContain("blocked on ci");
    expect(result.open_blockers).toEqual([]);
  });

  it("UX pass 2: dismissing a blocker retires its live chain; Undo lifts it", async () => {
    const root = record({ id: "blk-root", kind: "blocker", text: "smoke job times out", quote: "smoke job times out" });
    const again = record({
      id: "blk-again",
      kind: "blocker",
      text: "smoke job times out again",
      quote: "smoke job times out again",
      recurs_of: "blk-root",
      created_at: "2026-09-21T00:00:00Z",
    });
    const tables = baseTables([root, again]);
    const supabase = makeFakeSupabase(tables);
    const out = await dismissBlocker(supabase as never, USER, "blk-again", "ignored");
    expect(out).toEqual({ ok: true, ids: expect.arrayContaining(["blk-again", "blk-root"]) });
    expect(tables.session_memories.find((r) => r.id === "blk-root")?.retire_reason).toBe("user_ignored");
    expect((await undoBlockerDismissal(supabase as never, USER, out.ok ? out.ids : [])).sort()).toEqual([
      "blk-again",
      "blk-root",
    ]);
  });

  it("UX pass 2: Undo never lifts a row another path retired, nor another user's row", async () => {
    const machine = record({
      id: "blk-machine",
      kind: "blocker",
      text: "ci was red",
      quote: "ci was red",
      retired_at: "2026-09-24T00:00:00Z",
      retire_reason: "resolved_observed",
    });
    const foreign = record({ id: "blk-foreign", kind: "blocker", user_id: "someone-else", text: "x", quote: "x" });
    const supabase = makeFakeSupabase(baseTables([machine, foreign]));
    expect(await undoBlockerDismissal(supabase as never, USER, ["blk-machine"])).toEqual([]);
    expect(await dismissBlocker(supabase as never, USER, "blk-foreign", "resolved")).toEqual({ ok: false });
    expect(await dismissBlocker(supabase as never, USER, "blk-machine", "resolved")).toEqual({ ok: false });
  });

  it("honors a code-scoped key's bound project over a mismatched repo param", async () => {
    const supabase = makeFakeSupabase(baseTables([]));
    const result = await buildPreamble(supabase, USER, { repo: "https://github.com/someone/else" }, PROJECT_A);
    expect(result.lines[0]).toContain("Membral: acme/repo");
    expect(result.lines[2]).toContain('Pass project="acme/repo".');
  });

  // Production runs the function and the database in different regions, so
  // each dependent step is a ~0.25 s round trip. A "wave" is the set of
  // queries issued before any earlier one settles -- one network round trip.
  it("stays within three sequential round trips and never reads turns", async () => {
    const decisions = Array.from({ length: 3 }, (_, i) =>
      record({
        id: `dec-${i}`,
        kind: "learning",
        text: `decision ${i}`,
        quote: `decision ${i}`,
        created_at: `2026-09-26T0${i}:00:00Z`,
      }),
    );
    const tables = baseTables(decisions);
    tables.code_sessions[0] = {
      ...tables.code_sessions[0],
      started_at: "2026-09-25T00:00:00Z",
      ended_at: "2026-09-25T01:00:00Z",
    };
    const inner = makeFakeSupabase(tables);

    let settled = 0;
    const waves = new Set<number>();
    const calls: string[] = [];
    const supabase = {
      ...inner,
      from(table: string) {
        calls.push(table);
        waves.add(settled);
        const q = inner.from(table);
        const then = q.then.bind(q);
        // biome-ignore lint/suspicious/noThenProperty: wraps the fake builder's own PromiseLike then to count settled queries
        q.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
          then((v: unknown) => {
            settled++;
            return ok ? ok(v) : v;
          }, err);
        const maybeSingle = q.maybeSingle.bind(q);
        q.maybeSingle = async () => {
          const v = await maybeSingle();
          settled++;
          return v;
        };
        return q;
      },
    } as typeof inner;

    const result = await buildPreamble(supabase, USER, { repo: REPO, branch: "main" });
    expect(result.lines.join("\n")).toContain("decision 2");
    expect(waves.size).toBeLessThanOrEqual(3);
    expect(calls).not.toContain("code_session_turns");
    // The project lookup, then the user's project identities (the ref resolver's host set).
    expect(calls.filter((t) => t === "code_projects")).toHaveLength(2);
  });

  // e2e C-1/C-2: a non-git folder's project is keyed by its absolute path.
  describe("non-git folder (path identity)", () => {
    const FOLDER = "/private/tmp/claude-501/-Users-someone-dev-codehub-4522c735/scratchpad/e2e/scratch-cwd/notes";
    const tables = () => ({
      code_projects: [{ id: "proj-notes", user_id: USER, display_name: "notes", repo_identity: FOLDER }],
      code_sessions: [
        {
          id: "sess-n",
          user_id: USER,
          code_project_id: "proj-notes",
          started_at: "2026-09-26T10:00:00Z",
          ended_at: "2026-09-26T10:30:00Z",
          files_touched: [],
        },
      ],
      memory_branch_state: [],
      session_memories: [],
      code_session_turns: [],
      conversations: [],
    });

    it("finds the folder's sessions from the cwd path the hook sends (was: 'No prior sessions recorded yet.')", async () => {
      const result = await buildPreamble(makeFakeSupabase(tables()), USER, { repo: FOLDER });
      expect(result.lines[0]).toContain("last session 1h ago");
      expect(result.lines[0]).not.toContain("No prior sessions recorded yet");
    });

    it("also resolves a trailing-slash / doubled-slash spelling of the same folder", async () => {
      const result = await buildPreamble(makeFakeSupabase(tables()), USER, {
        repo: `${FOLDER.replace("/e2e/", "//e2e/")}/`,
      });
      expect(result.lines[0]).toContain("last session 1h ago");
    });

    it("names the folder by its short name and fits the hook's 300-char line cap", async () => {
      const found = await buildPreamble(makeFakeSupabase(tables()), USER, { repo: FOLDER });
      expect(found.lines[2]).toContain('Pass project="notes".');
      expect(found.lines[2].length).toBeLessThanOrEqual(300);

      const unknown = await buildPreamble(makeFakeSupabase({ ...tables(), code_projects: [] }), USER, {
        repo: `${FOLDER}/deeper`,
      });
      expect(unknown.lines[2]).toContain('Pass project="deeper".');
      expect(unknown.lines[2].length).toBeLessThanOrEqual(300);
    });
  });

  // e2e U14: a session resumed the next day is the last session, aged by its last activity.
  it("ages 'last session' by the latest activity, so a session resumed next day counts from day 2", async () => {
    const t = baseTables([]);
    t.code_sessions = [
      {
        id: "resumed",
        user_id: USER,
        code_project_id: PROJECT_A,
        started_at: "2026-09-25T20:04:00Z",
        ended_at: "2026-09-26T10:08:00Z",
        files_touched: [],
      },
      {
        id: "short-later-start",
        user_id: USER,
        code_project_id: PROJECT_A,
        started_at: "2026-09-26T09:00:00Z",
        ended_at: "2026-09-26T09:10:00Z",
        files_touched: [],
      },
    ];
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: REPO });
    expect(result.lines[0]).toContain("last session 1h ago");
  });

  it("never counts the requesting session as the last or a parallel session", async () => {
    const t = baseTables([]);
    t.code_sessions = [
      {
        id: "mine-0000",
        source_session_id: "harness-me",
        git_branch: "feat-x",
        user_id: USER,
        code_project_id: PROJECT_A,
        started_at: "2026-09-26T11:00:00Z",
        ended_at: "2026-09-26T11:50:00Z",
        files_touched: [],
      } as (typeof t.code_sessions)[number],
      {
        id: "older-1111",
        source_session_id: "harness-other",
        git_branch: "flags-cleanup",
        user_id: USER,
        code_project_id: PROJECT_A,
        started_at: "2026-09-26T08:00:00Z",
        ended_at: "2026-09-26T09:00:00Z",
        files_touched: [],
      } as (typeof t.code_sessions)[number],
    ];
    const result = await buildPreamble(makeFakeSupabase(t), USER, {
      repo: REPO,
      branch: "feat-x",
      session: "harness-me",
    });
    expect(result.lines[0]).toContain("last session 3h ago");
    const text = result.lines.join("\n");
    expect(text).toContain("Another session ran here 3h ago on branch flags-cleanup (session older-1111).");
    expect(text).not.toContain("mine…");
  });
});

describe("renderRecordLine", () => {
  const rec = (o: Partial<ServedRecord>) =>
    ({
      id: "r",
      kind: "decision",
      text: "kept the queue",
      quote: null,
      verified: true,
      when: "2026-10-06T00:00:00Z",
      ...o,
    }) as ServedRecord;
  const url = "https://github.com/acme/codehub/issues/12";

  it("appends the ref's URL when it fits", () => {
    expect(renderRecordLine(rec({ ref_url: url }))).toBe(`- [decision] kept the queue → ${url}`);
  });

  it("caps the text at 300 chars and drops a URL that would pass the cap", () => {
    const line = renderRecordLine(rec({ text: "word ".repeat(100), ref_url: url }));
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).not.toContain("→");
  });
});
