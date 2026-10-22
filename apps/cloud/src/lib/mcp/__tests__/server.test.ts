import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockSearchConversationsScoped = vi.fn();
const mockGetScopedConversation = vi.fn();
const mockListRecentConversations = vi.fn();

const mockListCodeProjects = vi.fn();
const mockGetCodeProject = vi.fn();
const mockGetCodeSession = vi.fn();
const mockGetCodeContextFor = vi.fn();

const { MockUnknownScopeError } = vi.hoisted(() => {
  class MockUnknownScopeError extends Error {
    constructor(scope: string) {
      super(`Unknown scope: "${scope}" is not one of your life areas`);
      this.name = "UnknownScopeError";
    }
  }
  return { MockUnknownScopeError };
});

vi.mock("@/lib/mcp/graph-tools", () => ({
  CODE_SESSION_SOURCES: new Set(["claude-code", "opencode", "copilot-cli", "codex"]),
  searchConversationsScoped: (...args: unknown[]) => mockSearchConversationsScoped(...args),
  getScopedConversation: (...args: unknown[]) => mockGetScopedConversation(...args),
  listRecentConversations: (...args: unknown[]) => mockListRecentConversations(...args),
  UnknownScopeError: MockUnknownScopeError,
}));

vi.mock("@/lib/mcp/code-tools", () => ({
  listCodeProjects: (...args: unknown[]) => mockListCodeProjects(...args),
  getCodeProject: (...args: unknown[]) => mockGetCodeProject(...args),
  getCodeSession: (...args: unknown[]) => mockGetCodeSession(...args),
  getCodeContextFor: (...args: unknown[]) => mockGetCodeContextFor(...args),
}));

const mockResolveSessionId = vi.fn(async (_db: unknown, _u: string, id: string) => ({ ok: true, id }));
vi.mock("@/lib/mcp/resolve-session-id", () => ({
  resolveSessionId: (...args: [unknown, string, string]) => mockResolveSessionId(...args),
}));

// Freshness (goal 2026-07-26 step 2, #63/#58) — PARTIAL mock: only
// getFreshnessForUser (the I/O-touching piece server.ts actually calls — see
// the round-3 MINOR 1 fix, which replaced a locally-reconstructed
// getFreshness(getServiceClient(), userId) with this already-hardened
// wrapper) is replaced so these tests can assert the server's OWN
// caching/degrade behaviour (compute once per server instance, never throw)
// independent of lib/freshness.ts's own unit tests.
// formatFreshnessPrefix/formatFreshnessCompactValue stay the REAL
// implementation — server.ts calls them unconditionally on every
// error/manual-handler/success path, and they're pure functions anyway, so
// there's no reason to fake them (and a `vi.mock` factory that doesn't
// re-export them would leave them `undefined`, crashing every one of those
// paths).
const mockGetFreshnessForUser = vi.fn();
vi.mock("@/lib/freshness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/freshness")>();
  return {
    ...actual,
    getFreshnessForUser: (...args: unknown[]) => mockGetFreshnessForUser(...args),
  };
});

// The READ tool set every chat-capable key gets (unscoped AND area-scoped).
const CHAT_READ_TOOLS = ["search_conversations", "get_conversation"];
const CHAT_TOOLS = [...CHAT_READ_TOOLS];
// list_recent_conversations is registered for EVERY key; the key's bounds
// decide which kinds it lists (see listRecentConversations).
const RECENT_TOOLS = ["list_recent_conversations"];
const CODE_TOOLS = ["list_code_projects", "get_code_project", "get_code_session", "get_code_context_for"];
// Memory v1 (#152): the three read tools are gated the SAME way as CODE_TOOLS
// (see server.ts's call site) — always alongside them, never alone.
const MEMORY_TOOLS = ["memory_search", "memory_recall", "memory_resolve", "session_summary"];

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: vi.fn() })),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
// Most of this file exercises the extended tools (get_code_project,
// get_code_context_for), which are off by default (D8): turn the
// flag on for the whole file; the "default surface" block below turns it off.
process.env.MEMBRAL_MCP_EXTENDED_TOOLS = "1";

import { formatFreshnessCompactValue, formatFreshnessPrefix } from "@/lib/freshness";
import { createCloudMcpServer } from "../server";
import { INSTRUMENTED, type McpToolCallRow } from "../telemetry";

type ToolMap = Record<
  string,
  {
    handler: (
      args: Record<string, unknown>,
      extra?: unknown,
      // biome-ignore lint/suspicious/noExplicitAny: freshness payload shape isn't relevant to these tests' own typing
    ) => Promise<{ content: { text: string }[]; isError?: boolean; freshness?: any }>;
  }
>;

function tools(server: ReturnType<typeof createCloudMcpServer>): ToolMap {
  return (server as unknown as Record<string, ToolMap>)["_registeredTools"];
}

describe("createCloudMcpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFreshnessForUser.mockResolvedValue(null);
  });

  it("returns an McpServer instance", () => {
    const server = createCloudMcpServer("user-123");
    expect(server).toBeDefined();
    expect(server.connect).toBeInstanceOf(Function);
  });

  it("unscoped: registers the chat tool set PLUS the code tools (old memories-shaped tools removed)", () => {
    const server = createCloudMcpServer("user-123");
    const registered = tools(server);
    expect(Object.keys(registered).sort()).toEqual(
      [...CHAT_TOOLS, ...CODE_TOOLS, ...MEMORY_TOOLS, ...RECENT_TOOLS].sort(),
    );
    expect(registered["weekly_digest"]).toBeUndefined();
  });

  describe("extended-tools flag (MEMBRAL_MCP_EXTENDED_TOOLS, W5 D8)", () => {
    afterEach(() => {
      process.env.MEMBRAL_MCP_EXTENDED_TOOLS = "1";
    });

    it("default (flag unset): an unscoped key lists 9 tools, without the two extended ones", () => {
      delete process.env.MEMBRAL_MCP_EXTENDED_TOOLS;
      const keys = Object.keys(tools(createCloudMcpServer("user-123"))).sort();
      expect(keys).toEqual(
        [
          "search_conversations",
          "get_conversation",
          "list_recent_conversations",
          "list_code_projects",
          "get_code_session",
          ...MEMORY_TOOLS,
        ].sort(),
      );
      expect(keys).toHaveLength(9);
    });

    it("flag on: restores the 2 extended tools (11 total) and keeps their scope gates", () => {
      process.env.MEMBRAL_MCP_EXTENDED_TOOLS = "1";
      const unscoped = Object.keys(tools(createCloudMcpServer("user-123")));
      expect(unscoped).toHaveLength(11);
      for (const t of ["get_code_project", "get_code_context_for"]) expect(unscoped).toContain(t);
      const area = Object.keys(tools(createCloudMcpServer("user-123", "area-bound")));
      expect(area).not.toContain("get_code_project");
      const code = Object.keys(tools(createCloudMcpServer("user-123", null, "code-bound")));
      expect(code).toContain("get_code_project");
    });
  });

  // ---- The three token-scope surfaces (ADR 0021 Q7) ----

  describe("tool surfaces by token scope (ADR 0021 Q7)", () => {
    it("area-scoped: chat READ tools ONLY — NO code tools", () => {
      const server = createCloudMcpServer("user-123", "area-bound");
      const keys = Object.keys(tools(server)).sort();
      expect(keys).toEqual([...CHAT_READ_TOOLS, ...RECENT_TOOLS].sort());
      for (const t of CODE_TOOLS) expect(keys).not.toContain(t);
    });

    it("code-project-scoped: code tools ONLY — NO chat tools, NO portrait/identity", () => {
      const server = createCloudMcpServer("user-123", null, "code-bound");
      const keys = Object.keys(tools(server)).sort();
      expect(keys).toEqual([...CODE_TOOLS, ...MEMORY_TOOLS, ...RECENT_TOOLS].sort());
      for (const t of CHAT_TOOLS) expect(keys).not.toContain(t);
    });

    it("unscoped: chat tools AND code tools (full access)", () => {
      const server = createCloudMcpServer("user-123");
      const keys = Object.keys(tools(server)).sort();
      expect(keys).toEqual([...CHAT_TOOLS, ...CODE_TOOLS, ...MEMORY_TOOLS, ...RECENT_TOOLS].sort());
    });
  });

  // ---- Code tools inject the code bound into every RPC wrapper ----

  describe("code-project-scoped token injects the code bound into every code tool", () => {
    const CODE_BOUND = "proj-membral";

    it("list_code_projects receives the code bound", async () => {
      mockListCodeProjects.mockResolvedValueOnce([]);
      const server = createCloudMcpServer("user-123", null, CODE_BOUND);
      await tools(server)["list_code_projects"].handler({});
      expect(mockListCodeProjects).toHaveBeenCalledWith(expect.anything(), "user-123", CODE_BOUND);
    });

    it("get_code_project forwards the code bound; a null (out-of-scope) result -> 404-equivalent isError", async () => {
      mockGetCodeProject.mockResolvedValueOnce(null);
      const server = createCloudMcpServer("user-123", null, CODE_BOUND);
      const result = await tools(server)["get_code_project"].handler({ id: "sibling-proj" });
      expect(mockGetCodeProject).toHaveBeenCalledWith(expect.anything(), "user-123", "sibling-proj", CODE_BOUND);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found/i);
    });

    it("get_code_session forwards the code bound; a sibling session -> null -> not found", async () => {
      mockGetCodeSession.mockResolvedValueOnce(null);
      const server = createCloudMcpServer("user-123", null, CODE_BOUND);
      const result = await tools(server)["get_code_session"].handler({ id: "sibling-sess" });
      expect(mockGetCodeSession).toHaveBeenCalledWith(expect.anything(), "user-123", "sibling-sess", CODE_BOUND);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found/i);
    });

    it("get_code_session resolves an id prefix under the code bound; an ambiguous one names candidates, never opens one", async () => {
      const full = "6b3ce53f-1111-4aaa-8aaa-aaaaaaaaaaaa";
      mockResolveSessionId.mockResolvedValueOnce({ ok: true, id: full });
      mockGetCodeSession.mockResolvedValueOnce(null);
      const server = createCloudMcpServer("user-123", null, CODE_BOUND);
      await tools(server)["get_code_session"].handler({ id: "6b3ce53f" });
      expect(mockResolveSessionId).toHaveBeenCalledWith(expect.anything(), "user-123", "6b3ce53f", CODE_BOUND);
      expect(mockGetCodeSession).toHaveBeenCalledWith(expect.anything(), "user-123", full, CODE_BOUND);

      mockGetCodeSession.mockClear();
      const message =
        'Ambiguous session id prefix "7c00aa11"; candidates: 7c00aa11-111, 7c00aa11-222 (first 12 chars each).';
      mockResolveSessionId.mockResolvedValueOnce({ ok: false, reason: "ambiguous", message } as never);
      const amb = await tools(server)["get_code_session"].handler({ id: "7c00aa11" });
      expect(amb.isError).toBe(true);
      expect(amb.content[0].text).toContain("candidates: 7c00aa11-111, 7c00aa11-222");

      mockResolveSessionId.mockResolvedValueOnce({ ok: false, reason: "not_found" } as never);
      const none = await tools(server)["get_code_session"].handler({ id: "9f9f9f9f" });
      expect(none.content[0].text).toMatch(/Code session not found: 9f9f9f9f/);
      expect(mockGetCodeSession).not.toHaveBeenCalled();
    });

    it("get_code_session surfaces sub_agents and parent_session_id from the bound-scoped RPC (first part carries sub_agents)", async () => {
      const turns = Array.from({ length: 40 }, (_, i) => ({
        idx: i,
        role: "user",
        kind: "prose",
        text: "x".repeat(3_000),
      }));
      mockGetCodeSession.mockResolvedValue({
        id: "sess-1",
        turns,
        files_touched: [],
        parent_session_id: "parent-1",
        sub_agents: [{ id: "child-1", agent_type: "explore", brief: "Find callers" }],
        sub_agents_total: 1,
      });
      const server = createCloudMcpServer("user-123", null, CODE_BOUND);
      const first = await tools(server)["get_code_session"].handler({ id: "sess-1" });
      expect(mockGetCodeSession).toHaveBeenCalledWith(expect.anything(), "user-123", "sess-1", CODE_BOUND);
      const body = JSON.parse(first.content[0].text.slice(first.content[0].text.indexOf("{")));
      expect(body.sub_agents).toEqual([{ id: "child-1", agent_type: "explore", brief: "Find callers" }]);
      expect(body.parent_session_id).toBe("parent-1");
      const second = await tools(server)["get_code_session"].handler({ id: "sess-1", start: body.next_start });
      const body2 = JSON.parse(second.content[0].text.slice(second.content[0].text.indexOf("{")));
      expect(body2).not.toHaveProperty("sub_agents");
      expect(body2.parent_session_id).toBe("parent-1");
      mockGetCodeSession.mockReset();
    });

    it("get_code_context_for forwards the code bound", async () => {
      mockGetCodeContextFor.mockResolvedValueOnce({
        query: "x",
        project_count: 0,
        projects: [],
        sessions: [],
        turns: [],
      });
      const server = createCloudMcpServer("user-123", null, CODE_BOUND);
      await tools(server)["get_code_context_for"].handler({ query: "x" });
      expect(mockGetCodeContextFor).toHaveBeenCalledWith(expect.anything(), "user-123", "x", CODE_BOUND);
    });

    it("get_code_project returns the row when in scope", async () => {
      mockGetCodeProject.mockResolvedValueOnce({ id: CODE_BOUND, display_name: "acme/membral", sessions: [] });
      const server = createCloudMcpServer("user-123", null, CODE_BOUND);
      const result = await tools(server)["get_code_project"].handler({ id: CODE_BOUND });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).id).toBe(CODE_BOUND);
    });
  });

  it("unscoped code tools get a null code bound (all projects)", async () => {
    mockListCodeProjects.mockResolvedValueOnce([]);
    const server = createCloudMcpServer("user-123");
    await tools(server)["list_code_projects"].handler({});
    expect(mockListCodeProjects).toHaveBeenCalledWith(expect.anything(), "user-123", null);
  });

  // ---- Unscoped token (tokenScopeId omitted -> null): pre-#83 parity ----

  it("search_conversations passes query, scope, limit + null token scope through, with includeCode true for an unscoped key (goal 2026-07-26 step 10)", async () => {
    mockSearchConversationsScoped.mockResolvedValueOnce([]);
    const server = createCloudMcpServer("user-123");
    await tools(server)["search_conversations"].handler({ query: "hooks", scope: "Work", limit: 5 });
    expect(mockSearchConversationsScoped).toHaveBeenCalledWith(
      expect.anything(),
      "user-123",
      "hooks",
      "Work",
      5,
      null,
      true,
      null,
    );
  });

  describe("search_conversations since/days (migration 095)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
      mockSearchConversationsScoped.mockResolvedValue([]);
    });
    afterEach(() => vi.useRealTimers());

    const sinceArg = () => mockSearchConversationsScoped.mock.calls[0][7];

    it("an ISO date becomes 00:00 UTC that day", async () => {
      await tools(createCloudMcpServer("user-123"))["search_conversations"].handler({
        query: "x",
        since: "2026-09-24",
      });
      expect(sinceArg()).toBe("2026-09-24T00:00:00.000Z");
    });

    it("days alone means now minus days; since wins when both are given", async () => {
      const server = createCloudMcpServer("user-123");
      await tools(server)["search_conversations"].handler({ query: "x", days: 2 });
      expect(sinceArg()).toBe("2026-09-23T12:00:00.000Z");
      await tools(server)["search_conversations"].handler({ query: "x", days: 2, since: "2026-09-01T08:00:00Z" });
      expect(mockSearchConversationsScoped.mock.calls[1][7]).toBe("2026-09-01T08:00:00.000Z");
    });

    it("an invalid since is an isError result and search never runs", async () => {
      const res = await tools(createCloudMcpServer("user-123"))["search_conversations"].handler({
        query: "x",
        since: "last tuesday",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid since: "last tuesday"');
      expect(mockSearchConversationsScoped).not.toHaveBeenCalled();
    });
  });

  describe("list_recent_conversations", () => {
    const NOW = new Date("2026-09-25T12:00:00.000Z");
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      mockListRecentConversations.mockResolvedValue({ hint: "h", results: [] });
    });
    afterEach(() => vi.useRealTimers());

    it("defaults to the last 7 days, no source, unscoped bound", async () => {
      const server = createCloudMcpServer("user-123");
      await tools(server)["list_recent_conversations"].handler({});
      expect(mockListRecentConversations).toHaveBeenCalledWith(
        expect.anything(),
        "user-123",
        { since: "2026-09-18T12:00:00.000Z", source: undefined, limit: undefined, kind: undefined },
        { tokenScopeId: null, codeScopeId: null },
      );
    });

    it("since wins over days; source and limit pass through", async () => {
      const server = createCloudMcpServer("user-123");
      await tools(server)["list_recent_conversations"].handler({
        since: "2026-09-24",
        days: 30,
        source: "opencode",
        limit: 10,
        kind: "code",
      });
      expect(mockListRecentConversations).toHaveBeenCalledWith(
        expect.anything(),
        "user-123",
        { since: "2026-09-24T00:00:00.000Z", source: "opencode", limit: 10, kind: "code" },
        { tokenScopeId: null, codeScopeId: null },
      );
    });

    it("days alone sets now minus days", async () => {
      const server = createCloudMcpServer("user-123");
      await tools(server)["list_recent_conversations"].handler({ days: 1 });
      expect(mockListRecentConversations).toHaveBeenCalledWith(
        expect.anything(),
        "user-123",
        expect.objectContaining({ since: "2026-09-24T12:00:00.000Z" }),
        { tokenScopeId: null, codeScopeId: null },
      );
    });

    it("an invalid since is an isError result naming the formats, and the list is never queried", async () => {
      const server = createCloudMcpServer("user-123");
      const res = await tools(server)["list_recent_conversations"].handler({ since: "yesterday" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid since: "yesterday"');
      expect(mockListRecentConversations).not.toHaveBeenCalled();
    });

    it("an unknown source is an isError result listing the known sources", async () => {
      const server = createCloudMcpServer("user-123");
      const res = await tools(server)["list_recent_conversations"].handler({ source: "myspace" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain(
        'Invalid source: "myspace". Use one of chatgpt, claude, claude-code, codex, copilot-cli, grok, opencode.',
      );
      expect(mockListRecentConversations).not.toHaveBeenCalled();
    });

    it("forwards the key's bounds: area-scoped and code-project-scoped keys each pass their own", async () => {
      await tools(createCloudMcpServer("user-123", "area-bound"))["list_recent_conversations"].handler({});
      expect(mockListRecentConversations).toHaveBeenLastCalledWith(expect.anything(), "user-123", expect.anything(), {
        tokenScopeId: "area-bound",
        codeScopeId: null,
      });
      await tools(createCloudMcpServer("user-123", null, "code-bound"))["list_recent_conversations"].handler({});
      expect(mockListRecentConversations).toHaveBeenLastCalledWith(expect.anything(), "user-123", expect.anything(), {
        tokenScopeId: null,
        codeScopeId: "code-bound",
      });
    });
  });

  // ---- Scoped token (issue #83): the token bound is injected into every tool ----

  describe("area-scoped token injects the bound into every tool (issue #83)", () => {
    const BOUND = "area-work-bound";

    it("a client scope param is still forwarded, but the token bound rides alongside it (narrow-only), with includeCode FALSE — an area-scoped key must never see code hits (goal step 10)", async () => {
      mockSearchConversationsScoped.mockResolvedValueOnce([]);
      const server = createCloudMcpServer("user-123", BOUND);
      await tools(server)["search_conversations"].handler({ query: "hooks", scope: "attempt-escape" });
      // The client scope is passed, but so is the mandatory bound — the graph-tool
      // layer (resolveEffectiveScopeId) is what forbids escaping it.
      expect(mockSearchConversationsScoped).toHaveBeenCalledWith(
        expect.anything(),
        "user-123",
        "hooks",
        "attempt-escape",
        undefined,
        BOUND,
        false,
        null,
      );
    });

    it("get_conversation forwards the token bound to getScopedConversation", async () => {
      mockGetScopedConversation.mockResolvedValueOnce({ id: "c1" });
      const server = createCloudMcpServer("user-123", BOUND);
      await tools(server)["get_conversation"].handler({ id: "c1" });
      expect(mockGetScopedConversation).toHaveBeenCalledWith(expect.anything(), "user-123", "c1", BOUND);
    });
  });

  it("a graph-tool error (e.g. UnknownScopeError) surfaces as isError text, not a thrown exception", async () => {
    mockListRecentConversations.mockRejectedValueOnce(new MockUnknownScopeError("Nonexistent"));
    const server = createCloudMcpServer("user-123");
    const result = await tools(server)["list_recent_conversations"].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown scope/);
  });

  it("get_conversation returns the row from getScopedConversation (unscoped: null bound)", async () => {
    const fakeConvo = {
      id: "conv-1",
      source: "chatgpt",
      title: "Test",
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
      model: "gpt-4",
      messages: [],
      metadata: {},
    };
    mockGetScopedConversation.mockResolvedValueOnce(fakeConvo);

    const server = createCloudMcpServer("user-123");
    const result = await tools(server)["get_conversation"].handler({ id: "conv-1" });

    expect(mockGetScopedConversation).toHaveBeenCalledWith(expect.anything(), "user-123", "conv-1", null);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...fakeConvo,
            total_messages: 0,
            total_chars: 0,
            returned: { start: 0, end: 0 },
            next_start: null,
          }),
        },
      ],
      freshness: null,
    });
  });

  describe("get_conversation pagination (MCP output cap)", () => {
    const bigConvo = () => ({
      id: "conv-big",
      source: "claude",
      title: "Long chat",
      messages: Array.from({ length: 35 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}:`.padEnd(3_500, "x"),
        timestamp: null,
        metadata: {},
      })),
    });
    const parse = (text: string) => JSON.parse(text.slice(text.indexOf("{")));

    it("id-only call on a long chat returns the first part, next_start and a continue note", async () => {
      mockGetScopedConversation.mockResolvedValueOnce(bigConvo());
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_conversation"].handler({ id: "conv-big" });
      const text: string = result.content[0].text;
      expect(text.split("\n")[0]).toBe(
        "Showing messages 0–16 of 35 (59,500 of 122,500 chars). Call get_conversation with start=17 for the rest.",
      );
      const body = parse(text);
      expect(body.messages).toHaveLength(17);
      expect(body).toMatchObject({
        total_messages: 35,
        total_chars: 122_500,
        returned: { start: 0, end: 17 },
        next_start: 17,
      });
    });

    it("following next_start covers every message exactly once, and the last part has no note", async () => {
      const server = createCloudMcpServer("user-123");
      const seen: string[] = [];
      let start: number | null = 0;
      let lastText = "";
      while (start !== null) {
        mockGetScopedConversation.mockResolvedValueOnce(bigConvo());
        const result = await tools(server)["get_conversation"].handler({ id: "conv-big", start });
        lastText = result.content[0].text;
        const body = parse(lastText);
        expect(body.returned.start).toBe(start);
        for (const m of body.messages) seen.push(m.content.split(":")[0]);
        start = body.next_start;
      }
      expect(seen).toEqual(Array.from({ length: 35 }, (_, i) => `m${i}`));
      expect(lastText.startsWith("{")).toBe(true);
    });

    it("passes start and max_chars through (max_chars clamped)", async () => {
      mockGetScopedConversation.mockResolvedValueOnce(bigConvo());
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_conversation"].handler({ id: "conv-big", start: 30, max_chars: 1 });
      const body = parse(result.content[0].text);
      // clamped to 5,000 → one 3,500-char message fits, two do not
      expect(body.returned).toEqual({ start: 30, end: 31 });
      expect(body.next_start).toBe(31);
    });
  });

  describe("get_code_session pagination (MCP output cap)", () => {
    const bigSession = (files: string[] = ["src/a.ts"]) => ({
      id: "sess-big",
      code_project_id: "proj-1",
      source: "claude-code",
      title: "Long session",
      summary: "CodeHub importer work.",
      files_touched: files,
      turns: Array.from({ length: 35 }, (_, i) => ({
        idx: i,
        role: "user",
        kind: "ask",
        text: `t${i}:`.padEnd(3_500, "x"),
        tool_name: null,
        file_path: null,
        ts: null,
      })),
    });
    const parse = (text: string) => JSON.parse(text.slice(text.indexOf("{")));

    it("id-only call on a long session returns the first part, next_start and a continue note", async () => {
      mockGetCodeSession.mockResolvedValueOnce(bigSession());
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_code_session"].handler({ id: "sess-big" });
      const text: string = result.content[0].text;
      expect(text.split("\n")[0]).toBe(
        "Showing turns 0–16 of 35 (59,500 of 122,500 chars). Call get_code_session with start=17 for the rest.",
      );
      const body = parse(text);
      expect(body.turns).toHaveLength(17);
      expect(body).toMatchObject({
        summary: "CodeHub importer work.",
        files_touched: ["src/a.ts"],
        total_turns: 35,
        total_chars: 122_500,
        returned: { start: 0, end: 17 },
        next_start: 17,
      });
    });

    it("following next_start covers every turn exactly once, and the last part has no note", async () => {
      const server = createCloudMcpServer("user-123");
      const seen: number[] = [];
      let start: number | null = 0;
      let lastText = "";
      while (start !== null) {
        mockGetCodeSession.mockResolvedValueOnce(bigSession());
        const result = await tools(server)["get_code_session"].handler({ id: "sess-big", start });
        lastText = result.content[0].text;
        const body = parse(lastText);
        expect(body.returned.start).toBe(start);
        expect(body.summary).toBe("CodeHub importer work.");
        for (const t of body.turns) seen.push(t.idx);
        start = body.next_start;
      }
      expect(seen).toEqual(Array.from({ length: 35 }, (_, i) => i));
      expect(lastText.startsWith("{")).toBe(true);
    });

    it("passes start and max_chars through (max_chars clamped); later parts omit files_touched", async () => {
      mockGetCodeSession.mockResolvedValueOnce(bigSession());
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_code_session"].handler({ id: "sess-big", start: 30, max_chars: 1 });
      const body = parse(result.content[0].text);
      expect(body.returned).toEqual({ start: 30, end: 31 });
      expect(body.next_start).toBe(31);
      expect(body).not.toHaveProperty("files_touched");
    });

    it("caps a long files_touched on the first part", async () => {
      mockGetCodeSession.mockResolvedValueOnce(bigSession(Array.from({ length: 250 }, (_, i) => `f${i}.ts`)));
      const server = createCloudMcpServer("user-123");
      const body = parse((await tools(server)["get_code_session"].handler({ id: "sess-big" })).content[0].text);
      expect(body.files_touched).toHaveLength(200);
      expect(body.files_touched_total).toBe(250);
      expect(body.files_touched_omitted).toBe(50);
    });

    it("turn opens the session at that turn: only the window, the focus block and outward hints", async () => {
      mockGetCodeSession.mockResolvedValueOnce(bigSession(["src/a.ts"]));
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_code_session"].handler({ id: "sess-big", turn: 20, window: 1 });
      const text: string = result.content[0].text;
      expect(text.split("\n")[0]).toBe(
        "Showing turns 19–21 around turn 20 (window ±1) of 35. Call get_code_session with start=16 for earlier turns, or start=22 for later ones.",
      );
      const body = parse(text);
      expect(body.turns.map((t: { idx: number }) => t.idx)).toEqual([19, 20, 21]);
      expect(body.focus).toEqual({ turn: 20, window: 1, first_idx: 19, last_idx: 21, total_turns: 35 });
      expect(body).not.toHaveProperty("files_touched");
    });

    it("without turn, window is ignored and paging is unchanged", async () => {
      mockGetCodeSession.mockResolvedValueOnce(bigSession());
      const server = createCloudMcpServer("user-123");
      const body = parse(
        (await tools(server)["get_code_session"].handler({ id: "sess-big", window: 2 })).content[0].text,
      );
      expect(body.turns).toHaveLength(17);
      expect(body).not.toHaveProperty("focus");
    });
  });

  it("get_conversation returns error (404-equivalent) when scoped fetch yields null", async () => {
    mockGetScopedConversation.mockResolvedValueOnce(null);

    const server = createCloudMcpServer("user-123", "area-bound");
    const result = await tools(server)["get_conversation"].handler({ id: "out-of-scope-id" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // ---- A (2026-09-25): get_conversation falls back to a code-session lookup ----
  describe("get_conversation accepts a coding-session id", () => {
    it("chat id -> the chat, via getScopedConversation; getCodeSession is never called", async () => {
      mockGetScopedConversation.mockResolvedValueOnce({
        id: "conv-1",
        source: "claude",
        title: "A chat",
        messages: [],
      });
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_conversation"].handler({ id: "conv-1" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("A chat");
      expect(mockGetCodeSession).not.toHaveBeenCalled();
    });

    it("code-session id -> get_code_session's own shape, with a short note, same paging params applied", async () => {
      mockGetScopedConversation.mockResolvedValueOnce(null);
      mockGetCodeSession.mockResolvedValueOnce({
        id: "sess-1",
        title: "Fix the parser",
        turns: [{ idx: 0, role: "user", kind: "prose", text: "fix it" }],
        files_touched: [],
      });
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_conversation"].handler({ id: "sess-1" });
      expect(mockGetCodeSession).toHaveBeenCalledWith(expect.anything(), "user-123", "sess-1", null);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/coding session, not a chat/i);
      const body = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf("{")));
      expect(body.id).toBe("sess-1");
      expect(body.title).toBe("Fix the parser");
    });

    it("unknown id -> not found (neither a chat nor a coding session)", async () => {
      mockGetScopedConversation.mockResolvedValueOnce(null);
      mockGetCodeSession.mockResolvedValueOnce(null);
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_conversation"].handler({ id: "no-such-id" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found/i);
    });

    it("area-scoped key never tries the code-session fallback (no code-session access at all)", async () => {
      mockGetScopedConversation.mockResolvedValueOnce(null);
      const server = createCloudMcpServer("user-123", "area-bound");
      const result = await tools(server)["get_conversation"].handler({ id: "some-id" });
      expect(mockGetCodeSession).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });
  });

  // ---- Freshness stamp (goal 2026-07-26 step 2, #63/#58) ----
  //
  // BLOCKER 1 (adversarial review): the stamp is USELESS to a real MCP host
  // unless it lives INSIDE content[0].text — a top-level `freshness` sibling
  // on the tool-call result is never handed to the model (proven via SDK
  // round-trip: only `content` blocks are). Every assertion below therefore
  // parses/inspects `result.content[0].text` itself, not just `result.freshness`
  // (which is kept too, as a harmless secondary field, and still asserted
  // alongside — but never as the ONLY proof the stamp reached the model).
  describe("freshness stamp", () => {
    const FRESHNESS = {
      corpus_current_through: {
        claude: { last_item_at: "2026-07-20T00:00:00.000Z", last_synced_at: "2026-07-25T00:00:00.000Z" },
      },
      generated_at: "2026-07-25T00:00:00.000Z",
    };

    it("folds freshness INTO the JSON text of a toolResult-routed success response, as {freshness, data} — freshness is the COMPACT one-line string, not the full object (NOTE fix)", async () => {
      mockGetFreshnessForUser.mockResolvedValueOnce(FRESHNESS);
      mockListRecentConversations.mockResolvedValueOnce([
        { id: "a1", label: "Work", summary: null, item_count: 1, conv_count: 2 },
      ]);
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["list_recent_conversations"].handler({});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.freshness).toBe(formatFreshnessCompactValue(FRESHNESS));
      expect(parsed.freshness).toBe("claude 2026-07-20T00:00:00.000Z");
      expect(parsed.data).toEqual([{ id: "a1", label: "Work", summary: null, item_count: 1, conv_count: 2 }]);
      // freshness is the FIRST key, per the brief ("freshness first so it renders at the top").
      expect(Object.keys(parsed)[0]).toBe("freshness");
      // the top-level sibling field is kept too (harmless secondary surface) — the FULL object there.
      expect(result.freshness).toEqual(FRESHNESS);
    });

    // ---- MINOR 5 fix (round-2 adversarial review): the stamp is a PREFIX on every plain-text path, ----
    // ---- one convention chosen and applied everywhere (see formatFreshnessPrefix's docstring). ----

    it("PREPENDS the compact stamp to isError text (a graph-tool throw) — plain text, not JSON, so it can't be folded", async () => {
      mockGetFreshnessForUser.mockResolvedValueOnce(FRESHNESS);
      mockListRecentConversations.mockRejectedValueOnce(new MockUnknownScopeError("Nonexistent"));
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["list_recent_conversations"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        `${formatFreshnessPrefix(FRESHNESS)}Unknown scope: "Nonexistent" is not one of your life areas`,
      );
      // it LEADS the text — first 40 chars already contain it (the truncation-safety property).
      expect(result.content[0].text.slice(0, 40)).toContain("corpus current through");
      expect(result.freshness).toEqual(FRESHNESS);
    });

    it("PREPENDS the compact stamp to the manually-handled code tools' success text (get_code_project)", async () => {
      mockGetFreshnessForUser.mockResolvedValueOnce(FRESHNESS);
      mockGetCodeProject.mockResolvedValueOnce({ id: "p1" });
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_code_project"].handler({ id: "p1" });

      expect(result.content[0].text).toBe(`${formatFreshnessPrefix(FRESHNESS)}${JSON.stringify({ id: "p1" })}`);
      expect(result.content[0].text.startsWith("[corpus current through: claude 2026-07-20T00:00:00.000Z]")).toBe(true);
      expect(result.freshness).toEqual(FRESHNESS);
    });

    it("PREPENDS the compact stamp to the manually-handled code tools' not-found text (get_code_session)", async () => {
      mockGetFreshnessForUser.mockResolvedValueOnce(FRESHNESS);
      mockGetCodeSession.mockResolvedValueOnce(null);
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_code_session"].handler({ id: "missing" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(`${formatFreshnessPrefix(FRESHNESS)}Code session not found: missing`);
    });

    it("PREPENDS the compact stamp to get_conversation's success text too", async () => {
      mockGetFreshnessForUser.mockResolvedValueOnce(FRESHNESS);
      mockGetScopedConversation.mockResolvedValueOnce({ id: "c1" });
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_conversation"].handler({ id: "c1" });

      expect(result.content[0].text).toBe(
        `${formatFreshnessPrefix(FRESHNESS)}${JSON.stringify({
          id: "c1",
          total_messages: 0,
          total_chars: 0,
          returned: { start: 0, end: 0 },
          next_start: null,
        })}`,
      );
    });

    it("a huge get_conversation payload still surfaces the stamp within the first 40 chars — the actual truncation-safety property (a real MCP-consuming eval harness caps captured text)", async () => {
      mockGetFreshnessForUser.mockResolvedValueOnce(FRESHNESS);
      mockGetScopedConversation.mockResolvedValueOnce({
        id: "c1",
        messages: Array(1000).fill({ text: "x".repeat(50) }),
      });
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_conversation"].handler({ id: "c1" });

      expect(result.content[0].text.length).toBeGreaterThan(4000); // genuinely huge
      expect(result.content[0].text.slice(0, 40)).toContain("corpus current through");
    });

    it("degrades to null when the freshness computation rejects (never breaks the tool response) — content still parses as {freshness: null, data}", async () => {
      mockGetFreshnessForUser.mockRejectedValueOnce(new Error("rpc unavailable"));
      mockListRecentConversations.mockResolvedValueOnce([
        { id: "a1", label: "Work", summary: null, item_count: 0, conv_count: 0 },
      ]);
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["list_recent_conversations"].handler({});
      expect(result.isError).toBeUndefined();
      expect(result.freshness).toBeNull();
      expect(JSON.parse(result.content[0].text)).toEqual({
        freshness: null,
        data: [{ id: "a1", label: "Work", summary: null, item_count: 0, conv_count: 0 }],
      });
    });

    it("degrading to null on a plain-text path prepends nothing at all (not even empty brackets)", async () => {
      mockGetFreshnessForUser.mockRejectedValueOnce(new Error("rpc unavailable"));
      mockGetCodeProject.mockResolvedValueOnce({ id: "p1" });
      const server = createCloudMcpServer("user-123");
      const result = await tools(server)["get_code_project"].handler({ id: "p1" });
      expect(result.content[0].text).toBe(JSON.stringify({ id: "p1" }));
      expect(result.content[0].text).not.toContain("corpus current through");
    });

    it("computes freshness ONCE per server instance — cached across multiple tool calls on the same server, same value folded into each", async () => {
      mockGetFreshnessForUser.mockResolvedValue(FRESHNESS);
      mockListRecentConversations.mockResolvedValue([]);
      mockListRecentConversations.mockResolvedValue([]);
      const server = createCloudMcpServer("user-123");

      const r1 = await tools(server)["list_recent_conversations"].handler({});
      await tools(server)["list_recent_conversations"].handler({});
      const r3 = await tools(server)["list_recent_conversations"].handler({});

      expect(mockGetFreshnessForUser).toHaveBeenCalledTimes(1);
      expect(JSON.parse(r1.content[0].text).freshness).toBe(formatFreshnessCompactValue(FRESHNESS));
      expect(JSON.parse(r3.content[0].text).freshness).toBe(formatFreshnessCompactValue(FRESHNESS));
    });

    it("computes freshness separately per server instance (a new server = a new request)", async () => {
      mockGetFreshnessForUser.mockResolvedValue(FRESHNESS);
      mockListRecentConversations.mockResolvedValue([]);

      const serverA = createCloudMcpServer("user-123");
      await tools(serverA)["list_recent_conversations"].handler({});
      const serverB = createCloudMcpServer("user-123");
      await tools(serverB)["list_recent_conversations"].handler({});

      expect(mockGetFreshnessForUser).toHaveBeenCalledTimes(2);
    });
  });
});

describe("tool-call telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFreshnessForUser.mockResolvedValue(null);
  });

  it.each([
    ["unscoped", null, null],
    ["area-scoped", "area-1", null],
    ["code-scoped", null, "proj-1"],
  ])("%s: every registered tool's handler is instrumented", (_label, tokenScopeId, codeScopeId) => {
    const registered = tools(createCloudMcpServer("user-123", tokenScopeId, codeScopeId));
    const names = Object.keys(registered);
    expect(names.length).toBeGreaterThan(0);
    const bare = names.filter((name) => !INSTRUMENTED.has(registered[name].handler));
    expect(bare).toEqual([]);
  });

  it("a real tool call writes one row with the key id and the User-Agent client", async () => {
    const rows: McpToolCallRow[] = [];
    const waited: Promise<unknown>[] = [];
    mockSearchConversationsScoped.mockResolvedValue([{ id: "c1", source_type: "chat" }]);
    const server = createCloudMcpServer("user-123", null, null, {
      apiKeyId: "key-1",
      sink: async (row) => {
        rows.push(row);
      },
      waitUntil: (p) => waited.push(p),
    });
    const extra = { requestInfo: { headers: { "user-agent": "claude-code/2.1.0 (cli)" } } };
    const res = await tools(server)["search_conversations"].handler({ query: "deploy", recall_token: "x" }, extra);
    expect(res.isError).toBeUndefined();
    await Promise.all(waited);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "user-123",
      api_key_id: "key-1",
      client_name: "claude-code",
      client_version: "2.1.0",
      tool: "search_conversations",
      ok: true,
      result_ids: ["c1"],
      args: { query: "deploy" },
    });
  });
});
