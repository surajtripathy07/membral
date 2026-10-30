import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { importCodeSession } from "../import";
import type { RawCodeSessionPayload } from "../payload";

const USER_ID = "user-1";

function makeSession(overrides: Partial<RawCodeSessionPayload> = {}): RawCodeSessionPayload {
  return {
    source: "claude-code",
    sourceSessionId: "session-abc",
    contentHash: "hash-v1",
    repo: { path: "/Users/dev/webapp", remoteUrl: "https://github.com/acme/webapp.git", branch: "main" },
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:05:00.000Z",
    model: "claude-code-sonnet",
    turns: [
      { idx: 0, role: "user", kind: "prose", text: "Add a login button", ts: "2026-07-01T10:00:00.000Z" },
      {
        idx: 1,
        role: "assistant",
        kind: "tool_use",
        toolName: "Edit",
        filePath: "/Users/dev/webapp/src/App.tsx",
        ts: "2026-07-01T10:01:00.000Z",
      },
      { idx: 2, role: "assistant", kind: "prose", text: "Done.", ts: "2026-07-01T10:04:00.000Z" },
    ],
    filesTouched: ["/Users/dev/webapp/src/App.tsx"],
    toolCounts: { Edit: 1 },
    ...overrides,
  };
}

describe("importCodeSession", () => {
  it("creates a new code_project + code_session + turns on first import", async () => {
    const db = new FakeSupabase();
    const result = await importCodeSession(db.asClient(), USER_ID, makeSession());

    expect(result.status).toBe("imported");
    expect(result.sessionId).toBeDefined();
    expect(result.codeProjectId).toBeDefined();

    const projects = db.getRows("code_projects");
    expect(projects).toHaveLength(1);
    expect(projects[0].repo_identity).toBe("github.com/acme/webapp");
    expect(projects[0].session_count).toBe(1);
    expect((projects[0].props as Record<string, unknown>).portrait_dirty).toBe(true);

    const sessions = db.getRows("code_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].content_hash).toBe("hash-v1");
    expect(sessions[0].turn_count).toBe(3);
    expect(sessions[0].user_turn_count).toBe(1);
    expect(sessions[0].tool_count).toBe(1);
    expect(sessions[0].duration_seconds).toBe(300);
    expect(sessions[0].summary).toBeNull(); // no LLM calls in P1a
    expect(sessions[0].title).toBeNull();

    const turns = db.getRows("code_session_turns");
    expect(turns).toHaveLength(3);
    expect(turns.every((t) => t.session_id === result.sessionId)).toBe(true);
  });

  it("HEADLESS RUNS: a session from Membral's own temp-dir `claude -p` run is skipped (reason membral_headless_run), writes nothing; a normal session still imports", async () => {
    const db = new FakeSupabase();
    for (const [i, path] of [
      "/private/var/folders/ab/cd1234/T/membral-claude-AbC123",
      "/var/folders/ab/cd1234/T/membral-lab-claude-XyZ9",
    ].entries()) {
      const result = await importCodeSession(
        db.asClient(),
        USER_ID,
        makeSession({ sourceSessionId: `headless-${i}`, repo: { path } }),
      );
      expect(result).toEqual({ status: "skipped", reason: "membral_headless_run" });
    }
    expect(db.getRows("code_projects")).toHaveLength(0);
    expect(db.getRows("code_sessions")).toHaveLength(0);
    expect(db.getRows("code_session_turns")).toHaveLength(0);

    const normal = await importCodeSession(db.asClient(), USER_ID, makeSession({ sourceSessionId: "real" }));
    expect(normal.status).toBe("imported");
    expect(db.getRows("code_projects")).toHaveLength(1);

    // A look-alike outside an OS temp dir is a real project and imports.
    const lookalike = await importCodeSession(
      db.asClient(),
      USER_ID,
      makeSession({ sourceSessionId: "lookalike", repo: { path: "/Users/dev/membral-claude-AbC123" } }),
    );
    expect(lookalike.status).toBe("imported");
  });

  it("clusters two sessions from the same repo into one code_project", async () => {
    const db = new FakeSupabase();
    await importCodeSession(db.asClient(), USER_ID, makeSession({ sourceSessionId: "s1" }));
    await importCodeSession(db.asClient(), USER_ID, makeSession({ sourceSessionId: "s2", contentHash: "hash-s2" }));

    const projects = db.getRows("code_projects");
    expect(projects).toHaveLength(1);
    expect(projects[0].session_count).toBe(2);

    const sessions = db.getRows("code_sessions");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.code_project_id === projects[0].id)).toBe(true);
  });

  it("keeps sessions from different repos in separate code_projects", async () => {
    const db = new FakeSupabase();
    await importCodeSession(db.asClient(), USER_ID, makeSession({ sourceSessionId: "s1" }));
    await importCodeSession(
      db.asClient(),
      USER_ID,
      makeSession({
        sourceSessionId: "s2",
        contentHash: "hash-s2",
        repo: { path: "/Users/dev/other", remoteUrl: "https://github.com/acme/other.git" },
      }),
    );

    const projects = db.getRows("code_projects");
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((p) => p.repo_identity))).toEqual(
      new Set(["github.com/acme/webapp", "github.com/acme/other"]),
    );
  });

  it("IDEMPOTENCY: unchanged content_hash short-circuits — skipped, turns untouched", async () => {
    const db = new FakeSupabase();
    const first = await importCodeSession(db.asClient(), USER_ID, makeSession());
    expect(first.status).toBe("imported");

    const turnsBefore = db.getRows("code_session_turns").map((t) => t.id);
    const projectBefore = { ...db.getRows("code_projects")[0] };

    const second = await importCodeSession(db.asClient(), USER_ID, makeSession()); // identical payload
    expect(second.status).toBe("skipped");
    expect(second.sessionId).toBe(first.sessionId);

    // Turns are byte-identical (same row ids, not deleted + re-inserted).
    const turnsAfter = db.getRows("code_session_turns").map((t) => t.id);
    expect(turnsAfter).toEqual(turnsBefore);

    // code_projects untouched — no session_count/props/updated_at write.
    const projectAfter = db.getRows("code_projects")[0];
    expect(projectAfter).toEqual(projectBefore);
  });

  it("FORCE (issue #91 backfill): unchanged content_hash still re-imports and replaces turns when force=true", async () => {
    const db = new FakeSupabase();
    const first = await importCodeSession(db.asClient(), USER_ID, makeSession());
    expect(first.status).toBe("imported");
    const turnsBefore = db.getRows("code_session_turns").map((t) => t.id);

    const forced = await importCodeSession(db.asClient(), USER_ID, makeSession(), true); // identical payload, force=true
    expect(forced.status).toBe("imported");
    expect(forced.sessionId).toBe(first.sessionId);

    // Turns were replaced wholesale (new row ids), not left byte-identical
    // like the non-forced idempotency case above.
    const turnsAfter = db.getRows("code_session_turns").map((t) => t.id);
    expect(turnsAfter).not.toEqual(turnsBefore);
    expect(turnsAfter).toHaveLength(turnsBefore.length);
  });

  it("without force (default), an unchanged content_hash still short-circuits exactly as before", async () => {
    const db = new FakeSupabase();
    const first = await importCodeSession(db.asClient(), USER_ID, makeSession());
    const second = await importCodeSession(db.asClient(), USER_ID, makeSession(), false);
    expect(second.status).toBe("skipped");
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("CHANGED content_hash re-imports and replaces turns wholesale", async () => {
    const db = new FakeSupabase();
    const first = await importCodeSession(db.asClient(), USER_ID, makeSession());
    const firstTurnIds = db.getRows("code_session_turns").map((t) => t.id);

    const changed = await importCodeSession(
      db.asClient(),
      USER_ID,
      makeSession({
        contentHash: "hash-v2",
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "Add a login button", ts: "2026-07-01T10:00:00.000Z" },
          { idx: 1, role: "user", kind: "prose", text: "Also add logout", ts: "2026-07-01T10:06:00.000Z" },
        ],
      }),
    );

    expect(changed.status).toBe("imported");
    expect(changed.sessionId).toBe(first.sessionId); // same session row, updated in place

    const sessions = db.getRows("code_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].content_hash).toBe("hash-v2");
    expect(sessions[0].turn_count).toBe(2);
    expect(sessions[0].user_turn_count).toBe(2);

    const turnsAfter = db.getRows("code_session_turns");
    expect(turnsAfter).toHaveLength(2);
    expect(turnsAfter.map((t) => t.id).some((id) => firstTurnIds.includes(id))).toBe(false); // wholesale replace
    expect(turnsAfter.map((t) => t.text)).toEqual(["Add a login button", "Also add logout"]);

    // Only this session's turns were touched — no other session's rows exist to leak into, but
    // assert the project's session_count still reflects exactly one session (no duplication).
    const projects = db.getRows("code_projects");
    expect(projects[0].session_count).toBe(1);
  });

  it("re-importing a changed session does not disturb a sibling session's turns in the same project", async () => {
    const db = new FakeSupabase();
    await importCodeSession(db.asClient(), USER_ID, makeSession({ sourceSessionId: "s1" }));
    await importCodeSession(db.asClient(), USER_ID, makeSession({ sourceSessionId: "s2", contentHash: "hash-s2" }));

    const s2TurnIdsBefore = db
      .getRows("code_session_turns")
      .filter((t) => t.session_id === db.getRows("code_sessions").find((s) => s.source_session_id === "s2")?.id)
      .map((t) => t.id);

    await importCodeSession(db.asClient(), USER_ID, makeSession({ sourceSessionId: "s1", contentHash: "hash-s1-v2" }));

    const s2TurnIdsAfter = db
      .getRows("code_session_turns")
      .filter((t) => t.session_id === db.getRows("code_sessions").find((s) => s.source_session_id === "s2")?.id)
      .map((t) => t.id);

    expect(s2TurnIdsAfter).toEqual(s2TurnIdsBefore);
  });

  it("step2d finding 1: a re-import MERGES props, preserving memory_* keys memory v1 wrote, never wiping them", async () => {
    const db = new FakeSupabase();
    const first = await importCodeSession(db.asClient(), USER_ID, makeSession());
    expect(first.status).toBe("imported");

    // Simulate memory v1 source C (memory/write/io.ts's updateSessionMemoryProps)
    // stamping the session row between this import and the next one — the
    // exact interleaving that used to be wiped by a full props replace.
    const sessions = db.getRows("code_sessions");
    const sessionRow = sessions.find((s) => s.id === first.sessionId) as Record<string, unknown>;
    sessionRow.props = {
      ...(sessionRow.props as Record<string, unknown>),
      memory_extraction: { prompt_version: "memory-extract-v3", records: 3 },
      memory_checkpoint_turn_idx: 2,
    };

    const second = await importCodeSession(
      db.asClient(),
      USER_ID,
      makeSession({ contentHash: "hash-v2", turns: makeSession().turns }),
    );
    expect(second.status).toBe("imported");

    const afterProps = db.getRows("code_sessions").find((s) => s.id === first.sessionId)?.props as Record<
      string,
      unknown
    >;
    expect(afterProps.memory_extraction).toEqual({ prompt_version: "memory-extract-v3", records: 3 });
    expect(afterProps.memory_checkpoint_turn_idx).toBe(2);
    // The import's own usage/models/subAgents keys still overlay normally —
    // this session fixture has none of those, so props otherwise just
    // carries the memory_* keys forward untouched.
  });

  it("falls back to code-project:unassigned when no path/remote is present", async () => {
    const db = new FakeSupabase();
    const result = await importCodeSession(db.asClient(), USER_ID, makeSession({ repo: {} }));
    expect(result.status).toBe("imported");
    const projects = db.getRows("code_projects");
    expect(projects[0].repo_identity).toBe("code-project:unassigned");
    expect(projects[0].display_name).toBe("Unassigned");
  });

  it("returns status 'error' (not a throw) when a write fails", async () => {
    const db = new FakeSupabase();
    // Force a failure by making the fake db reject: simplest is passing a
    // client whose from() throws for a specific table.
    const client = {
      from: (table: string) => {
        if (table === "code_projects") {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
            insert: () => {
              throw new Error("boom");
            },
          };
        }
        return db.from(table);
      },
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any;

    const result = await importCodeSession(client, USER_ID, makeSession());
    expect(result.status).toBe("error");
    expect(result.error).toContain("boom");
  });

  it("WRITE ORDER (issue #91 M4, #175): a failed turn import keeps the previous turns and leaves content_hash pending, so the next run retries", async () => {
    const db = new FakeSupabase();
    const first = await importCodeSession(db.asClient(), USER_ID, makeSession());
    expect(first.status).toBe("imported");
    const oldIds = db
      .getRows("code_session_turns")
      .map((t) => t.id)
      .sort();
    expect(oldIds).toHaveLength(3);

    // The turn import is one RPC (migration 112). This client fails that RPC
    // and throws if the importer touches code_session_turns directly at all:
    // a separate delete or insert would be outside the RPC's transaction.
    const oplogBefore = db.oplog.length;
    const failingClient = {
      from: (table: string) => {
        if (table === "code_session_turns") throw new Error("code_session_turns touched outside the RPC");
        return db.from(table);
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === "import_code_session_turns") {
          return Promise.resolve({ data: null, error: { message: "turns rpc boom" } });
        }
        return db.rpc(name, args);
      },
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any;

    const changed = makeSession({
      contentHash: "hash-v2",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "Replaced", ts: "2026-07-01T10:00:00.000Z" }],
    });
    const crashed = await importCodeSession(failingClient, USER_ID, changed);
    expect(crashed.status).toBe("error");
    expect(crashed.error).toContain("turns rpc boom");

    // The previous complete turn set is still there, same rows.
    expect(
      db
        .getRows("code_session_turns")
        .map((t) => t.id)
        .sort(),
    ).toEqual(oldIds);
    // The session row was rewritten with the PENDING hash, never "hash-v2",
    // so the next run's short-circuit cannot skip it.
    const pending = db.getRows("code_sessions")[0];
    expect(pending.content_hash).toBe("");
    const turnWrites = db.oplog
      .slice(oplogBefore)
      .filter((o) => o.table === "code_session_turns" && (o.op === "delete" || o.op === "insert"));
    expect(turnWrites).toHaveLength(0);

    const retried = await importCodeSession(db.asClient(), USER_ID, changed);
    expect(retried.status).toBe("imported");
    expect(retried.sessionId).toBe(pending.id);
    expect(db.getRows("code_sessions")[0].content_hash).toBe("hash-v2");
    const turns = db.getRows("code_session_turns");
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Replaced");
  });
});

describe("importCodeSession — sub-agent child sessions (migration 089)", () => {
  it("stores parentSessionId in parent_source_session_id and the spawn metadata in props.subAgent", async () => {
    const db = new FakeSupabase();
    await importCodeSession(db.asClient(), USER_ID, makeSession({ sourceSessionId: "parent-1" }));
    const child = await importCodeSession(
      db.asClient(),
      USER_ID,
      makeSession({
        sourceSessionId: "parent-1:agent-a1",
        contentHash: "hash-child",
        parentSessionId: "parent-1",
        subAgent: { agentId: "a1", agentType: "Explore", description: "look around", toolUseId: "toolu_1" },
      }),
    );
    expect(child.status).toBe("imported");

    const sessions = db.getRows("code_sessions");
    const parentRow = sessions.find((s) => s.source_session_id === "parent-1");
    const childRow = sessions.find((s) => s.source_session_id === "parent-1:agent-a1");
    expect(parentRow?.parent_source_session_id).toBeNull();
    expect(childRow?.parent_source_session_id).toBe("parent-1");
    expect((childRow?.props as Record<string, unknown>).subAgent).toMatchObject({ agentType: "Explore" });
    // Same repo → same project as the parent.
    expect(childRow?.code_project_id).toBe(parentRow?.code_project_id);
    // The child is not counted as one of the project's sessions.
    expect(db.getRows("code_projects")[0].session_count).toBe(1);
  });

  it("imports a child uploaded BEFORE its parent (no FK, upload order doesn't matter)", async () => {
    const db = new FakeSupabase();
    const child = await importCodeSession(
      db.asClient(),
      USER_ID,
      makeSession({ sourceSessionId: "p:agent-x", parentSessionId: "p", contentHash: "hc" }),
    );
    expect(child.status).toBe("imported");
    const parent = await importCodeSession(db.asClient(), USER_ID, makeSession({ sourceSessionId: "p" }));
    expect(parent.status).toBe("imported");
    expect(db.getRows("code_projects")[0].session_count).toBe(1);
  });
});

describe("importCodeSession — Postgres-unsafe characters", () => {
  it("strips U+0000 and replaces lone surrogates in every turn column + props, keeping the client contentHash", async () => {
    const db = new FakeSupabase();
    const session = makeSession({
      contentHash: "hash-with-nul",
      turns: [
        {
          idx: 0,
          role: "user",
          kind: "prose",
          text: 'check ["/\u0000","/"] and a\uD800b',
          ts: "2026-07-01T10:00:00.000Z",
        },
        {
          idx: 1,
          role: "assistant",
          kind: "tool_use",
          toolName: "Ed\u0000it",
          filePath: "/Users/dev/webapp/src/\u0000App.tsx",
          toolUseId: "tu\u0000-1",
          inputDigest: "-x\u0000 +y\uDC00 +ok 👉",
          ts: "2026-07-01T10:01:00.000Z",
        },
      ],
      subAgent: { agentId: "a\u0000b", description: "nested \uD800 desc\u0000" },
    });

    const result = await importCodeSession(db.asClient(), USER_ID, session);
    expect(result.status).toBe("imported");

    const turns = db.getRows("code_session_turns");
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain("\\u0000");
    expect(serialized).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    const REPLACEMENT = String.fromCharCode(0xfffd);
    expect(turns[0].text).toBe(`check ["/","/"] and a${REPLACEMENT}b`);
    expect(turns[1].tool_name).toBe("Edit");
    expect(turns[1].file_path).toBe("/Users/dev/webapp/src/App.tsx");
    const props = turns[1].props as { toolUseId: string; inputDigest: string };
    expect(props.toolUseId).toBe("tu-1");
    expect(props.inputDigest).toBe(`-x +y${REPLACEMENT} +ok 👉`);
    const sessionProps = db.getRows("code_sessions")[0].props as { subAgent: { agentId: string; description: string } };
    expect(sessionProps.subAgent).toEqual({ agentId: "ab", description: `nested ${REPLACEMENT} desc` });

    // Dedup is keyed on the client's hash of the ORIGINAL transcript.
    expect(db.getRows("code_sessions")[0].content_hash).toBe("hash-with-nul");
    const again = await importCodeSession(db.asClient(), USER_ID, session);
    expect(again.status).toBe("skipped");
  });
});

describe("importCodeSession — forge action props (goal 2026-09-26 W3 / P1)", () => {
  it("copies a turn's structured action (and every chained action) into code_session_turns.props while the turn text stays the elided sentinel", async () => {
    const db = new FakeSupabase();
    const committed = {
      verb: "committed",
      refKind: "commit",
      sha: "d7e5977",
      branch: "15178-5-idempotent-debits",
      subject: "make debit posting idempotent",
      source: "cli",
    } as const;
    const pushed = { verb: "pushed", ref: "15178-5-idempotent-debits", refKind: "branch", source: "cli" } as const;
    const session = makeSession({
      turns: [
        {
          idx: 0,
          role: "user",
          kind: "prose",
          text: "/review-mr https://codehub.example/acme/billing/-/merge_requests/17049",
          ts: "2026-07-01T10:00:00.000Z",
          action: {
            verb: "referenced",
            ref: "acme/billing!17049",
            refKind: "merge_request",
            url: "https://codehub.example/acme/billing/-/merge_requests/17049",
            skill: "review-mr",
            source: "command",
          },
        },
        {
          idx: 1,
          role: "assistant",
          kind: "tool_use",
          toolName: "Bash",
          toolUseId: "tu-1",
          inputDigest: 'git commit -m "make debit posting idempotent" && git push -u origin 15178-5-idempotent-debits',
          ts: "2026-07-01T10:01:00.000Z",
          action: pushed,
          actions: [committed, pushed],
        },
        {
          idx: 2,
          role: "user",
          kind: "tool_result",
          toolName: "Bash",
          text: "[tool_result elided: ok]",
          ts: "2026-07-01T10:01:05.000Z",
        },
      ],
    });

    const result = await importCodeSession(db.asClient(), USER_ID, session);
    expect(result.status).toBe("imported");

    const turns = db.getRows("code_session_turns");
    expect((turns[0].props as { action: unknown }).action).toEqual(session.turns[0].action);
    expect((turns[1].props as { action: unknown }).action).toEqual(pushed);
    expect((turns[1].props as { actions: unknown }).actions).toEqual([committed, pushed]);
    // The result row carries no action and its text is still the sentinel (B10).
    expect(turns[2].props).not.toHaveProperty("action");
    expect(turns[2].props).not.toHaveProperty("actions");
    expect(turns[2].text).toBe("[tool_result elided: ok]");
    expect(JSON.stringify(turns)).not.toContain("41 insertions");
  });
});

describe("importCodeSession — session profile (goal 2026-09-26 W4 / P2)", () => {
  it("writes code_sessions.props.profile from the turns' actions: the ref, its ladders and turn share", async () => {
    const db = new FakeSupabase();
    const session = makeSession({
      turns: [
        {
          idx: 0,
          role: "user",
          kind: "prose",
          text: "fix https://codehub.example/acme/billing/-/issues/15178",
          ts: "2026-07-01T10:00:00.000Z",
          action: { verb: "referenced", ref: "acme/billing#15178", refKind: "issue", source: "paste" },
        },
        {
          idx: 1,
          role: "assistant",
          kind: "tool_use",
          toolName: "Edit",
          filePath: "src/x.ts",
          ts: "2026-07-01T10:01:00.000Z",
        },
        {
          idx: 2,
          role: "assistant",
          kind: "tool_use",
          toolName: "Bash",
          inputDigest: "git commit -am x",
          ts: "2026-07-01T10:02:00.000Z",
          action: { verb: "committed", refKind: "commit", sha: "d7e5977", source: "cli" },
        },
        {
          idx: 3,
          role: "user",
          kind: "tool_result",
          toolName: "Bash",
          text: "[tool_result elided: ok]",
          ts: "2026-07-01T10:02:05.000Z",
        },
      ],
    });
    const result = await importCodeSession(db.asClient(), USER_ID, session);
    expect(result.status).toBe("imported");
    const props = db.getRows("code_sessions")[0].props as {
      profile: { refs: unknown[]; edits: number; commits: number; turns: number };
    };
    expect(props.profile.turns).toBe(4);
    expect(props.profile.edits).toBe(1);
    expect(props.profile.commits).toBe(1);
    expect(props.profile.refs).toEqual([
      expect.objectContaining({
        ref: "acme/billing#15178",
        refKind: "issue",
        build_verb: "committed",
        review_verb: null,
        // v4 B1: a pasted issue + a commit on no PR branch labels the issue; cost needs a PR branch.
        turn_share: 0,
        shas: ["d7e5977"],
      }),
    ]);
  });

  it("a session with no forge tools, no refs and no edits still gets a profile with no refs (B12)", async () => {
    const db = new FakeSupabase();
    await importCodeSession(db.asClient(), USER_ID, makeSession());
    const props = db.getRows("code_sessions")[0].props as { profile: { refs: unknown[] } };
    expect(props.profile.refs).toEqual([]);
  });

  it("stores the parser's actionsVersion stamp as props.actions_version, and omits it for an unstamped (old CLI) session", async () => {
    const stamped = new FakeSupabase();
    await importCodeSession(stamped.asClient(), USER_ID, makeSession({ actionsVersion: 1 }));
    expect((stamped.getRows("code_sessions")[0].props as { actions_version?: number }).actions_version).toBe(1);

    const old = new FakeSupabase();
    await importCodeSession(old.asClient(), USER_ID, makeSession());
    expect(old.getRows("code_sessions")[0].props).not.toHaveProperty("actions_version");
  });

  // Issue #585: an empty timestamp string made Postgres reject the whole session.
  describe("empty or unparseable timestamps (#585)", () => {
    it("imports every turn of a session with one empty-timestamp turn, storing that turn's ts as null", async () => {
      const db = new FakeSupabase();
      const base = makeSession();
      const session = makeSession({ turns: base.turns.map((t) => (t.idx === 1 ? { ...t, ts: "" } : t)) });
      const result = await importCodeSession(db.asClient(), USER_ID, session);

      expect(result.status).toBe("imported");
      const turns = db.getRows("code_session_turns");
      expect(turns).toHaveLength(3);
      expect(turns.map((t) => t.ts)).toEqual(["2026-07-01T10:00:00.000Z", null, "2026-07-01T10:04:00.000Z"]);
      expect(db.getRows("code_sessions")[0].turn_count).toBe(3);
    });

    it("treats whitespace-only and unparseable turn timestamps as missing", async () => {
      const db = new FakeSupabase();
      const base = makeSession();
      const bad = ["   ", "not a date", "2026-99-99T00:00:00Z"];
      const session = makeSession({ turns: base.turns.map((t, i) => ({ ...t, ts: bad[i] ?? t.ts })) });
      const result = await importCodeSession(db.asClient(), USER_ID, session);

      expect(result.status).toBe("imported");
      expect(db.getRows("code_session_turns").map((t) => t.ts)).toEqual([null, null, null]);
    });

    it("derives an empty start and end from the earliest and latest usable turn times", async () => {
      const db = new FakeSupabase();
      const result = await importCodeSession(db.asClient(), USER_ID, makeSession({ startedAt: "", endedAt: " " }));

      expect(result.status).toBe("imported");
      const row = db.getRows("code_sessions")[0];
      expect(row.started_at).toBe("2026-07-01T10:00:00.000Z");
      expect(row.ended_at).toBe("2026-07-01T10:04:00.000Z");
      expect(row.duration_seconds).toBe(240);
      expect(db.getRows("code_session_turns")).toHaveLength(3);
    });

    it("skips unusable turns when deriving start and end, and keeps a valid session start or end", async () => {
      const db = new FakeSupabase();
      const base = makeSession();
      // turn 0 (the earliest) and turn 2 (the latest) are unusable; only turn 1 (10:01) has a time.
      const turns = base.turns.map((t) => (t.idx === 1 ? t : { ...t, ts: "" }));
      await importCodeSession(db.asClient(), USER_ID, makeSession({ startedAt: "", turns }));
      const row = db.getRows("code_sessions")[0];
      expect(row.started_at).toBe("2026-07-01T10:01:00.000Z");
      expect(row.ended_at).toBe("2026-07-01T10:05:00.000Z"); // the valid session end is kept, not replaced
    });

    it("still imports when every session and turn timestamp is empty", async () => {
      const db = new FakeSupabase();
      const base = makeSession();
      const session = makeSession({ startedAt: "", endedAt: "", turns: base.turns.map((t) => ({ ...t, ts: "" })) });
      const result = await importCodeSession(db.asClient(), USER_ID, session);

      expect(result.status).toBe("imported");
      expect(db.getRows("code_session_turns")).toHaveLength(3);
      expect(db.getRows("code_session_turns").every((t) => t.ts === null)).toBe(true);
      const row = db.getRows("code_sessions")[0];
      expect(row.started_at).toBeNull();
      expect(row.ended_at).toBeNull();
      expect(row.duration_seconds).toBeNull();
      expect(db.getRows("code_projects")[0].session_count).toBe(1);
    });
  });
});
