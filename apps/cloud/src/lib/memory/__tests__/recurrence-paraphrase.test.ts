// e2e A-B4: one wall ("the FX-rates fixture download hangs npm test") said
// three different ways in three sessions must become ONE recurrence chain,
// and the preamble must show it as ONE line with "(seen 3× in this
// project)", first among blockers. Texts and quotes are the real extracted
// rows from the e2e run; the embeddings are 5-d vectors whose pairwise
// cosines equal the real text-embedding-3-small cosines of those rows
// (0.650 / 0.660 / 0.642 / 0.809 / 0.717 / 0.843). Sessions are extracted
// in the order the e2e run did: newest session first.
// Prompt v12: below the 0.80 cosine band the link is the extraction call's own
// in-context `recurs_of` on an offered open blocker (modelled here as the
// `recursOfHint` the call's validated answer becomes) — never a word list.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import {
  dropCrossSessionDuplicates,
  fetchOpenBlockersForRecurrence,
  type InsertableRecord,
  insertMemoryRecords,
} from "@/lib/memory/write";
import { renderOpenBlockersBlock, resolveRecursOf } from "../extract";
import { collapseRecurrenceChains } from "../preamble";

const V = {
  timeout: [1, 0, 0, 0, 0],
  stuck: [0.65, 0.759934, 0, 0, 0],
  hangs: [0.66, 0.500043, 0.560675, 0, 0],
  causes: [0.642, 0.394376, 0.396085, 0.524805, 0],
  gateway: [0, 0, 0, 0, 1],
};

const rec = (
  contentHash: string,
  text: string,
  quote: string,
  embedding: number[],
  recursOfHint?: string,
): InsertableRecord =>
  ({
    ...(recursOfHint ? { recursOfHint } : {}),
    kind: "blocker",
    text,
    quote,
    turn_idx: 0,
    turn_role: "user",
    ref: null,
    ref_kind: null,
    thread: null,
    paths: [],
    verified: true,
    durable: true,
    scope: "project",
    confidence: 1,
    contentHash,
    embedding,
    windowIndex: 0,
  }) as unknown as InsertableRecord;

async function extract(rows: Record<string, Row[]>, sessionId: string, createdAt: string, records: InsertableRecord[]) {
  const supabase = makeFakeSupabase(rows);
  const { kept } = await dropCrossSessionDuplicates(supabase, "u1", "p1", sessionId, records);
  const before = new Set(rows.session_memories.map((r) => r.id));
  await insertMemoryRecords(supabase, "u1", "p1", sessionId, "main", kept);
  for (const r of rows.session_memories) if (!before.has(r.id)) r.created_at = createdAt; // the DB default
}

describe("recurrence across real paraphrases (e2e A-B4)", () => {
  it("three sessions' paraphrases of one blocker form one chain: one preamble line, seen 3×, first", async () => {
    const rows: Record<string, Row[]> = { session_memories: [] };
    // Session −1d, extracted first.
    await extract(rows, "s-1d", "2026-09-26T20:20:46Z", [
      rec(
        "t",
        "FX fixture download timeout in tests is blocking progress",
        "FX fixture download timeout in tests is still blocking",
        V.timeout,
      ),
    ]);
    // The extraction call is offered the open blockers and links each paraphrase.
    const offered = await fetchOpenBlockersForRecurrence(makeFakeSupabase(rows), "u1", "p1", "s-2d", 10);
    expect(offered.map((o) => o.text)).toEqual(["FX fixture download timeout in tests is blocking progress"]);
    const rootId = resolveRecursOf({ kind: "blocker", recurs_of: "b1" }, offered) as string;
    expect(rootId).toBe(rows.session_memories[0].id);
    // Session −2d.
    await extract(rows, "s-2d", "2026-09-26T20:21:02Z", [
      rec(
        "s",
        "The test suite is stuck on downloading the FX-rates fixture.",
        "the test suite is stuck on downloading the FX-rates fixture — this is blocking me",
        V.stuck,
        rootId,
      ),
    ]);
    // Session −3d states the wall twice (two extractor rows, one quote), plus a one-off.
    await extract(rows, "s-3d", "2026-09-26T20:21:12Z", [
      rec(
        "h",
        "npm test hangs on the FX-rates fixture download",
        "npm test hangs on the FX-rates fixture download",
        V.hangs,
        rootId,
      ),
      rec(
        "c",
        "FX-rates fixture download causes npm test to hang.",
        "npm test hangs on the FX-rates fixture download",
        V.causes,
        rootId,
      ),
    ]);
    await extract(rows, "s-key", "2026-09-26T20:22:00Z", [
      rec(
        "k",
        "The payment-gateway sandbox key in .env.example is expired.",
        "the payment-gateway sandbox key in .env.example is expired",
        V.gateway,
      ),
    ]);

    const fx = rows.session_memories.filter((r) => /fixture/i.test(r.text as string));
    // The −3d session's second paraphrase is kept as its own row (review N2: never
    // dropped), but it is not a second sighting — the root's count moves once.
    expect(fx.map((r) => r.code_session_id).sort()).toEqual(["s-1d", "s-2d", "s-3d", "s-3d"]);
    const root = fx.find((r) => r.code_session_id === "s-1d");
    expect(root?.recurrence_count).toBe(3);
    expect(fx.filter((r) => r !== root).every((r) => r.recurs_of === root?.id)).toBe(true);

    const live = rows.session_memories.map((r) => ({ ...r, retired_at: null })) as unknown as Parameters<
      typeof collapseRecurrenceChains
    >[0];
    const { rows: collapsed, seen } = collapseRecurrenceChains(live);
    const blockers = collapsed
      .filter((r) => r.kind === "blocker")
      .sort((x, y) => (seen.get(y.id) ?? 1) - (seen.get(x.id) ?? 1));
    expect(blockers).toHaveLength(2);
    expect(blockers[0].text).toMatch(/fixture/i);
    expect(seen.get(blockers[0].id)).toBe(3);
    expect(blockers[1].text).toBe("The payment-gateway sandbox key in .env.example is expired.");
  });

  it("a German paraphrase links through the model's recurs_of, not shared words", async () => {
    const rows: Record<string, Row[]> = { session_memories: [] };
    await extract(rows, "s-en", "2026-09-26T20:00:00Z", [
      rec(
        "en",
        "npm test hangs on the FX-rates fixture download",
        "npm test hangs on the FX-rates fixture download",
        V.timeout,
      ),
    ]);
    const offered = await fetchOpenBlockersForRecurrence(makeFakeSupabase(rows), "u1", "p1", "s-de", 10);
    expect(renderOpenBlockersBlock(offered)).toContain("[b1] npm test hangs on the FX-rates fixture download");
    const hint = resolveRecursOf({ recurs_of: "B1" }, offered);
    await extract(rows, "s-de", "2026-09-26T20:05:00Z", [
      rec(
        "de",
        "Die Testsuite bleibt beim Herunterladen der Wechselkurs-Testdaten hängen.",
        "die Tests hängen immer noch beim Download der Wechselkurs-Daten",
        V.gateway, // cosine 0 to the English row: no embedding link at all
        hint,
      ),
    ]);
    const de = rows.session_memories.find((r) => r.code_session_id === "s-de");
    const en = rows.session_memories.find((r) => r.code_session_id === "s-en");
    expect(de?.recurs_of).toBe(en?.id);
    expect(en?.recurrence_count).toBe(2);
  });

  it("two different unapplied migrations stay apart: the model says no link, cosine 0.666 is below the band", async () => {
    const rows: Record<string, Row[]> = { session_memories: [] };
    const m92 = [1, 0, 0, 0, 0];
    const m83 = [0.666, Math.sqrt(1 - 0.666 ** 2), 0, 0, 0];
    await extract(rows, "s-a", "2026-09-26T20:00:00Z", [
      rec(
        "a",
        "Migration 092 must be applied to the hosted database to enable closing blockers from later sessions.",
        "092 still needs applying on hosted",
        m92,
      ),
    ]);
    const offered = await fetchOpenBlockersForRecurrence(makeFakeSupabase(rows), "u1", "p1", "s-b", 10);
    // The model returned no recurs_of (and an invented label is ignored).
    expect(resolveRecursOf({ kind: "blocker" }, offered)).toBeUndefined();
    expect(resolveRecursOf({ recurs_of: "b7" }, offered)).toBeUndefined();
    expect(resolveRecursOf({ recurs_of: offered[0].id }, offered)).toBeUndefined();
    await extract(rows, "s-b", "2026-09-26T20:05:00Z", [
      rec(
        "b",
        "Migration 083 is unapplied on the hosted database, preventing the expected table count from being accurate.",
        "083 is unapplied on hosted",
        m83,
      ),
    ]);
    expect(rows.session_memories.every((r) => !r.recurs_of)).toBe(true);
  });
});
