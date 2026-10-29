// Box 2.4: get_code_session wiring of the handoff block (flag off is unchanged, first page only, turn= unaffected, budget).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCodeSession = vi.fn();
const mockLoad = vi.fn();

vi.mock("@/lib/mcp/code-tools", () => ({
  listCodeProjects: vi.fn(),
  getCodeProject: vi.fn(),
  getCodeSession: (...args: unknown[]) => mockGetCodeSession(...args),
  getCodeContextFor: vi.fn(),
}));
vi.mock("@/lib/mcp/resolve-session-id", () => ({
  resolveSessionId: vi.fn(async (_db: unknown, _u: string, id: string) => ({ ok: true, id })),
}));
vi.mock("@/lib/freshness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/freshness")>();
  return { ...actual, getFreshnessForUser: vi.fn(async () => null) };
});
vi.mock("@/lib/mcp/not-in-handoff-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/not-in-handoff-view")>();
  return { ...actual, loadNotInHandoffSection: (...a: unknown[]) => mockLoad(...a) };
});
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ from: vi.fn() })) }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.MEMBRAL_MCP_EXTENDED_TOOLS = "1";

import { createCloudMcpServer } from "../server";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const call = (args: Record<string, unknown>) => {
  const reg = (createCloudMcpServer("user-123") as unknown as Record<string, Record<string, { handler: Handler }>>)[
    "_registeredTools"
  ];
  return reg["get_code_session"].handler(args);
};
const session = () => ({
  id: "s1",
  turns: Array.from({ length: 30 }, (_, i) => ({ idx: i, role: "user", text: `turn ${i} ${"x".repeat(100)}` })),
});
const SECTION = { handoff: { label: "l", text: "n", written_at: "t" }, uncovered_records: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCodeSession.mockImplementation(async () => session());
});
afterEach(() => vi.unstubAllEnvs());

describe("get_code_session: handoff block wiring", () => {
  it("first page of a whole-session read carries the section", async () => {
    mockLoad.mockResolvedValue(SECTION);
    const out = JSON.parse((await call({ id: "s1" })).content[0].text.replace(/^[^{]*/, ""));
    expect(out.handoff).toEqual(SECTION.handoff);
    expect(mockLoad).toHaveBeenCalledWith(expect.anything(), "user-123", "s1", expect.any(Number));
  });

  it("flag off (loader returns null): the output has neither key", async () => {
    mockLoad.mockResolvedValue(null);
    const out = JSON.parse((await call({ id: "s1" })).content[0].text.replace(/^[^{]*/, ""));
    expect(out).not.toHaveProperty("handoff");
    expect(out).not.toHaveProperty("uncovered_records");
  });

  it("turn= focus reads never load or carry the section", async () => {
    mockLoad.mockResolvedValue(SECTION);
    const out = JSON.parse((await call({ id: "s1", turn: 3 })).content[0].text.replace(/^[^{]*/, ""));
    expect(mockLoad).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty("handoff");
  });

  it("a later part (start > 0) gets no section", async () => {
    mockLoad.mockResolvedValue(SECTION);
    const out = JSON.parse((await call({ id: "s1", start: 5 })).content[0].text.replace(/^[^{]*/, ""));
    expect(mockLoad).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty("handoff");
  });

  it("passes half of max_chars (capped at 6000) as the section budget", async () => {
    mockLoad.mockResolvedValue(null);
    await call({ id: "s1", max_chars: 8000 });
    expect(mockLoad.mock.calls[0][3]).toBe(4000);
    mockLoad.mockClear();
    await call({ id: "s1" });
    expect(mockLoad.mock.calls[0][3]).toBe(6000);
  });
});
