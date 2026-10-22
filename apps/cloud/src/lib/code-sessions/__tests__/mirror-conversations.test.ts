import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { computeSourceHash } from "@/lib/util/source-hash";
import { buildMirrorMessages, capMirrorMessages, mirrorCodeSessionsToConversations } from "../mirror-conversations";

const USER_ID = "user-1";

interface RawTurn {
  idx: number;
  role: "user" | "assistant";
  kind: "prose" | "tool_use" | "tool_result" | "thinking";
  text?: string | null;
  tool_name?: string | null;
  file_path?: string | null;
  ts?: string | null;
}

function seedProjectAndSession(
  db: FakeSupabase,
  opts: {
    sessionId: string;
    projectId?: string;
    displayName?: string | null;
    repoIdentity?: string;
    branch?: string | null;
    cwd?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    title?: string | null;
    summary?: string | null;
    contentHash?: string;
    turns: RawTurn[];
  },
): void {
  const projectId = opts.projectId ?? `${opts.sessionId}-project`;
  const existingProject = db.getRows("code_projects").find((p) => p.id === projectId);
  if (!existingProject) {
    db.seed("code_projects", [
      {
        id: projectId,
        user_id: USER_ID,
        display_name: opts.displayName ?? "acme/webapp",
        repo_identity: opts.repoIdentity ?? "github.com/acme/webapp",
      },
    ]);
  }
  // Replace (not add to) any prior seed of the same session — several tests
  // re-seed the same sessionId to simulate a changed re-import.
  db.setRows(
    "code_sessions",
    db.getRows("code_sessions").filter((s) => s.id !== opts.sessionId),
  );
  db.seed("code_sessions", [
    {
      id: opts.sessionId,
      user_id: USER_ID,
      code_project_id: projectId,
      git_branch: opts.branch ?? "main",
      cwd: opts.cwd ?? "/Users/dev/webapp",
      model: "claude-code-sonnet",
      started_at: opts.startedAt ?? "2026-07-01T10:00:00.000Z",
      ended_at: opts.endedAt ?? "2026-07-01T10:05:00.000Z",
      title: opts.title ?? null,
      summary: opts.summary ?? null,
      content_hash: opts.contentHash ?? "hash-v1",
    },
  ]);
  db.setRows(
    "code_session_turns",
    db.getRows("code_session_turns").filter((t) => t.session_id !== opts.sessionId),
  );
  db.seed(
    "code_session_turns",
    opts.turns.map((t) => ({
      id: `${opts.sessionId}-turn-${t.idx}`,
      user_id: USER_ID,
      session_id: opts.sessionId,
      idx: t.idx,
      role: t.role,
      kind: t.kind,
      text: t.text ?? null,
      tool_name: t.tool_name ?? null,
      file_path: t.file_path ?? null,
      ts: t.ts ?? "2026-07-01T10:00:00.000Z",
    })),
  );
}

describe("buildMirrorMessages", () => {
  it("keeps prose turns as real messages, ordered by idx, each carrying its originating turn idx", () => {
    const messages = buildMirrorMessages([
      { idx: 1, role: "assistant", kind: "prose", text: "Done.", tool_name: null, file_path: null, ts: null },
      { idx: 0, role: "user", kind: "prose", text: "Add a login button", tool_name: null, file_path: null, ts: null },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Add a login button", timestamp: null, metadata: { idx: 0 } },
      { role: "assistant", content: "Done.", timestamp: null, metadata: { idx: 1 } },
    ]);
  });

  it("drops thinking turns entirely", () => {
    const messages = buildMirrorMessages([
      {
        idx: 0,
        role: "assistant",
        kind: "thinking",
        text: "internal deliberation",
        tool_name: null,
        file_path: null,
        ts: null,
      },
    ]);
    expect(messages).toEqual([]);
  });

  it("never emits an empty message for an empty or whitespace-only prose turn", () => {
    const messages = buildMirrorMessages([
      { idx: 0, role: "user", kind: "prose", text: "Ship it", tool_name: null, file_path: null, ts: null },
      { idx: 1, role: "assistant", kind: "prose", text: "", tool_name: null, file_path: null, ts: null },
      { idx: 2, role: "assistant", kind: "prose", text: "  \n ", tool_name: null, file_path: null, ts: null },
      { idx: 3, role: "assistant", kind: "prose", text: null, tool_name: null, file_path: null, ts: null },
      { idx: 4, role: "assistant", kind: "prose", text: "Shipped.", tool_name: null, file_path: null, ts: null },
    ]);
    expect(messages.map((m) => m.content)).toEqual(["Ship it", "Shipped."]);
    expect(messages.every((m) => m.content.trim().length > 0)).toBe(true);
  });

  it("collapses tool_use into one short line folded into the trailing assistant message, never as a user message", () => {
    const messages = buildMirrorMessages([
      { idx: 0, role: "user", kind: "prose", text: "Fix the bug", tool_name: null, file_path: null, ts: null },
      { idx: 1, role: "assistant", kind: "prose", text: "On it.", tool_name: null, file_path: null, ts: null },
      {
        idx: 2,
        role: "assistant",
        kind: "tool_use",
        text: null,
        tool_name: "Edit",
        file_path: "src/App.tsx",
        ts: null,
      },
      {
        idx: 3,
        role: "user",
        kind: "tool_result",
        text: "[tool_result elided: ok]",
        tool_name: "Edit",
        file_path: null,
        ts: null,
      },
    ]);
    // prose(idx0,user) -> its own message; prose(idx1,assistant) -> its own
    // message; tool_use(idx2) + tool_result(idx3) both fold into the
    // TRAILING message, which is idx1's — folding only checks the trailing
    // message's ROLE, not how it was created.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "Fix the bug", timestamp: null, metadata: { idx: 0 } });
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("On it.");
    expect(messages[1].content).toContain("[tool: Edit src/App.tsx]");
    expect(messages[1].content).toContain("[tool_result elided: ok]");
    // Folded message's metadata.idx is the message's OWN originating turn
    // (idx1, the prose turn); idxs collects the LATER folded turns on top.
    expect(messages[1].metadata).toEqual({ idx: 1, idxs: [1, 2, 3] });
    expect(messages.some((m) => m.role === "user" && m.content.includes("elided"))).toBe(false);
  });

  it("starts a new assistant message for a leading tool_use with no prior assistant message", () => {
    const messages = buildMirrorMessages([
      { idx: 0, role: "assistant", kind: "tool_use", text: null, tool_name: "Bash", file_path: null, ts: null },
    ]);
    expect(messages).toEqual([
      { role: "assistant", content: "[tool: Bash]", timestamp: null, metadata: { idx: 0, idxs: [0] } },
    ]);
  });
});

function msg(role: "user" | "assistant", content: string, idx = 0) {
  return { role, content, timestamp: null, metadata: { idx } };
}

describe("capMirrorMessages", () => {
  it("is a no-op under the cap", () => {
    const messages = [msg("user", "hi")];
    const result = capMirrorMessages(messages, 1000);
    expect(result).toEqual({ messages, truncated: false, droppedChars: 0 });
  });

  it("keeps user turns whole and truncates/empties assistant turns from the end, exactly at the cap (no marker overshoot — M5)", () => {
    const messages = [
      msg("user", "u".repeat(40), 0),
      msg("assistant", "a".repeat(40), 1),
      msg("assistant", "b".repeat(40), 2),
    ];
    const result = capMirrorMessages(messages, 60);
    expect(result.truncated).toBe(true);
    // user content untouched
    expect(result.messages[0]).toEqual(messages[0]);
    // array length UNCHANGED (M8) — the second assistant message is emptied, not removed.
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2].content).toBe("");
    expect(result.messages[2].metadata).toEqual({ idx: 2 });
    // total is exactly at the cap, never over it (the naive slice+marker bug this fixes).
    const total = result.messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBe(60);
    expect(result.messages[1].content).toContain("[truncated]");
    // msg1 (40 "a"s) truncated to fit the 20-char budget exactly (8 kept +
    // 12-char marker) -> drops 20; msg2 (40 "b"s) gets 0 budget left -> drops all 40.
    expect(result.droppedChars).toBe(60);
  });

  it("M5: truncates user prose from the end (tail-only) when user prose alone exceeds the cap, after every assistant message is already emptied", () => {
    const messages = [
      msg("user", "u".repeat(30), 0),
      msg("assistant", "a".repeat(30), 1),
      msg("user", "v".repeat(50), 2),
    ];
    const result = capMirrorMessages(messages, 60);
    expect(result.truncated).toBe(true);
    // assistant emptied first (it's never exempt)
    expect(result.messages[1].content).toBe("");
    // total lands exactly at the cap
    const total = result.messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBe(60);
    // the FIRST (earlier) user message is untouched — only the tail (LAST) user message is cut.
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[2].content.length).toBeLessThan(50);
    expect(result.messages).toHaveLength(3);
  });

  it("R1 (review round 2, HIGH): many FITTING assistant messages still consume the budget, so user prose is never wrongly emptied", () => {
    // The bug: assistantBudget was only decremented on the TRUNCATED branch
    // — a run of assistant messages that each individually fit within the
    // (never-decremented) budget sailed through pass 1 completely untouched,
    // however far their SUM overshot the real budget; pass 2 then absorbed
    // the whole overshoot out of user content, even emptying it entirely.
    // 10 assistant messages @ 100 chars = 1000 chars against an 800-char
    // assistant budget (cap 1000, user 200) — under the bug, all 10 survive
    // pass 1 whole (1000 assistant chars) and pass 2 empties the ENTIRE
    // 200-char user message trying to claw back the 200-char overshoot.
    const messages = [
      msg("user", "U".repeat(200), 0),
      ...Array.from({ length: 10 }, (_, i) => msg("assistant", "a".repeat(100), i + 1)),
    ];
    const result = capMirrorMessages(messages, 1000);

    const total = result.messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(1000);
    // User prose is retained FIRST and IN FULL — the whole point of "user
    // turns kept whole first" (ADR 0039 §4) is defeated if pass 1's budget
    // bookkeeping lets assistant content eat into it.
    expect(result.messages[0].content).toBe("U".repeat(200));
    // The assistant messages correctly consumed exactly their 800-char
    // budget (8 whole + 2 emptied), landing the total exactly at the cap.
    expect(total).toBe(1000);
  });

  it("M8: retained messages keep the SAME array index across a re-cap after new content is appended (append-only growth)", () => {
    const first = [msg("user", "u".repeat(30), 0), msg("assistant", "a".repeat(40), 1)];
    const firstCapped = capMirrorMessages(first, 60).messages;

    // Simulate the session growing: two more turns appended at the end.
    const grown = [...first, msg("user", "w".repeat(5), 2), msg("assistant", "b".repeat(40), 3)];
    const grownCapped = capMirrorMessages(grown, 60).messages;

    // Every message present in BOTH runs keeps the same metadata.idx at the
    // same array index — the bug this regression test targets (M8) is a
    // dropped message being REMOVED, which shifts every later index.
    for (let i = 0; i < firstCapped.length; i++) {
      expect(grownCapped[i].metadata.idx).toBe(firstCapped[i].metadata.idx);
      expect(grownCapped[i].role).toBe(firstCapped[i].role);
    }
    expect(grownCapped).toHaveLength(4);
  });
});

describe("mirrorCodeSessionsToConversations", () => {
  it("mirrors a session into a conversations row with source='claude-code'", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      turns: [
        { idx: 0, role: "user", kind: "prose", text: "Add a login button" },
        { idx: 1, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: "src/App.tsx" },
        { idx: 2, role: "assistant", kind: "prose", text: "Done." },
      ],
    });

    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);

    expect(result.processed).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.errors).toEqual([]);

    const conversations = db.getRows("conversations");
    expect(conversations).toHaveLength(1);
    const conv = conversations[0];
    expect(conv.source).toBe("claude-code");
    expect(conv.source_id).toBe("sess-1");
    expect(conv.user_id).toBe(USER_ID);
    const metadata = conv.metadata as Record<string, unknown>;
    expect(metadata.code_session_id).toBe("sess-1");
    expect(metadata.code_project_id).toBe("sess-1-project");
    expect(metadata.branch).toBe("main");
    expect(metadata.lane).toBe("code");
    expect(metadata.code_session_content_hash).toBe("hash-v1");
    const messages = conv.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "user", content: "Add a login button" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "[tool: Edit src/App.tsx]" });
    expect(messages[2]).toMatchObject({ role: "assistant", content: "Done." });
  });

  it("derives a title from project · branch · date when the session has no title/summary", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      displayName: "acme/webapp",
      branch: "feature/login",
      startedAt: "2026-07-01T10:00:00.000Z",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi" }],
    });
    await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    const conv = db.getRows("conversations")[0];
    expect(conv.title).toBe("acme/webapp · feature/login · 2026-07-01");
  });

  it("is idempotent: re-running with an unchanged content_hash is a true no-op — zero writes (fast path, M7)", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi" }],
    });
    const first = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    expect(first.inserted).toBe(1);
    const convBefore = { ...db.getRows("conversations")[0] };

    const second = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.titleUpdated).toBe(0);
    expect(second.skippedUnchanged).toBe(1);
    expect(db.getRows("conversations")).toHaveLength(1);
    expect(db.getRows("conversations")[0]).toEqual(convBefore);
  });

  it("re-mirrors when turns actually changed (a real re-import bumps content_hash, matching import.ts's own invariant)", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      contentHash: "hash-v1",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi" }],
    });
    await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    const hashBefore = computeSourceHash(db.getRows("conversations")[0].messages);

    // Simulate a re-import: import.ts always bumps content_hash whenever it
    // actually replaces turns — a test that changed turns WITHOUT bumping
    // the hash would be testing a state the real importer can't produce.
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      contentHash: "hash-v2",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi there, more context now" }],
    });

    const second = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    expect(second.updated).toBe(1);
    expect(second.skippedUnchanged).toBe(0);
    const hashAfter = computeSourceHash(db.getRows("conversations")[0].messages);
    expect(hashAfter).not.toBe(hashBefore);
  });

  it("M4: updates the title (without touching messages) when the session is titled after the first mirror, on the fast path", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      contentHash: "hash-v1",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi" }],
    });
    await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    const messagesBefore = db.getRows("conversations")[0].messages;
    expect(db.getRows("conversations")[0].title).toBe("acme/webapp · main · 2026-07-01"); // fallback pattern

    // P1c titles the session later — content_hash is UNCHANGED (turns didn't move).
    db.setRows(
      "code_sessions",
      db.getRows("code_sessions").map((s) => (s.id === "sess-1" ? { ...s, title: "Fixed the login flow" } : s)),
    );

    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    expect(result.titleUpdated).toBe(1);
    expect(result.updated).toBe(0);
    const conv = db.getRows("conversations")[0];
    expect(conv.title).toBe("Fixed the login flow");
    // messages untouched by the title-only update.
    expect(conv.messages).toEqual(messagesBefore);
  });

  it("R2 (review round 2, HIGH): a legacy row (content hash matches but no mirror_format_version) is REBUILT, not fast-pathed", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      contentHash: "hash-v1",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi" }],
    });
    // Hand-seed a "legacy" conversations row exactly as round 1's buggy fast
    // path would have left it: the content hash matches (so a hash-only
    // check would wrongly call it current) but no `metadata.idx` on its
    // messages and no `mirror_format_version` at all — the state 75 real
    // founder-1k rows were actually left in before this fix.
    db.seed("conversations", [
      {
        id: "legacy-conv-1",
        user_id: USER_ID,
        source: "claude-code",
        source_id: "sess-1",
        title: "acme/webapp · main · 2026-07-01",
        messages: [{ role: "user", content: "hi", timestamp: null, metadata: {} }], // no `idx`
        metadata: { code_session_content_hash: "hash-v1", lane: "code" }, // no mirror_format_version
      },
    ]);

    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    // Must NOT take the fast/title-only path — a version mismatch forces
    // the full rebuild even though the content hash matched.
    expect(result.skippedUnchanged).toBe(0);
    expect(result.titleUpdated).toBe(0);
    expect(result.updated).toBe(1);

    const conv = db.getRows("conversations").find((c) => c.source_id === "sess-1");
    const messages = conv?.messages as { metadata?: { idx?: number } }[];
    expect(messages[0].metadata?.idx).toBe(0);
    const metadata = conv?.metadata as Record<string, unknown>;
    expect(metadata.mirror_format_version).toBeTypeOf("number");
  });

  it("M10: merges into existing metadata instead of clobbering it, so a hand-set key survives a re-mirror", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      contentHash: "hash-v1",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi" }],
    });
    await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    db.setRows(
      "conversations",
      db
        .getRows("conversations")
        .map((c) => ({ ...c, metadata: { ...(c.metadata as object), custom_flag: "keep-me" } })),
    );

    seedProjectAndSession(db, {
      sessionId: "sess-1",
      contentHash: "hash-v2",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi, changed" }],
    });
    await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);

    const metadata = db.getRows("conversations")[0].metadata as Record<string, unknown>;
    expect(metadata.custom_flag).toBe("keep-me");
    expect(metadata.code_session_content_hash).toBe("hash-v2");
  });

  it("M10: an archived mirror (metadata.archived_at set) is never re-mirrored, even when the session content changes", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      contentHash: "hash-v1",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi" }],
    });
    await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    db.setRows(
      "conversations",
      db
        .getRows("conversations")
        .map((c) => ({ ...c, metadata: { ...(c.metadata as object), archived_at: "2026-08-27T00:00:00Z" } })),
    );
    const archivedRow = { ...db.getRows("conversations")[0] };

    seedProjectAndSession(db, {
      sessionId: "sess-1",
      contentHash: "hash-v2",
      title: "Should never land",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi, changed a lot" }],
    });
    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);

    expect(result.skippedArchived).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.titleUpdated).toBe(0);
    expect(db.getRows("conversations")[0]).toEqual(archivedRow);
  });

  it("skips a session with zero mirrorable turns without writing a conversation row", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      turns: [{ idx: 0, role: "assistant", kind: "thinking", text: "internal only" }],
    });
    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    expect(result.skippedEmpty).toBe(1);
    expect(db.getRows("conversations")).toHaveLength(0);
  });

  it("dryRun computes without writing", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "hi" }],
    });
    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID, { dryRun: true });
    expect(result.inserted).toBe(1);
    expect(db.getRows("conversations")).toHaveLength(0);
  });

  it("mirrors only the given sessionIds when provided", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, { sessionId: "sess-1", turns: [{ idx: 0, role: "user", kind: "prose", text: "a" }] });
    seedProjectAndSession(db, { sessionId: "sess-2", turns: [{ idx: 0, role: "user", kind: "prose", text: "b" }] });

    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID, { sessionIds: ["sess-1"] });
    expect(result.processed).toBe(1);
    expect(db.getRows("conversations")).toHaveLength(1);
    expect(db.getRows("conversations")[0].source_id).toBe("sess-1");
  });

  it("M6: chunks a sessionIds batch larger than IN_CHUNK_SIZE (200) without error", async () => {
    const db = new FakeSupabase();
    const ids: string[] = [];
    for (let i = 0; i < 210; i++) {
      const id = `sess-${i}`;
      ids.push(id);
      seedProjectAndSession(db, {
        sessionId: id,
        projectId: "shared-project",
        contentHash: `hash-${i}`,
        turns: [{ idx: 0, role: "user", kind: "prose", text: `turn ${i}` }],
      });
    }
    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID, { sessionIds: ids });
    expect(result.processed).toBe(210);
    expect(result.inserted).toBe(210);
    expect(db.getRows("conversations")).toHaveLength(210);
  });

  it("caps a huge conversation and records truncated/dropped_chars in metadata, landing exactly at the cap", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      turns: [
        { idx: 0, role: "user", kind: "prose", text: "u".repeat(1000) },
        { idx: 1, role: "assistant", kind: "prose", text: "a".repeat(70_000) },
      ],
    });
    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    expect(result.truncatedCount).toBe(1);
    const conv = db.getRows("conversations")[0];
    const metadata = conv.metadata as Record<string, unknown>;
    expect(metadata.truncated).toBe(true);
    expect(typeof metadata.dropped_chars).toBe("number");
    expect((metadata.dropped_chars as number) > 0).toBe(true);
    const total = (conv.messages as { content: string }[]).reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(60_000);
  });

  it("M5: caps a conversation whose USER prose alone exceeds 60k, truncating user content and flagging it", async () => {
    const db = new FakeSupabase();
    seedProjectAndSession(db, {
      sessionId: "sess-1",
      turns: [{ idx: 0, role: "user", kind: "prose", text: "u".repeat(85_591) }],
    });
    const result = await mirrorCodeSessionsToConversations(db.asClient(), USER_ID);
    expect(result.truncatedCount).toBe(1);
    const conv = db.getRows("conversations")[0];
    const metadata = conv.metadata as Record<string, unknown>;
    expect(metadata.truncated).toBe(true);
    const messages = conv.messages as { role: string; content: string }[];
    const total = messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(60_000);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content.length).toBeLessThan(85_591);
  });
});
