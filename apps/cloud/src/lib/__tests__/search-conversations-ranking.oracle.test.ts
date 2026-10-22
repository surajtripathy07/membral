// TS ORACLE — migration 071 (rev-2)'s search_conversations() ranking rule
// (goal 2026-08-27 D6, #106). Hand-transcribed from the actual SQL text in
// apps/cloud/supabase/migrations/071_search_fts_fix.sql, following the same
// pattern already established for the sibling function in
// lib/mcp/__tests__/search-unified-ranking.oracle.test.ts — these functions
// are NOT called by production code; they exist so the ranking rule has a
// place to be regression-tested without a live Postgres connection. SQL IS
// NORMATIVE: if 071's SQL ever changes this ordering, this file must change
// with it.
//
// REVISION 2 (adversarial round 1, scratchpad/W2_adv_round1.md, finding F4):
// the first version of this file transcribed an RRF (reciprocal rank
// fusion) formula and asserted only properties of RRF itself — none of the
// 6 assertions encoded D6's actual acceptance criterion (top-10 SET
// EQUALITY with a ts_rank-ordered FTS-only truth query), and none of them
// would have failed had the SQL regressed to the 4/10-overlap RRF design
// that round 1 measured as broken. Migration 071 rev-2 replaced RRF with
// STRICT FTS DOMINANCE: `order by fts_hit desc, fts_rank desc, similarity
// desc nulls last, id` — every fts_hit row sorts ahead of every non-hit row,
// ordered by ts_rank (== the truth query's own order) among themselves;
// embedding-only rows only fill leftover slots. This file now encodes THAT
// rule directly, with cases that fail under the old RRF ordering and pass
// under this one (verified by construction below).

import { describe, expect, it } from "vitest";

interface CandidateRow {
  id: string;
  ftsHit: boolean;
  ftsRank: number; // ts_rank score, meaningful only when ftsHit — ignored otherwise
  similarity: number | null; // cosine similarity, null when no embedding supplied
}

/**
 * Transcription of migration 071 rev-2's final `order by fts_hit desc,
 * fts_rank desc, similarity desc nulls last, id` (the WHERE clause's
 * candidate selection — `fts_hit OR similarity > 0.3` — is assumed already
 * applied upstream, matching the SQL's `matches` CTE).
 */
function rankStrictFtsFirst(rows: CandidateRow[], limit: number): CandidateRow[] {
  return [...rows]
    .sort((a, b) => {
      if (a.ftsHit !== b.ftsHit) return a.ftsHit ? -1 : 1;
      if (a.ftsHit && b.ftsHit && a.ftsRank !== b.ftsRank) return b.ftsRank - a.ftsRank;
      const aSim = a.similarity ?? -Infinity;
      const bSim = b.similarity ?? -Infinity;
      if (aSim !== bSim) return bSim - aSim;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limit);
}

describe("SQL ORACLE — search_conversations strict FTS-first ordering (migration 071 rev-2, D6/#106)", () => {
  it("D6 ACCEPTANCE CRITERION: 12 FTS-only rows + 5 cosine-only rows (all cosine scores HIGHER than every fts_rank) -> top-10 is EXACTLY the FTS top-10 by ts_rank, as a SET", () => {
    // Cosine-only rows all score 0.9-0.99 (would dominate under the old RRF
    // /pure-cosine designs); FTS-only rows score 0.05-0.4 on ts_rank, i.e.
    // deliberately the LOSING side on raw magnitude — exactly the shape
    // that broke rev-1 (RRF) and 014 (pure cosine).
    const ftsRows: CandidateRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `fts-${i}`,
      ftsHit: true,
      ftsRank: 0.4 - i * 0.03, // strictly decreasing -> fts-0 is the true #1
      similarity: null,
    }));
    const cosineNoise: CandidateRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `cosine-${i}`,
      ftsHit: false,
      ftsRank: 0,
      similarity: 0.99 - i * 0.01,
    }));

    const top10 = rankStrictFtsFirst([...ftsRows, ...cosineNoise], 10);
    const truthTop10 = ftsRows
      .slice()
      .sort((a, b) => b.ftsRank - a.ftsRank)
      .slice(0, 10)
      .map((r) => r.id);

    expect(new Set(top10.map((r) => r.id))).toEqual(new Set(truthTop10));
    // Order within the FTS group must ALSO match ts_rank exactly (not just
    // the set) — D6 additionally requires this for the FTS-hit group.
    expect(top10.map((r) => r.id)).toEqual(truthTop10);
    // No cosine-only row leaked into the top 10 despite every one of them
    // outscoring every FTS row on raw magnitude.
    expect(top10.every((r) => r.ftsHit)).toBe(true);
  });

  it("REGRESSION GUARD: the same 12 FTS + 5 cosine input would have put a cosine-only row in the top 10 under RRF (1/(60+rank)) — this ordering does not", () => {
    const ftsRows: CandidateRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `fts-${i}`,
      ftsHit: true,
      ftsRank: 0.4 - i * 0.03,
      similarity: null,
    }));
    const cosineNoise: CandidateRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `cosine-${i}`,
      ftsHit: false,
      ftsRank: 0,
      similarity: 0.99 - i * 0.01,
    }));
    const top10 = rankStrictFtsFirst([...ftsRows, ...cosineNoise], 10);
    expect(top10.some((r) => !r.ftsHit)).toBe(false);

    // Sanity check that RRF WOULD have let a cosine row in, proving this is
    // a real behavioral difference, not a vacuous assertion (F4's critique
    // of the round-1 oracle).
    const RRF_K = 60;
    const ftsRanked = [...ftsRows].sort((a, b) => b.ftsRank - a.ftsRank);
    const cosineRanked = [...cosineNoise].sort((a, b) => (b.similarity as number) - (a.similarity as number));
    const rrfScored = [
      ...ftsRanked.map((r, i) => ({ id: r.id, rrf: 1 / (RRF_K + i + 1) })),
      ...cosineRanked.map((r, i) => ({ id: r.id, rrf: 1 / (RRF_K + i + 1) })),
    ].sort((a, b) => b.rrf - a.rrf);
    expect(rrfScored.slice(0, 10).some((r) => r.id.startsWith("cosine-"))).toBe(true);
  });

  it("fewer than 10 FTS matches: cosine-only rows fill the remaining slots, IN SIMILARITY ORDER", () => {
    const ftsRows: CandidateRow[] = Array.from({ length: 4 }, (_, i) => ({
      id: `fts-${i}`,
      ftsHit: true,
      ftsRank: 0.9 - i * 0.1,
      similarity: null,
    }));
    const cosineRows: CandidateRow[] = [
      { id: "cosine-lo", ftsHit: false, ftsRank: 0, similarity: 0.31 },
      { id: "cosine-hi", ftsHit: false, ftsRank: 0, similarity: 0.8 },
      { id: "cosine-mid", ftsHit: false, ftsRank: 0, similarity: 0.5 },
    ];

    const top10 = rankStrictFtsFirst([...ftsRows, ...cosineRows], 10);
    // All 4 FTS rows first, in ts_rank order.
    expect(top10.slice(0, 4).map((r) => r.id)).toEqual(["fts-0", "fts-1", "fts-2", "fts-3"]);
    // Remaining slots filled by the 3 cosine rows, in similarity order.
    expect(top10.slice(4).map((r) => r.id)).toEqual(["cosine-hi", "cosine-mid", "cosine-lo"]);
    expect(top10).toHaveLength(7); // only 7 candidates total, limit 10 doesn't fabricate rows
  });

  it("null-embedding path (keywordSearch's fallback) is IDENTICAL to the FTS-only ordering — no embedding leg ever contributes", () => {
    const ftsRows: CandidateRow[] = [
      { id: "hi", ftsHit: true, ftsRank: 0.5, similarity: null },
      { id: "mid", ftsHit: true, ftsRank: 0.3, similarity: null },
      { id: "lo", ftsHit: true, ftsRank: 0.1, similarity: null },
    ];
    // With query_embedding => null, every row's similarity is null (the SQL
    // CASE sets it to null when query_embedding is not supplied), so the
    // embedding leg can never activate (`similarity is not null and
    // similarity > 0.3` is false for every row) — ordering is pure ts_rank.
    const top = rankStrictFtsFirst(ftsRows, 10);
    expect(top.map((r) => r.id)).toEqual(["hi", "mid", "lo"]);
  });

  it("a genuine tie in fts_rank falls back to id for a fully deterministic order (matches the SQL's stable tiebreak)", () => {
    const rows: CandidateRow[] = [
      { id: "b", ftsHit: true, ftsRank: 0.5, similarity: null },
      { id: "a", ftsHit: true, ftsRank: 0.5, similarity: null },
    ];
    const top = rankStrictFtsFirst(rows, 10);
    expect(top.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
