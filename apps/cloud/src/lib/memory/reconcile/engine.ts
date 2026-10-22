// L1: proposes reconciliation links for a set of records against the older live records of the same user and project.
// All reads go through `ReconSource` so the engine is testable with a fake; it writes nothing. The caller turns the
// proposed links into a plan (plan.ts), a dry-run report, or (apply, gated elsewhere) SQL.
import { parseVector } from "@/lib/llm/vector";
import { cosineSimilarity } from "../embed";
import { type Cand, cosineTop, mergeCandidates, refToken } from "./candidates";
import { type JudgeLlm, judgePairs } from "./judge";
import { type PlannedLink, plannedLink } from "./plan";
import { type OrientedPair, orientPair, type ReconRecord, type ReconTurn } from "./verdict";

export interface ScopeRow extends ReconRecord {
  embedding: number[];
  valid_to: string | null;
  /** The replacing record, when the projection is set (read so a retired replacement can be reconsidered). */
  superseded_by?: string | null;
}

export interface ReconSource {
  /** Live (not retired) records of one user, all projects in scope. */
  scope(): Promise<Array<Omit<ScopeRow, "sessionStart">>>;
  /** Real session start (ms) per code_session id. */
  sessionStarts(ids: readonly string[]): Promise<Map<string, number>>;
  /** Hybrid (lexical + semantic) top ids for a record's text, same project. */
  hybrid(rec: ScopeRow, kinds: readonly string[], n: number): Promise<string[]>;
  /** Turns of one session. */
  turns(sessionId: string): Promise<ReconTurn[]>;
  /** Timestamp (ms) of the turn each (session, idx) names, keyed `${session}:${idx}`; absent when the turn has none. */
  turnTimes?(refs: ReadonlyArray<{ session: string; idx: number }>): Promise<Map<string, number>>;
}

export interface ProposeOptions {
  /** Only records from sessions starting at or after this epoch ms are re-judged as the NEWER side. */
  sinceMs?: number;
  /** Stop after this many records (newest first). */
  limitRecords?: number;
  /** Only these records are processed as the NEWER side (the labelled-pair recall measurement). */
  onlyIds?: ReadonlySet<string>;
  maxCalls: number;
  conversationId: string;
  /** Checked before every model call; true abandons the rest of the run (no further calls). */
  shouldStop?: () => boolean;
  /** pairKey()s already judged (memoised); never re-asked. */
  seen?: ReadonlySet<string>;
  /** Called after each session batch with its judged pairs, so a caller can persist them (resumable dry-run). */
  onJudged?: (
    batch: ReadonlyArray<{
      link: PlannedLink | null;
      from_id: string;
      to_id: string;
      relation: string;
      session_id: string;
    }>,
    totals: { calls: number; costUsd: number; retries: number },
  ) => Promise<void> | void;
}

export interface ProposeResult {
  links: PlannedLink[];
  /** Every judged pair (all relations incl. abstained), for the memo file. */
  judgedPairs: Array<{ from_id: string; to_id: string; relation: string; session_id: string }>;
  liveByProject: Record<string, number>;
  shortlists: Map<string, Cand[]>;
  recordsConsidered: number;
  pairsJudged: number;
  calls: number;
  costUsd: number;
  providerFailed: boolean;
  capped: boolean;
  liveInScope: number;
  /** Batches retried once as shorter batches / pairs left unjudged because a call failed twice. */
  retries: number;
  /** Records whose orientation had to fall back to the session start (a turn time was missing). */
  turnTimeFallbacks: number;
}

/** Kinds a NEWER record of `kind` can be compared against: its own kind; outcomes only against open blockers. */
export function candidateKinds(kind: string): string[] {
  if (kind === "outcome") return ["blocker"];
  if (kind === "decision" || kind === "learning" || kind === "blocker") return [kind];
  return [];
}

export async function propose(src: ReconSource, llm: JudgeLlm | null, opts: ProposeOptions): Promise<ProposeResult> {
  const raw = await src.scope();
  const starts = await src.sessionStarts([...new Set(raw.map((r) => r.code_session_id))]);
  // A projection whose replacement is no longer live (retired) is treated as unset, so its target is reconsidered.
  const liveIds = new Set(raw.map((r) => r.id));
  const times = src.turnTimes
    ? await src.turnTimes(
        raw.filter((r) => r.turn_idx !== null).map((r) => ({ session: r.code_session_id, idx: r.turn_idx as number })),
      )
    : new Map<string, number>();
  let turnTimeFallbacks = 0;
  const rows: ScopeRow[] = raw.map((r) => {
    const turnTs = r.turn_idx !== null ? times.get(`${r.code_session_id}:${r.turn_idx}`) : undefined;
    if (turnTs === undefined) turnTimeFallbacks++;
    return {
      ...r,
      valid_to: r.valid_to && r.superseded_by && !liveIds.has(r.superseded_by) ? null : r.valid_to,
      sessionStart: starts.get(r.code_session_id),
      ...(turnTs !== undefined ? { turnTs } : {}),
    };
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const seen = opts.seen ?? new Set<string>();

  const order = (r: ScopeRow) => r.sessionStart ?? 0;
  let targets = rows
    .filter((r) => candidateKinds(r.kind).length > 0 && r.sessionStart !== undefined)
    .filter((r) => opts.sinceMs === undefined || order(r) >= opts.sinceMs)
    .filter((r) => !opts.onlyIds || opts.onlyIds.has(r.id))
    .sort((a, b) => order(b) - order(a) || (b.turn_idx ?? 0) - (a.turn_idx ?? 0) || (a.id < b.id ? -1 : 1));
  if (opts.limitRecords) targets = targets.slice(0, opts.limitRecords);

  const shortlists = new Map<string, Cand[]>();
  const itemsBySession = new Map<string, Array<{ pair: OrientedPair; cosine: number | null }>>();
  const byProject = new Map<string, ScopeRow[]>();
  for (const r of rows) {
    const list = byProject.get(r.code_project_id) ?? [];
    list.push(r);
    byProject.set(r.code_project_id, list);
  }

  for (const n of targets) {
    const kinds = candidateKinds(n.kind);
    // Older, live, not already replaced, one user and project, a kind this record may link to.
    const pool = (byProject.get(n.code_project_id) ?? []).filter((c) => {
      if (c.id === n.id || c.valid_to || !kinds.includes(c.kind)) return false;
      const o = orientPair(n, c);
      return !!o && o.from.id === n.id;
    });
    if (pool.length === 0) continue;
    const poolIds = new Set(pool.map((c) => c.id));
    const hybrid = (await src.hybrid(n, kinds, 8)).filter((id) => poolIds.has(id));
    const nv = n.embedding.length > 0 ? n.embedding : null;
    const cosines = new Map<string, number>();
    if (nv)
      for (const c of pool) if (c.embedding.length === nv.length) cosines.set(c.id, cosineSimilarity(nv, c.embedding));
    const cosine = cosineTop([...cosines].map(([id, cos]) => ({ id, cosine: cos })));
    const tok = refToken(n.ref);
    const ref = tok ? pool.filter((c) => refToken(c.ref) === tok).map((c) => c.id) : [];
    const cands = mergeCandidates(n.id, { hybrid, cosine, ref }, seen);
    shortlists.set(n.id, cands);
    for (const cand of cands) {
      const older = byId.get(cand.id);
      const pair = older ? orientPair(n, older) : null;
      if (!pair) continue;
      const list = itemsBySession.get(n.code_session_id) ?? [];
      list.push({ pair, cosine: cosines.get(cand.id) ?? null });
      itemsBySession.set(n.code_session_id, list);
    }
  }

  const links: PlannedLink[] = [];
  const judgedPairs: ProposeResult["judgedPairs"] = [];
  let calls = 0;
  let pairsJudged = 0;
  let costUsd = 0;
  let providerFailed = false;
  let capped = false;
  let retries = 0;
  if (llm) {
    for (const [sessionId, items] of itemsBySession) {
      if (calls >= opts.maxCalls) {
        capped = true;
        break;
      }
      if (opts.shouldStop?.()) break;
      const turns = await src.turns(sessionId);
      const res = await judgePairs(
        llm,
        items.map((i) => ({ pair: i.pair, cosine: i.cosine, turns })),
        {
          conversationId: opts.conversationId,
          maxCalls: opts.maxCalls,
          callsSoFar: calls,
          shouldStop: opts.shouldStop,
        },
      );
      calls += res.calls;
      costUsd += res.costUsd;
      providerFailed ||= res.failed;
      retries += res.retries;
      pairsJudged += res.judged.filter((j) => j.answered).length;
      if (res.skipped > 0) capped = true;
      const batch: Array<{
        link: PlannedLink | null;
        from_id: string;
        to_id: string;
        relation: string;
        session_id: string;
      }> = [];
      for (const j of res.judged) {
        if (!j.answered) continue;
        const rec = {
          from_id: j.item.pair.from.id,
          to_id: j.item.pair.to.id,
          relation: j.accepted.relation,
          session_id: j.item.pair.from.code_session_id,
        };
        judgedPairs.push(rec);
        const link = j.accepted.relation !== "unrelated" ? plannedLink(j.item.pair, j.accepted) : null;
        if (link) links.push(link);
        batch.push({ link, ...rec });
      }
      // Unanswered pairs (cap, stop, a call that failed twice) are not memoised: a rerun judges them.
      if (opts.onJudged && batch.length > 0) await opts.onJudged(batch, { calls, costUsd, retries });
    }
  }
  return {
    links,
    judgedPairs,
    shortlists,
    recordsConsidered: targets.length,
    pairsJudged,
    calls,
    costUsd,
    providerFailed,
    capped,
    liveInScope: rows.length,
    retries,
    turnTimeFallbacks,
    liveByProject: Object.fromEntries([...byProject].map(([k, v]) => [k, v.length])),
  };
}

/** Helper for io.ts: pgvector text or array to number[]. */
export function toVec(value: unknown): number[] {
  return Array.isArray(value) ? (value as number[]) : parseVector(value);
}
