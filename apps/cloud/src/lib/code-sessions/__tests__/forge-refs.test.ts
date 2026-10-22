// W3 D9: observed forge refs (docs/design/observed-forge-refs.md §1–§3, §5).
// Fixtures use the fictional forge codehub.example; github.com only where the
// GitHub kind fold is under test.
import { createHash } from "node:crypto";
import { createFakeDb, FakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import {
  computeForgeRefs,
  FORGE_REFS_VERSION,
  type ForgeRefRow,
  type ForgeRefTurn,
  loadRefTurns,
  refillSessionForgeRefs,
  storedItemKey,
} from "../forge-refs";
import { importCodeSession } from "../import";
import type { RawCodeSessionPayload } from "../payload";

const STARTED = "2026-10-02T09:00:00.000Z";
const PROJECT = "codehub.example/acme/billing";

function turn(idx: number, actions: unknown[], extra: Partial<ForgeRefTurn> = {}): ForgeRefTurn {
  const props = actions.length === 1 ? { action: actions[0] } : { action: actions[0], actions };
  return { idx, ts: `2026-10-02T09:0${idx}:00.000Z`, tool_name: "Bash", props, ...extra };
}

function refs(turns: ForgeRefTurn[], identities: string[] = [PROJECT], project: string | null = PROJECT) {
  return computeForgeRefs(turns, { projectIdentity: project, projectIdentities: identities, startedAt: STARTED });
}

const keys = (rows: ForgeRefRow[]) => rows.map((r) => r.item_key);

describe("computeForgeRefs", () => {
  it("resolves host and no-host spellings of one item to one item_key", () => {
    const rows = refs([
      turn(0, [{ verb: "viewed", source: "cli", ref: "codehub.example/acme/billing!17", refKind: "merge_request" }]),
      turn(1, [{ verb: "viewed", source: "mcp", ref: "acme/billing!17", refKind: "merge_request" }], {
        tool_name: "mcp__codehub__get_merge_request",
      }),
      turn(2, [{ verb: "checked_out", source: "cli", ref: "!17", refKind: "merge_request", branch: "17-fix" }]),
    ]);
    expect(new Set(keys(rows))).toEqual(new Set(["merge_request codehub.example/acme/billing#17"]));
    expect(rows.map((r) => [r.host, r.project, r.number])).toEqual([
      ["codehub.example", "acme/billing", 17],
      ["codehub.example", "acme/billing", 17],
      ["codehub.example", "acme/billing", 17],
    ]);
    expect(rows[2].branch).toBe("17-fix");
  });

  it("keeps two forges holding the same owner/repo distinct, and a host-less spelling unbound", () => {
    const identities = ["github.com/acme/web", "codehub.example/acme/web"];
    const rows = refs(
      [
        turn(0, [{ verb: "viewed", source: "cli", ref: "github.com/acme/web#5", refKind: "issue" }]),
        turn(1, [{ verb: "viewed", source: "cli", ref: "codehub.example/acme/web#5", refKind: "issue" }]),
        turn(2, [{ verb: "viewed", source: "mcp", ref: "acme/web#5", refKind: "issue" }]),
      ],
      identities,
      "codehub.example/acme/web",
    );
    expect(keys(rows)).toEqual(["issue github.com/acme/web#5", "issue codehub.example/acme/web#5", "issue acme/web#5"]);
  });

  it("stores a state with the observation time of its turn (session start when the turn has none)", () => {
    const rows = refs([
      turn(3, [{ verb: "viewed", source: "cli", ref: "!9", refKind: "merge_request", state: "opened", title: "Fix" }]),
      turn(4, [{ verb: "merged", source: "cli", ref: "!9", refKind: "merge_request", state: "merged" }], { ts: null }),
    ]);
    expect(rows.map((r) => [r.observed_state, r.observed_at, r.title])).toEqual([
      ["opened", "2026-10-02T09:03:00.000Z", "Fix"],
      ["merged", STARTED, null],
    ]);
  });

  it("takes no title or state from an MCP list tool, nor a state implied by an MCP verb", () => {
    const listed = {
      verb: "viewed",
      source: "mcp",
      ref: "acme/billing#3",
      refKind: "issue",
      state: "opened",
      title: "T",
    };
    const rows = refs([
      turn(0, [listed], { tool_name: "mcp__codehub__list_issues" }),
      turn(1, [listed], { tool_name: "mcp__codehub__get_issue_comments" }),
      turn(2, [listed], { tool_name: "mcp__codehub__get_issue" }),
      turn(3, [{ verb: "reopened", source: "mcp", ref: "acme/billing#3", refKind: "issue", state: "opened" }], {
        tool_name: "mcp__codehub__reopen_issue",
      }),
    ]);
    expect(rows.map((r) => [r.observed_state, r.title])).toEqual([
      [null, null],
      [null, null],
      ["opened", "T"],
      [null, null],
    ]);
  });

  it("writes slash-line and pasted refs as prose_ref rows", () => {
    const rows = refs([
      turn(0, [{ verb: "referenced", source: "command", ref: "#12", refKind: "issue", skill: "review" }]),
      turn(1, [
        {
          verb: "referenced",
          source: "paste",
          ref: "acme/billing!40",
          refKind: "merge_request",
          url: "https://codehub.example/acme/billing/-/merge_requests/40",
        },
      ]),
    ]);
    expect(rows.map((r) => [r.kind, r.prose_ref, r.verb, r.item_key])).toEqual([
      ["issue", true, "referenced", "issue codehub.example/acme/billing#12"],
      ["merge_request", true, "referenced", "merge_request codehub.example/acme/billing#40"],
    ]);
  });

  it("writes commits, subject refs carrying the sha, branches and comments", () => {
    const rows = refs([
      turn(0, [
        {
          verb: "committed",
          source: "cli",
          refKind: "commit",
          sha: "a1b2c3d",
          branch: "fix-4",
          subject: "Fix totals #4",
        },
        { verb: "pushed", source: "cli", refKind: "branch", ref: "fix-4", branch: "fix-4" },
      ]),
      turn(1, [{ verb: "commented", source: "cli", ref: "!9", refKind: "merge_request" }]),
      turn(2, [{ verb: "pushed", source: "cli", refKind: "branch", ref: "x", repoUnknown: true }]),
      turn(3, [{ verb: "viewed", source: "cli", ref: "#8", refKind: "issue", repoUnknown: true }]),
    ]);
    expect(rows.map((r) => [r.action_ix, r.kind, r.target_kind, r.sha, r.branch, r.item_key])).toEqual([
      [0, "commit", null, "a1b2c3d", "fix-4", "commit codehub.example/acme/billing@a1b2c3d"],
      [0, "issue", null, "a1b2c3d", null, "issue codehub.example/acme/billing#4"],
      [1, "branch", null, null, "fix-4", "branch codehub.example/acme/billing@fix-4"],
      [0, "comment", "merge_request", null, null, "merge_request codehub.example/acme/billing#9"],
    ]);
  });

  it("folds a GitHub subject ref to the kind another action observed, else keys it kind-less", () => {
    const gh = "github.com/acme/web";
    const rows = refs(
      [
        turn(0, [{ verb: "viewed", source: "cli", ref: `${gh}#5`, refKind: "merge_request" }]),
        turn(1, [{ verb: "committed", source: "cli", refKind: "commit", sha: "abcdef1", subject: "Land (#5) and #6" }]),
      ],
      [gh],
      gh,
    );
    const subject = rows.filter((r) => r.turn_idx === 1 && r.kind !== "commit");
    expect(subject.map((r) => [r.kind, r.item_key])).toEqual([
      ["merge_request", "merge_request github.com/acme/web#5"],
      ["issue", "github.com/acme/web#6"],
    ]);
  });

  it("stores keys Postgres text can hold (no U+0000)", () => {
    const rows = refs([turn(0, [{ verb: "viewed", source: "cli", ref: "!17", refKind: "merge_request" }])]);
    expect(rows[0].item_key).toBe("merge_request codehub.example/acme/billing#17");
    expect(rows.some((r) => r.item_key.includes("\u0000"))).toBe(false);
  });

  it("is deterministic: the same turns give the same rows", () => {
    const turns = [
      turn(0, [{ verb: "viewed", source: "cli", ref: "!17", refKind: "merge_request", state: "opened" }]),
      turn(1, [{ verb: "committed", source: "cli", refKind: "commit", sha: "a1b2c3d", subject: "x #17" }]),
    ];
    expect(refs(turns)).toEqual(refs(turns));
  });
});

describe("importCodeSession writes forge refs in the turns RPC", () => {
  const USER_ID = "user-1";
  const session: RawCodeSessionPayload = {
    source: "claude-code",
    sourceSessionId: "session-refs",
    contentHash: "hash-refs",
    repo: { path: "/Users/dev/billing", remoteUrl: "https://codehub.example/acme/billing.git", branch: "main" },
    startedAt: STARTED,
    endedAt: "2026-10-02T09:30:00.000Z",
    model: "claude-code-sonnet",
    turns: [
      { idx: 0, role: "user", kind: "prose", text: "look at !17", ts: STARTED },
      {
        idx: 1,
        role: "assistant",
        kind: "tool_use",
        toolName: "Bash",
        ts: "2026-10-02T09:01:00.000Z",
        action: { verb: "viewed", source: "cli", ref: "!17", refKind: "merge_request", state: "opened" },
      },
      {
        idx: 2,
        role: "assistant",
        kind: "tool_use",
        toolName: "Bash",
        ts: "2026-10-02T09:02:00.000Z",
        action: {
          verb: "committed",
          source: "cli",
          refKind: "commit",
          sha: "a1b2c3d",
          branch: "17-fix",
          subject: "Fix #4",
        },
      },
    ],
    filesTouched: [],
    toolCounts: { Bash: 2 },
  } as RawCodeSessionPayload;

  const refsPayloads = (db: FakeSupabase) =>
    db.oplog
      .filter((o) => o.op === "rpc" && o.table === "import_code_session_turns")
      .map((o) => (o.payload as Record<string, unknown>) ?? {});

  it("sends the session's rows and version, and the same rows again on a re-import", async () => {
    const db = new FakeSupabase();
    expect((await importCodeSession(db.asClient(), USER_ID, session)).status).toBe("imported");
    expect((await importCodeSession(db.asClient(), USER_ID, session, true)).status).toBe("imported");
    const [first, second] = refsPayloads(db);
    expect(first.p_forge_refs_version).toBe(FORGE_REFS_VERSION);
    const rows = first.p_forge_refs as ForgeRefRow[];
    expect(rows.map((r) => [r.kind, r.item_key])).toEqual([
      ["merge_request", "merge_request codehub.example/acme/billing#17"],
      ["commit", "commit codehub.example/acme/billing@a1b2c3d"],
      ["issue", "issue codehub.example/acme/billing#4"],
    ]);
    expect(second.p_forge_refs).toEqual(first.p_forge_refs);
  });
});

describe("branch rows from checkouts (branchConfirmed)", () => {
  it("writes a checkout/switch branch row only when the parser confirmed the name", () => {
    const rows = refs([
      turn(0, [
        { verb: "navigated", source: "cli", ref: "fix-4", refKind: "branch", branch: "fix-4", branchConfirmed: true },
      ]),
      turn(1, [{ verb: "navigated", source: "cli", ref: "src/a.ts", refKind: "branch", branch: "src/a.ts" }]),
      turn(2, [{ verb: "pushed", source: "cli", ref: "fix-4", refKind: "branch", branch: "fix-4" }]),
    ]);
    expect(rows.map((r) => [r.turn_idx, r.verb, r.branch])).toEqual([
      [0, "navigated", "fix-4"],
      [2, "pushed", "fix-4"],
    ]);
  });

  it("storedItemKey replaces every U+0000", () => {
    expect(storedItemKey("issue\u0000a\u0000b")).toBe("issue a b");
  });
});

describe("backfill: paged turns and the hash guard", () => {
  const USER = "user-1";
  const SESSION = "session-1";
  const turnRows = Array.from({ length: 5 }, (_, idx) => ({
    id: `turn-${idx}`,
    user_id: USER,
    session_id: SESSION,
    idx,
    ts: `2026-10-02T09:0${idx}:00.000Z`,
    tool_name: "Bash",
    props: { action: { verb: "viewed", source: "cli", ref: `!${idx + 1}`, refKind: "merge_request" } },
  }));
  const md5 = (ids: string[]) => createHash("md5").update(ids.join(",")).digest("hex");

  it("loadRefTurns reads every page until a short one (PostgREST caps a response at 1000 rows)", async () => {
    const db = createFakeDb({
      flavour: "db",
      recordReads: true,
      tables: { code_session_turns: [...turnRows].reverse() },
    });
    const { turns, turnIdsMd5 } = await loadRefTurns(db.asClient(), USER, SESSION, 2);
    expect(turns.map((t) => t.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(turnIdsMd5).toBe(md5(turnRows.map((t) => t.id)));
    const ranges = db.oplog.filter((o) => o.table === "code_session_turns").length;
    expect(ranges).toBe(3);
  });

  function guardedDb(storedHash: string) {
    const writes: Record<string, unknown>[] = [];
    const db = createFakeDb({
      flavour: "db",
      tables: { code_session_turns: turnRows },
      rpc: {
        // Mirrors migration 115's guard: content_hash and turn-id md5 must be what the caller read.
        replace_code_session_forge_refs: (args) => {
          if (args.p_expected_content_hash !== storedHash) return { data: -1, error: null };
          if (args.p_expected_turn_ids_md5 !== md5(turnRows.map((t) => t.id))) return { data: -1, error: null };
          writes.push(args);
          return { data: (args.p_forge_refs as unknown[]).length, error: null };
        },
      },
    });
    return { db, writes };
  }
  const session = (content_hash: string) => ({
    id: SESSION,
    user_id: USER,
    started_at: STARTED,
    content_hash,
    projectIdentity: PROJECT,
  });

  it("writes when the session is unchanged, passing what it read", async () => {
    const { db, writes } = guardedDb("h1");
    expect(await refillSessionForgeRefs(db.asClient(), session("h1"), [PROJECT], { pageSize: 2 })).toEqual({
      status: "written",
      rows: 5,
    });
    expect(writes[0].p_forge_refs_version).toBe(FORGE_REFS_VERSION);
  });

  it("skips when a concurrent import changed the session under the lock, and when an import is in flight", async () => {
    const changed = guardedDb("h2");
    expect(await refillSessionForgeRefs(changed.db.asClient(), session("h1"), [PROJECT])).toEqual({
      status: "skipped",
      rows: 0,
    });
    expect(changed.writes).toHaveLength(0);
    const pending = guardedDb("");
    expect(await refillSessionForgeRefs(pending.db.asClient(), session(""), [PROJECT])).toEqual({
      status: "skipped",
      rows: 0,
    });
    expect(pending.db.oplog.some((o) => o.op === "rpc")).toBe(false);
  });
});

describe("upload schema carries the fields the fill reads", () => {
  const base = {
    source: "claude-code",
    sourceSessionId: "session-wire",
    contentHash: "hash-wire",
    repo: { path: "/Users/dev/billing", remoteUrl: "https://codehub.example/acme/billing.git", branch: "main" },
    startedAt: STARTED,
    endedAt: "2026-10-02T09:30:00.000Z",
    model: "claude-code-sonnet",
    filesTouched: [],
    toolCounts: { Bash: 2 },
  };
  const toolTurn = (idx: number, action: Record<string, unknown>) => ({
    idx,
    role: "assistant",
    kind: "tool_use",
    toolName: "Bash",
    ts: `2026-10-02T09:0${idx}:00.000Z`,
    action,
  });

  it("keeps branchConfirmed and title through the request schema into importCodeSession's fill", async () => {
    const { CodeSessionsRequestSchema } = await import("../payload");
    const parsed = CodeSessionsRequestSchema.parse({
      sessions: [
        {
          ...base,
          turns: [
            toolTurn(0, {
              verb: "navigated",
              source: "cli",
              ref: "fix-4",
              refKind: "branch",
              branch: "fix-4",
              branchConfirmed: true,
            }),
            toolTurn(1, {
              verb: "viewed",
              source: "cli",
              ref: "!17",
              refKind: "merge_request",
              title: "Fix ledger totals",
            }),
          ],
        },
      ],
    });
    const action0 = parsed.sessions[0].turns[0].action;
    expect(action0?.branchConfirmed).toBe(true);
    expect(parsed.sessions[0].turns[1].action?.title).toBe("Fix ledger totals");

    const db = new FakeSupabase();
    expect((await importCodeSession(db.asClient(), "user-1", parsed.sessions[0])).status).toBe("imported");
    const call = db.oplog.find((o) => o.op === "rpc" && o.table === "import_code_session_turns");
    const rows = (call?.payload as { p_forge_refs: ForgeRefRow[] }).p_forge_refs;
    expect(rows.map((r) => [r.kind, r.branch, r.title])).toEqual([
      ["branch", "fix-4", null],
      ["merge_request", null, "Fix ledger totals"],
    ]);
  });

  it("still accepts an old CLI's action with neither field", async () => {
    const { CodeSessionsRequestSchema } = await import("../payload");
    const res = CodeSessionsRequestSchema.safeParse({
      sessions: [
        { ...base, turns: [toolTurn(0, { verb: "viewed", source: "cli", ref: "!17", refKind: "merge_request" })] },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.data?.sessions[0].turns[0].action).toEqual({
      verb: "viewed",
      source: "cli",
      ref: "!17",
      refKind: "merge_request",
    });
  });
});
