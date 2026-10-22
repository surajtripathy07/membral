import { getAccessToken } from "../auth/auth.js";
import { resolveSyncWindowDays } from "../common/constants.js";
import {
  getConversationCountByProvider,
  getKnownUpdatedAtByProvider,
  getSettings,
  getSyncState,
  saveConversationsBatch,
  setLastFullSyncAt,
  updateProviderSyncState,
} from "../common/storage.js";
import type { IsCancelled, OnBatchCallback, ProviderSyncResult, SyncProgress } from "../common/types.js";
import { provider as chatgptProvider } from "../providers/chatgpt.js";
import { provider as claudeProvider } from "../providers/claude.js";
import { getCloudIdMap } from "./cloud-manifest.js";
import { getCloudUrl } from "./cloud-push.js";
import {
  applyCursorOverlap,
  computeCursor,
  computeSyncWindowCutoff,
  isWideningSyncWindow,
  laterCutoff,
  maxKnownUpdatedAt,
} from "./delta.js";

interface ProviderModule {
  id: string;
  name: string;
  sync: (
    sinceTimestamp: string | null,
    onProgress: (p: SyncProgress) => void,
    onBatch: OnBatchCallback,
    retryIds: string[] | undefined,
    known: Map<string, string> | undefined,
    isCancelled: IsCancelled | undefined,
  ) => Promise<ProviderSyncResult>;
}

interface SyncResult {
  success: boolean;
  count: number;
  error?: string;
  cancelled?: boolean;
}

interface EngineProgress extends SyncProgress {
  providerId: string;
}

export interface SyncOptions {
  /**
   * Bypass the cursor entirely and re-list every conversation from the
   * provider (goal 2026-07-26 step 15, #27/#57 requirement 5) — the
   * explicit manual "reconciliation backstop" surfaced on the options page.
   * The default sync button/schedule path never sets this; it stays a
   * delta sync. Reuses partitionByChangeStatus with an empty `known` map so
   * every listed conversation counts as "new" and nothing is skipped
   * (full-payload re-fetch on every listed id, catching drift the cursor
   * or a locally-corrupted copy would otherwise hide).
   */
  forceFull?: boolean;
}

const PROVIDER_MODULES: Record<string, ProviderModule> = {
  claude: claudeProvider,
  chatgpt: chatgptProvider,
};

let syncLock: Promise<unknown> | null = null;

// --- Cancellation (CLAUDE.md "Cancel mechanism" rule) ---
//
// A single module-level flag, not per-provider: cancelling mid-sync should
// stop the WHOLE run (remaining providers in a multi-provider syncAll too),
// not just the provider currently in flight. Reset once at the top of each
// top-level run (syncAll's run(), or syncOne standalone) — never inside
// syncProvider itself, or a multi-provider run would forget a cancellation
// requested while provider A was still finishing up before provider B started.
let cancelRequested = false;

/** Request cancellation of whatever sync is currently in flight. Safe to call with nothing running (no-op). */
export function requestCancel(): void {
  console.log("Sync: cancellation requested");
  cancelRequested = true;
}

function isCancelled(): boolean {
  return cancelRequested;
}

async function syncProvider(
  providerId: string,
  onProgress: (p: EngineProgress) => void,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const providerModule = PROVIDER_MODULES[providerId];
  if (!providerModule) return { success: false, count: 0, error: `Unknown provider: ${providerId}` };

  if (cancelRequested) {
    return { success: false, count: 0, error: "Cancelled by user", cancelled: true };
  }

  const state = await getSyncState();
  const providerState = state.providers[providerId] || {};
  const retryIds = providerState.failedIds || [];

  // MAJOR 4 fix (goal 2026-07-26 step 2, #63/#58, adversarial review):
  // syncStartedAt lets badge.ts detect a "syncing" status that never
  // resolved (MV3 service-worker termination mid-sync leaves nothing to
  // ever flip it to success/error) and stop treating it as currently
  // syncing after SYNC_TIMEOUT_MS.
  await updateProviderSyncState(providerId, {
    lastSyncStatus: "syncing",
    lastError: null,
    syncStartedAt: new Date().toISOString(),
  });

  try {
    const onBatch: OnBatchCallback = (convos) => saveConversationsBatch(convos);

    // Cursor + known-state (goal 2026-07-26 step 15, #27/#57 requirements
    // 1-3): forceFull ignores both entirely -- null cursor means "list
    // everything," an empty known map means partitionByChangeStatus treats
    // every listed id as new, so nothing gets skipped. forceFull is also the
    // one path deliberately exempt from the sync-window floor below (#120):
    // it's the explicit "Full Re-scrape (reconciliation backstop)" escape
    // hatch, already documented on the options page as re-listing EVERY
    // conversation to catch drift the cursor might have missed -- narrowing
    // that to the window too would silently make it not actually do what it
    // says, and would defeat its purpose of catching drift that predates the
    // window.
    let sinceTimestamp: string | null = null;
    let known = new Map<string, string>();
    // Only set (non-undefined) on the !forceFull path below -- forceFull
    // leaves the provider's stored sync-window floor untouched (`undefined`
    // is stripped by updateProviderSyncState's partial-update merge).
    let newWindowFloorIso: string | null | undefined;

    if (!opts.forceFull) {
      const localKnown = await getKnownUpdatedAtByProvider(providerId);
      known = localKnown;

      const token = await getAccessToken();
      if (token) {
        const cloudUrl = await getCloudUrl();
        const cloudIdMap = await getCloudIdMap(localKnown.size, token, cloudUrl);
        const prefix = `${providerId}:`;
        for (const [key, updatedAt] of cloudIdMap) {
          if (!key.startsWith(prefix)) continue;
          const id = key.slice(prefix.length);
          const existing = known.get(id);
          if (!existing || new Date(updatedAt).getTime() > new Date(existing).getTime()) {
            known.set(id, updatedAt);
          }
        }
        // B1 fix (adversarial review): cursor is seeded from the CLOUD
        // MANIFEST DATA ONLY -- never merged with local wall-clock
        // lastSyncAt, which used to win outright regardless of whether the
        // cloud had actually confirmed ingesting anything from this cycle. A
        // wiped/reinstalled extension self-heals from what the cloud has
        // already confirmed ingested; lastSyncAt is not consulted here at
        // all anymore.
        // Follow-up fix (round-2 adversarial review): computeCursor returns
        // null when the manifest is empty/unavailable for this provider
        // (fresh login that never pushed yet, or a failed manifest fetch
        // with nothing cached) -- with a cloud token but no manifest data,
        // that null cursor previously made EVERY cycle re-list the whole
        // corpus. Fall back to the local-data-derived max (never the
        // wall-clock lastSyncAt, per B1) so a token-but-no-manifest cycle
        // still gets a real cursor.
        sinceTimestamp = computeCursor(cloudIdMap, providerId) ?? maxKnownUpdatedAt(localKnown);
      } else {
        // No cloud auth -- degrade to a cursor derived from LOCAL DATA (the
        // max updated_at already stored locally), never the wall-clock
        // lastSyncAt (B1 fix, local-only variant of the same defect):
        // lastSyncAt is sync-COMPLETION time, not data, so a conversation
        // updated while the sync was still running would land behind it and
        // be skipped forever.
        sinceTimestamp = maxKnownUpdatedAt(localKnown);
      }

      // B1 fix (adversarial review): subtract a fixed safety overlap from
      // whatever cursor was just computed, cloud- or local-derived alike, so
      // a conversation updated WHILE the previous sync cycle was still
      // running gets re-listed instead of silently skipped forever.
      // partitionByChangeStatus makes the re-list cheap (unchanged ids skip
      // the full-payload fetch).
      const deltaCursor = applyCursorOverlap(sinceTimestamp);

      // Sync window (#120): fold the window floor into the same "pagination
      // stop / item-exclusion" boundary the delta cursor already uses
      // (isAtOrBeforeCursor) -- no per-provider changes needed, listing just
      // gets a smarter combined cutoff.
      const settings = await getSettings();
      const windowDays = resolveSyncWindowDays(settings.syncWindowDays);
      const windowCutoffIso = computeSyncWindowCutoff(windowDays);
      // MAJOR fix (adversarial review): `providerState.syncWindowFloorIso`
      // MUST be read raw, NOT `?? null`'d away here -- `undefined` ("never
      // recorded a floor for this provider") and `null` ("explicitly
      // recorded: confirmed full/no-floor coverage") mean fundamentally
      // different things, and collapsing them together was the bug: a
      // reinstall/second device has an EMPTY local provider state
      // (undefined) but can still get a non-null `deltaCursor` from the
      // cloud manifest (another device's data) -- treating that as "null =
      // nothing to widen into" made isWideningSyncWindow say "not a widen,"
      // so laterCutoff(deltaCursor, windowCutoffIso) picked the manifest's
      // recent cursor and skipped straight past the entire window's older
      // range, THEN persisted windowCutoffIso as the confirmed floor below
      // -- recording coverage that was never actually verified, permanently
      // (a later widen could never re-trigger, since the floor now looked
      // legitimate). The 30-day default makes this the NORMAL case for any
      // reinstall/second device with existing cloud coverage, not an edge
      // case.
      const storedFloor = providerState.syncWindowFloorIso;
      const widening =
        storedFloor === undefined
          ? // Never recorded: coverage back to the window is UNKNOWN, not
            // "everything." A null deltaCursor (truly nothing known
            // anywhere -- real fresh start) doesn't need the override:
            // laterCutoff(null, windowCutoffIso) already reduces to
            // windowCutoffIso on its own. But a non-null deltaCursor (e.g.
            // cloud manifest data on a wiped/reinstalled local install) has
            // an unvalidated "everything before this is already known"
            // assumption -- treat this first cycle the same as a widen so
            // the floor persisted below is actually truthful.
            deltaCursor !== null
          : isWideningSyncWindow(storedFloor, windowCutoffIso);

      if (widening) {
        // Widen (or unknown-coverage first cycle): the delta cursor's
        // "everything before this is already known" assumption only holds
        // back to the PREVIOUS confirmed floor -- combining it with the new
        // (wider, or unverified) window via laterCutoff would make
        // pagination stop almost immediately (the cursor is normally far
        // more recent than any window floor) and never reach the
        // newly-included older range at all. Drop the cursor for this one
        // cycle and page down to the floor instead; already-known
        // conversations in the overlap region still get skipped from the
        // expensive full-payload fetch by partitionByChangeStatus inside
        // providerModule.sync (only the cheap listing calls re-walk that
        // range).
        sinceTimestamp = windowCutoffIso;
      } else {
        sinceTimestamp = laterCutoff(deltaCursor, windowCutoffIso);
      }
      newWindowFloorIso = windowCutoffIso;
    }

    const result = await providerModule.sync(
      sinceTimestamp,
      (progress) => {
        onProgress({ providerId, ...progress });
      },
      onBatch,
      retryIds,
      known,
      isCancelled,
    );

    const totalCount = await getConversationCountByProvider(providerId);

    if (result.cancelled) {
      // Deliberately do NOT advance lastSyncAt (the cursor) here: pagination
      // itself may have been cut short before reaching the true old
      // boundary, so a later page of newer-than-old-cursor conversations may
      // never have been listed. Advancing the cursor to "now" would make
      // the next sync's stop-condition think those are already covered and
      // silently drop them forever.
      //
      // M1 fix (adversarial review): failedIds is the UNION of the previous
      // retry queue (retryIds, read at the top of this function) and
      // whatever this cycle's result reports -- a cancellation during
      // LISTING (before the per-conversation loop even starts) returns an
      // empty result.failedIds, and naively using that alone would silently
      // wipe out a retry queue this cycle never got a chance to touch.
      const mergedFailedIds = Array.from(new Set([...retryIds, ...result.failedIds]));
      await updateProviderSyncState(providerId, {
        lastSyncStatus: "cancelled",
        lastError: "Sync cancelled by user",
        conversationCount: totalCount,
        failedIds: mergedFailedIds.length > 0 ? mergedFailedIds : null,
        syncStartedAt: null,
        lastDeltaNew: result.newCount,
        lastDeltaUpdated: result.updatedCount,
      });
      return { success: false, count: result.conversations.length, error: "Cancelled by user", cancelled: true };
    }

    // NOTE fix (adversarial review): the runaway page-count guard
    // (MAX_LIST_PAGES) firing during listing means pagination stopped
    // WITHOUT confirming it actually reached `sinceTimestamp` -- persisting
    // `newWindowFloorIso` as the achieved floor in that case would durably
    // record coverage that was never actually verified, and a later widen
    // could never re-trigger to fix it (the stored floor would look
    // legitimate). Applies regardless of whether this particular cycle was
    // a widen -- a truncated LISTING never confirms full coverage down to
    // whatever `sinceTimestamp` it was given, widen or not. Leave the
    // previously-stored floor untouched (undefined -- stripped by
    // updateProviderSyncState) so the next cycle re-attempts from the same
    // starting point.
    if (result.listTruncated) {
      console.warn(`Sync (${providerId}): listing was truncated by the page-count guard -- window floor not advanced`);
      newWindowFloorIso = undefined;
    }

    await updateProviderSyncState(providerId, {
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: "success",
      lastError: null,
      conversationCount: totalCount,
      // Not cancelled -- every retryId was actually attempted this cycle (it
      // was merged into convList unless already present), so result.failedIds
      // alone is the accurate up-to-date set; no union needed here.
      failedIds: result.failedIds.length > 0 ? result.failedIds : null,
      syncStartedAt: null,
      lastDeltaNew: result.newCount,
      lastDeltaUpdated: result.updatedCount,
      // Sync window (#120): record the floor actually enforced this cycle
      // (undefined/stripped on forceFull, or when listing was truncated
      // above, both of which leave it untouched) so the next cycle can
      // detect a widen. Never advanced on cancellation (the
      // `result.cancelled` branch above returns before reaching here) --
      // pagination may not have actually reached this floor yet.
      syncWindowFloorIso: newWindowFloorIso,
    });

    return { success: true, count: result.conversations.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Sync failed for ${providerId}:`, err);

    await updateProviderSyncState(providerId, {
      lastSyncStatus: "error",
      lastError: message,
      syncStartedAt: null,
    });

    return { success: false, count: 0, error: message };
  }
}

/**
 * Run sync across all enabled providers.
 * Each provider runs independently -- one failure does not block others.
 */
export async function syncAll(
  onProgress: (p: EngineProgress) => void = () => {},
  opts: SyncOptions = {},
): Promise<{ results: Record<string, SyncResult> }> {
  if (syncLock) {
    console.warn("Sync already in progress — skipping");
    return { results: {} };
  }

  const run = async () => {
    cancelRequested = false;
    const settings = await getSettings();
    const enabledProviders = settings.enabledProviders || [];
    const results: Record<string, SyncResult> = {};

    for (const providerId of enabledProviders) {
      if (cancelRequested) {
        console.log(`Sync: cancelled before starting ${providerId}`);
        break;
      }
      onProgress({ providerId, status: "starting", detail: `Starting ${providerId} sync...` });
      results[providerId] = await syncProvider(providerId, onProgress, opts);
    }

    await setLastFullSyncAt(new Date().toISOString());

    return { results };
  };

  syncLock = run();
  try {
    return (await syncLock) as { results: Record<string, SyncResult> };
  } finally {
    syncLock = null;
  }
}

/**
 * Sync a single provider by id.
 *
 * N2 fix (adversarial review): must take `syncLock` just like syncAll --
 * previously syncOne ignored the lock entirely, so it could run concurrently
 * with a syncAll (or another syncOne) already in flight, AND it unconditionally
 * reset the single module-level `cancelRequested` flag, which could wipe out a
 * cancellation someone had just requested for that OTHER already-running
 * sync. The flag is only reset once this call actually acquires the lock.
 */
export async function syncOne(
  providerId: string,
  onProgress: (p: EngineProgress) => void = () => {},
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (syncLock) {
    console.warn("Sync already in progress — skipping");
    return { success: false, count: 0, error: "Sync already in progress" };
  }

  const run = async () => {
    cancelRequested = false;
    return syncProvider(providerId, onProgress, opts);
  };

  syncLock = run();
  try {
    return (await syncLock) as SyncResult;
  } finally {
    syncLock = null;
  }
}
