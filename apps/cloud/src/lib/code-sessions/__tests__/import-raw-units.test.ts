// I33 PR 2: importCodeSession writes the session's raw units after the turns are stored, heals them on a skipped
// import, and a unit failure never fails the import.
import { FakeSupabase } from "@membral/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRawUnits, computeSourceHash, resetRawUnitsCaches } from "@/lib/memory/raw-units";
import { fakeEmbedder, withUnitsRpc } from "@/lib/memory/raw-units/__tests__/helpers";

vi.mock("@/lib/memory/agent-resolve", () => ({ verifyAgentResolutions: async () => ({ verified: [] }) }));
vi.mock("@/lib/memory/influence", () => ({
  reconcileRecallInfluence: async () => ({ checked: 0, influencedQuote: 0, influencedEdit: 0 }),
}));

import { importCodeSession } from "../import";
import type { RawCodeSessionPayload } from "../payload";

const USER_ID = "user-1";

function session(extra: Partial<RawCodeSessionPayload> = {}): RawCodeSessionPayload {
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
      { idx: 1, role: "assistant", kind: "prose", text: "Added it to the header.", ts: "2026-07-01T10:01:00.000Z" },
    ],
    filesTouched: [],
    toolCounts: {},
    ...extra,
  };
}

const setup = () => {
  const u = withUnitsRpc(new FakeSupabase());
  // biome-ignore lint/suspicious/noExplicitAny: fake client
  const client = u.client as any;
  const opts = () => ({ rawUnits: { enabled: true, embedder: fakeEmbedder() } });
  return { u, client, opts };
};

describe("importCodeSession + raw units", () => {
  // Never let a developer's MEMBRAL_LOCAL / provider keys make these tests reach a real embedder.
  beforeEach(() => {
    resetRawUnitsCaches();
    vi.stubEnv("MEMBRAL_LOCAL", "0");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("MEMBRAL_EMBEDDINGS_BASE_URL", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a scheduler takes the unit work off the response path: nothing embeds until the task runs", async () => {
    const { u, client } = setup();
    const e = fakeEmbedder();
    const tasks: Array<() => Promise<void>> = [];
    const res = await importCodeSession(client, USER_ID, session(), false, {
      rawUnits: { enabled: true, embedder: e },
      deferRawUnits: (t) => tasks.push(t),
    });
    expect(res.status).toBe("imported");
    expect(e.calls).toHaveLength(0);
    expect(u.rows()).toHaveLength(0);
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(u.rows().length).toBeGreaterThan(0);
  });

  it("a deferred task that throws is swallowed, and a scheduler that throws does not fail the import", async () => {
    const { client } = setup();
    const tasks: Array<() => Promise<void>> = [];
    const bad = { generate: 1 };
    const res = await importCodeSession(client, USER_ID, session(), false, {
      // biome-ignore lint/suspicious/noExplicitAny: broken embedder on purpose
      rawUnits: { enabled: true, embedder: bad as any },
      deferRawUnits: (t) => tasks.push(t),
    });
    expect(res.status).toBe("imported");
    await expect(tasks[0]()).resolves.toBeUndefined();
    const res2 = await importCodeSession(
      client,
      USER_ID,
      session({ sourceSessionId: "s2", contentHash: "h2" }),
      false,
      {
        rawUnits: { enabled: true, embedder: fakeEmbedder() },
        deferRawUnits: () => {
          throw new Error("no request scope");
        },
      },
    );
    expect(res2.status).toBe("imported");
  });

  it("writes nothing by default when MEMBRAL_LOCAL is off", async () => {
    const { u, client } = setup();
    await importCodeSession(client, USER_ID, session());
    expect(u.rpcCalls).toHaveLength(0);
  });

  it("writes units after the turns, tied to the final source hash", async () => {
    const { u, client, opts } = setup();
    const s = session();
    const r = await importCodeSession(client, USER_ID, s, false, opts());
    expect(r.status).toBe("imported");
    expect(u.rows()).toHaveLength(buildRawUnits(s.turns).length);
    expect(u.rows()[0].source_hash).toBe(computeSourceHash(s.turns));
  });

  it("does nothing when raw units are disabled (hosted)", async () => {
    const { u, client } = setup();
    await importCodeSession(client, USER_ID, session(), false, { rawUnits: { enabled: false } });
    expect(u.rows()).toHaveLength(0);
    expect(u.rpcCalls).toHaveLength(0);
  });

  it("an unchanged re-import is a no-op for units", async () => {
    const { u, client, opts } = setup();
    await importCodeSession(client, USER_ID, session(), false, opts());
    const before = u.rpcCalls.length;
    const e = fakeEmbedder();
    const r = await importCodeSession(client, USER_ID, session(), false, { rawUnits: { enabled: true, embedder: e } });
    expect(r.status).toBe("skipped");
    expect(e.calls).toHaveLength(0);
    expect(u.rpcCalls).toHaveLength(before);
  });

  it("regenerates when the session changes", async () => {
    const { u, client, opts } = setup();
    await importCodeSession(client, USER_ID, session(), false, opts());
    const grown = session({
      contentHash: "hash-v2",
      turns: [
        ...session().turns,
        { idx: 2, role: "user", kind: "prose", text: "Make it blue", ts: "2026-07-01T10:02:00.000Z" },
      ],
    });
    await importCodeSession(client, USER_ID, grown, false, opts());
    expect(u.rows()).toHaveLength(buildRawUnits(grown.turns).length);
    expect(u.rows().every((r) => r.source_hash === computeSourceHash(grown.turns))).toBe(true);
  });

  it("heals missing units on a skipped import (crash between turns and units)", async () => {
    const { u, client, opts } = setup();
    await importCodeSession(client, USER_ID, session(), false, { rawUnits: { enabled: false } });
    expect(u.rows()).toHaveLength(0);
    const r = await importCodeSession(client, USER_ID, session(), false, opts());
    expect(r.status).toBe("skipped");
    expect(u.rows().length).toBeGreaterThan(0);
  });

  it("import (payload order) and a later sweep (stored rows) agree on the source hash", async () => {
    const { u, client, opts } = setup();
    const s = session();
    s.turns = [...s.turns].reverse();
    await importCodeSession(client, USER_ID, s, false, opts());
    const sessionId = u.db.getRows("code_sessions")[0].id as string;
    const { sweepSessionRawUnits } = await import("@/lib/memory/raw-units");
    const r = await sweepSessionRawUnits(client, USER_ID, sessionId, { embedder: fakeEmbedder() });
    expect(r.status).toBe("current");
  });

  it("a unit failure does not fail the import and the turns stay stored", async () => {
    const { u, client, opts } = setup();
    u.failReplace("boom");
    const r = await importCodeSession(client, USER_ID, session(), false, opts());
    expect(r.status).toBe("imported");
    expect(u.db.getRows("code_session_turns")).toHaveLength(2);
    expect(u.db.getRows("code_sessions")[0].content_hash).toBe("hash-v1");
  });

  it("an embed failure leaves null vectors and still imports", async () => {
    const { u, client } = setup();
    const e = fakeEmbedder();
    e.failing = true;
    const r = await importCodeSession(client, USER_ID, session(), false, { rawUnits: { enabled: true, embedder: e } });
    expect(r.status).toBe("imported");
    expect(u.rows().every((x) => x.embedding === null && x.embedding_failed_at)).toBe(true);
  });
});
