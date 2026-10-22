/**
 * Shared delta-sync helpers (goal 2026-07-26 step 15, #27/#57).
 *
 * Pulled out of providers/chatgpt.ts + providers/claude.ts so the cursor /
 * pagination-stop-condition / changed-vs-known partitioning logic is a set
 * of small pure functions — independently testable, and shared between
 * providers instead of duplicated per-provider.
 */

export interface ConvStub {
  id: string;
  /** ISO 8601, or null if the provider gave nothing usable. */
  updatedAtIso: string | null;
}

/**
 * Mutable out-param both providers' fetchConversationList use to report
 * whether the runaway page-count guard (MAX_LIST_PAGES) fired
 * (adversarial-review NOTE, #120) -- a separate optional out-param rather
 * than a return-shape change, so the existing pagination unit tests that
 * treat fetchConversationList's return value as a plain array are
 * unaffected. engine.ts uses this to avoid persisting a sync-window floor
 * that was requested but never actually confirmed reached.
 */
export interface ListTruncationFlag {
  truncated: boolean;
}

/**
 * ChatGPT's `update_time` is epoch seconds (CLAUDE.md "Extension Runtime
 * Rules": always convert to ISO before comparing with stored ISO
 * timestamps); Claude's `updated_at` is already ISO 8601. Both provider
 * modules funnel their raw timestamp through this so cursor comparisons
 * never mix units. Returns null for anything unparseable so callers can
 * decide how to treat "no usable timestamp" explicitly rather than let a
 * NaN silently poison a Date comparison.
 */
export function toIsoTimestamp(raw: string | number | null | undefined, epochSeconds: boolean): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const d = epochSeconds && typeof raw === "number" ? new Date(raw * 1000) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * True when `updatedAtIso` is at-or-before `cursor` — i.e. already covered
 * by the cursor's high-water mark, so paginated listing can stop here (the
 * provider lists newest-updated first, per both providers' list endpoints).
 *
 * - A null/missing cursor means "no cursor yet" (first-ever or forced full
 *   sync) — never stops paging.
 * - B2 fix (adversarial review): a null/unparseable `updatedAtIso` (a
 *   provider entry with no usable timestamp) is NEVER treated as "at or
 *   before" — the old behavior (treating it as old) meant a single
 *   malformed entry mid-page would both drop that item AND falsely signal
 *   "we've reached old data," truncating the rest of an otherwise-newer
 *   page and stopping pagination entirely. An item we can't prove is old
 *   must be included and must never be a stop signal; MN1's whole-page stop
 *   condition + page cap are the runaway-pagination guard instead of this
 *   function pretending to know something it doesn't.
 */
export function isAtOrBeforeCursor(updatedAtIso: string | null, cursor: string | null): boolean {
  if (!cursor) return false;
  if (!updatedAtIso) return false;
  return new Date(updatedAtIso).getTime() <= new Date(cursor).getTime();
}

/**
 * Per-provider high-water mark, derived ONLY from the CLOUD manifest DATA
 * (B1 fix, adversarial review) — never merged with a local/wall-clock
 * fallback. The manifest reflects what the cloud has actually confirmed
 * ingested, so it always governs when it has an entry for this provider,
 * even if a local timestamp (e.g. sync-completion wall-clock) claims to be
 * later — a wall clock advances every cycle regardless of whether anything
 * was truly ingested, which is exactly the defect this replaces. `idMap` is
 * keyed "source:source_id" -> updated_at, exactly as produced by
 * cloud-manifest.ts's getCloudIdMap. Returns null when the manifest has
 * nothing for this provider (true fresh start, or a provider the cloud
 * hasn't seen yet) — callers needing a local-data fallback for that case
 * use `maxKnownUpdatedAt` over local storage instead (never lastSyncAt).
 * The caller is also responsible for applying `applyCursorOverlap` — this
 * function returns the raw high-water mark only.
 */
export function computeCursor(idMap: Map<string, string>, providerId: string): string | null {
  const prefix = `${providerId}:`;
  let manifestMax: string | null = null;
  for (const [key, updatedAt] of idMap) {
    if (!key.startsWith(prefix) || !updatedAt) continue;
    if (manifestMax === null || new Date(updatedAt).getTime() > new Date(manifestMax).getTime()) {
      manifestMax = updatedAt;
    }
  }
  return manifestMax;
}

/**
 * Data-derived high-water mark from LOCAL storage only (B1 fix, adversarial
 * review) — used when there is no cloud auth at all, so engine.ts has a
 * DATA-derived fallback instead of degrading to the wall-clock
 * `providerState.lastSyncAt` (sync-completion time, not data: a
 * conversation updated during the sync window would land behind it and be
 * skipped forever).
 */
export function maxKnownUpdatedAt(known: Map<string, string>): string | null {
  let max: string | null = null;
  for (const updatedAt of known.values()) {
    if (!updatedAt) continue;
    if (max === null || new Date(updatedAt).getTime() > new Date(max).getTime()) {
      max = updatedAt;
    }
  }
  return max;
}

/**
 * Safety overlap subtracted from any computed cursor before it's used to
 * list/stop-paging (B1 fix, adversarial review): even a purely data-derived
 * cursor can miss a conversation that was updated WHILE the previous sync
 * cycle was still running — that update's timestamp could land at or before
 * the cursor this cycle computes, since the cursor is only as fresh as the
 * last completed cycle's data. Subtracting a fixed window re-lists a small
 * amount of already-seen history so in-flight-during-sync updates and clock
 * skew get picked up again rather than silently vanishing forever.
 * partitionByChangeStatus makes this cheap: re-listed-but-unchanged ids skip
 * the expensive full-payload fetch, only the (already-cheap) listing walks a
 * few extra items. A null cursor (no cursor yet) stays null.
 */
export const CURSOR_OVERLAP_MS = 15 * 60 * 1000;

export function applyCursorOverlap(cursor: string | null, overlapMs: number = CURSOR_OVERLAP_MS): string | null {
  if (!cursor) return null;
  return new Date(new Date(cursor).getTime() - overlapMs).toISOString();
}

/**
 * Sync-window helpers (#120): the extension now fetches only conversations
 * updated within a configurable rolling window (common/constants.ts's
 * SYNC_WINDOW_PRESETS, default 30 days) instead of a provider's entire
 * history on first sync. All three functions below are pure and reuse the
 * SAME "at or before X -- stop paging / exclude" semantics as the existing
 * delta cursor (isAtOrBeforeCursor above), so the window floor plugs into
 * fetchConversationList's existing pagination-stop-and-inclusion-filter
 * mechanism as just another cutoff value -- no per-provider changes needed.
 */

/**
 * The absolute ISO cutoff for a window of `days` back from `now` (real
 * current time by default). `days === null` means "All history" -- no
 * floor at all.
 */
export function computeSyncWindowCutoff(days: number | null, now: Date = new Date()): string | null {
  if (days === null) return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Combine two independent "at or before X" cutoffs (the delta cursor and
 * the sync-window floor) into the single boundary fetchConversationList's
 * stop condition should use. `null` means "no restriction" (never stops --
 * pages to the true beginning): when one side is null, the OTHER side is
 * the whole restriction; when both restrict, pagination must stop as soon
 * as EITHER alone would justify stopping, i.e. the LATER (more recent, so
 * tighter) of the two.
 */
export function laterCutoff(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/**
 * True when `newCutoff` reaches further into the past than `oldCutoff` --
 * the user widened the sync window (e.g. 30 days -> 90 days/All), so the
 * NEXT sync must backfill the newly-included older range rather than trust
 * the delta cursor's "everything before this is already known" assumption,
 * which only holds back to whatever floor was actually enforced last time
 * (a plain delta cursor is the single most-recently-updated conversation's
 * timestamp -- combined naively via laterCutoff it would make pagination
 * stop almost immediately and never reach the newly-widened range at all).
 *
 * `oldCutoff === null` means a floor has been CONFIRMED absent -- either a
 * provider explicitly recorded as having full/no-floor coverage already, or
 * (per this function's own contract) the caller's own "no prior sync"
 * degenerate case where nothing is known at all locally. This function only
 * ever sees that confirmed `null`, never "no record exists yet": the two
 * are NOT the same thing, and conflating them was a MAJOR bug (adversarial
 * review, #120) -- a reinstall/second device with an EMPTY local provider
 * state (no record exists, i.e. `undefined` on the caller's
 * `syncWindowFloorIso`) can still get a non-null delta cursor from the
 * cloud manifest (another device's data), and that cursor's "everything
 * before this is already known" assumption has never actually been
 * verified against the window. engine.ts is responsible for telling
 * `undefined` (unknown coverage -- do NOT call this function with `null`
 * for that case; treat it as a widen directly) apart from a confirmed `null`
 * BEFORE calling this function; only the confirmed case reaches here.
 * `newCutoff === null` ("All history") is always a widen relative to any
 * real prior floor.
 */
export function isWideningSyncWindow(oldCutoff: string | null, newCutoff: string | null): boolean {
  if (oldCutoff === null) return false;
  if (newCutoff === null) return true;
  return new Date(newCutoff).getTime() < new Date(oldCutoff).getTime();
}

export interface DeltaPartition {
  newIds: string[];
  updatedIds: string[];
  unchangedIds: string[];
}

/**
 * Partition a page of listed conversations into new / updated / unchanged
 * against `known` (id -> last known updated_at ISO string, merged by the
 * caller from local storage + the cloud manifest).
 *
 * - Absent from `known` -> new.
 * - Present, with a strictly newer `updatedAtIso` -> updated (must be
 *   re-fetched even though the id is already known — e.g. a conversation
 *   that got a new message since we last saw it).
 * - Present, with no usable `updatedAtIso` from this listing -> treated as
 *   updated too: we can't prove it's unchanged, and silently skipping a
 *   known id on missing data would be a quiet drop.
 * - Present, with an equal-or-older timestamp -> unchanged, safe to skip
 *   the (expensive) full-payload fetch for.
 */
export function partitionByChangeStatus(listed: ConvStub[], known: Map<string, string>): DeltaPartition {
  const newIds: string[] = [];
  const updatedIds: string[] = [];
  const unchangedIds: string[] = [];

  for (const conv of listed) {
    const knownUpdatedAt = known.get(conv.id);
    if (knownUpdatedAt === undefined) {
      newIds.push(conv.id);
      continue;
    }
    if (!conv.updatedAtIso) {
      updatedIds.push(conv.id);
      continue;
    }
    if (new Date(conv.updatedAtIso).getTime() > new Date(knownUpdatedAt).getTime()) {
      updatedIds.push(conv.id);
    } else {
      unchangedIds.push(conv.id);
    }
  }

  return { newIds, updatedIds, unchangedIds };
}
