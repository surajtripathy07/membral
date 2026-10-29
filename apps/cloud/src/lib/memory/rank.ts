// Ranking (docs/design/memory-v1.md §4). One pure, unit-tested sort shared
// by every serving surface — `memory_search`/`memory_recall`/`session_summary`
// (mode "tool") and the ≤12-line preamble (mode "push"). Never touches the
// network; callers resolve `verified` (verify.ts) and `branchLive` (from
// memory_branch_state) before calling this.
//
// Two different kind orders, both from §4, because the two surfaces answer
// different questions:
//   - "tool" (search/recall/session_summary): "outcome first (what shipped
//     is the cheapest useful line a session can be handed), then decision,
//     open blocker, learning, preference."
//   - "push" (the preamble's 8 record lines): **open blockers, learnings, at
//     most 2 global preferences, decisions** -- outcomes take NO record line
//     there (they collapse into the header's commit/PR/comment count), so
//     callers building the push must filter kind !== "outcome" out BEFORE
//     ranking; this module still accepts them (ranked last) rather than
//     throwing, so a caller bug fails safe instead of crashing the push.
//     Reordered 2026-09-13 (maintainer decision, after reading five rendered
//     preambles): the original order ("global preferences, open blockers,
//     decisions, learnings") filled three of five rendered pushes with eight
//     preference lines that read as noise, burying the blockers and gotchas
//     that were the actually useful lines -- see the preference cap in
//     `selectPushRecords` below and docs/design/memory-v1.md §4.
//
// Branch provenance (rule 6, "while the record's branch is live and is this
// session's, it ranks first ... only positive evidence demotes") is ONLY
// part of push ranking: none of the three read tools take a "current
// session's branch" parameter (see the §4 tool-input table), so there is no
// "this session" for rule 6 to compare against outside the push -- and §4's
// own "Ranking within those" paragraph for tool output lists only voice,
// recency, paths and source, omitting branch. `branchLive` is therefore
// `false | undefined` for every tool-mode caller and inert in that mode by
// construction (both records tie on it, so the comparator falls through).
//
// `confidence` never appears below -- rule 5's closing line ("`confidence`
// is stored and shown, never a tiebreak") is a hard requirement, not an
// oversight: every documented mode falls through to `id` before it would
// ever need one more key.
import type { MemoryKind, MemorySource } from "./schema";

export type RankMode = "tool" | "push";

export interface RankableRecord {
  id: string;
  kind: MemoryKind;
  source: MemorySource;
  turn_role: "user" | "assistant";
  agent_id: string | null;
  verified: boolean;
  paths: string[];
  created_at: string; // ISO
  /** Only consulted in "push" mode -- see header comment. */
  branchLive?: boolean;
  /**
   * Query relevance (higher = better), set only by `memory_search` from
   * `memory_search_records`' fused score. When both records carry one it is
   * the first key after rule 3 (verified): a topic search answers "what
   * matches these words", so kind/voice/recency only break ties. Found live
   * 2026-09-25: kind-first order served build/env decisions above the exact
   * "pnpm" preference. Recall/session_summary/push never set it.
   */
  relevance?: number;
  /**
   * How many of the query's strong anchors (file paths and refs --
   * query-anchors.ts; backticked identifiers only boost `relevance`) the
   * record carries. Set only by
   * `memory_search`. When both records carry one it is compared right after
   * rule 3 (verified) and before relevance: a record naming the exact file or
   * ref the query names answers it more directly than any record that only
   * shares its vocabulary (prompt-time recall, 2026-10-08).
   */
  anchorHits?: number;
}

const TOOL_KIND_ORDER: Record<MemoryKind, number> = {
  outcome: 0,
  decision: 1,
  blocker: 2,
  learning: 3,
  preference: 4,
};

// Order per the 2026-09-13 maintainer decision (see header comment): open
// blockers, learnings, preferences (capped at 2 -- selectPushRecords),
// decisions.
const PUSH_KIND_ORDER: Record<MemoryKind, number> = {
  blocker: 0,
  learning: 1,
  preference: 2,
  decision: 3,
  outcome: 9, // never selected for a push line by a correct caller -- see header
};

const SOURCE_ORDER: Record<MemorySource, number> = { hook: 0, agent: 1, extractor: 2, "claude-mem": 3 };

/** Rule 5: "user-voiced verified > main-transcript assistant verified > sub-agent", `source` only as the very last tiebreak below. */
function voiceReceiptRank(r: RankableRecord): number {
  if (r.turn_role === "user") return 0;
  if (!r.agent_id) return 1; // main-transcript assistant
  return 2; // sub-agent
}

function pathOverlapCount(paths: string[], recentFiles: readonly string[]): number {
  if (recentFiles.length === 0 || paths.length === 0) return 0;
  const recent = new Set(recentFiles);
  let n = 0;
  for (const p of paths) if (recent.has(p)) n++;
  return n;
}

/**
 * Sort `records` per §4. `recentFiles` is the repo's most-recently-edited
 * file set (rule 5's paths-overlap tiebreak) -- pass `[]` when unknown, it
 * simply drops out of the comparison (every record ties on 0 overlap).
 *
 * Pure and total: never mutates its input (returns a new array), never
 * throws, deterministic on a full tie (falls through to `id`).
 */
export function rankRecords<T extends RankableRecord>(
  records: readonly T[],
  mode: RankMode,
  recentFiles: readonly string[] = [],
): T[] {
  const kindOrder = mode === "push" ? PUSH_KIND_ORDER : TOOL_KIND_ORDER;

  return [...records].sort((a, b) => {
    // Rule 3: an unverified record ranks last, whatever else is true.
    if (a.verified !== b.verified) return a.verified ? -1 : 1;

    if (a.anchorHits !== undefined && b.anchorHits !== undefined && a.anchorHits !== b.anchorHits) {
      return b.anchorHits - a.anchorHits;
    }

    if (a.relevance !== undefined && b.relevance !== undefined && a.relevance !== b.relevance) {
      return b.relevance - a.relevance;
    }

    const ka = kindOrder[a.kind] ?? 9;
    const kb = kindOrder[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;

    if (mode === "push") {
      const ba = a.branchLive ? 0 : 1;
      const bb = b.branchLive ? 0 : 1;
      if (ba !== bb) return ba - bb;
    }

    const va = voiceReceiptRank(a);
    const vb = voiceReceiptRank(b);
    if (va !== vb) return va - vb;

    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    if (ta !== tb) return tb - ta; // recency: newest first

    const pa = pathOverlapCount(a.paths, recentFiles);
    const pb = pathOverlapCount(b.paths, recentFiles);
    if (pa !== pb) return pb - pa; // more overlap first

    const sa = SOURCE_ORDER[a.source] ?? 9;
    const sb = SOURCE_ORDER[b.source] ?? 9;
    if (sa !== sb) return sa - sb;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // fully deterministic
  });
}

/** Rule 5's "agent pins capped at 2 of the eight lines". */
const MAX_AGENT_PUSH_LINES = 2;
/**
 * 2026-09-13 maintainer decision (see this file's header comment): global
 * preferences read as noise at their old volume (three of five rendered
 * preambles were eight preference lines), so at most 2 of the ≤8 push lines
 * may be a `preference`, on top of -- not instead of -- the agent-pin cap
 * below. Independent caps: a record can trip either, both, or neither.
 */
const MAX_PREFERENCE_PUSH_LINES = 2;

/**
 * Two independent per-kind/per-source caps -- a push-only selection step
 * applied AFTER ranking, not part of the sort itself: neither cap reorders
 * anything, they only decide which already-ranked records fill the ≤8 push
 * slots, skipping a capped-out record in favor of the next best one further
 * down the ranking (never dropping it from the data -- it stays fully
 * available on pull, per §4):
 *   - source === "agent": capped at `MAX_AGENT_PUSH_LINES` (rule 5).
 *   - kind === "preference": capped at `MAX_PREFERENCE_PUSH_LINES`
 *     (2026-09-13 decision, above).
 */
export function selectPushRecords<T extends RankableRecord>(ranked: readonly T[], maxLines: number): T[] {
  const selected: T[] = [];
  let agentCount = 0;
  let preferenceCount = 0;
  for (const rec of ranked) {
    if (selected.length >= maxLines) break;
    if (rec.source === "agent" && agentCount >= MAX_AGENT_PUSH_LINES) continue;
    if (rec.kind === "preference" && preferenceCount >= MAX_PREFERENCE_PUSH_LINES) continue;
    if (rec.source === "agent") agentCount++;
    if (rec.kind === "preference") preferenceCount++;
    selected.push(rec);
  }
  return selected;
}
