/**
 * Blocker freshness (#436, maintainer ruling 2026-10-04: "a blocker older
 * than 7 days is old everywhere"). One window, read by every blocker reader:
 * the SessionStart preamble lines and its open_blockers outbox
 * (lib/memory/preamble.ts), the prompt-relevance outbox (relevance.ts),
 * memory_search and memory_recall (search.ts, recall.ts), Today's blockers
 * panel (lib/threads/queries.ts), the project page's "Open blockers" group
 * (session-memories-browse.ts), and the later-session auto-resolution
 * candidates (write/io.ts fetchLaterResolutionCandidates via tail-capture.ts).
 *
 * Nothing is deleted or retired by age: an old blocker stays a live row and is
 * only hidden when read. The /memories archive (listSessionMemories) and its
 * search still show it.
 *
 * The timestamp is `created_at`, the same one the preamble used before this
 * module: for a recurring blocker it is the newest live row of the chain, so a
 * blocker seen again is fresh again.
 */
import { ageText } from "./age";

/** A blocker whose `created_at` is more than this many days old is old on every surface. */
export const BLOCKER_FRESH_DAYS = 7;

/** The fields freshness reads. */
export interface BlockerFreshnessRow {
  kind: string;
  created_at: string;
}

/**
 * True for a non-blocker (the rule only narrows blockers) and for a blocker
 * whose `created_at` is at most BLOCKER_FRESH_DAYS before `now`. An
 * unparseable `created_at` counts as old (never shown by mistake). Pure.
 */
export function isFreshBlocker(row: BlockerFreshnessRow, now: number = Date.now()): boolean {
  if (row.kind !== "blocker") return true;
  const t = Date.parse(row.created_at);
  if (!Number.isFinite(t)) return false;
  return (now - t) / 86_400_000 <= BLOCKER_FRESH_DAYS;
}

/** The ISO lower bound on `created_at` for a fresh blocker — for `.gte("created_at", …)` reads. */
export function blockerFreshCutoff(now: number = Date.now()): string {
  return new Date(now - BLOCKER_FRESH_DAYS * 86_400_000).toISOString();
}

/** A blocker's age label, e.g. `3d ago` (the shared relative-age formatter). */
export function blockerAge(createdAt: string, now: number = Date.now()): string {
  return ageText(createdAt, now);
}
