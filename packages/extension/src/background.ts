import type { Conversation } from "@membral/core";
import { demoteStaleSyncingProviders, refreshBadge } from "./common/badge.js";
import { STORAGE_KEYS, SYNC_ALARM_NAME, SYNC_INTERVAL_MINUTES } from "./common/constants.js";
import {
  getAllConversationsForExport,
  getSettings,
  getSyncState,
  migrateStorageKeys,
  saveConversationsBatch,
  updateProviderSyncState,
} from "./common/storage.js";
import { autoExportIfEnabled } from "./sync/auto-export.js";
import { getCloudSyncStatus, pushToCloud } from "./sync/cloud-push.js";
import { requestCancel, syncAll, syncOne } from "./sync/engine.js";
import { exportAsJson } from "./sync/exporter.js";

// --- Toolbar badge (goal 2026-07-26 step 2, #63/#58) ---
//
// The badge is a pure function of storage (common/badge.ts's computeBadgeSpec
// over SyncState + Settings), so a single chrome.storage.onChanged listener
// covers every writer (this file's own updateProviderSyncState calls,
// engine.ts's per-provider syncProvider, the popup's manual sync trigger)
// without needing to sprinkle refreshBadge() calls at every call site.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE_KEYS.SYNC_STATE] || changes[STORAGE_KEYS.SETTINGS]) {
    refreshBadge().catch((err) => console.error("Badge refresh failed:", err));
  }
});

// MAJOR 3 fix (round-2 adversarial review, goal 2026-07-26 step 2, #63/#58):
// onInstalled/onStartup only fire on an actual extension install or a full
// BROWSER startup — an MV3 service worker is torn down and re-woken far more
// often than that (a new tab activating an event listener, an alarm firing,
// etc.), and background.ts's top-level module body re-runs on every one of
// those wakes. Without a badge refresh HERE, a badge left in a wrong state by
// a worker that got killed mid-computation (or before onChanged fired) could
// sit wrong until the next storage write or full browser restart — for a
// terminated-during-sync worker specifically, that could be up to the alarm's
// 24h cadence. This call makes every wake self-correcting.
refreshBadge().catch((err) => console.error("Badge refresh failed:", err));

// --- Alarm Setup ---

chrome.runtime.onInstalled.addListener(async () => {
  console.log("Membral installed");
  await migrateStorageKeys();
  await setupAlarm();
  await refreshBadge().catch((err) => console.error("Badge refresh failed:", err));
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("Membral started");
  await migrateStorageKeys();
  // MAJOR 4 fix (goal 2026-07-26 step 2, #63/#58): onStartup is the one
  // point a service-worker restart is a certainty — if the previous worker
  // died mid-sync, this is where its stuck "syncing" state gets settled to
  // "error" rather than lingering forever. Never let this block the rest of
  // startup (alarm setup, badge) if it fails for some reason.
  await demoteStaleSyncingProviders().catch((err) => console.error("Stale-syncing demotion failed:", err));
  await setupAlarm();
  await refreshBadge().catch((err) => console.error("Badge refresh failed:", err));
});

async function setupAlarm(): Promise<void> {
  const settings = await getSettings();
  const intervalMinutes = settings.syncIntervalMinutes || SYNC_INTERVAL_MINUTES;

  await chrome.alarms.clear(SYNC_ALARM_NAME);
  chrome.alarms.create(SYNC_ALARM_NAME, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes,
  });
  console.log(`Sync alarm set: every ${intervalMinutes} minutes`);
}

// --- Alarm Handler ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    console.log("Alarm fired: starting scheduled sync");
    // MAJOR 3 fix (round-2 adversarial review): the alarm is the OTHER
    // regular point (besides onStartup and the top-level module-init call
    // above) where a stuck "syncing" state matters most — it's about to
    // start a fresh sync for possibly the SAME provider that got stuck last
    // time, so settle any leftover stale "syncing" first rather than let a
    // new cycle start on top of confused state. Never let this block the
    // actual sync if it fails for some reason.
    await demoteStaleSyncingProviders().catch((err) => console.error("Stale-syncing demotion failed:", err));
    try {
      const results = await syncAll((progress) => {
        console.log(`[${progress.providerId}] ${progress.status}: ${progress.detail}`);
      });
      console.log("Scheduled sync complete:", results);

      const totalSynced = Object.values(results.results).reduce((sum, r) => sum + r.count, 0);
      // MAJOR 2 fix (goal 2026-07-26 step 2, #63/#58): providers whose cycle
      // completed successfully this run, even with zero new conversations —
      // pushToCloud still reports these as `sources` so a quiet-but-healthy
      // provider gets its freshness heartbeat, not just providers that found
      // something new. A FAILED provider is deliberately excluded: reporting
      // it as a source would tell the server "checked, all quiet" when it
      // actually never completed a check at all.
      const successfulProviderIds = Object.entries(results.results)
        .filter(([, r]) => r.success)
        .map(([id]) => id);
      if (totalSynced > 0 || successfulProviderIds.length > 0) {
        const allConversations = await getAllConversationsForExport();
        const cloudResult = await pushToCloud(allConversations, successfulProviderIds);
        if (cloudResult.pushed) {
          console.log(`Cloud push: synced ${cloudResult.synced} conversations`);
        } else if (cloudResult.error) {
          console.warn("Cloud push failed:", cloudResult.error);
        }
        const cloudStatus = await getCloudSyncStatus();
        chrome.runtime.sendMessage({ action: "cloudSyncStatus", ...cloudStatus }).catch(() => {});
      }

      const exportResult = await autoExportIfEnabled();
      if (exportResult.exported) {
        console.log("Auto-exported to:", exportResult.path);
      }
    } catch (err) {
      console.error("Scheduled sync failed:", err);
    }
  }
});

// --- Message Handler (popup communication) ---

interface MessageRequest {
  action: string;
  providerId?: string;
  data?: unknown;
  /** Reconciliation-backstop flag (goal 2026-07-26 step 15, #27/#57 requirement 5) — bypasses the delta cursor for an explicit manual full re-scrape. Never set by the default sync button/schedule path. */
  forceFull?: boolean;
}

chrome.runtime.onMessage.addListener(
  (request: MessageRequest, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    handleMessage(request)
      .then(sendResponse)
      .catch((err: Error) => {
        sendResponse({ error: err.message });
      });
    return true; // Keep channel open for async
  },
);

async function handleMessage(request: MessageRequest): Promise<unknown> {
  switch (request.action) {
    case "getSyncState":
      return getSyncState();

    case "syncAll": {
      const syncResults = await syncAll(
        (progress) => {
          chrome.runtime
            .sendMessage({
              action: "syncProgress",
              ...progress,
            })
            .catch(() => {}); // Popup may be closed
        },
        { forceFull: request.forceFull },
      );

      const allConversations = await getAllConversationsForExport();
      // MAJOR 2 fix (goal 2026-07-26 step 2, #63/#58) — see the alarm handler
      // above for why only successful providers are reported as sources.
      const successfulProviderIds = Object.entries(syncResults.results)
        .filter(([, r]) => r.success)
        .map(([id]) => id);
      const cloudResult = await pushToCloud(allConversations, successfulProviderIds);
      if (cloudResult.pushed) {
        console.log(`Cloud push: synced ${cloudResult.synced} conversations`);
      } else if (cloudResult.error) {
        console.warn("Cloud push failed:", cloudResult.error);
      }
      const cloudStatus = await getCloudSyncStatus();
      chrome.runtime.sendMessage({ action: "cloudSyncStatus", ...cloudStatus }).catch(() => {});

      await autoExportIfEnabled();
      return syncResults;
    }

    case "syncOne":
      return syncOne(
        request.providerId!,
        (progress) => {
          chrome.runtime
            .sendMessage({
              action: "syncProgress",
              ...progress,
            })
            .catch(() => {});
        },
        { forceFull: request.forceFull },
      );

    // Cancel mechanism (CLAUDE.md "Cancel mechanism" rule) — every
    // long-running operation must expose a way to cancel mid-run. Fires
    // synchronously; the running sync observes it at its next
    // pagination/per-conversation-fetch check point.
    case "cancelSync":
      requestCancel();
      return { cancelled: true };

    case "export": {
      const exportResult = await exportAsJson();
      const exportSettings = await getSettings();
      const autoExport = exportSettings.autoExport;
      const useAutoPath = autoExport?.enabled && autoExport?.filename;
      try {
        const downloadId = await chrome.downloads.download({
          url: exportResult.url,
          filename: useAutoPath ? autoExport.filename : exportResult.filename,
          conflictAction: useAutoPath ? "overwrite" : "uniquify",
          saveAs: !useAutoPath,
        });
        return { success: true, stats: exportResult.stats, downloadId };
      } catch (dlErr) {
        const message = dlErr instanceof Error ? dlErr.message : String(dlErr);
        return { error: `Download failed: ${message}`, stats: exportResult.stats };
      }
    }

    case "import": {
      const importData = request.data as { conversations: Conversation[] } | undefined;
      if (!importData?.conversations) return { error: "No conversations in import data" };
      let imported = 0;
      const BATCH = 50;
      const convos = importData.conversations;
      for (let i = 0; i < convos.length; i += BATCH) {
        await saveConversationsBatch(convos.slice(i, i + BATCH));
        imported += Math.min(BATCH, convos.length - i);
      }
      const sources: Record<string, { count: number; maxUpdatedAt: string }> = {};
      for (const c of convos) {
        const src = c.source;
        if (!sources[src]) sources[src] = { count: 0, maxUpdatedAt: "" };
        sources[src].count += 1;
        const ts = c.updated_at || c.synced_at || "";
        if (ts > sources[src].maxUpdatedAt) sources[src].maxUpdatedAt = ts;
      }
      for (const [providerId, { count, maxUpdatedAt }] of Object.entries(sources)) {
        await updateProviderSyncState(providerId, {
          lastSyncAt: maxUpdatedAt || new Date().toISOString(),
          lastSyncStatus: "success",
          conversationCount: count,
        });
      }
      return { success: true, imported };
    }

    case "getSettings":
      return getSettings();

    default:
      return { error: `Unknown action: ${request.action}` };
  }
}
