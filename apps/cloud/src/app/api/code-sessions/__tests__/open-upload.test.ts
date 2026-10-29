// Goal 2026-10-25 box 2.1, server half: an upload from a STILL-OPEN session (the Stop hook sends `open: true`)
// stores turns and raw units but queues no paid extraction; the closing upload of the same content then queues it.
//
// LEVEL: route + importCodeSession for real, over the in-memory FakeSupabase (a JS twin of the tables and of the
// raw-unit replace rpc) with a deterministic embedder. NOT a live Postgres, and no memory_search call: searchability
// is asserted at the data level (session_raw_units rows carry the open session's text). The extraction queue and
// trigger are mocked and asserted not to be called.
import { FakeSupabase } from "@membral/test-kit";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEmbedder, withUnitsRpc } from "@/lib/memory/raw-units/__tests__/helpers";

const capturedAfter: Array<() => unknown> = [];
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (cb: (() => unknown) | Promise<unknown>) => {
      capturedAfter.push(typeof cb === "function" ? cb : () => cb);
    },
  };
});
async function flushAfter(): Promise<void> {
  while (capturedAfter.length > 0) await capturedAfter.shift()?.();
}

let units = withUnitsRpc(new FakeSupabase());
let db = units.db;

vi.mock("@/lib/code-sessions/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-sessions/auth")>()),
  // biome-ignore lint/suspicious/noExplicitAny: fake client
  getCodeSessionsServiceClient: () => units.client as any,
}));
vi.mock("@/lib/api-keys", () => ({
  validateApiKey: async () => ({ valid: true, userId: "user-1", scopeNodeId: null, scopeCodeProjectId: null }),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  enforceRateLimit: async () => ({ allowed: true, retryAfter: 0, remaining: 99 }),
}));
vi.mock("@/lib/sync-heartbeat", () => ({ recordCodeHeartbeat: async () => {} }));
vi.mock("@/lib/memory/agent-resolve", () => ({ verifyAgentResolutions: async () => ({ verified: [] }) }));
vi.mock("@/lib/memory/influence", () => ({
  reconcileRecallInfluence: async () => ({ checked: 0, influencedQuote: 0, influencedEdit: 0 }),
}));
vi.mock("@/lib/code-sessions/mirror-conversations", () => ({
  mirrorCodeSessionsToConversations: async () => ({ errors: [], skippedQuota: 0 }),
}));
const mockSynthesize = vi.fn(async () => {});
vi.mock("@/lib/code-sessions/synthesize", () => ({ synthesizeCodeDimensionForUser: () => mockSynthesize() }));
vi.mock("@/lib/llm/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/config")>()),
  chatConfigured: () => true,
}));
// Real import, but with raw units on and a deterministic embedder (the route only passes a scheduler).
vi.mock("@/lib/code-sessions/import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/code-sessions/import")>();
  return {
    ...actual,
    importCodeSession: (...a: Parameters<typeof actual.importCodeSession>) =>
      actual.importCodeSession(a[0], a[1], a[2], a[3], {
        ...a[4],
        rawUnits: { enabled: true, embedder: fakeEmbedder() },
      }),
  };
});
const mockEnqueue = vi.fn(async () => 1);
vi.mock("@/lib/memory/extraction-queue", () => ({
  enqueueMemoryExtraction: (...a: unknown[]) => mockEnqueue(...(a as [])),
  MEMORY_QUEUE_TABLE: "memory_extraction_queue",
}));
const mockTrigger = vi.fn(async () => true);
vi.mock("@/lib/memory/extraction-trigger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/extraction-trigger")>()),
  triggerMemoryExtraction: () => mockTrigger(),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.MEMBRAL_LOCAL = "0";

import { POST } from "../route";

const TS = "2026-07-01T10:00:00.000Z";
const turn = (idx: number, text: string) => ({
  idx,
  role: idx % 2 ? "assistant" : "user",
  kind: "prose",
  text,
  ts: TS,
});
function session(hash: string, texts: string[]) {
  return {
    source: "claude-code",
    sourceSessionId: "open-session-1",
    contentHash: hash,
    repo: { path: "/Users/dev/webapp", remoteUrl: "https://github.com/acme/webapp.git", branch: "main" },
    startedAt: TS,
    endedAt: TS,
    turns: texts.map((t, i) => turn(i, t)),
    filesTouched: [],
    toolCounts: {},
  };
}
async function post(body: unknown) {
  const res = await POST(
    new NextRequest("http://localhost:3000/api/code-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer lls_ok" },
      body: JSON.stringify(body),
    }),
  );
  await flushAfter();
  return {
    status: res.status,
    json: (await res.json()) as { imported: number; skipped: number; open_supported?: boolean },
  };
}
const sessions = () => db.getRows("code_sessions");
const turns = () => db.getRows("code_session_turns");
const rawText = () =>
  units
    .rows()
    .map((r) => String(r.text ?? ""))
    .join("\n");

describe("open-session upload (Stop hook) over the real route + import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedAfter.length = 0;
    units = withUnitsRpc(new FakeSupabase());
    db = units.db;
  });

  const SHORT = ["we pinned the retry budget at 3 attempts", "agreed, 3 attempts with jitter"];
  const LONG = [...SHORT, "then we found the outage cause: expired lease"];

  it("stores turns and raw units, but queues no extraction and runs no synthesis", async () => {
    const r = await post({ sessions: [session("h-short", SHORT)], open: true });
    expect(r.status).toBe(200);
    expect(r.json.imported).toBe(1);
    expect(turns()).toHaveLength(2);
    expect(rawText()).toContain("retry budget at 3 attempts"); // searchable data without any SessionEnd
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("a later, longer open upload replaces the turns and units rather than duplicating them", async () => {
    await post({ sessions: [session("h-short", SHORT)], open: true });
    await post({ sessions: [session("h-long", LONG)], open: true });
    expect(sessions()).toHaveLength(1);
    expect(sessions()[0].turn_count).toBe(3);
    expect(turns()).toHaveLength(3);
    expect(rawText()).toContain("expired lease");
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("an identical open re-upload is skipped", async () => {
    await post({ sessions: [session("h-short", SHORT)], open: true });
    const r = await post({ sessions: [session("h-short", SHORT)], open: true });
    expect(r.json).toMatchObject({ imported: 0, skipped: 1 });
  });

  it("the closing (non-open) upload of IDENTICAL content is not skipped: it re-imports once and queues extraction", async () => {
    await post({ sessions: [session("h-long", LONG)], open: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
    const r = await post({ sessions: [session("h-long", LONG)] }); // SessionEnd / sweep, same hash
    expect(r.json).toMatchObject({ imported: 1, skipped: 0 });
    expect(turns()).toHaveLength(3); // replaced, not duplicated
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0]).toEqual([expect.anything(), "user-1", { requeue: [sessions()[0].id] }]);
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    // The stamp is cleared, so a further identical upload short-circuits as before.
    const again = await post({ sessions: [session("h-long", LONG)] });
    expect(again.json).toMatchObject({ imported: 0, skipped: 1 });
  });

  it("an out-of-order older open upload is a no-op: turns kept, stamp untouched", async () => {
    await post({ sessions: [session("h-long", LONG)], open: true });
    const r = await post({ sessions: [session("h-short", SHORT)], open: true }); // delayed, fewer turns
    expect(r.json).toMatchObject({ imported: 0, skipped: 1 });
    expect(turns()).toHaveLength(3);
    expect(sessions()[0].turn_count).toBe(3);
    expect(sessions()[0].content_hash).toBe("h-long");
    expect(sessions()[0].props).toMatchObject({ open_upload: true });
  });

  it("a delayed NON-open upload with fewer turns than an open row is a no-op: newer turns kept, stamp kept, nothing queued", async () => {
    await post({ sessions: [session("h-long", LONG)], open: true });
    const r = await post({ sessions: [session("h-short", SHORT)] }); // slow SessionEnd / sweep child, older snapshot
    expect(r.json).toMatchObject({ imported: 0, skipped: 1 });
    expect(turns()).toHaveLength(3);
    expect(sessions()[0].content_hash).toBe("h-long");
    expect(sessions()[0].props).toMatchObject({ open_upload: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("a NON-open upload with MORE turns than an open row still re-imports and queues extraction", async () => {
    await post({ sessions: [session("h-short", SHORT)], open: true });
    const r = await post({ sessions: [session("h-long", LONG)] });
    expect(r.json).toMatchObject({ imported: 1, skipped: 0 });
    expect(turns()).toHaveLength(3);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("the response carries open_supported: true (the ack a legacy server cannot give)", async () => {
    const r = await post({ sessions: [session("h-short", SHORT)], open: true });
    expect(r.json).toMatchObject({ open_supported: true });
  });

  it("an open upload with EQUAL turns and a different hash after a closed import is skipped and does not stamp", async () => {
    await post({ sessions: [session("h-closed", LONG)] });
    const r = await post({ sessions: [session("h-other", LONG)], open: true });
    expect(r.json).toMatchObject({ imported: 0, skipped: 1 });
    expect(sessions()[0].content_hash).toBe("h-closed");
    expect((sessions()[0].props as Record<string, unknown>).open_upload).not.toBe(true);
  });

  it("open-to-open with equal turns and a changed hash still refreshes", async () => {
    await post({ sessions: [session("h-a", LONG)], open: true });
    const r = await post({ sessions: [session("h-b", LONG)], open: true });
    expect(r.json).toMatchObject({ imported: 1 });
    expect(sessions()[0].content_hash).toBe("h-b");
  });

  it("props after: an open import stamps open_upload=true; a non-open import clears it (twin of migration 109 patch)", async () => {
    await post({ sessions: [session("h-long", LONG)], open: true });
    expect(sessions()[0].props).toMatchObject({ open_upload: true });
    await post({ sessions: [session("h-long", LONG)] });
    expect(sessions()[0].props).toMatchObject({ open_upload: false });
    expect((sessions()[0].props as Record<string, unknown>).open_upload).not.toBe(true);
  });

  it("a plain (never open) upload still queues extraction as before", async () => {
    await post({ sessions: [session("h-long", LONG)] });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-boolean open", async () => {
    const r = await post({ sessions: [session("h", SHORT)], open: "yes" });
    expect(r.status).toBe(400);
  });
});
