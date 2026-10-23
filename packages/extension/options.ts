import type { Conversation } from "@membral/core";
import { clearApiKey, getApiKey, getAuthState, setApiKey } from "./src/auth/auth.js";
import {
  daysToOptionValue,
  optionValueToDays,
  resolveSyncWindowDays,
  STORAGE_KEYS,
  SYNC_WINDOW_PRESETS,
} from "./src/common/constants.js";
import { getSettings, saveConversationsBatch, saveSettings, updateProviderSyncState } from "./src/common/storage.js";
import { applyCloudUrl } from "./src/common/target.js";
import { DEFAULT_AUTO_EXPORT } from "./src/sync/auto-export.js";
import { getCloudUrl } from "./src/sync/cloud-push.js";

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude.ai",
  chatgpt: "ChatGPT",
};

// --- DOM references ---
const syncIntervalEl = document.getElementById("sync-interval") as HTMLSelectElement;
const syncWindowEl = document.getElementById("sync-window") as HTMLSelectElement;
const syncWindowHintEl = document.getElementById("sync-window-hint") as HTMLDivElement;
const providerClaudeEl = document.getElementById("provider-claude") as HTMLInputElement;
const providerChatgptEl = document.getElementById("provider-chatgpt") as HTMLInputElement;
const cloudUrlEl = document.getElementById("cloud-url") as HTMLInputElement;
const cloudUrlSaveBtn = document.getElementById("cloud-url-save-btn") as HTMLButtonElement;
const apiKeyEl = document.getElementById("api-key") as HTMLInputElement;
const apiKeySaveBtn = document.getElementById("api-key-save-btn") as HTMLButtonElement;
const apiKeyClearBtn = document.getElementById("api-key-clear-btn") as HTMLButtonElement;
const authStatusEl = document.getElementById("auth-status") as HTMLSpanElement;
const autoExportEnabledEl = document.getElementById("auto-export-enabled") as HTMLInputElement;
const autoExportFilenameEl = document.getElementById("auto-export-filename") as HTMLInputElement;
const exportPathHint = document.getElementById("export-path-hint") as HTMLDivElement;
const exportAllBtn = document.getElementById("export-all-btn") as HTMLButtonElement;
const importBtn = document.getElementById("import-btn") as HTMLButtonElement;
const importFileEl = document.getElementById("import-file") as HTMLInputElement;
const clearAllBtn = document.getElementById("clear-all-btn") as HTMLButtonElement;
const fullRescrapeBtn = document.getElementById("full-rescrape-btn") as HTMLButtonElement;
const versionEl = document.getElementById("about-version") as HTMLSpanElement;
const statusBar = document.getElementById("status-bar") as HTMLDivElement;

const PROVIDER_CHECKBOXES: Record<string, HTMLInputElement> = {
  claude: providerClaudeEl,
  chatgpt: providerChatgptEl,
};

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function updateExportPathHint(filename: string): void {
  const name = filename || DEFAULT_AUTO_EXPORT.filename;
  exportPathHint.textContent = `~/Downloads/${name}`;
}

// --- Sync window (#120) ---
function populateSyncWindowOptions(): void {
  syncWindowEl.innerHTML = "";
  for (const preset of SYNC_WINDOW_PRESETS) {
    const opt = document.createElement("option");
    opt.value = daysToOptionValue(preset.days);
    opt.textContent = preset.label;
    syncWindowEl.appendChild(opt);
  }
}

function updateSyncWindowHint(days: number | null): void {
  syncWindowHintEl.textContent =
    days === null
      ? "Every sync fetches a provider's full history. Slower and heavier -- use this only if you need it."
      : `Only conversations updated in the last ${days} days are fetched. Widening this later backfills the newly-included older range without re-fetching what's already synced.`;
}

// --- Load settings into the form ---
async function loadSettings(): Promise<void> {
  const settings = await getSettings();

  // Sync interval
  syncIntervalEl.value = String(settings.syncIntervalMinutes);

  // Sync window (#120)
  const syncWindowDays = resolveSyncWindowDays(settings.syncWindowDays);
  syncWindowEl.value = daysToOptionValue(syncWindowDays);
  updateSyncWindowHint(syncWindowDays);

  // Enabled providers
  for (const [id, checkbox] of Object.entries(PROVIDER_CHECKBOXES)) {
    checkbox.checked = settings.enabledProviders.includes(id);
  }

  // Auto-export
  const autoExport = settings.autoExport ?? DEFAULT_AUTO_EXPORT;
  autoExportEnabledEl.checked = autoExport.enabled;
  autoExportFilenameEl.value = autoExport.filename;
  updateExportPathHint(autoExport.filename);

  // Membral URL (issue #12) — the field stays empty when no override is
  // stored (an override, not the value itself, is what's persisted), but
  // its placeholder shows the actually-effective URL (the stored override,
  // or the build's default — see getCloudUrl/DEFAULT_CLOUD_URL in
  // cloud-push.ts) so the user isn't left guessing what's active.
  const result = await chrome.storage.local.get(STORAGE_KEYS.CLOUD_URL);
  const storedOverride = (result[STORAGE_KEYS.CLOUD_URL] as string) || "";
  cloudUrlEl.value = storedOverride;
  cloudUrlEl.placeholder = storedOverride || (await getCloudUrl());

  // The key itself is never echoed back into the field once saved.
  apiKeyEl.value = "";
  apiKeyEl.placeholder = (await getApiKey()) ? "Key saved (paste a new one to replace it)" : "lls_…";
}

// --- Save settings from the form (debounced) ---
function scheduleSave(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveNow, 500);
}

async function saveNow(): Promise<void> {
  try {
    const enabledProviders: string[] = [];
    for (const [id, checkbox] of Object.entries(PROVIDER_CHECKBOXES)) {
      if (checkbox.checked) enabledProviders.push(id);
    }

    await saveSettings({
      syncIntervalMinutes: Number(syncIntervalEl.value),
      syncWindowDays: optionValueToDays(syncWindowEl.value),
      enabledProviders,
      autoExport: {
        enabled: autoExportEnabledEl.checked,
        filename: autoExportFilenameEl.value || DEFAULT_AUTO_EXPORT.filename,
      },
    });

    showStatus("Settings saved");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Error saving: ${msg}`, true);
  }
}

// --- Auth status ---
function setAuthStatus(connected: boolean, label?: string): void {
  authStatusEl.textContent = "";
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.style.background = connected ? "#4ade80" : "#888";
  authStatusEl.appendChild(dot);
  authStatusEl.appendChild(document.createTextNode(connected ? ` ${label}` : " Not connected"));
  authStatusEl.className = connected ? "auth-status auth-connected" : "auth-status auth-disconnected";
}

async function loadAuthStatus(): Promise<void> {
  try {
    const authState = await getAuthState();
    if (authState.isLoggedIn) {
      setAuthStatus(
        true,
        authState.kind === "api-key" ? "Connected with an API key" : `Connected (${authState.email})`,
      );
    } else {
      setAuthStatus(false);
    }
  } catch {
    setAuthStatus(false);
  }
}

// --- Membral URL (explicit Save: the permission prompt needs a user gesture) ---
async function handleSaveCloudUrl(): Promise<void> {
  cloudUrlSaveBtn.disabled = true;
  try {
    // Must be the first await in the click handler's call chain so the gesture is still live.
    const result = await applyCloudUrl(cloudUrlEl.value);
    if (!result.ok) {
      showStatus(result.error, true);
      return;
    }
    cloudUrlEl.value = result.url ?? "";
    cloudUrlEl.placeholder = await getCloudUrl();
    showStatus(result.url ? `Membral URL saved: ${result.url}` : "Membral URL reset to the default");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Error saving URL: ${msg}`, true);
  } finally {
    cloudUrlSaveBtn.disabled = false;
  }
}

// --- API key ---
async function handleSaveApiKey(): Promise<void> {
  try {
    await setApiKey(apiKeyEl.value);
    await loadSettings();
    await loadAuthStatus();
    showStatus("API key saved");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(msg, true);
  }
}

async function handleClearApiKey(): Promise<void> {
  try {
    await clearApiKey();
    await loadSettings();
    await loadAuthStatus();
    showStatus("API key cleared");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Error: ${msg}`, true);
  }
}

// --- Export all conversations ---
async function handleExportAll(): Promise<void> {
  exportAllBtn.disabled = true;
  exportAllBtn.textContent = "Exporting...";

  try {
    const result = await chrome.runtime.sendMessage({ action: "export" });
    if (result?.error) {
      showStatus(`Export error: ${result.error}`, true);
    } else {
      const total = result?.stats?.total_conversations ?? 0;
      showStatus(`Exported ${total} conversations`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Export error: ${msg}`, true);
  } finally {
    exportAllBtn.disabled = false;
    exportAllBtn.textContent = "Export All Conversations";
  }
}

// --- Import from export ---
async function handleImport(): Promise<void> {
  importFileEl.click();
}

async function handleImportFile(): Promise<void> {
  const file = importFileEl.files?.[0];
  if (!file) return;

  importBtn.disabled = true;
  importBtn.textContent = "Importing...";

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.conversations || !Array.isArray(data.conversations)) {
      showStatus("Invalid export file: no conversations array", true);
      return;
    }
    const convos: Conversation[] = data.conversations;
    const BATCH = 50;
    let saved = 0;
    for (let i = 0; i < convos.length; i += BATCH) {
      await saveConversationsBatch(convos.slice(i, i + BATCH));
      saved += Math.min(BATCH, convos.length - i);
      showStatus(`Importing... ${saved}/${convos.length}`);
    }
    const sources: Record<string, { count: number; maxUpdatedAt: string }> = {};
    for (const c of convos) {
      if (!sources[c.source]) sources[c.source] = { count: 0, maxUpdatedAt: "" };
      sources[c.source].count += 1;
      const ts = c.updated_at || c.synced_at || "";
      if (ts > sources[c.source].maxUpdatedAt) sources[c.source].maxUpdatedAt = ts;
    }
    for (const [providerId, { count, maxUpdatedAt }] of Object.entries(sources)) {
      await updateProviderSyncState(providerId, {
        lastSyncAt: maxUpdatedAt || new Date().toISOString(),
        lastSyncStatus: "success",
        conversationCount: count,
      });
    }
    const verify = await chrome.storage.local.get(STORAGE_KEYS.SYNC_STATE);
    const verifyIndex = await chrome.storage.local.get("membral_conv_index");
    const indexLen = ((verifyIndex["membral_conv_index"] as string[]) || []).length;
    const stateStr = JSON.stringify(verify[STORAGE_KEYS.SYNC_STATE]);
    console.log(`Import verify: ${indexLen} conversations indexed, state=${stateStr}`);
    showStatus(`Imported ${convos.length} conversations (${indexLen} indexed)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Import error: ${msg}`, true);
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = "Import from Export";
    importFileEl.value = "";
  }
}

// --- Clear all data ---
async function handleClearAll(): Promise<void> {
  const confirmed = confirm(
    "This will delete all synced conversations and reset settings. This cannot be undone. Continue?",
  );
  if (!confirmed) return;

  clearAllBtn.disabled = true;
  clearAllBtn.textContent = "Clearing...";

  try {
    await chrome.storage.local.clear();
    await loadSettings();
    await loadAuthStatus();
    showStatus("All data cleared");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Error: ${msg}`, true);
  } finally {
    clearAllBtn.disabled = false;
    clearAllBtn.textContent = "Clear All Data";
  }
}

// --- Full re-scrape (reconciliation backstop, goal 2026-07-26 step 15, #27/#57 requirement 5) ---
// The default sync button/schedule path (background.ts's "syncAll"/alarm) stays delta;
// this is the explicit manual fallback that bypasses the cursor entirely.
async function handleFullRescrape(): Promise<void> {
  const confirmed = confirm(
    "This re-lists and re-fetches every conversation from each connected provider, ignoring " +
      "the delta cursor. It's slower and heavier than a normal sync -- only needed if you " +
      "suspect the delta sync missed something. Continue?",
  );
  if (!confirmed) return;

  fullRescrapeBtn.disabled = true;
  fullRescrapeBtn.textContent = "Re-scraping...";
  showStatus("Starting full re-scrape...");

  const progressListener = (msg: { action: string; providerId?: string; detail?: string }) => {
    if (msg.action === "syncProgress") {
      showStatus(`[${PROVIDER_LABELS[msg.providerId ?? ""] ?? msg.providerId}] ${msg.detail ?? ""}`);
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  try {
    const result = await chrome.runtime.sendMessage({ action: "syncAll", forceFull: true });
    if (result?.error) {
      showStatus(`Re-scrape error: ${result.error}`, true);
    } else {
      const results = (result?.results ?? {}) as Record<string, { count?: number }>;
      // MN6 fix (adversarial review): syncAll() returns an empty `results`
      // object when a sync is ALREADY in progress (engine.ts's syncLock
      // guard) -- previously that rendered as an empty summary string,
      // which fell back to "Full re-scrape complete" with no summary,
      // misleadingly implying the re-scrape ran (and finished) when it
      // never even started.
      if (Object.keys(results).length === 0) {
        showStatus("A sync is already in progress — try again once it finishes.", true);
      } else {
        const summary = Object.entries(results)
          .map(([id, r]) => `${PROVIDER_LABELS[id] ?? id}: ${r.count ?? 0}`)
          .join(", ");
        showStatus(`Full re-scrape complete${summary ? `: ${summary}` : ""}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Re-scrape error: ${msg}`, true);
  } finally {
    chrome.runtime.onMessage.removeListener(progressListener);
    fullRescrapeBtn.disabled = false;
    fullRescrapeBtn.textContent = "Full Re-scrape (reconciliation backstop)";
  }
}

// --- Status bar ---
function showStatus(text: string, isError = false): void {
  statusBar.textContent = text;
  statusBar.className = isError ? "status-bar error" : "status-bar";
  setTimeout(() => {
    statusBar.textContent = "";
  }, 3000);
}

// --- Wire up events ---
document.addEventListener("DOMContentLoaded", async () => {
  versionEl.textContent = `Membral v${chrome.runtime.getManifest().version}`;

  populateSyncWindowOptions();
  await loadSettings();
  await loadAuthStatus();

  // Auto-save on change
  syncIntervalEl.addEventListener("change", scheduleSave);
  syncWindowEl.addEventListener("change", () => {
    updateSyncWindowHint(optionValueToDays(syncWindowEl.value));
    scheduleSave();
  });
  providerClaudeEl.addEventListener("change", scheduleSave);
  providerChatgptEl.addEventListener("change", scheduleSave);
  cloudUrlSaveBtn.addEventListener("click", handleSaveCloudUrl);
  apiKeySaveBtn.addEventListener("click", handleSaveApiKey);
  apiKeyClearBtn.addEventListener("click", handleClearApiKey);
  autoExportEnabledEl.addEventListener("change", scheduleSave);
  autoExportFilenameEl.addEventListener("input", () => {
    updateExportPathHint(autoExportFilenameEl.value);
    scheduleSave();
  });

  // Data actions
  exportAllBtn.addEventListener("click", handleExportAll);
  importBtn.addEventListener("click", handleImport);
  importFileEl.addEventListener("change", handleImportFile);
  clearAllBtn.addEventListener("click", handleClearAll);
  fullRescrapeBtn.addEventListener("click", handleFullRescrape);
});
