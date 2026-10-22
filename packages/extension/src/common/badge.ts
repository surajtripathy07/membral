// Toolbar badge (goal 2026-07-26 step 2 — GitHub #63 silent-breakage class,
// #58 adjacent): the first-ever surfacing of sync freshness in the extension
// UI itself. Sourced from the existing SyncState.providers[id].lastSyncAt/
// lastSyncStatus (common/storage.ts) — no new storage shape needed.
//
// MV3 service-worker rules apply (CLAUDE.md): background.ts has no `document`
// etc., but chrome.action.* is available there, so the actual
// chrome.action.setBadgeText/setBadgeBackgroundColor calls live in
// refreshBadge() below, called from background.ts on sync-state changes and
// on service-worker startup.
import type { ProviderSyncState, SyncState } from "@membral/core";
import { getSettings, getSyncState, type Settings, updateProviderSyncState } from "./storage.js";

export interface BadgeSpec {
  /** Empty string clears the badge (chrome.action.setBadgeText contract). */
  text: string;
  /** Only meaningful when `text` is non-empty. */
  color: string;
}

/** A provider whose last successful sync is older than this counts as stale — well past any reasonable sync cadence, so it means the extension (or the account) has stopped working, not just "due soon." */
export const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

/**
 * MAJOR 4 fix (adversarial review): engine.ts writes lastSyncStatus:"syncing"
 * BEFORE its try block; an MV3 service-worker termination mid-sync (the
 * worker is killed, e.g. idle timeout or crash) leaves that status stuck
 * forever — nothing else ever runs to flip it to success/error. Since
 * computeBadgeSpec previously gave "syncing" unconditional priority, a stuck
 * sync would mask a real, ongoing failure behind a permanent "…" badge. A
 * provider still reporting "syncing" after this long is treated as NOT
 * currently syncing for badge purposes (falls through to the health check
 * below instead) — 10 minutes is generous headroom above any real sync's
 * expected duration.
 */
export const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

const SYNCING_COLOR = "#60a5fa";
const ERROR_COLOR = "#f87171";

/**
 * Is `p` stuck in "syncing" — i.e. reporting that status but with no
 * evidence a sync is still actually in flight? True when lastSyncStatus is
 * "syncing" AND either syncStartedAt is missing (pre-migration state — no
 * start time recorded, so there's no evidence it's still running) or older
 * than SYNC_TIMEOUT_MS. False for anything not currently "syncing" at all.
 */
export function isStaleSyncing(p: ProviderSyncState, now: Date = new Date()): boolean {
  if (p.lastSyncStatus !== "syncing") return false;
  if (!p.syncStartedAt) return true;
  const age = now.getTime() - new Date(p.syncStartedAt).getTime();
  return !Number.isFinite(age) || age > SYNC_TIMEOUT_MS;
}

/**
 * Pure badge-spec derivation from sync state (brief: "pure function taking
 * SyncState -> badge spec"; `enabledProviders` is threaded in too since
 * staleness/health is only evaluated over providers the user actually has
 * turned on — a disabled provider's stale/never state must never trigger the
 * badge).
 *
 *   - ANY enabled provider ACTIVELY syncing (status "syncing" AND not stale
 *     per isStaleSyncing) -> "…" / blue, takes priority over everything else
 *     (it's the most current truth about what's happening).
 *   - ELSE any enabled provider unhealthy (last status "error", OR a
 *     recorded lastSyncAt older than STALE_SYNC_MS) -> "!" / red. A STALE
 *     syncing provider is deliberately NOT unconditionally unhealthy by
 *     itself here (adversarial review, MAJOR 4 fix wording: it "falls
 *     through to the health check" rather than being special-cased) — it
 *     just stops counting as "actively syncing" above, so the ordinary
 *     error/staleness rule alone decides. A provider stuck syncing with a
 *     genuinely fine (or absent-but-otherwise-undecided) lastSyncAt reads as
 *     healthy; paired with an actually-stale lastSyncAt or another errored
 *     provider, the existing rule still turns it red.
 *   - ELSE (all enabled providers healthy, including a fresh install where
 *     every provider is still "never" with no lastSyncAt — nothing to warn
 *     about yet) -> empty badge.
 */
export function computeBadgeSpec(state: SyncState, enabledProviders: string[], now: Date = new Date()): BadgeSpec {
  const providers = enabledProviders.map((id) => state.providers[id]).filter((p): p is ProviderSyncState => Boolean(p));

  const activelySyncing = providers.some((p) => p.lastSyncStatus === "syncing" && !isStaleSyncing(p, now));
  if (activelySyncing) {
    return { text: "…", color: SYNCING_COLOR };
  }

  const isUnhealthy = (p: ProviderSyncState): boolean => {
    if (p.lastSyncStatus === "error") return true;
    // N4 (adversarial review): "cancelled" deliberately has NO explicit case
    // here. A user-requested cancellation is not itself a health problem --
    // the user chose to stop it. A cancelled provider's health is judged the
    // same way as any other non-actively-syncing state below: by how stale
    // its last successful lastSyncAt is. This is intentional, not a gap.
    if (!p.lastSyncAt) return false; // never synced yet — not an error, just not-started
    const age = now.getTime() - new Date(p.lastSyncAt).getTime();
    return Number.isFinite(age) && age > STALE_SYNC_MS;
  };

  if (providers.some(isUnhealthy)) {
    return { text: "!", color: ERROR_COLOR };
  }

  return { text: "", color: "" };
}

/**
 * Demote every provider stuck in a stale "syncing" (MAJOR 4 fix) to
 * "error" — called from background.ts's onStartup handler, the one point
 * where a service-worker restart is a certainty (the previous worker, if
 * it died mid-sync, is definitely gone by the time a new one starts up).
 * This is a belt-and-suspenders companion to computeBadgeSpec's own
 * stale-syncing handling: the badge already stops showing "…" for a stuck
 * provider without this, but the stored state stays literally "syncing"
 * (misleading to anything else that reads it, e.g. a future popup UI)
 * until something explicitly settles it.
 */
export async function demoteStaleSyncingProviders(now: Date = new Date()): Promise<void> {
  const state = await getSyncState();
  for (const [providerId, p] of Object.entries(state.providers)) {
    if (isStaleSyncing(p, now)) {
      await updateProviderSyncState(providerId, {
        lastSyncStatus: "error",
        lastError: "Sync did not complete (extension restarted mid-sync)",
        syncStartedAt: null,
      });
    }
  }
}

/** Read current sync state + settings, compute the badge spec, and apply it via chrome.action. Called from background.ts on every sync-state change and on service-worker startup. MINOR 3 fix (adversarial review): chrome.action is guarded — some (rare, mis-packaged) contexts this module loads in may not have it, and a badge failure must never throw into a caller that isn't expecting it. */
export async function refreshBadge(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.action) return;
  const [state, settings]: [SyncState, Settings] = await Promise.all([getSyncState(), getSettings()]);
  const spec = computeBadgeSpec(state, settings.enabledProviders || []);
  await chrome.action.setBadgeText({ text: spec.text });
  if (spec.text) {
    await chrome.action.setBadgeBackgroundColor({ color: spec.color });
  }
}
