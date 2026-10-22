import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { listRecentConversations, RECENT_HINT, RecentKindNotAllowedError } from "../graph-tools";

// Rows as mcp_recent_conversations (migration 094) returns them: chats and
// code sessions already merged and ordered newest activity first in SQL.
const ROWS = [
  {
    type: "code",
    id: "s-new",
    project_name: "example/codehub-alpha",
    git_branch: "main",
    source: "opencode",
    started_at: "2026-09-24T19:00:00Z",
    ended_at: "2026-09-24T20:00:00Z",
    turn_count: 14,
    summary: "Added a recency filter",
  },
  {
    type: "chat",
    id: "c-new",
    title: "Newest chat",
    source: "claude",
    created_at: "2026-09-24T08:00:00Z",
    updated_at: "2026-09-24T18:00:00Z",
    message_count: 12,
  },
  {
    type: "code",
    id: "s-old",
    project_name: "example/codehub-beta",
    git_branch: null,
    source: "claude-code",
    started_at: "2026-09-23T10:00:00Z",
    ended_at: null,
    turn_count: null,
    summary: null,
  },
  {
    type: "chat",
    id: "c-old",
    title: "Older chat",
    source: "chatgpt",
    created_at: "2026-09-20T10:00:00Z",
    updated_at: null,
    message_count: 0,
  },
];

// D (2026-09-25): fillRecentCodeTitleFallbacks' `.from("code_session_turns")`
// lookup (getFirstUserMessages) — one row per session id, matching the same
// role="user"/kind="prose" shape the real table has. Empty by default (most
// tests below never have a row with BOTH title and summary missing, so the
// lookup never fires); pass `turns` for a test that does.
function makeSupabase(
  rows: unknown[] = ROWS,
  error: { message: string } | null = null,
  turns: { session_id: string; idx: number; text: string }[] = [],
) {
  const from = vi.fn((table: string) => {
    if (table !== "code_session_turns") throw new Error(`unexpected table: ${table}`);
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      // getFirstUserMessages pages by keyset: .gt("id", …).order().limit() (one short page here).
      order: () => builder,
      limit: () => builder,
      gt: () => builder,
      // biome-ignore lint/suspicious/noThenProperty: mimics supabase-js's thenable query builder (real code awaits it directly) — same precedent as graph-tools.test.ts's own `.from("conversations")` fake
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: turns, error: null }).then(resolve, reject),
    };
    return builder;
  });
  return { rpc: vi.fn().mockResolvedValue({ data: error ? null : rows, error }), from } as unknown as SupabaseClient & {
    rpc: ReturnType<typeof vi.fn>;
  };
}

const UNSCOPED = { tokenScopeId: null, codeScopeId: null };

describe("listRecentConversations", () => {
  it("unscoped: forwards since, clamped limit, source, kind flags and null bounds", async () => {
    const supabase = makeSupabase();
    await listRecentConversations(supabase, "user-1", {
      since: "2026-09-18T00:00:00.000Z",
      source: "claude",
      limit: 5,
    });
    expect(supabase.rpc).toHaveBeenCalledWith("mcp_recent_conversations", {
      p_user_id: "user-1",
      p_since: "2026-09-18T00:00:00.000Z",
      p_limit: 5,
      p_source: "claude",
      p_scope_id: null,
      p_scope_code_project_id: null,
      p_include_chat: true,
      p_include_code: true,
    });
  });

  it("defaults limit to 30 and clamps it to 1..100", async () => {
    const supabase = makeSupabase();
    await listRecentConversations(supabase, "user-1", { since: null });
    expect(supabase.rpc).toHaveBeenLastCalledWith(
      "mcp_recent_conversations",
      expect.objectContaining({ p_limit: 30, p_source: null, p_since: null }),
    );
    await listRecentConversations(supabase, "user-1", { since: null, limit: 500 });
    expect(supabase.rpc).toHaveBeenLastCalledWith(
      "mcp_recent_conversations",
      expect.objectContaining({ p_limit: 100 }),
    );
    await listRecentConversations(supabase, "user-1", { since: null, limit: 0 });
    expect(supabase.rpc).toHaveBeenLastCalledWith("mcp_recent_conversations", expect.objectContaining({ p_limit: 1 }));
  });

  it.each([
    ["chat", true, false],
    ["code", false, true],
    ["all", true, true],
  ] as const)("kind=%s -> include_chat=%s, include_code=%s", async (kind, chat, code) => {
    const supabase = makeSupabase();
    await listRecentConversations(supabase, "user-1", { since: null, kind }, UNSCOPED);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "mcp_recent_conversations",
      expect.objectContaining({ p_include_chat: chat, p_include_code: code }),
    );
  });

  describe("key scope", () => {
    it("area-scoped key: chats bounded to the area, never code rows", async () => {
      const supabase = makeSupabase();
      await listRecentConversations(supabase, "user-1", { since: null }, { tokenScopeId: "area-1", codeScopeId: null });
      expect(supabase.rpc).toHaveBeenCalledWith(
        "mcp_recent_conversations",
        expect.objectContaining({
          p_scope_id: "area-1",
          p_scope_code_project_id: null,
          p_include_chat: true,
          p_include_code: false,
        }),
      );
      await expect(
        listRecentConversations(
          supabase,
          "user-1",
          { since: null, kind: "code" },
          { tokenScopeId: "area-1", codeScopeId: null },
        ),
      ).rejects.toThrow(RecentKindNotAllowedError);
    });

    it("code-project-scoped key: code rows bounded to the project, never chats", async () => {
      const supabase = makeSupabase();
      await listRecentConversations(supabase, "user-1", { since: null }, { tokenScopeId: null, codeScopeId: "proj-1" });
      expect(supabase.rpc).toHaveBeenCalledWith(
        "mcp_recent_conversations",
        expect.objectContaining({
          p_scope_id: null,
          p_scope_code_project_id: "proj-1",
          p_include_chat: false,
          p_include_code: true,
        }),
      );
      await expect(
        listRecentConversations(
          supabase,
          "user-1",
          { since: null, kind: "chat" },
          { tokenScopeId: null, codeScopeId: "proj-1" },
        ),
      ).rejects.toThrow(/cannot list chats/);
      expect(supabase.rpc).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the merged SQL order and returns only metadata fields per kind, plus the open hint", async () => {
    const heavy = ROWS.map((r) => ({
      ...r,
      messages: [{ role: "user", content: "x" }],
      turns: [{ idx: 0 }],
      metadata: {},
    }));
    const result = await listRecentConversations(makeSupabase(heavy), "user-1", { since: null });
    expect(result.hint).toBe(RECENT_HINT);
    expect(result.hint).toContain("get_conversation id=<id>");
    expect(result.hint).toContain("get_code_session id=<id>");
    expect(result.results.map((r) => `${r.type}:${r.id}`)).toEqual([
      "code:s-new",
      "chat:c-new",
      "code:s-old",
      "chat:c-old",
    ]);
    for (const r of result.results) {
      const keys = Object.keys(r).sort();
      if (r.type === "chat") {
        expect(keys).toEqual(["created_at", "id", "message_count", "source", "title", "type", "updated_at"]);
      } else {
        expect(keys).toEqual([
          "ended_at",
          "git_branch",
          "id",
          "project_name",
          "source",
          "started_at",
          "summary",
          "title",
          "turn_count",
          "type",
        ]);
      }
    }
  });

  // D (2026-09-25): "no more Untitled session" — a code row's title falls back
  // to its summary (s-new), then to a batched first-user-message lookup for
  // any row still "Untitled session" after that (s-old, which has no summary).
  it("fills a code row's title: summary when present, else the first user message, never a raw null", async () => {
    const result = await listRecentConversations(
      makeSupabase(ROWS, null, [{ session_id: "s-old", idx: 0, text: "fix the flaky sync test\nmore context" }]),
      "user-1",
      { since: null },
    );
    const sNew = result.results.find((r) => r.id === "s-new");
    const sOld = result.results.find((r) => r.id === "s-old");
    expect(sNew).toMatchObject({ title: "Added a recency filter" });
    expect(sOld).toMatchObject({ title: "fix the flaky sync test" });
  });

  it("returns an empty list on null data and throws a named error on an RPC error", async () => {
    const empty = await listRecentConversations(makeSupabase([]), "user-1", { since: null });
    expect(empty.results).toEqual([]);
    await expect(
      listRecentConversations(makeSupabase([], { message: "boom" }), "user-1", { since: null }),
    ).rejects.toThrow("mcp_recent_conversations failed: boom");
  });
});
