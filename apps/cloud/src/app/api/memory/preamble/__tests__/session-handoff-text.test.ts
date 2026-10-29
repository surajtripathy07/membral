// Brief 2.3b: the preamble route's `handoff_text` field. Resume/compact only, behind MEMBRAL_HANDOFF_SYNTHESIS, absent
// (response otherwise byte-identical) when off, on a fresh start, for an area-scoped key or when the session has none.

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
const mockInsert = vi.fn((_row: Record<string, unknown>) => Promise.resolve({ data: null, error: null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ rpc: mockRpc, from: vi.fn(() => ({ insert: mockInsert })) })),
}));
const mockValidateApiKey = vi.fn();
vi.mock("@/lib/api-keys", () => ({ validateApiKey: (...a: unknown[]) => mockValidateApiKey(...a) }));
const mockBuildPreamble = vi.fn();
vi.mock("@/lib/memory/preamble", () => ({ buildPreamble: (...a: unknown[]) => mockBuildPreamble(...a) }));
const mockSelf = vi.fn();
vi.mock("@/lib/memory/prompt-recall", () => ({ buildSessionStartSelfRecall: (...a: unknown[]) => mockSelf(...a) }));
const mockHandoff = vi.fn();
vi.mock("@/lib/memory/session-handoff-serve", () => ({ loadServedHandoff: (...a: unknown[]) => mockHandoff(...a) }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET } from "../route";

const served = { lines: ["preamble"], recall_token: "tok", open_blockers: [], record_ids: ["rec-a"] };
const HEADERS = { authorization: "Bearer lls_good", accept: "application/json" };
// The CLI sends `handoff=1` when it renders handoff_text; `capable: false` is an older CLI.
const get = (qs: string, capable = true) =>
  GET(
    new NextRequest(`http://localhost:3001/api/memory/preamble?repo=x&${qs}${capable ? "&handoff=1" : ""}`, {
      headers: HEADERS,
    }),
  );

describe("preamble handoff_text", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeCodeProjectId: null });
    mockBuildPreamble.mockResolvedValue(served);
    mockSelf.mockResolvedValue({ lines: ["self"], record_ids: ["self-1"] });
    mockHandoff.mockResolvedValue({ text: "HEADER\nNote", id: "note-1", truncated: false });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("resume and compact return handoff_text and log the note id; the source picks the budget", async () => {
    const res = await get("session=s1&self=resume");
    expect(await res.json()).toMatchObject({ self_lines: ["self"], handoff_text: "HEADER\nNote" });
    expect(mockHandoff).toHaveBeenLastCalledWith(
      expect.anything(),
      "user-1",
      null,
      { sourceSessionId: "s1", harness: "claude-code" },
      "resume",
    );
    expect(mockInsert.mock.calls[0][0].record_ids).toEqual(["rec-a", "self-1", "note-1"]);
    await get("session=s1&self=compact");
    expect(mockHandoff.mock.lastCall?.[4]).toBe("compact");
  });

  it("capability gate: a request without handoff=1 (an older CLI) gets no field, no lookup and no logged note id", async () => {
    const body = await (await get("session=s1&self=resume", false)).json();
    expect(body).not.toHaveProperty("handoff_text");
    expect(mockHandoff).not.toHaveBeenCalled();
    expect(mockInsert.mock.calls[0][0].record_ids).toEqual(["rec-a", "self-1"]);
  });

  it("a fresh session (no self=, or self=startup) gets no note and no lookup", async () => {
    for (const qs of ["session=s1", "session=s1&self=startup", "self=resume"]) {
      const body = await (await get(qs)).json();
      expect(body).not.toHaveProperty("handoff_text");
    }
    expect(mockHandoff).not.toHaveBeenCalled();
  });

  it("flag off: no lookup, and the response is byte-identical to one for a session that has no note", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "");
    const off = await (await get("session=s1&self=resume")).text();
    expect(mockHandoff).not.toHaveBeenCalled();
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    mockHandoff.mockResolvedValue(null);
    const none = await (await get("session=s1&self=resume")).text();
    expect(off).toBe(none);
    expect(off).not.toContain("handoff_text");
  });

  it("an area-scoped key gets none and does no lookup", async () => {
    mockValidateApiKey.mockResolvedValue({
      valid: true,
      userId: "user-1",
      scopeCodeProjectId: null,
      scopeNodeId: "n1",
    });
    expect(await (await get("session=s1&self=resume")).json()).not.toHaveProperty("handoff_text");
    expect(mockHandoff).not.toHaveBeenCalled();
  });

  it("passes a code-project-scoped key's project to the lookup", async () => {
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeCodeProjectId: "p1" });
    await get("session=s1&self=resume");
    expect(mockHandoff.mock.lastCall?.[2]).toBe("p1");
  });
});
