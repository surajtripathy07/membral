// #361: importCodeSession runs the recall-influence reconciliation after the
// turns land, and a reconciliation failure never fails the import.
import { FakeSupabase } from "@membral/test-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain function, not vi.fn(): the failure case must reject from the code
// under test only, so nothing but import.ts's own catch can observe it.
const calls: unknown[][] = [];
// Snapshot of the DB as the reconciliation sees it, to prove call order.
let seenAtCall: { turns: number; contentHash: unknown; sessionCount: unknown } | null = null;
let currentDb: FakeSupabase | null = null;
let reconcileImpl: () => Promise<unknown> = async () => ({ checked: 0, influencedQuote: 0, influencedEdit: 0 });
// #436: the import also runs memory_resolve verification; it reads the influence module's windows, mocked away here.
vi.mock("@/lib/memory/agent-resolve", () => ({ verifyAgentResolutions: async () => ({ verified: [] }) }));
vi.mock("@/lib/memory/influence", () => ({
  reconcileRecallInfluence: (...args: unknown[]) => {
    calls.push(args);
    if (currentDb) {
      seenAtCall = {
        turns: currentDb.getRows("code_session_turns").length,
        contentHash: currentDb.getRows("code_sessions")[0]?.content_hash,
        sessionCount: currentDb.getRows("code_projects")[0]?.session_count,
      };
    }
    return reconcileImpl();
  },
}));

import { importCodeSession } from "../import";
import type { RawCodeSessionPayload } from "../payload";

const USER_ID = "user-1";

function makeSession(): RawCodeSessionPayload {
  return {
    source: "claude-code",
    sourceSessionId: "session-abc",
    contentHash: "hash-v1",
    repo: { path: "/Users/dev/webapp", remoteUrl: "https://github.com/acme/webapp.git", branch: "main" },
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:05:00.000Z",
    model: "claude-code-sonnet",
    turns: [{ idx: 0, role: "user", kind: "prose", text: "Add a login button", ts: "2026-07-01T10:00:00.000Z" }],
    filesTouched: [],
    toolCounts: {},
  };
}

describe("importCodeSession + recall influence", () => {
  beforeEach(() => {
    calls.length = 0;
    seenAtCall = null;
    currentDb = null;
    reconcileImpl = async () => ({ checked: 0, influencedQuote: 0, influencedEdit: 0 });
  });

  it("calls the reconciliation with the imported session id, after turns, content hash and project bump", async () => {
    const db = new FakeSupabase();
    currentDb = db;
    const result = await importCodeSession(db.asClient(), USER_ID, makeSession());
    expect(result.status).toBe("imported");
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(1, 3)).toEqual([USER_ID, result.sessionId]);
    // the import hands over the turns it already holds, so reconcile need not re-read them
    expect(Array.isArray(calls[0][3])).toBe(true);
    // replaceTurns, finalizeContentHash and bumpCodeProject all ran first.
    expect(seenAtCall).toEqual({ turns: 1, contentHash: "hash-v1", sessionCount: 1 });
  });

  it("a reconciliation error is swallowed: the import still succeeds", async () => {
    reconcileImpl = async () => {
      throw new Error("events lookup failed");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = new FakeSupabase();
    const result = await importCodeSession(db.asClient(), USER_ID, makeSession());
    expect(result.status).toBe("imported");
    expect(calls).toHaveLength(1);
    expect(db.getRows("code_sessions")[0].content_hash).toBe("hash-v1");
    expect(db.getRows("code_session_turns")).toHaveLength(1);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("recall influence reconciliation failed");
    warn.mockRestore();
  });
});
