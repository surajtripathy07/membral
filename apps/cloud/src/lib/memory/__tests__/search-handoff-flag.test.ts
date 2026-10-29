// MEMBRAL_HANDOFF_SEARCH (off by default): handoff notes join the default kinds of memory_search, memory_recall and
// prompt recall, are embedded at write time, served truncated, and backfilled. No network, no paid API.

import { createFakeDb, type Row } from "@membral/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handoffSearchEnabled } from "@/lib/env";
import type { LlmClient } from "@/lib/llm/client";
import { compactServedRecord, HANDOFF_SERVED_MAX_CHARS, truncateHandoffText } from "@/lib/mcp/served-record-view";
import { backfillHandoffEmbeddings, parseArgs } from "../../../../scripts/memory/backfill-handoff-embeddings";
import { memoryRecallWithStats } from "../recall";
import { embedHandoffNote, HANDOFF_EMBED_MAX_CHARS } from "../session-handoff-embed";
import { fitToTokenBudget } from "../token-budget";
import type { ServedRecord } from "../verify";

const USER = "u1";

afterEach(() => {
  vi.unstubAllEnvs();
});

function llmWith(embedMany: () => Promise<unknown>): LlmClient {
  return { embedMany } as never as LlmClient;
}
const okEmbed = () => vi.fn(async () => ({ vectors: [[0.1, 0.2, 0.3]], record: { cost_usd: 0 } }));

function noteRow(over: Row = {}): Row {
  return {
    id: "h1",
    user_id: USER,
    kind: "handoff",
    text: "Next: wire the cache",
    retired_at: null,
    embedding: null,
    created_at: "2026-10-25T00:00:00Z",
    ...over,
  };
}

describe("flag", () => {
  it("is off by default and on for 1/true", () => {
    expect(handoffSearchEnabled()).toBe(false);
    vi.stubEnv("MEMBRAL_HANDOFF_SEARCH", "true");
    expect(handoffSearchEnabled()).toBe(true);
    vi.stubEnv("MEMBRAL_HANDOFF_SEARCH", "0");
    expect(handoffSearchEnabled()).toBe(false);
  });
});

describe("memory_recall default kinds", () => {
  async function kindsRead(): Promise<string[]> {
    const db = createFakeDb({ flavour: "db", tables: { session_memories: [] } });
    const inSpy = vi.fn();
    const orig = db.client.from.bind(db.client);
    (db.client as { from: unknown }).from = (t: string) => {
      const q = orig(t) as Record<string, unknown>;
      const origIn = q.in as (c: string, v: unknown[]) => unknown;
      q.in = (c: string, v: unknown[]) => {
        if (c === "kind") inSpy(v);
        return origIn.call(q, c, v);
      };
      return q;
    };
    await memoryRecallWithStats(db.client, USER, null, {});
    return (inSpy.mock.calls[0]?.[0] as string[]) ?? [];
  }
  it("both flags off: no kind filter at all, as on main", async () => {
    expect(await kindsRead()).toEqual([]);
  });
  it("synthesis on, search off: an explicit list without handoff", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    const kinds = await kindsRead();
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain("handoff");
  });
  it("flag on: the default list includes handoff", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SEARCH", "1");
    expect(await kindsRead()).toContain("handoff");
  });
});

describe("served handoff note", () => {
  const base = {
    id: "h1",
    kind: "handoff",
    text: "x".repeat(3000),
    session_id: "s1",
    turn_idx: 4,
    when: "2026-10-25T10:00:00Z",
    durable: false,
    verified: false,
    confidence: 1,
  } as unknown as ServedRecord;
  it("is cut to the cap, keeps kind and session_id", () => {
    const out = compactServedRecord(base);
    expect(out.kind).toBe("handoff");
    expect(out.session_id).toBe("s1");
    expect(out.text.startsWith("x".repeat(HANDOFF_SERVED_MAX_CHARS))).toBe(true);
    expect(out.text.length).toBeLessThan(HANDOFF_SERVED_MAX_CHARS + 120);
    expect(out.text).toContain("get_code_session");
  });
  it("memory_get opens the note whole (wholeHandoff)", () => {
    const out = compactServedRecord(base, undefined, undefined, Date.now(), true);
    expect(out.text).toHaveLength(3000);
    expect(out.text).not.toContain("truncated");
  });
  it("leaves a short note and every other kind untouched", () => {
    expect(truncateHandoffText("short")).toBe("short");
    expect(compactServedRecord({ ...base, kind: "decision" } as ServedRecord).text).toHaveLength(3000);
  });
});

describe("handoff slot and max_tokens", () => {
  it("a served note counts against the budget at its truncated size, and a tight budget still fits the atoms first", () => {
    const note = compactServedRecord({
      id: "h1",
      kind: "handoff",
      text: "z".repeat(5000),
      session_id: "s1",
      turn_idx: 0,
      when: "2026-10-25T10:00:00Z",
      durable: false,
      verified: false,
      confidence: 1,
    } as unknown as ServedRecord);
    const atom = { id: "a", text: "short fact" };
    const fitted = fitToTokenBudget([atom, note], 400);
    expect(fitted.records.map((r) => r.id)).toContain("h1");
    expect(fitted.tokens).toBeLessThanOrEqual(400);
    const tight = fitToTokenBudget([atom, note], 20);
    expect(tight.records.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("embedHandoffNote", () => {
  it("stores the vector on the note row", async () => {
    const db = createFakeDb({ flavour: "db", tables: { session_memories: [noteRow()] } });
    const res = await embedHandoffNote(db.client, llmWith(okEmbed()), USER, "h1", "Next: wire the cache");
    expect(res.status).toBe("embedded");
    expect(String(db.getRows("session_memories")[0]?.embedding)).toContain("0.1");
  });
  it("embeds only the first HANDOFF_EMBED_MAX_CHARS", async () => {
    const embedMany = vi.fn(async (_a: { texts: string[] }) => ({ vectors: [[1, 2, 3]], record: { cost_usd: 0 } }));
    const db = createFakeDb({ flavour: "db", tables: { session_memories: [noteRow()] } });
    await embedHandoffNote(
      db.client,
      llmWith(embedMany as never),
      USER,
      "h1",
      "y".repeat(HANDOFF_EMBED_MAX_CHARS + 500),
    );
    expect(embedMany.mock.calls[0]?.[0].texts[0]).toHaveLength(HANDOFF_EMBED_MAX_CHARS);
  });
  it("embeddings down: stores null and does not throw", async () => {
    const db = createFakeDb({ flavour: "db", tables: { session_memories: [noteRow()] } });
    const res = await embedHandoffNote(
      db.client,
      llmWith(async () => {
        throw new Error("down");
      }),
      USER,
      "h1",
      "text",
    );
    expect(res.status).toBe("no_vector");
    expect(db.getRows("session_memories")[0]?.embedding).toBeNull();
  });
  it("an empty note is skipped without a call", async () => {
    const embedMany = okEmbed();
    const db = createFakeDb({ flavour: "db", tables: { session_memories: [noteRow()] } });
    expect((await embedHandoffNote(db.client, llmWith(embedMany), USER, "h1", "  ")).status).toBe("skipped_empty");
    expect(embedMany).not.toHaveBeenCalled();
  });
});

describe("backfill", () => {
  it("parses args", () => {
    expect(parseArgs(["--user", "u1", "--dry-run", "--limit", "5"])).toEqual({ userId: "u1", dryRun: true, limit: 5 });
    expect(() => parseArgs([])).toThrow();
  });
  it("dry run counts un-embedded live notes and writes nothing", async () => {
    const db = createFakeDb({
      flavour: "db",
      tables: {
        session_memories: [
          noteRow(),
          noteRow({ id: "h2" }),
          noteRow({ id: "h3", embedding: "[1]" }),
          noteRow({ id: "h4", retired_at: "x" }),
        ],
      },
    });
    const s = await backfillHandoffEmbeddings(db.client, null, { userId: USER, dryRun: true, limit: undefined });
    expect(s).toEqual({ found: 2, embedded: 0, failed: 0 });
    expect(db.getRows("session_memories").filter((r) => r.embedding === null)).toHaveLength(3);
  });
  it("a real run embeds and is idempotent", async () => {
    const db = createFakeDb({ flavour: "db", tables: { session_memories: [noteRow(), noteRow({ id: "h2" })] } });
    const args = { userId: USER, dryRun: false, limit: undefined };
    expect(await backfillHandoffEmbeddings(db.client, llmWith(okEmbed()), args)).toEqual({
      found: 2,
      embedded: 2,
      failed: 0,
    });
    expect(await backfillHandoffEmbeddings(db.client, llmWith(okEmbed()), args)).toEqual({
      found: 0,
      embedded: 0,
      failed: 0,
    });
  });
});
