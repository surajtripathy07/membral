// Open threads — the one Supabase touch point (goal 2026-09-26 W7 / P5).
// Every read is the caller's own rows (RLS `user_id = auth.uid()`; the cookie
// client /api/pulse hands in). Rows go to open-threads.ts's pure
// `computeThreads`; nothing here decides anything.
//
// The window bounds WHICH SESSIONS are read (a predicate on
// `code_sessions.started_at`); actions, issue rows and branch state follow
// from those sessions — no time-keyed git anywhere (B4), and no query here is
// ever reached from the preamble or the MCP tools (the guard test in
// __tests__/preamble-guard.test.ts asserts it).

import { redactPii, redactSecrets } from "@membral/core";
import { asModelList, asRawUsage } from "@/lib/agent-stats/aggregate";
import { computeCost } from "@/lib/code-sessions/price-table";
import { hostlessRefQualifier } from "@/lib/code-sessions/ref-canon";
import type { Db } from "@/lib/db/types";
import { blockerFreshCutoff } from "@/lib/domain/blockers";
import type { ForgeRefKind } from "@/lib/forge/ref-url";
import { collapseRecurrenceChains, retiredRootCountsFor } from "@/lib/memory/preamble";
import { mapWithConcurrency, READ_FANOUT_LIMIT } from "@/lib/util/concurrency";
import { PAGE_SIZE, selectAllByIdKeyset, selectAllRows, selectAllRowsParallel } from "@/lib/util/pagination";
import {
  type ComputeThreadsResult,
  computeThreads,
  type DismissReason,
  THREAD_LIMIT,
  THREAD_WINDOW_DAYS,
  type Thread,
  type ThreadBranchStateRow,
  type ThreadDismissalRow,
  type ThreadIssueRow,
  type ThreadMemoryRow,
  type ThreadSessionRow,
  type ThreadTurnRow,
} from "./open-threads";

const IN_CHUNK = 100;
/** Action-turn pages requested up front per session chunk (#173); any more are paged one at a time. */
const TURN_PAGES_AT_ONCE = 2;
export const MAX_THREAD_WINDOW_DAYS = 90;
/** Blockers read per request; ordered in SQL (recurrence desc, latest first) before the cap. */
const BLOCKER_READ_LIMIT = 50;
export const THREAD_DISMISSALS_TABLE = "thread_dismissals";

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A promise that never rejects: its outcome, rethrown later by `unwrap` (#173: started early, surfaced in the old order). */
function settle<T>(p: PromiseLike<T>): Promise<Settled<T>> {
  return Promise.resolve(p).then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  );
}

function unwrap<T>(s: Settled<T>): T {
  if (s.ok) return s.value;
  throw s.error;
}

/** Only what pricing needs (F18): `props->usage` and `props->models`, not the whole props blob. */
interface SessionRowRaw {
  id: string;
  code_project_id: string | null;
  started_at: string | null;
  ended_at?: string | null;
  git_branch: string | null;
  turn_count: number | null;
  parent_source_session_id: string | null;
  source: string | null;
  source_session_id: string | null;
  usage?: unknown;
  models?: unknown;
}

/** code_sessions.props.usage priced with the same table as every other cost on the dashboard. */
function priceSession(row: Pick<SessionRowRaw, "usage" | "models">): number | null {
  const usage = asRawUsage(row.usage);
  if (!usage) return null;
  const models = asModelList(row.models);
  return computeCost(usage, models[0])?.amount ?? null;
}

export interface ListOpenThreadsResult extends ComputeThreadsResult {
  window_days: number;
}

/**
 * `listOpenThreads(supabase, userId, {days: 30, limit: 5})` — B6 over the
 * caller's sessions started in the last `days` days. `open` is capped at
 * `limit`; `recent` is every thread in the window (discussed included).
 */
export async function listOpenThreads(
  supabase: Db,
  userId: string,
  opts: { days?: number; limit?: number; now?: Date } = {},
): Promise<ListOpenThreadsResult> {
  const days = Math.min(MAX_THREAD_WINDOW_DAYS, Math.max(1, opts.days ?? THREAD_WINDOW_DAYS));
  const limit = opts.limit ?? THREAD_LIMIT;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();

  // #173: the memory, dismissal and project-identity reads depend only on
  // `userId`/`since`, so they start alongside the sessions read instead of
  // after the per-chunk loop. They are settled (never left rejecting): a
  // failure surfaces only where the serial version threw it — after a
  // non-empty sessions read — and an empty window ignores them, as before.
  const MEMORY_COLS =
    "id, kind, ref, ref_kind, text, quote, turn_role, turn_idx, recurrence_count, priority, retired_at, created_at, code_session_id, recurs_of";
  const memoryReads = settle(
    Promise.all([
      // The owner's quotes (B8): live decision/preference rows on a ref, every page (F8).
      selectAllRows<ThreadMemoryRow>((from, to) =>
        supabase
          .from("session_memories")
          .select(MEMORY_COLS)
          .eq("user_id", userId)
          .in("kind", ["decision", "preference"])
          .is("retired_at", null)
          .not("ref", "is", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      // B7: live blockers in the window, most recurrent first, then latest — ordered before the cap.
      Promise.resolve(
        supabase
          .from("session_memories")
          .select(MEMORY_COLS)
          .eq("user_id", userId)
          .eq("kind", "blocker")
          .is("retired_at", null)
          // #436: fresh blockers only (lib/domain/blockers.ts) — the later of the
          // thread window and the blocker window.
          .gte("created_at", blockerFreshCutoff(now.getTime()) > since ? blockerFreshCutoff(now.getTime()) : since)
          .order("recurrence_count", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(BLOCKER_READ_LIMIT),
      ),
      listThreadDismissals(supabase, userId),
    ]),
  );
  // v3 item 6 (d): stored host-less `owner/repo#N` refs take their known host, so Today's
  // chips link (forgeUrl needs a host) and group with the hosted spelling of the item.
  const identitiesRead = selectAllByIdKeyset<{ id: string; repo_identity: string | null }>(() =>
    supabase.from("code_projects").select("id, repo_identity").eq("user_id", userId),
  ).catch(() => [] as { repo_identity: string | null }[]);

  const raw = await selectAllRows<SessionRowRaw>((from, to) =>
    supabase
      .from("code_sessions")
      .select(
        "id, code_project_id, started_at, ended_at, git_branch, turn_count, parent_source_session_id, source, source_session_id, usage:props->usage, models:props->models",
      )
      .eq("user_id", userId)
      .gte("started_at", since)
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  const sessions: ThreadSessionRow[] = raw.map((s) => ({
    id: s.id,
    code_project_id: s.code_project_id,
    started_at: s.started_at,
    ended_at: s.ended_at ?? null,
    git_branch: s.git_branch,
    turn_count: s.turn_count,
    parent_source_session_id: s.parent_source_session_id ?? null,
    source: s.source ?? null,
    source_session_id: s.source_session_id ?? null,
    cost_usd: priceSession(s),
  }));
  if (sessions.length === 0) {
    return { open: [], recent: [], recurring_blockers: [], estimated: true, window_days: days };
  }
  const sessionIds = sessions.map((s) => s.id);
  const projectIds = [...new Set(sessions.map((s) => s.code_project_id).filter((id): id is string => !!id))];

  // #173: every 100-id chunk is read concurrently (was one chunk after
  // another), and inside a chunk the issue and action-turn reads run
  // together; only the proof-turn times wait, on that chunk's issue rows.
  // Results are concatenated in chunk order, so the rows match the serial read.
  // Per-request concurrency ceiling (#173): 6 chunks × (1 issues + ≤2 turn pages) + 6 branch + 3 memory/dismissal + 1 identities ≈ 28 in flight, worst case.
  const turnCountById = new Map(raw.map((s) => [s.id, s.turn_count ?? 0]));
  const chunkReads = mapWithConcurrency(chunk(sessionIds, IN_CHUNK), READ_FANOUT_LIMIT, async (ids) => {
    const [issuePage, turnPage] = await Promise.all([
      selectAllRows<ThreadIssueRow>((from, to) =>
        supabase
          .from("code_session_issues")
          .select(
            "session_id, ref, number, kind, role, evidence_quote, turn_idx, review_verb, build_verb, tier, turn_share, related_to",
          )
          .eq("user_id", userId)
          .in("session_id", ids)
          .order("session_id", { ascending: true })
          .order("ref", { ascending: true })
          .order("kind", { ascending: true })
          .range(from, to),
      ),
      // The chunk's turn_count sum bounds its action turns, so the first pages go out at once
      // (selectAllRowsParallel). Capped at two pages: action turns are a small share of all turns,
      // and an uncapped sum (~30k) would fire ~30 empty-page reads per chunk.
      selectAllRowsParallel<ThreadTurnRow>(
        (from, to) =>
          supabase
            .from("code_session_turns")
            .select("session_id, idx, ts, props")
            .eq("user_id", userId)
            .in("session_id", ids)
            .not("props->action", "is", null)
            .order("session_id", { ascending: true })
            .order("idx", { ascending: true })
            .range(from, to),
        Math.min(
          ids.reduce((sum, id) => sum + (turnCountById.get(id) ?? 0), 0),
          TURN_PAGES_AT_ONCE * PAGE_SIZE - 1,
        ),
      ),
    ]);

    // v4 item 5: the proof turn of every issue row, so a row is dated by its own action turn
    // (a sub-agent spawn row carries no action, so it is not in the page above).
    const proofIdx = [...new Set(issuePage.map((r) => r.turn_idx).filter((i) => Number.isInteger(i)))];
    const wanted = new Set(issuePage.map((r) => `${r.session_id}\u0000${r.turn_idx}`));
    // Usually one idx chunk; read one at a time so the outer cap stays the bound.
    const timePages = await mapWithConcurrency(chunk(proofIdx, IN_CHUNK), 1, (idxs) =>
      selectAllRows<{ session_id: string; idx: number; ts: string | null }>((from, to) =>
        supabase
          .from("code_session_turns")
          .select("session_id, idx, ts")
          .eq("user_id", userId)
          .in("session_id", ids)
          .in("idx", idxs)
          .order("session_id", { ascending: true })
          .order("idx", { ascending: true })
          .range(from, to),
      ),
    );
    const times = timePages.flat().filter((t) => wanted.has(`${t.session_id}\u0000${t.idx}`));
    return { issuePage, turnPage, times };
  });

  const branchReads = mapWithConcurrency(chunk(projectIds, IN_CHUNK), READ_FANOUT_LIMIT, (ids) =>
    selectAllRows<ThreadBranchStateRow>((from, to) =>
      supabase
        .from("memory_branch_state")
        .select("code_project_id, branch, last_seen_sha, merged_into, merged_at, branch_gone_at")
        .eq("user_id", userId)
        .in("code_project_id", ids)
        .order("code_project_id", { ascending: true })
        .order("branch", { ascending: true })
        .range(from, to),
    ),
  );

  const memoryAndDismissals = memoryReads.then(async (settled) => {
    const [refMemories, blockers, dismissals] = unwrap(settled);
    if (blockers.error) throw new Error(`threads: blockers read failed: ${blockers.error.message}`);
    const liveBlockers = await collapseBlockerChains(supabase, userId, (blockers.data ?? []) as ThreadMemoryRow[]);
    return { memories: [...refMemories, ...liveBlockers], dismissals };
  });

  const [chunkResults, branchPages, { memories, dismissals }, identities] = await Promise.all([
    chunkReads,
    branchReads,
    memoryAndDismissals,
    identitiesRead,
  ]);
  const issues: ThreadIssueRow[] = chunkResults.flatMap((r) => r.issuePage);
  const turns: ThreadTurnRow[] = chunkResults.flatMap((r) => r.turnPage);
  const turnTimes = chunkResults.flatMap((r) => r.times);
  const branchState: ThreadBranchStateRow[] = branchPages.flat();

  const withHost = hostlessRefQualifier(identities.map((p) => p.repo_identity));
  for (const r of issues) r.ref = withHost(r.ref, r.evidence_quote);

  const projectIdentity: Record<string, string | null> = {};
  for (const p of identities as { id?: string; repo_identity: string | null }[])
    if (p.id) projectIdentity[p.id] = p.repo_identity;
  const result = computeThreads(
    { issues, sessions, turns, branchState, memories, dismissals, turnTimes, projectIdentity },
    { limit, now },
  );
  // Titles are observed free text (commit subjects, forge titles): redacted
  // again here, server-side, so no email/phone/secret reaches the page (B10).
  const seen = new Set<Thread>();
  for (const t of [...result.open, ...result.recent]) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (t.title) t.title = redactPii(redactSecrets(t.title));
    if (t.forge_title) t.forge_title = redactPii(redactSecrets(t.forge_title));
    if (t.first_commit_subject) t.first_commit_subject = redactPii(redactSecrets(t.first_commit_subject));
  }
  return { ...result, window_days: days };
}

type ChainInput = Parameters<typeof collapseRecurrenceChains>[0];

/**
 * Pulse recurring blockers (e2e A-B4): ONE row per recurrence chain — the
 * chain's newest live row (preamble.ts collapseRecurrenceChains, the same
 * rule the preamble uses), its `recurrence_count` the chain's count (a
 * retired root's count included, as the preamble counts it), and its
 * `seen_at` the newest member's SESSION time (ended_at, else started_at),
 * never the extraction clock (`created_at`), so time-shifted or re-extracted
 * sessions order by when the blocker was actually hit. Best-effort on the
 * session read: a failure leaves `seen_at` unset (created_at is shown).
 */
export async function collapseBlockerChains(
  supabase: Db,
  userId: string,
  rows: ThreadMemoryRow[],
): Promise<ThreadMemoryRow[]> {
  const blockers = rows.filter((r) => r.kind === "blocker" && !!r.id);
  if (blockers.length === 0) return rows;
  // A chain whose root was retired still counts the root's sightings — the
  // same read the preamble does, so both surfaces show the same "seen N×".
  const chainRows = blockers as unknown as ChainInput;
  // #173: the retired-root counts and the members' session times are
  // independent reads, so they run together (and the session chunks run
  // concurrently); results are consumed in chunk order below.
  const sessionIds = [...new Set(blockers.map((r) => r.code_session_id).filter((id): id is string => !!id))];
  const [retiredCounts, sessionPages] = await Promise.all([
    retiredRootCountsFor(supabase, userId, chainRows),
    mapWithConcurrency(chunk(sessionIds, IN_CHUNK), READ_FANOUT_LIMIT, (ids) =>
      Promise.resolve(
        supabase.from("code_sessions").select("id, started_at, ended_at").eq("user_id", userId).in("id", ids),
      ),
    ),
  ]);
  const { rows: kept, seen } = collapseRecurrenceChains(chainRows, retiredCounts);
  const keptIds = new Set(kept.map((r) => r.id));

  // Chain membership (for the newest member's session): union over recurs_of.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  for (const r of blockers) {
    const id = r.id as string;
    if (!parent.has(id)) parent.set(id, id);
    if (r.recurs_of) {
      if (!parent.has(r.recurs_of)) parent.set(r.recurs_of, r.recurs_of);
      const a = find(id);
      const b = find(r.recurs_of);
      if (a !== b) parent.set(a, b);
    }
  }
  const sessionAt = new Map<string, string>();
  for (const { data, error } of sessionPages) {
    if (error) break;
    for (const s of (data ?? []) as { id: string; started_at: string | null; ended_at: string | null }[]) {
      const at = s.ended_at ?? s.started_at;
      if (at) sessionAt.set(s.id, at);
    }
  }
  const newestSeen = new Map<string, string>();
  for (const r of blockers) {
    const at = r.code_session_id ? sessionAt.get(r.code_session_id) : undefined;
    if (!at) continue;
    const root = find(r.id as string);
    const prev = newestSeen.get(root);
    if (!prev || Date.parse(at) > Date.parse(prev)) newestSeen.set(root, at);
  }

  const out: ThreadMemoryRow[] = [];
  for (const r of rows) {
    if (r.kind !== "blocker" || !r.id) {
      out.push(r);
      continue;
    }
    if (!keptIds.has(r.id)) continue;
    out.push({
      ...r,
      recurrence_count: seen.get(r.id) ?? r.recurrence_count ?? 1,
      seen_at: newestSeen.get(find(r.id)) ?? null,
    });
  }
  return out;
}

/** Every dismissal of the caller's, paginated (F8: never a silent 1000-row slice). */
export async function listThreadDismissals(supabase: Db, userId: string): Promise<ThreadDismissalRow[]> {
  return selectAllRows<ThreadDismissalRow>((from, to) =>
    supabase
      .from(THREAD_DISMISSALS_TABLE)
      .select("ref, kind, reason, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .order("ref", { ascending: true })
      .range(from, to),
  );
}

// ---- dismiss ------------------------------------------------------------------

export type DismissOutcome =
  | { ok: true; already: boolean; dismissal_id: string | null }
  | { ok: false; reason: "unknown_ref" };

/**
 * POST /api/threads/dismiss: record that the owner dismissed the thread
 * (kind, ref) with a reason, in `thread_dismissals` (migration 106) — never in
 * session_memories, so no memory/MCP/preamble path can serve it (D-051).
 * One row per (kind, ref): an existing dismissal returns `already: true`
 * and is REFRESHED — created_at moves to now and reason to the new click —
 * because a thread re-opens when a build action lands after created_at
 * (open-threads.ts), and dismissing it again must hide it again (review B1).
 * The update is RLS update-own, column-limited to (created_at, reason) by
 * migration 106. A (kind, ref) no session of the caller's ever touched is
 * `unknown_ref`.
 */
export async function writeThreadDismissal(
  supabase: Db,
  userId: string,
  target: { ref: string; kind: ForgeRefKind },
  reason: DismissReason,
  opts: { now?: Date } = {},
): Promise<DismissOutcome> {
  const { ref, kind } = target;
  const existing = await supabase
    .from(THREAD_DISMISSALS_TABLE)
    .select("id")
    .eq("user_id", userId)
    .eq("kind", kind)
    .eq("ref", ref)
    .limit(1);
  if (existing.error) throw new Error(`threads: dismissal read failed: ${existing.error.message}`);
  const live = ((existing.data ?? []) as { id: string }[])[0];
  if (live) {
    const refreshed = await supabase
      .from(THREAD_DISMISSALS_TABLE)
      .update({ created_at: (opts.now ?? new Date()).toISOString(), reason })
      .eq("id", live.id)
      .eq("user_id", userId);
    if (refreshed.error) throw new Error(`threads: dismissal refresh failed: ${refreshed.error.message}`);
    return { ok: true, already: true, dismissal_id: live.id };
  }

  const issue = await supabase
    .from("code_session_issues")
    .select("session_id")
    .eq("user_id", userId)
    .eq("ref", ref)
    .eq("kind", kind)
    .limit(1);
  if (issue.error) throw new Error(`threads: code_session_issues read failed: ${issue.error.message}`);
  if (((issue.data ?? []) as unknown[]).length === 0) return { ok: false, reason: "unknown_ref" };

  const inserted = await supabase
    .from(THREAD_DISMISSALS_TABLE)
    .upsert(
      { user_id: userId, ref, kind, reason, created_at: (opts.now ?? new Date()).toISOString() },
      { onConflict: "user_id,kind,ref", ignoreDuplicates: true },
    )
    .select("id");
  if (inserted.error) throw new Error(`threads: dismissal write failed: ${inserted.error.message}`);
  const id = ((inserted.data ?? []) as { id?: string }[])[0]?.id ?? null;
  return { ok: true, already: false, dismissal_id: id };
}
