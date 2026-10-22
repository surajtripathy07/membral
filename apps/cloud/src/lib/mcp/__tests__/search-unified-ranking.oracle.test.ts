// TS ORACLE — migration 044/045's mcp_search_unified() cross-leg ranking and
// chunk-coverage resolution semantics, hand-derived from the actual SQL text
// (not from lib/mcp/graph-tools.ts, which is a thin pass-through with no
// ranking logic of its own — see toUnifiedResult()). These functions are
// NOT called by production code; they exist ONLY so the ranking/coverage
// DECISION RULES documented in migration 044/045's headers have a place to be
// pinned down and regression-tested without a live Postgres connection (this
// task runs with no supabase/db commands — the mandatory adversarial review
// that follows this change is expected to verify these formulas against a
// real migrated database).
//
// SQL IS NORMATIVE: if migration 044/045's SQL ever changes these formulas,
// this file must change with it — these are hand-transcriptions of specific
// expressions from those migrations, not independently-derived logic.
//
// REVISION (fresh adversarial review, 2026-07-26, NOT SOLID: 3 BLOCKER/7
// MAJOR/5 MINOR): the original version of this oracle modeled a single
// GREATEST(ts_rank, cosine) score competing under one global LIMIT — exactly
// the design that blocker B2/B3 proved broken with live data (the code leg
// returned ZERO rows at limit 10/20 with a real query embedding; a
// chunk-resolved row could never outrank its own fallback). This oracle now
// models the FIXED design: rank-then-fuse (RRF) across legs, and
// GREATEST(chunk score, conversation score) for chat-leg resolution.

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// RRF fusion oracle (B2): each leg is ranked SEPARATELY (row_number() over
// its own leg-appropriate score, descending), then merged by
// rrf = 1.0 / (60 + leg_rank). Final order is rrf DESC (ties broken by
// recency/stable id in the real SQL — irrelevant to what this oracle pins:
// that the code leg is GUARANTEED representation near the top of any limit
// whenever it has a matching row at all, regardless of how its raw score
// compares to the chat leg's on an absolute scale).
// ---------------------------------------------------------------------------

interface LegRow {
  id: string;
  score: number;
}

const RRF_K = 60;

function rankLeg(rows: LegRow[]): Map<string, number> {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const ranks = new Map<string, number>();
  sorted.forEach((r, i) => ranks.set(r.id, i + 1));
  return ranks;
}

interface FusedRow {
  id: string;
  source: "chat" | "code";
  rrf: number;
}

function fuseLegsByRRF(chat: LegRow[], code: LegRow[], limit: number): FusedRow[] {
  const chatRanks = rankLeg(chat);
  const codeRanks = rankLeg(code);
  const combined: FusedRow[] = [
    ...chat.map((r) => ({ id: r.id, source: "chat" as const, rrf: 1 / (RRF_K + (chatRanks.get(r.id) as number)) })),
    ...code.map((r) => ({ id: r.id, source: "code" as const, rrf: 1 / (RRF_K + (codeRanks.get(r.id) as number)) })),
  ];
  combined.sort((a, b) => b.rrf - a.rrf);
  return combined.slice(0, limit);
}

describe("SQL ORACLE — RRF cross-leg fusion (migration 044/045, fix for BLOCKER B2)", () => {
  it("the best row in EACH leg gets the identical rrf value (1/61) regardless of the legs' absolute score scales", () => {
    const chat: LegRow[] = [{ id: "chat-1", score: 0.41 }]; // corpus-average cosine, per the live finding
    const code: LegRow[] = [{ id: "code-1", score: 0.39 }]; // ts_rank max, per the live finding — LOWER than chat's score
    const fused = fuseLegsByRRF(chat, code, 10);
    const chatRow = fused.find((r) => r.id === "chat-1");
    const codeRow = fused.find((r) => r.id === "code-1");
    expect(chatRow?.rrf).toBeCloseTo(1 / 61);
    expect(codeRow?.rrf).toBeCloseTo(1 / 61);
  });

  it("REGRESSION GUARD (B2 live finding): 10 chat rows all scoring higher than the code leg's single matching row STILL leave that code row inside a limit-10 result — GREATEST-under-one-LIMIT would have excluded it", () => {
    const code: LegRow[] = [{ id: "code-1", score: 0.39 }]; // beats 8/10 chat rows on raw score but loses to the top 2

    // Construct the actually-failing case the live finding described: nine
    // chat rows ALL scoring above code's raw score (under the OLD design —
    // one global sort by raw GREATEST score — code-1 would be excluded from
    // a limit-10 result entirely).
    const chatBeatsCode: LegRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `chat-${i}`,
      score: 0.395 + i * 0.001,
    }));
    const fused = fuseLegsByRRF(chatBeatsCode, code, 10);
    expect(fused.some((r) => r.source === "code")).toBe(true);

    // Unrelated to the naive-sort contrast above: prove code-1's OWN leg
    // rank (1st and only in its leg) beats every chat row ranked worse than
    // #1 in the fused order, regardless of code-1's raw score being below
    // ALL ten chat rows here.
    const allChatBeatCode: LegRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `chat-${i}`,
      score: 0.5 + i * 0.01,
    }));
    const fusedAllBeat = fuseLegsByRRF(allChatBeatCode, code, 10);
    expect(fusedAllBeat.some((r) => r.id === "code-1")).toBe(true);
    // code-1 (leg rank 1) ties chat-0 (leg rank 1) at the very top, so it is
    // never pushed further down than position 2.
    expect(fusedAllBeat.findIndex((r) => r.id === "code-1")).toBeLessThanOrEqual(1);
  });

  it("interleaving guarantee: when both legs have several matches, at least one row from EACH leg lands inside a small limit", () => {
    const chat: LegRow[] = Array.from({ length: 5 }, (_, i) => ({ id: `chat-${i}`, score: 0.9 - i * 0.1 }));
    const code: LegRow[] = Array.from({ length: 5 }, (_, i) => ({ id: `code-${i}`, score: 0.5 - i * 0.05 }));
    const fused = fuseLegsByRRF(chat, code, 4);
    expect(fused.some((r) => r.source === "chat")).toBe(true);
    expect(fused.some((r) => r.source === "code")).toBe(true);
  });

  it("an empty code leg (no code match at all) never fabricates a code row — chat-only results are unaffected", () => {
    const chat: LegRow[] = [{ id: "chat-1", score: 0.5 }];
    const fused = fuseLegsByRRF(chat, [], 10);
    expect(fused).toHaveLength(1);
    expect(fused[0].source).toBe("chat");
  });

  it("a higher-scoring row within the SAME leg always gets a better (larger) rrf than a lower-scoring row in that same leg", () => {
    const chat: LegRow[] = [
      { id: "chat-hi", score: 0.9 },
      { id: "chat-lo", score: 0.1 },
    ];
    const fused = fuseLegsByRRF(chat, [], 10);
    const hi = fused.find((r) => r.id === "chat-hi") as FusedRow;
    const lo = fused.find((r) => r.id === "chat-lo") as FusedRow;
    expect(hi.rrf).toBeGreaterThan(lo.rrf);
  });
});

// ---------------------------------------------------------------------------
// Chat-leg score oracle (B3): resolved rows use
// GREATEST(chunk score, conversation score) — a chunk hit can only ever
// IMPROVE a row's rank over the pre-chunking baseline (conv score alone),
// never bury it. `chunkScore`/`convScore` here stand in for
// `GREATEST(ts_rank, similarity)` on each side, already computed.
// ---------------------------------------------------------------------------

function chatLegScore(params: { resolved: boolean; chunkScore: number; convScore: number }): number {
  return params.resolved ? Math.max(params.chunkScore, params.convScore) : params.convScore;
}

describe("SQL ORACLE — chat leg score, resolved-never-demotes (migration 045, fix for BLOCKER B3)", () => {
  it("a resolved row whose chunk score is WORSE than its conversation score still scores at the conversation baseline — never demoted", () => {
    expect(chatLegScore({ resolved: true, chunkScore: 0.1, convScore: 0.5 })).toBe(0.5);
  });

  it("a resolved row whose chunk score is BETTER than its conversation score scores at the (higher) chunk score — resolution improves rank", () => {
    expect(chatLegScore({ resolved: true, chunkScore: 0.9, convScore: 0.2 })).toBe(0.9);
  });

  it("a non-resolved (fallback) row scores at the plain conversation score, unaffected by chunking existing at all", () => {
    expect(chatLegScore({ resolved: false, chunkScore: 0.99, convScore: 0.3 })).toBe(0.3);
  });

  it("REGRESSION GUARD (B3 live finding): resolved never scores BELOW what the identical row would have scored had it never been chunked", () => {
    // Live finding: first resolved row landed at position 106/200 at the
    // corpus's global minimum score under the old bare-ts_rank formula.
    // This property must hold for every (chunkScore, convScore) pair.
    const cases = [
      { chunkScore: 0.0, convScore: 0.7 },
      { chunkScore: 0.05, convScore: 0.39 },
      { chunkScore: 0.6, convScore: 0.6 },
    ];
    for (const c of cases) {
      const resolvedScore = chatLegScore({ resolved: true, ...c });
      const unresolvedBaseline = chatLegScore({ resolved: false, ...c });
      expect(resolvedScore).toBeGreaterThanOrEqual(unresolvedBaseline);
    }
  });
});

// ---------------------------------------------------------------------------
// Chunk-match / candidate-widening oracle (fix 2/3 in migration 045's header:
// chunk_best now pre-filters to MATCHING, non-sentinel chunks before its
// DISTINCT ON, so "has a best matching chunk" and "is resolved" collapse to
// the same condition — no separate has-coverage-but-no-match state).
// ---------------------------------------------------------------------------

function chunkCandidateOracle(params: {
  chunkMatches: boolean; // true iff a chunk_best row exists for this conversation post-filter
  convLevelMatch: boolean;
}): { included: boolean; resolved: boolean } {
  return {
    included: params.convLevelMatch || params.chunkMatches,
    resolved: params.chunkMatches,
  };
}

describe("SQL ORACLE — chunk_best pre-filter collapses coverage+match into one condition (fixes MAJOR M1)", () => {
  it("a conversation matching ONLY via its own chunk (whole-document predicate does not match) is included and resolved", () => {
    const r = chunkCandidateOracle({ chunkMatches: true, convLevelMatch: false });
    expect(r.included).toBe(true);
    expect(r.resolved).toBe(true);
  });

  it("a conversation matching only at the whole-document level (no matching chunk) is included but NOT resolved — falls back cleanly", () => {
    const r = chunkCandidateOracle({ chunkMatches: false, convLevelMatch: true });
    expect(r.included).toBe(true);
    expect(r.resolved).toBe(false);
  });

  it("a conversation matching neither level is excluded", () => {
    const r = chunkCandidateOracle({ chunkMatches: false, convLevelMatch: false });
    expect(r.included).toBe(false);
    expect(r.resolved).toBe(false);
  });

  it("a conversation matching at BOTH levels is included and resolved (chat-leg score then takes GREATEST — see the B3 suite above)", () => {
    const r = chunkCandidateOracle({ chunkMatches: true, convLevelMatch: true });
    expect(r.included).toBe(true);
    expect(r.resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security invariant oracle (MAJOR M2): the code leg requires BOTH the
// caller's opt-in AND the absence of a LifeArea scope.
// ---------------------------------------------------------------------------

function codeLegRuns(params: { includeCode: boolean; scopeId: string | null }): boolean {
  return params.includeCode && params.scopeId === null;
}

describe("SQL ORACLE — code leg security invariant (migration 044/045, fix for MAJOR M2)", () => {
  it("defaults to false: omitting p_include_code never runs the code leg", () => {
    expect(codeLegRuns({ includeCode: false, scopeId: null })).toBe(false);
  });

  it("REGRESSION GUARD (M2 live finding): even p_include_code=true never runs the code leg when a LifeArea scope is present — an area-scoped key must never see code data", () => {
    expect(codeLegRuns({ includeCode: true, scopeId: "area-space" })).toBe(false);
  });

  it("runs only for a fully unscoped caller that explicitly opts in", () => {
    expect(codeLegRuns({ includeCode: true, scopeId: null })).toBe(true);
  });
});
