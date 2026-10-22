import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockMemorySearch = vi.fn();
const mockMemoryRecall = vi.fn();
const mockSessionSummary = vi.fn();
const mockLogSearchRecall = vi.fn();

vi.mock("@/lib/memory/search", () => ({
  memorySearch: (...args: unknown[]) => mockMemorySearch(...args),
  logSearchRecall: (...args: unknown[]) => mockLogSearchRecall(...args),
}));
vi.mock("@/lib/memory/recall", () => ({
  memoryRecallWithStats: async (...args: unknown[]) => ({
    records: await mockMemoryRecall(...args),
    staleBlockersHidden: 0,
  }),
}));
vi.mock("@/lib/memory/summary", () => ({ sessionSummary: (...args: unknown[]) => mockSessionSummary(...args) }));
const mockResolveSessionId = vi.fn(async (_db: unknown, _u: string, id: string) => ({ ok: true, id }));
vi.mock("../resolve-session-id", () => ({
  resolveSessionId: (...args: [unknown, string, string]) => mockResolveSessionId(...args),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { MEMORY_TOOL_NAMES } from "@/lib/memory/preamble";
import { registerMemoryTools } from "../memory-tools";

const USER = "user-1";
const PROJECT_SCOPE = "proj-1";

interface RegisteredTool {
  name: string;
  config: { description: string; inputSchema?: unknown };
  handler: (...args: unknown[]) => Promise<unknown>;
}

function fakeServer() {
  const tools: RegisteredTool[] = [];
  return {
    server: {
      registerTool: (
        name: string,
        config: { description: string; inputSchema?: unknown },
        handler: (...args: unknown[]) => Promise<unknown>,
      ) => {
        tools.push({ name, config, handler });
      },
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any,
    tools,
  };
}

const toolResult = async (fn: () => Promise<unknown>) => {
  try {
    const data = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], freshness: null };
  } catch (err) {
    return { content: [{ type: "text" as const, text: String(err) }], isError: true, freshness: null };
  }
};
const getFreshnessCached = async () => null;

describe("registerMemoryTools", () => {
  beforeEach(() => {
    mockMemorySearch.mockReset();
    mockMemoryRecall.mockReset();
    mockSessionSummary.mockReset();
  });

  it("registers memory_search, memory_recall, memory_resolve and session_summary -- never memory_record (that's #153's write tool)", () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_recall",
      "memory_resolve",
      "memory_search",
      "session_summary",
    ]);
  });

  // Tool search often defers MCP tools behind their names alone -- the words
  // a "learnings from the last few days" prompt is likely to echo must be in
  // memory_search's FIRST sentence, not buried after it.
  it("memory_search's first sentence names learnings, decisions and past sessions", () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    const tool = tools.find((t) => t.name === "memory_search")!;
    const firstSentence = tool.config.description.split(". ")[0];
    expect(firstSentence).toContain("learnings");
    expect(firstSentence).toContain("decisions");
    expect(firstSentence).toContain("past sessions");
  });

  it("memory_search and memory_recall say, in their first 2,048 chars, what links records carry and how to open a session", () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    for (const name of ["memory_search", "memory_recall"]) {
      const description = tools.find((t) => t.name === name)!.config.description;
      expect(description.length).toBeLessThan(2_048);
      for (const word of ["sha", "paths", "ref_url", "get_code_session id=<session_id> turn=<turn_idx>"])
        expect(description).toContain(word);
    }
  });

  it("memory_search passes userId and codeScopeId straight through, never trusting a client-supplied scope", async () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, PROJECT_SCOPE, toolResult, getFreshnessCached);
    mockMemorySearch.mockResolvedValueOnce({ records: [] });

    const tool = tools.find((t) => t.name === "memory_search")!;
    await tool.handler({ query: "cache key" });

    expect(mockMemorySearch).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      PROJECT_SCOPE,
      { query: "cache key" },
      { floor: true, dateHints: true, logEvent: false, collapseByMeaning: true, raw: true },
    );
  });

  it("memory_recall passes userId and codeScopeId straight through", async () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, PROJECT_SCOPE, toolResult, getFreshnessCached);
    mockMemoryRecall.mockResolvedValueOnce([]);

    const tool = tools.find((t) => t.name === "memory_recall")!;
    await tool.handler({ repo: "github.com/acme/repo" });

    expect(mockMemoryRecall).toHaveBeenCalledWith(expect.anything(), USER, PROJECT_SCOPE, {
      repo: "github.com/acme/repo",
    });
  });

  it("session_summary reports a clean not-found error (no existence leak) when the tool returns null", async () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    mockSessionSummary.mockResolvedValueOnce(null);

    const tool = tools.find((t) => t.name === "session_summary")!;
    const result = (await tool.handler({ session_id: "does-not-exist" })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it("session_summary returns the data as JSON on success", async () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    mockSessionSummary.mockResolvedValueOnce({ header: { id: "sess-1" }, journey: [] });

    const tool = tools.find((t) => t.name === "session_summary")!;
    const result = (await tool.handler({ session_id: "sess-1" })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("sess-1");
  });

  it("session_summary resolves an id prefix (user- and scope-bound) and passes the full id on", async () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, PROJECT_SCOPE, toolResult, getFreshnessCached);
    const full = "6b3ce53f-1111-4aaa-8aaa-aaaaaaaaaaaa";
    mockResolveSessionId.mockResolvedValueOnce({ ok: true, id: full });
    mockSessionSummary.mockResolvedValueOnce({ header: { id: full }, journey: [] });

    const tool = tools.find((t) => t.name === "session_summary")!;
    const result = (await tool.handler({ session_id: "6b3ce53f" })) as { isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(mockResolveSessionId).toHaveBeenCalledWith(expect.anything(), USER, "6b3ce53f", PROJECT_SCOPE);
    expect(mockSessionSummary).toHaveBeenCalledWith(expect.anything(), USER, PROJECT_SCOPE, {
      session_id: full,
      last: undefined,
      repo: undefined,
      recall_token: undefined,
    });
  });

  it("session_summary: an ambiguous prefix is an error naming the candidates; an unmatched one is not found", async () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    const tool = tools.find((t) => t.name === "session_summary")!;
    const message =
      'Ambiguous session id prefix "7c00aa11"; candidates: 7c00aa11-111, 7c00aa11-222 (first 12 chars each).';
    mockResolveSessionId.mockResolvedValueOnce({ ok: false, reason: "ambiguous", message } as never);
    const amb = (await tool.handler({ session_id: "7c00aa11" })) as { isError?: boolean; content: { text: string }[] };
    expect(amb.isError).toBe(true);
    expect(amb.content[0].text).toContain("candidates: 7c00aa11-111, 7c00aa11-222");

    mockResolveSessionId.mockResolvedValueOnce({ ok: false, reason: "not_found" } as never);
    const none = (await tool.handler({ session_id: "9f9f9f9f" })) as { isError?: boolean; content: { text: string }[] };
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toMatch(/Session not found/);
    expect(mockSessionSummary).not.toHaveBeenCalled();
  });

  // e2e C-10: a fresh user asking for their last session gets an empty answer, not an error.
  it("session_summary {last:true} with no sessions returns an explicit empty result, not an error", async () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    mockSessionSummary.mockResolvedValueOnce(null);

    const tool = tools.find((t) => t.name === "session_summary")!;
    const result = (await tool.handler({ last: true })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ session: null, message: "No coding sessions recorded yet." });
  });

  it("session_summary {last:true, repo} with no sessions names the repo in the empty result", async () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    mockSessionSummary.mockResolvedValueOnce(null);

    const tool = tools.find((t) => t.name === "session_summary")!;
    const result = (await tool.handler({ last: true, repo: "notes" })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).message).toContain('"notes"');
  });

  // e2e C-3: the preamble's "Tools:" line must only name tools this server registers.
  it("every tool the preamble advertises (MEMORY_TOOL_NAMES) is registered", () => {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    const registered = new Set(tools.map((t) => t.name));
    for (const name of MEMORY_TOOL_NAMES) expect(registered.has(name), name).toBe(true);
  });
});

describe("memory_search: I33 served lines (docs/design/i33-port.md D7)", () => {
  const line = (n: number, type: "record" | "raw" = "record", members: string[] = [`m${n}`]) => ({
    type,
    id8: "abcdef12",
    span: [n, n] as [number, number],
    members,
    text: `L${n}:`.padEnd(40, "x"),
  });
  const fat = (n: number, chars: number, type: "record" | "raw" = "record") => ({
    ...line(n, type),
    text: "z".repeat(chars),
  });

  async function search(args: Record<string, unknown>, result: Record<string, unknown>) {
    const { server, tools } = fakeServer();
    registerMemoryTools(server, USER, null, toolResult, getFreshnessCached);
    mockMemorySearch.mockResolvedValueOnce({ records: [], ...result });
    const tool = tools.find((t) => t.name === "memory_search")!;
    const res = (await tool.handler({ query: "q", ...args })) as { content: { text: string }[] };
    return { data: JSON.parse(res.content[0].text), tools };
  }

  beforeEach(() => {
    mockMemorySearch.mockReset();
    mockLogSearchRecall.mockReset();
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("local: returns the lines joined by newline, served_tokens and the metadata, with no records array", async () => {
    const lines = [line(1), line(2, "raw", ["unit-9"]), line(3)];
    const { data } = await search(
      {},
      { served: lines, degraded: "SEARCH DEGRADED: x", stale_blockers_hidden: 2, date_hint: { phrase: "yesterday" } },
    );
    const joined = lines.map((l) => l.text).join("\n");
    expect(data.served).toBe(joined);
    expect(data.served_tokens).toBe(Math.ceil(joined.length / 4));
    expect(data).not.toHaveProperty("records");
    expect(data).not.toHaveProperty("raw_reason");
    expect(data).not.toHaveProperty("dropped_for_budget");
    expect(data.degraded).toBe("SEARCH DEGRADED: x");
    expect(data.stale_blockers_hidden).toBe(2);
    expect(data.date_hint).toEqual({ phrase: "yesterday" });
    // The recall event logs record members only; raw unit ids are not record ids.
    expect(mockLogSearchRecall.mock.calls[0][2]).toMatchObject({ query: "q", recordIds: ["m1", "m3"] });
  });

  it("the caller's max_tokens is a packing budget: whole lines, and packing stops at the first line that does not fit", async () => {
    // 400 chars = 100 tokens; 400 + "\n" + 600 = 1001 chars = 251 tokens > 200; the 4-char line after it would fit but is not tried.
    const lines = [fat(1, 400), fat(2, 600), fat(3, 4, "raw")];
    const { data } = await search({ max_tokens: 200 }, { served: lines });
    expect(data.served).toBe(lines[0].text);
    expect(data.served_tokens).toBe(100);
    expect(mockLogSearchRecall.mock.calls[0][2].recordIds).toEqual(["m1"]);
    // memorySearch is not handed the budget: it returns the lines, this tool packs them once.
    expect(mockMemorySearch.mock.calls[0][3]).toEqual({ query: "q" });
  });

  it("defaults to 3000 tokens: six 1999-char lines (3000 tokens joined) fit, the seventh does not", async () => {
    const lines = Array.from({ length: 7 }, (_, i) => fat(i + 1, 1999));
    const { data } = await search({}, { served: lines });
    expect(data.served.split("\n")).toHaveLength(6);
    expect(data.served_tokens).toBe(3000);
  });

  it("an empty served on a local run with no raw_reason falls back to the records shape", async () => {
    const { data } = await search({}, { served: [], reason: "No memory records match", empty_reason: "no_match" });
    expect(data.records).toEqual([]);
    expect(data).not.toHaveProperty("served");
    expect(data.reason).toBe("No memory records match");
  });

  it("raw unavailable (raw_reason set): the records shape, with raw_reason so the agent can see why", async () => {
    const { data } = await search(
      {},
      { served: [line(1)], raw_reason: "no calibrated raw-unit floors for this embedding model" },
    );
    expect(data.records).toEqual([]);
    expect(data.raw_reason).toBe("no calibrated raw-unit floors for this embedding model");
    expect(data).not.toHaveProperty("served");
    expect(data).not.toHaveProperty("served_tokens");
    expect(data.stale_blockers_hidden).toBe(0);
  });

  it("hosted: the records shape as before, no raw_reason, even though memorySearch returned record lines", async () => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
    const { data } = await search({}, { served: [line(1)] });
    expect(data.records).toEqual([]);
    expect(data).not.toHaveProperty("served");
    expect(data).not.toHaveProperty("raw_reason");
  });

  it("max_tokens is clamped 200..20000 by the input schema, and the description states the 3000 default", async () => {
    const { tools } = await search({}, { served: [line(1)] });
    const tool = tools.find((t) => t.name === "memory_search")!;
    // biome-ignore lint/suspicious/noExplicitAny: zod shape behind the file's `as any`
    const schema = (tool.config.inputSchema as any).max_tokens;
    expect(schema.safeParse(199).success).toBe(false);
    expect(schema.safeParse(200).success).toBe(true);
    expect(schema.safeParse(20_000).success).toBe(true);
    expect(schema.safeParse(20_001).success).toBe(false);
    expect(schema.description).toContain("default 3000");
    expect(tool.config.description).toContain("default 3000");
    expect(tool.config.description).toContain("raw excerpt");
  });
});
