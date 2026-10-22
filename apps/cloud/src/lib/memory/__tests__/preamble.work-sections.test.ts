// Preamble redesign: "On this branch" / "Elsewhere in this repo, last 7 days",
// one line per item saying what was done (current-work.ts renderWorkSections),
// the parallel-session line, and the 13 x 300 caps every installed CLI enforces.
import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ELSEWHERE_HEADING,
  type ForgeRefReadRow,
  fitLine,
  GOTCHAS_HEADING,
  ON_BRANCH_HEADING,
  RECENT_WORK_HEADING,
  renderWorkSections,
} from "../current-work";
import { buildPreamble, ROUTING_LINE } from "../preamble";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const USER = "user-1";
const PROJECT = "proj-a";
const PROJECT_IDENTITY = "codehub.example/acme/api";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";

const S_LEDGER = "5c61aaaa-0000-4000-8000-000000000001";
const S_LEDGER_OLD = "f65abbbb-0000-4000-8000-000000000002";
const S_FLAGS = "9b6fcccc-0000-4000-8000-000000000003";
const S_HEALTH = "a1b2dddd-0000-4000-8000-000000000004";
const S_ME = "eeee0000-0000-4000-8000-000000000005";

const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function session(id: string, branch: string | null, endedHoursAgo: number, over: Partial<Row> = {}): Row {
  return {
    id,
    user_id: USER,
    code_project_id: PROJECT,
    source_session_id: `${id.slice(0, 4)}0000-src`,
    git_branch: branch,
    short_title: null,
    parent_source_session_id: null,
    started_at: hoursAgo(endedHoursAgo + 1),
    ended_at: hoursAgo(endedHoursAgo),
    files_touched: [],
    ...over,
  };
}

function forge(over: Partial<ForgeRefReadRow>): Row {
  return {
    user_id: USER,
    session_id: S_LEDGER,
    turn_idx: 0,
    action_ix: 0,
    kind: "merge_request",
    target_kind: null,
    prose_ref: false,
    host: "codehub.example",
    project: "acme/api",
    number: null,
    sha: null,
    branch: null,
    observed_state: null,
    title: null,
    observed_at: hoursAgo(3),
    ...over,
  };
}

function memory(over: Partial<Row> & { id: string; text: string }): Row {
  return {
    user_id: USER,
    code_project_id: PROJECT,
    code_session_id: S_LEDGER,
    kind: "decision",
    ref: null,
    ref_kind: null,
    branch: null,
    supersedes: null,
    retired_at: null,
    created_at: hoursAgo(3),
    ...over,
  };
}

function tables(sessions: Row[], forgeRows: Row[], memories: Row[]) {
  return {
    code_projects: [{ id: PROJECT, user_id: USER, display_name: "acme/api", repo_identity: PROJECT_IDENTITY }],
    code_sessions: sessions,
    session_memories: memories,
    code_session_forge_refs: forgeRows,
  };
}

/** The brief's target shape: two items on the branch, one elsewhere, a parallel session. */
function fixture() {
  return tables(
    [
      session(S_ME, "feat-ledger", 0, { source_session_id: "harness-me", ended_at: null, started_at: hoursAgo(0.1) }),
      session(S_LEDGER, "feat-ledger", 3),
      session(S_LEDGER_OLD, "feat-ledger", 27),
      session(S_FLAGS, "flags-cleanup", 2),
      session(S_HEALTH, "health-check", 48),
    ],
    [
      forge({ number: 12, title: "Fix ledger totals", observed_state: "opened", observed_at: hoursAgo(3) }),
      forge({
        session_id: S_LEDGER_OLD,
        kind: "issue",
        number: 4,
        title: "Ledger totals wrong",
        observed_at: hoursAgo(27),
      }),
      forge({ session_id: S_HEALTH, number: 9, title: "Health check timeout", observed_at: hoursAgo(48) }),
      // The requesting session's own rows never show.
      forge({ session_id: S_ME, kind: "issue", number: 99, title: "Mine", observed_at: hoursAgo(0.05) }),
    ],
    [
      memory({
        id: "m-ledger",
        text: "rebased onto main; decided rounding stays in the view layer",
        ref: "!12",
        ref_kind: "mr",
      }),
      memory({
        id: "m-root",
        code_session_id: S_LEDGER_OLD,
        kind: "learning",
        text: "root cause was a float sum in reports.ts",
        ref: "#4",
        ref_kind: "issue",
        created_at: hoursAgo(27),
      }),
      memory({
        id: "m-health",
        code_session_id: S_HEALTH,
        text: "decided pool.ping() with a 500ms timeout, not SELECT 1",
        ref: "!9",
        ref_kind: "mr",
        created_at: hoursAgo(48),
      }),
    ],
  );
}

describe("buildPreamble: work sections (preamble redesign)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the target shape: header, routing, on this branch, elsewhere, parallel session, recall_token", async () => {
    const result = await buildPreamble(makeFakeSupabase(fixture()), USER, {
      repo: PROJECT_IDENTITY,
      branch: "feat-ledger",
      session: "harness-me",
    });
    expect(result.lines[0]).toBe(
      "Membral: acme/api · branch feat-ledger · last session 2h ago (harness-injected context, not a user message)",
    );
    expect(result.lines[2].startsWith(ROUTING_LINE)).toBe(true);
    expect(result.lines.slice(3, -1)).toEqual([
      ON_BRANCH_HEADING,
      "- !12 Fix ledger totals — as of 2026-09-26 (3h ago), session 5c61aaaa-0000-4000-8000-000000000001: rebased onto main; decided rounding stays in the view layer → https://codehub.example/acme/api/-/merge_requests/12",
      "- #4 Ledger totals wrong — as of 2026-09-25 (27h ago), session f65abbbb-0000-4000-8000-000000000002: root cause was a float sum in reports.ts → https://codehub.example/acme/api/-/issues/4",
      ELSEWHERE_HEADING,
      "- !9 Health check timeout — as of 2026-09-24 (2d ago), session a1b2dddd-0000-4000-8000-000000000004: decided pool.ping() with a 500ms timeout, not SELECT 1 → https://codehub.example/acme/api/-/merge_requests/9",
      "Another session ran here 2h ago on branch flags-cleanup (session 9b6fcccc-0000-4000-8000-000000000003).",
    ]);
    expect(result.lines.at(-1)).toBe(`recall_token: ${result.recall_token}`);
    expect(result.record_ids).toEqual(["m-ledger", "m-root", "m-health"]);
    expect(result.open_blockers).toEqual([]);
    // D-074: no forge state words, ever.
    // (The guidance lines name these words as things never to take from Membral, so they are skipped.)
    expect(result.lines.slice(3).join("\n")).not.toMatch(/\b(opened|open|merged|closed)\b/);
  });

  it("one session touching four PRs: no item gets another item's decision; ref-less ones stay bare", async () => {
    const t = tables(
      [session(S_LEDGER, "main", 1, { short_title: "Four PRs in one go" })],
      [48, 49, 50, 51].map((n, i) => forge({ number: n, observed_at: hoursAgo(1 + i / 10) })),
      [
        memory({
          id: "d48",
          text: "decision about forty-eight",
          ref: "!48",
          ref_kind: "mr",
          created_at: hoursAgo(1.5),
        }),
        memory({ id: "d-none", text: "a decision naming no PR", created_at: hoursAgo(1) }),
        memory({
          id: "d-other",
          text: "a decision about another PR",
          ref: "!77",
          ref_kind: "mr",
          created_at: hoursAgo(1),
        }),
      ],
    );
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "main" });
    const itemLines = result.lines.filter((l) => /^- !\d+/.test(l));
    expect(itemLines).toEqual([
      "- !48 — as of 2026-09-26 (1h ago), session 5c61aaaa-0000-4000-8000-000000000001: decision about forty-eight → https://codehub.example/acme/api/-/merge_requests/48",
      "- !49 — as of 2026-09-26 (1h ago), session 5c61aaaa-0000-4000-8000-000000000001 → https://codehub.example/acme/api/-/merge_requests/49",
      "- !50 — as of 2026-09-26 (1h ago), session 5c61aaaa-0000-4000-8000-000000000001 → https://codehub.example/acme/api/-/merge_requests/50",
      "- !51 — as of 2026-09-26 (1h ago), session 5c61aaaa-0000-4000-8000-000000000001 → https://codehub.example/acme/api/-/merge_requests/51",
    ]);
    // The session touched four items, so its own title names none of them.
    expect(result.lines.join("\n")).not.toContain("Four PRs in one go");
  });

  it("cuts what was done to 120 chars on a word boundary", async () => {
    const t = tables(
      [session(S_LEDGER, "main", 1)],
      [forge({ number: 12 })],
      [memory({ id: "long", text: "alpha ".repeat(60), ref: "!12", ref_kind: "mr", created_at: hoursAgo(1) })],
    );
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "main" });
    const line = result.lines.find((l) => l.startsWith("- !12")) as string;
    // The text part only: the item URL rides after it (` → https://…`).
    const text = line.slice(line.indexOf(": ") + 2, line.indexOf(" → "));
    expect(text.length).toBeLessThanOrEqual(120);
    // Full session id and URL on top of the text, still inside the CLI's 300-char line cut.
    expect(line.length).toBeLessThanOrEqual(300);
    expect(text.endsWith("alpha…")).toBe(true);
  });

  it("drops an item URL that would not fit the 300-char line whole, never cutting it", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    const at = "2026-10-08T09:00:00Z";
    const sid = "5c61aaaa-0000-4000-8000-000000000001";
    const item = (url: string) => ({
      key: "k",
      kind: "merge_request" as const,
      token: "!77",
      title: "Split totals per user ".repeat(4).trim(),
      lastSeen: at,
      sessionSeen: new Map([[sid, at]]),
      url,
    });
    const render = (url: string) =>
      renderWorkSections({
        items: [item(url)],
        keyOfMemoryRef: () => null,
        memories: [],
        sessions: [
          {
            id: sid,
            source_session_id: null,
            parent_source_session_id: null,
            git_branch: "main",
            short_title: null,
            started_at: "2026-10-01T00:00:00Z",
            ended_at: "2026-10-01T01:00:00Z",
            files_touched: [],
          },
        ],
        branch: "main",
        maxLines: 10,
        now,
      }).lines.find((l) => l.includes("!77")) as string;
    const short = "https://codehub.example/acme/api/-/merge_requests/77";
    expect(render(short).endsWith(` → ${short}`)).toBe(true);
    const deep = `https://codehub.example/acme/${"subgroup-number-one/".repeat(8)}api/-/merge_requests/77`;
    const line = render(deep);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).not.toContain("→");
    expect(line).not.toContain("https://");
  });

  it("falls back to the session's short title when it touched only that item, then to no colon part", async () => {
    const t = tables(
      [session(S_LEDGER, "feat-ledger", 3, { short_title: "Ledger totals fix" }), session(S_HEALTH, "other", 5)],
      [forge({ number: 12 }), forge({ session_id: S_HEALTH, number: 9, observed_at: hoursAgo(5) })],
      [],
    );
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "feat-ledger" });
    expect(result.lines).toContain(
      `- !12 — as of 2026-09-26 (3h ago), session 5c61aaaa-0000-4000-8000-000000000001: Ledger totals fix → https://codehub.example/acme/api/-/merge_requests/12`,
    );
    expect(result.lines).toContain(
      `- !9 — as of 2026-09-26 (5h ago), session a1b2dddd-0000-4000-8000-000000000004 → https://codehub.example/acme/api/-/merge_requests/9`,
    );
  });

  it("never renders a decision without a ref; recent learnings fill Gotchas (deduped, newest first)", async () => {
    const t = tables(
      [session(S_LEDGER, "feat-ledger", 30), session(S_FLAGS, "flags-cleanup", 40)],
      [],
      [
        memory({ id: "b1", text: "keep the ledger view read-only", branch: "feat-ledger", created_at: hoursAgo(30) }),
        memory({
          id: "e1",
          code_session_id: S_FLAGS,
          kind: "outcome",
          text: "removed three dead flags",
          created_at: hoursAgo(40),
        }),
        memory({
          id: "g1",
          kind: "learning",
          text: "Run the db:types step after rebasing on main.",
          created_at: hoursAgo(5),
        }),
        memory({
          id: "g1b",
          kind: "learning",
          text: "run the db types step after rebasing on main",
          created_at: hoursAgo(6),
        }),
        memory({
          id: "g2",
          code_session_id: S_FLAGS,
          kind: "learning",
          text: "The fake client ignores .or()",
          created_at: hoursAgo(7),
        }),
        memory({ id: "g3", kind: "learning", text: "third learning", created_at: hoursAgo(8) }),
      ],
    );
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "feat-ledger" });
    expect(result.lines.slice(3, -1)).toEqual([
      GOTCHAS_HEADING,
      "- Run the db:types step after rebasing on main.",
      "- The fake client ignores .or()",
    ]);
    expect(result.lines.join("\n")).not.toMatch(/read-only|dead flags/);
  });

  it("keeps issues like MRs, including a cross-project issue and one a sub-agent touched, ranked by recency", async () => {
    const t = tables(
      [
        session(S_LEDGER, "main", 1, { source_session_id: "parent-src" }),
        session(S_FLAGS, "main", 1, { parent_source_session_id: "parent-src" }),
      ],
      [
        forge({ number: 12, observed_at: hoursAgo(5) }),
        forge({ session_id: S_FLAGS, kind: "issue", number: 16399, observed_at: hoursAgo(1) }),
        forge({
          session_id: S_FLAGS,
          kind: "issue",
          host: null,
          project: "acme/meta",
          number: 3303,
          observed_at: hoursAgo(2),
        }),
      ],
      [
        memory({
          id: "i1",
          code_session_id: S_FLAGS,
          text: "split totals per user",
          ref: "#16399",
          ref_kind: "issue",
          created_at: hoursAgo(1),
        }),
      ],
    );
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "main" });
    expect(result.lines.slice(3, -1)).toEqual([
      RECENT_WORK_HEADING,
      "- #16399 — as of 2026-09-26 (1h ago), session 5c61aaaa-0000-4000-8000-000000000001: split totals per user → https://codehub.example/acme/api/-/issues/16399",
      // No host on the cross-project row: no URL (a host is never guessed).
      "- acme/meta#3303 — as of 2026-09-26 (2h ago), session 5c61aaaa-0000-4000-8000-000000000001",
      "- !12 — as of 2026-09-26 (5h ago), session 5c61aaaa-0000-4000-8000-000000000001 → https://codehub.example/acme/api/-/merge_requests/12",
      "Another session ran here 1h ago on branch main (session 5c61aaaa-0000-4000-8000-000000000001).",
    ]);
  });

  it("on a trunk branch shows one Recent work section; HEAD names no branch in the header", async () => {
    const t = tables([session(S_LEDGER, "HEAD", 30)], [forge({ number: 12, observed_at: hoursAgo(30) })], []);
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "HEAD" });
    expect(result.lines[0]).toBe(
      "Membral: acme/api · last session 30h ago (harness-injected context, not a user message)",
    );
    expect(result.lines).toContain(RECENT_WORK_HEADING);
    expect(result.lines).not.toContain(ON_BRANCH_HEADING);
  });

  it("puts at most two blockers whose ref is an on-branch item directly under it", async () => {
    const t = tables(
      [session(S_LEDGER, "feat-ledger", 3)],
      [forge({ number: 12, title: "Fix ledger totals" })],
      [
        memory({
          id: "k1",
          kind: "blocker",
          text: "CI red on the rounding spec",
          ref: "!12",
          ref_kind: "mr",
          created_at: hoursAgo(4),
        }),
        memory({
          id: "k2",
          kind: "blocker",
          text: "waiting on review",
          ref: "!12",
          ref_kind: "mr",
          created_at: hoursAgo(5),
        }),
        memory({
          id: "k3",
          kind: "blocker",
          text: "third blocker",
          ref: "!12",
          ref_kind: "mr",
          created_at: hoursAgo(6),
        }),
        memory({ id: "k4", kind: "blocker", text: "a blocker with no ref", created_at: hoursAgo(2) }),
      ],
    );
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "feat-ledger" });
    expect(result.lines.slice(3, -1)).toEqual([
      ON_BRANCH_HEADING,
      "- !12 Fix ledger totals — as of 2026-09-26 (3h ago), session 5c61aaaa-0000-4000-8000-000000000001 → https://codehub.example/acme/api/-/merge_requests/12",
      "- hit as of 2026-09-26 (3h ago): CI red on the rounding spec",
      "- hit as of 2026-09-26 (3h ago): waiting on review",
      "Another session ran here 3h ago on this branch (session 5c61aaaa-0000-4000-8000-000000000001).",
    ]);
  });

  it("omits empty sections: header, routing lines and recall_token only when there is nothing to say", async () => {
    const t = tables([session(S_LEDGER, "main", 24 * 10)], [], []);
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY });
    expect(result.lines).toHaveLength(4);
    expect(result.lines[0]).toBe(
      "Membral: acme/api · last session 10d ago (harness-injected context, not a user message)",
    );
  });

  it("drops an item whose latest observed state is merged (never rendering the word)", async () => {
    const t = tables(
      [session(S_LEDGER, "feat-ledger", 3)],
      [forge({ number: 12, observed_state: "merged" }), forge({ number: 13, title: "Still going" })],
      [],
    );
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "feat-ledger" });
    const text = result.lines.slice(3).join("\n");
    expect(text).not.toContain("!12");
    expect(text).toContain("!13 Still going");
    expect(text).not.toMatch(/merged/);
  });

  it("stays within 13 lines of at most 300 chars with many items and long memories", async () => {
    const long = "word ".repeat(120).trim();
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session(
        `${String(i).padStart(4, "0")}aaaa-0000-4000-8000-00000000000${i % 10}`,
        i % 2 ? "feat-ledger" : "other",
        i + 1,
      ),
    );
    const rows = sessions.map((s, i) =>
      forge({ session_id: s.id as string, number: i + 1, title: "T".repeat(150), observed_at: hoursAgo(i + 1) }),
    );
    const mems = sessions.map((s, i) =>
      memory({ id: `m${i}`, code_session_id: s.id as string, text: long, created_at: hoursAgo(i + 1) }),
    );
    const result = await buildPreamble(makeFakeSupabase(tables(sessions, rows, mems)), USER, {
      repo: PROJECT_IDENTITY,
      branch: "feat-ledger",
    });
    expect(result.lines).toHaveLength(13);
    for (const l of result.lines.slice(0, -1)) expect(l.length).toBeLessThanOrEqual(300);
    expect(result.lines).toContain(ON_BRANCH_HEADING);
    expect(result.lines).toContain(ELSEWHERE_HEADING);
    expect(result.lines.some((l) => l.startsWith("Another session ran here"))).toBe(true);
  });

  it("serves the sections without titles when migration 117's columns are missing", async () => {
    const inner = makeFakeSupabase(fixture());
    const supabase = {
      ...inner,
      from(table: string) {
        const q = inner.from(table);
        const select = q.select.bind(q);
        q.select = (cols?: string, opts?: unknown) => {
          if (table === "session_memories" && cols?.includes("ref_title")) {
            const failed = Promise.resolve({ data: null, error: { message: "column does not exist", code: "42703" } });
            const chain: Record<string, unknown> = {};
            for (const m of ["eq", "is", "not", "in", "order", "limit"]) chain[m] = () => chain;
            // biome-ignore lint/suspicious/noThenProperty: a thenable query builder, like PostgREST's
            chain.then = failed.then.bind(failed);
            return chain;
          }
          return select(cols, opts as never);
        };
        return q;
      },
    } as typeof inner;
    const result = await buildPreamble(supabase, USER, { repo: PROJECT_IDENTITY, branch: "feat-ledger" });
    expect(result.lines).toContain(ON_BRANCH_HEADING);
  });
});

describe("buildPreamble: blockers and moved refs (review fixes)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never renders a blocker older than 7 days, and a recurrence chain is one line", async () => {
    const t = tables(
      [session(S_LEDGER, "feat-ledger", 3), session(S_LEDGER_OLD, "feat-ledger", 24 * 25)],
      [forge({ number: 12 })],
      [
        memory({
          id: "old",
          kind: "blocker",
          text: "stale blocker",
          ref: "!12",
          ref_kind: "mr",
          code_session_id: S_LEDGER_OLD,
          created_at: hoursAgo(24 * 25),
        }),
        memory({
          id: "root",
          kind: "blocker",
          text: "CI red again",
          ref: "!12",
          ref_kind: "mr",
          created_at: hoursAgo(30),
        }),
        memory({
          id: "again",
          kind: "blocker",
          text: "CI red, third time",
          ref: "!12",
          ref_kind: "mr",
          recurs_of: "root",
          created_at: hoursAgo(4),
        }),
      ],
    );
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "feat-ledger" });
    const hits = result.lines.filter((l) => l.startsWith("- hit "));
    expect(hits).toEqual(["- hit as of 2026-09-26 (3h ago): CI red, third time"]);
  });

  it("a backfilled in-window session renders its session age (2d), not the extraction age", async () => {
    // S_OUT is a 2-day-old session; its blocker was extracted just now.
    const S_OUT = "0a0a0000-0000-4000-8000-000000000006";
    const t = tables(
      [session(S_LEDGER, "feat-ledger", 3), session(S_LEDGER_OLD, "feat-ledger", 24 * 20)],
      [forge({ number: 12 })],
      [
        // Session 20 days old, extracted just now: must not show.
        memory({
          id: "bf",
          kind: "blocker",
          text: "backfilled stale",
          ref: "!12",
          ref_kind: "mr",
          code_session_id: S_LEDGER_OLD,
          created_at: hoursAgo(0.1),
        }),
        // Session 2 days old, extracted just now: shows as 2d, never 0h.
        memory({
          id: "out",
          kind: "blocker",
          text: "backfilled in window",
          ref: "!12",
          ref_kind: "mr",
          code_session_id: S_OUT,
          created_at: hoursAgo(0.1),
        }),
      ],
    );
    t.code_sessions.push(session(S_OUT, "feat-ledger", 48));
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "feat-ledger" });
    const hits = result.lines.filter((l) => l.startsWith("- hit "));
    expect(hits).toEqual(["- hit as of 2026-09-24 (2d ago): backfilled in window"]);
  });

  it("reads the times of sessions missing from the window list by id; their blockers are not rendered", async () => {
    const S_GONE = "0b0b0000-0000-4000-8000-000000000007";
    const t = tables(
      [session(S_LEDGER, "feat-ledger", 3)],
      [forge({ number: 12 })],
      [
        memory({
          id: "gone",
          kind: "blocker",
          text: "no listed session",
          ref: "!12",
          ref_kind: "mr",
          code_session_id: S_GONE,
          created_at: hoursAgo(0.1),
        }),
      ],
    );
    // Not in the project window list (another project's session), but its row exists for the by-id read.
    t.code_sessions.push(session(S_GONE, "feat-ledger", 24 * 40, { code_project_id: "other-proj" }));
    const fake = makeFakeSupabase(t);
    const inCalls: unknown[][] = [];
    // biome-ignore lint/suspicious/noExplicitAny: a recording proxy over the untyped fake query builder
    const watch = (q: any): any =>
      new Proxy(q, {
        get(target, prop) {
          const v = target[prop];
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            if (prop === "in" && args[0] === "id") inCalls.push(args[1] as unknown[]);
            const r = v.apply(target, args);
            return r === target ? watch(r) : r;
          };
        },
      });
    const realFrom = fake.from.bind(fake);
    fake.from = (table: string) => (table === "code_sessions" ? watch(realFrom(table)) : realFrom(table));
    const result = await buildPreamble(fake, USER, { repo: PROJECT_IDENTITY, branch: "feat-ledger" });
    expect(inCalls).toContainEqual([S_GONE]);
    expect(result.lines.filter((l) => l.startsWith("- hit "))).toEqual([]);
  });

  it("a bare-ref memory follows its session's moved row to the other repo", async () => {
    const t = tables(
      [session(S_LEDGER, "main", 1)],
      [
        // `glab mr view 123456` without -R (filed under this repo), retried against the right repo 9s later.
        forge({ number: 123456, observed_at: hoursAgo(2) }),
        forge({
          number: 123456,
          project: "codehub-org/codehub",
          observed_at: new Date(NOW - 2 * 3_600_000 + 9_000).toISOString(),
        }),
      ],
      [memory({ id: "rv", text: "review posted", ref: "!123456", ref_kind: "mr", created_at: hoursAgo(1) })],
    );
    const result = await buildPreamble(makeFakeSupabase(t), USER, { repo: PROJECT_IDENTITY, branch: "main" });
    const items = result.lines.filter((l) => /^- \S*!123456/.test(l));
    expect(items).toEqual([
      `- codehub-org/codehub!123456 — as of 2026-09-26 (1h ago), session 5c61aaaa-0000-4000-8000-000000000001: review posted → https://codehub.example/codehub-org/codehub/-/merge_requests/123456`,
    ]);
  });
});

describe("fitLine", () => {
  it("cuts on a word boundary within 300 chars and marks the cut", () => {
    const line = fitLine("- !12 Fix — as of 2026-09-26 (3h ago), session 5c610000…", "alpha ".repeat(80));
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line.endsWith("alpha…")).toBe(true);
  });

  it("renders the prefix alone when there is no text", () => {
    expect(fitLine("- #4 — as of 2026-09-24 (2d ago)", null)).toBe("- #4 — as of 2026-09-24 (2d ago)");
  });
});
