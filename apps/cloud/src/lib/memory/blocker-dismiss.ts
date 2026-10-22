// Today's blocker rows: "Resolved" / "Ignore" (UX pass 2).
//
// A dismissal is an ordinary retirement: `retired_at = now()` plus a
// user-chosen `retire_reason` (migration 086's free-text column, no CHECK, so
// no migration). Every serving path already reads live rows only — the
// SessionStart preamble (preamble.ts `.is("retired_at", null)`), MCP recall
// and search (recall.ts, the search RPC's p_include_retired = false), the
// session summary and Today's blocker read (threads/queries.ts) — so a
// dismissed blocker leaves all of them with no read-side change.
//
// One Today row stands for a whole recurrence CHAIN (rows linked through
// `recurs_of`, collapsed to the newest live row — preamble.ts
// collapseRecurrenceChains). Retiring only that row would promote the next
// live member of the chain into its place, so every LIVE member of the chain
// is retired, and the ids come back so Undo lifts exactly those rows.
//
// Dismissals survive later extraction (carryUserDismissals, called by
// tail-capture.ts before insert):
//   - "Ignore" is sticky: a new sighting matching an ignored row is inserted
//     already retired `user_ignored:carried`, linked to the clicked row
//     through `recurs_of`. Only clicked rows are ever matched against.
//   - "Resolved" holds for sightings from before the click (a --force re-run
//     of an old session re-derives the same blocker); a session active
//     AFTER the dismissal is a new occurrence and resurfaces live.
//   - --force re-run: the retire step only touches LIVE rows, so a dismissed
//     row keeps its user reason (never becomes `rerun`), and the re-derived
//     record takes the same reason by the rule above.
// Reason vocabulary (migration 086's free-text column): user_resolved,
// user_ignored (a click) and the same with ":carried". Every one of them sets
// retired_at, so every serving path already excludes them.
// Undo never lifts a row some other machine path retired: it matches the user
// reasons and `agent_resolved` (#436) only, and it follows `recurs_of` so a sighting carried after the
// dismissal lifts with its chain. `--reverify` (write.ts) lifts `unverified:*` only, so it never
// undoes a user's dismissal either.
import type { Db } from "@/lib/db/types";
import {
  AGENT_RESOLVED_RETIRE_REASON,
  CARRIED_SUFFIX,
  USER_IGNORED_RETIRE_REASON,
  USER_RESOLVED_RETIRE_REASON,
} from "@/lib/domain/retire-reasons";
import { vectorThreshold } from "@/lib/llm/embedding-family";
import { parseVector } from "@/lib/llm/vector";
import { log } from "@/lib/log";
import type { InsertableRecord } from "@/lib/memory/write";
import { cosineSimilarity } from "./embed";
import { normalizeForDedup } from "./merge";

export const BLOCKER_DISMISS_REASONS = ["resolved", "ignored"] as const;
export type BlockerDismissReason = (typeof BLOCKER_DISMISS_REASONS)[number];

/** The `retire_reason` each user action stores. Distinct from every machine reason (`resolved_observed`, `resolved_later`, …) so they can be counted apart. */
export const BLOCKER_DISMISS_RETIRE_REASON: Record<BlockerDismissReason, string> = {
  resolved: USER_RESOLVED_RETIRE_REASON,
  ignored: USER_IGNORED_RETIRE_REASON,
};

export { CARRIED_SUFFIX } from "@/lib/domain/retire-reasons";

/** Rows the user's own click retired — the only carry-over match targets and the Dismissed list's rows. */
export const CLICKED_RETIRE_REASONS: readonly string[] = Object.values(BLOCKER_DISMISS_RETIRE_REASON);
/** Every user-dismissal reason, clicked or carried. */
export const USER_RETIRE_REASONS: readonly string[] = [
  ...CLICKED_RETIRE_REASONS,
  ...CLICKED_RETIRE_REASONS.map((r) => `${r}${CARRIED_SUFFIX}`),
];
/** The Dismissed list's rows and the carry-over match targets: the user's clicks plus agent resolutions (#436). */
const LISTED_RETIRE_REASONS: readonly string[] = [...CLICKED_RETIRE_REASONS, AGENT_RESOLVED_RETIRE_REASON];
/** What Undo may lift: every user-dismissal reason plus an agent's `memory_resolve` (#436), clicked or carried. */
export const UNDOABLE_RETIRE_REASONS: readonly string[] = [
  ...USER_RETIRE_REASONS,
  AGENT_RESOLVED_RETIRE_REASON,
  `${AGENT_RESOLVED_RETIRE_REASON}${CARRIED_SUFFIX}`,
];

interface ChainRow {
  id: string;
  recurs_of: string | null;
}

/** Ids of every row in `target`'s recurrence chain (transitive over `recurs_of`, either direction). Pure. */
export function chainMemberIds(targetId: string, rows: readonly ChainRow[]): string[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(id, root);
    return root;
  };
  const touch = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  touch(targetId);
  for (const r of rows) {
    touch(r.id);
    if (r.recurs_of) {
      touch(r.recurs_of);
      const a = find(r.id);
      const b = find(r.recurs_of);
      if (a !== b) parent.set(a, b);
    }
  }
  const root = find(targetId);
  const ids = new Set<string>([targetId]);
  for (const r of rows) if (find(r.id) === root) ids.add(r.id);
  return [...ids];
}

export type DismissBlockerOutcome = { ok: true; ids: string[] } | { ok: false };

/**
 * Retires the caller's live blocker `id` and every live member of its chain
 * (chains never cross projects, so only that project's live blockers are
 * read). `{ok: false}` when `id` is not a live blocker of the caller's.
 */
export async function dismissBlocker(
  supabase: Db,
  userId: string,
  id: string,
  reason: BlockerDismissReason,
): Promise<DismissBlockerOutcome> {
  return retireBlockerChain(supabase, userId, id, { retire_reason: BLOCKER_DISMISS_RETIRE_REASON[reason] });
}

/**
 * Retires the caller's live blocker `id` and every live member of its
 * recurrence chain with `fields` (retire_reason plus any receipt columns) and
 * one `retired_at`. Shared by Today's dismiss and the MCP memory_resolve tool
 * (#436). `codeProjectId` (a code-scoped key's bound) narrows the target.
 * `{ok: false}` when `id` is not a live blocker of the caller's — the same
 * answer whether the id is someone else's, retired, not a blocker, or absent.
 */
export async function retireBlockerChain(
  supabase: Db,
  userId: string,
  id: string,
  fields: { retire_reason: string; resolution_quote?: string; resolved_by_harness_session_id?: string | null },
  codeProjectId: string | null = null,
): Promise<DismissBlockerOutcome> {
  let targetQuery = supabase
    .from("session_memories")
    .select("id, code_project_id")
    .eq("user_id", userId)
    .eq("id", id)
    .eq("kind", "blocker")
    .is("retired_at", null);
  if (codeProjectId) targetQuery = targetQuery.eq("code_project_id", codeProjectId);
  const { data: target, error: targetErr } = await targetQuery.maybeSingle();
  if (targetErr) throw new Error(`blocker dismiss: read failed: ${targetErr.message}`);
  if (!target) return { ok: false };

  // code_project_id is NOT NULL (migration 084).
  const projectId = (target as { code_project_id: string }).code_project_id;
  const { data: rows, error: liveErr } = await supabase
    .from("session_memories")
    .select("id, recurs_of")
    .eq("user_id", userId)
    .eq("kind", "blocker")
    .eq("code_project_id", projectId)
    .is("retired_at", null);
  if (liveErr) throw new Error(`blocker dismiss: chain read failed: ${liveErr.message}`);

  const ids = chainMemberIds(id, (rows ?? []) as ChainRow[]);
  const { data: updated, error: updErr } = await supabase
    .from("session_memories")
    .update({ retired_at: new Date().toISOString(), ...fields })
    .eq("user_id", userId)
    .in("id", ids)
    .is("retired_at", null)
    .select("id");
  if (updErr) throw new Error(`blocker dismiss: update failed: ${updErr.message}`);
  const retired = ((updated ?? []) as { id: string }[]).map((r) => r.id);
  return retired.length > 0 ? { ok: true, ids: retired } : { ok: false };
}

/** Hops of `recurs_of` Undo follows to sightings carried after the dismissal. */
const UNDO_CHAIN_HOPS = 5;

/**
 * Lifts a user dismissal or an agent resolution (#436): only rows of the
 * caller's that one of `reasons` retired — the given ids, then any row a later
 * sighting carried onto them (`recurs_of` into the lifted set). The receipt
 * columns are cleared with it (they are null on a user dismissal already).
 * Returns every id lifted.
 */
export async function undoBlockerDismissal(
  supabase: Db,
  userId: string,
  ids: readonly string[],
  reasons: readonly string[] = UNDOABLE_RETIRE_REASONS,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const lift = async (column: "id" | "recurs_of", values: string[]): Promise<string[]> => {
    const { data, error } = await supabase
      .from("session_memories")
      .update({
        retired_at: null,
        retire_reason: null,
        resolution_quote: null,
        resolution_turn_idx: null,
        resolved_by_session_id: null,
        resolved_by_harness_session_id: null,
      })
      .eq("user_id", userId)
      .in(column, values)
      .in("retire_reason", [...reasons])
      .select("id");
    if (error) throw new Error(`blocker undo: update failed: ${error.message}`);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  };
  const lifted = await lift("id", [...ids]);
  let frontier = [...ids];
  for (let hop = 0; hop < UNDO_CHAIN_HOPS && frontier.length > 0; hop++) {
    frontier = await lift("recurs_of", frontier);
    lifted.push(...frontier);
  }
  return [...new Set(lifted)];
}

interface DismissedRow {
  id: string;
  text: string;
  quote: string | null;
  embedding: unknown;
  retired_at: string;
  retire_reason: string;
}

/**
 * The user's dismissal, carried onto freshly extracted blockers headed LIVE
 * and not already linked to a live chain. Match targets are ONLY rows the
 * user's own click retired (never a carried row — so the Resolved cut-off
 * can't drift forward and Ignore can't walk away by chained cosine hops).
 * Match rule = the recurrence linker's (write.ts dropCrossSessionDuplicates):
 * normalized text equal, or embedding cosine >= vectorThreshold("blocker_dismiss");
 * a record with no comparable embedding matches on normalized quote.
 * `user_ignored` always carries; `user_resolved` only when the sighting
 * (`sightingAt(record)`: its receipt turn's time, else the session's end) is
 * not after the click. A carried record is inserted retired
 * `<reason>:carried` with `recurs_of` = the clicked row, so Undo on that row
 * lifts it too. Retired inserts never bump `recurrence_count` (write.ts), so
 * "seen N×" after an Undo counts the chain's distinct sessions instead.
 * Best-effort: a failed read carries nothing.
 */
export async function carryUserDismissals<T extends InsertableRecord>(
  supabase: Db,
  userId: string,
  codeProjectId: string,
  sessionId: string,
  sightingAt: (record: T) => string | null,
  records: T[],
): Promise<{ records: T[]; carried: number }> {
  const eligible = (r: T) => r.kind === "blocker" && r.verified && !r.retireReason && !r.recursOf;
  if (!records.some(eligible)) return { records, carried: 0 };
  let dismissed: DismissedRow[];
  try {
    const { data, error } = await supabase
      .from("session_memories")
      .select("id, text, quote, embedding, retired_at, retire_reason")
      .eq("user_id", userId)
      .eq("code_project_id", codeProjectId)
      .eq("kind", "blocker")
      // #436: an agent's memory_resolve carries like "Resolved", so a --force re-run never revives it.
      .in("retire_reason", [...LISTED_RETIRE_REASONS])
      .order("retired_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    dismissed = (data ?? []) as DismissedRow[];
  } catch (err) {
    log.warn("memory: dismissed-blocker lookup failed — no dismissal carried", {
      user_id: userId,
      code_session_id: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { records, carried: 0 };
  }
  if (dismissed.length === 0) return { records, carried: 0 };

  const candidates = dismissed.map((d) => ({
    row: d,
    norm: normalizeForDedup(d.text),
    quoteNorm: d.quote ? normalizeForDedup(d.quote) : null,
    embedding: parseVector(d.embedding),
  }));
  const dismissCut = vectorThreshold("blocker_dismiss");
  let carried = 0;
  const out = records.map((r) => {
    if (!eligible(r)) return r;
    const seen = sightingAt(r);
    const at = seen ? Date.parse(seen) : Number.NaN;
    const applies = (d: DismissedRow) =>
      d.retire_reason === BLOCKER_DISMISS_RETIRE_REASON.ignored ||
      (Number.isFinite(at) && at <= Date.parse(d.retired_at));
    const norm = normalizeForDedup(r.text);
    const quoteNorm = r.quote ? normalizeForDedup(r.quote) : null;
    // L8: the cosine cut is calibrated per embedding family; an uncalibrated model matches on text/quote only.
    const vec = r.embedding && r.embedding.length > 0 && dismissCut !== null ? r.embedding : null;
    const match = candidates.find(
      (c) =>
        applies(c.row) &&
        (c.norm === norm ||
          (vec && c.embedding.length === vec.length
            ? cosineSimilarity(vec, c.embedding) >= (dismissCut ?? 1)
            : !!quoteNorm && c.quoteNorm === quoteNorm)),
    );
    if (!match) return r;
    carried++;
    return { ...r, retireReason: `${match.row.retire_reason}${CARRIED_SUFFIX}`, recursOf: match.row.id };
  });
  if (carried > 0) log.info("memory: user dismissal carried onto re-extracted blockers", { user_id: userId, carried });
  return { records: out, carried };
}

/** One click on Today: the chain rows it retired together (one update, one timestamp). */
export interface DismissedBlocker {
  ids: string[];
  text: string;
  quote: string | null;
  reason: BlockerDismissReason;
  dismissed_at: string;
  /** #436: true when an agent closed it through memory_resolve (shown as resolved; Restore lifts it). */
  by_agent?: true;
}

/**
 * The caller's clicked dismissals and agent resolutions (#436), newest first, one entry per click (rows
 * sharing project, reason and retired_at — dismissBlocker retires a chain in
 * one statement), so the Blockers "N dismissed" list can Restore any of them
 * after a reload. Carried rows are left out: Restore lifts them through
 * `recurs_of`.
 */
export async function listDismissedBlockers(supabase: Db, userId: string, limit = 50): Promise<DismissedBlocker[]> {
  const { data, error } = await supabase
    .from("session_memories")
    .select("id, code_project_id, text, quote, turn_role, retired_at, retire_reason, created_at")
    .eq("user_id", userId)
    .eq("kind", "blocker")
    .in("retire_reason", [...LISTED_RETIRE_REASONS])
    .order("retired_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`dismissed blockers read failed: ${error.message}`);
  const groups = new Map<string, DismissedBlocker & { newest: string }>();
  for (const r of (data ?? []) as Array<{
    id: string;
    code_project_id: string;
    text: string;
    quote: string | null;
    turn_role: string | null;
    retired_at: string;
    retire_reason: string;
    created_at: string;
  }>) {
    const key = `${r.code_project_id}\u0000${r.retire_reason}\u0000${r.retired_at}`;
    const reason: BlockerDismissReason =
      r.retire_reason === BLOCKER_DISMISS_RETIRE_REASON.ignored ? "ignored" : "resolved";
    const quote = r.turn_role === "user" && r.quote?.trim() ? r.quote.trim() : null;
    const g = groups.get(key);
    if (!g) {
      const byAgent = r.retire_reason === AGENT_RESOLVED_RETIRE_REASON ? { by_agent: true as const } : {};
      groups.set(key, {
        ids: [r.id],
        text: r.text,
        quote,
        reason,
        dismissed_at: r.retired_at,
        newest: r.created_at,
        ...byAgent,
      });
      continue;
    }
    g.ids.push(r.id);
    if (r.created_at > g.newest) Object.assign(g, { text: r.text, quote, newest: r.created_at });
  }
  return [...groups.values()].slice(0, limit).map(({ newest: _newest, ...g }) => g);
}
