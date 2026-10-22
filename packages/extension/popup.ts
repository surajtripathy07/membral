import type { ProviderSyncState } from "@membral/core";
import { getAuthState, login, logout } from "./src/auth/auth.js";
import { isStaleSyncing } from "./src/common/badge.js";
import { resolveSyncWindowDays, STORAGE_KEYS, SYNC_WINDOW_PRESETS } from "./src/common/constants.js";
import { getSettings } from "./src/common/storage.js";
import { type CloudSyncStatus, formatCloudSyncStatus, getCloudSyncStatus } from "./src/sync/cloud-push.js";

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude.ai",
  chatgpt: "ChatGPT",
};

const PROVIDER_LOGOS: Record<string, { letter: string; cssClass: string }> = {
  claude: { letter: "C", cssClass: "logo-claude" },
  chatgpt: { letter: "G", cssClass: "logo-chatgpt" },
};

const PROVIDER_ORDER = ["claude", "chatgpt"] as const;

interface ProviderState {
  lastSyncAt?: string | null;
  lastSyncStatus?: string;
  lastError?: string | null;
  conversationCount?: number;
  lastDeltaNew?: number;
  lastDeltaUpdated?: number;
  syncStartedAt?: string | null;
}

interface PopupSyncState {
  providers?: Record<string, ProviderState>;
  lastFullSyncAt?: string | null;
  error?: string;
}

interface SyncResult {
  error?: string;
  results?: Record<string, { count: number }>;
}

interface ExportResult {
  error?: string;
  stats?: { total_conversations?: number; by_source?: Record<string, number> };
}

document.addEventListener("DOMContentLoaded", async () => {
  await renderAuthState();
  await renderState();
  await renderSyncWindowNote();

  document.getElementById("sync-all-btn")!.addEventListener("click", syncAll);
  document.getElementById("export-btn")!.addEventListener("click", exportAll);
  document.getElementById("cancel-sync-btn")!.addEventListener("click", cancelSync);
  document.getElementById("auth-toggle-btn")!.addEventListener("click", toggleAuthForm);
  document.getElementById("auth-login-btn")!.addEventListener("click", handleLogin);
  document.getElementById("auth-logout-btn")!.addEventListener("click", handleLogout);
  document.getElementById("settings-link")!.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  });
  document.getElementById("dismiss-hint-btn")?.addEventListener("click", async () => {
    const hintEl = document.getElementById("first-run-hint");
    if (hintEl) hintEl.style.display = "none";
    await chrome.storage.local.set({ [STORAGE_KEYS.FIRST_RUN_HINT_DISMISSED]: true });
  });

  chrome.runtime.onMessage.addListener(
    (msg: {
      action: string;
      providerId?: string;
      detail?: string;
      status?: string;
      state?: string;
      count?: number;
      total?: number;
      atLimit?: boolean;
      error?: string;
      at?: string;
    }) => {
      if (msg.action === "syncProgress") {
        updateProgress(`[${PROVIDER_LABELS[msg.providerId!] || msg.providerId}] ${msg.detail || msg.status}`);
      } else if (msg.action === "cloudSyncStatus" && msg.state) {
        const syncStatusEl = document.getElementById("auth-sync-status");
        if (syncStatusEl) {
          const cloudStatus: CloudSyncStatus = {
            state: msg.state as CloudSyncStatus["state"],
            count: msg.count,
            total: msg.total,
            atLimit: msg.atLimit,
            error: msg.error,
            at: msg.at,
          };
          updateCloudSyncStatusEl(syncStatusEl, cloudStatus);
        }
      }
    },
  );

  setInterval(renderState, 2000);
});

// Sync-window read-only note (#120) -- the popup is a status view, not a
// settings form, so this is display-only; the existing "Settings" link
// (chrome.tabs.create to options.html, never chrome.runtime.openOptionsPage
// per the repo's service-worker/popup rule) is the one place to change it.
async function renderSyncWindowNote(): Promise<void> {
  const el = document.getElementById("sync-window-note");
  if (!el) return;
  try {
    const settings = await getSettings();
    const days = resolveSyncWindowDays(settings.syncWindowDays);
    const preset = SYNC_WINDOW_PRESETS.find((p) => p.days === days);
    el.textContent = preset ? `Syncing: ${preset.label.replace(/^Last /, "last ")}` : `Syncing: last ${days} days`;
  } catch {
    el.textContent = "";
  }
}

async function renderState(): Promise<void> {
  try {
    const state: PopupSyncState = await chrome.runtime.sendMessage({ action: "getSyncState" });
    if (state.error) throw new Error(state.error);
    renderProviders(state);
  } catch (err) {
    console.error("Failed to get state:", err);
  }
}

function renderProviders(state: PopupSyncState): void {
  const container = document.getElementById("providers")!;
  container.innerHTML = "";

  for (const id of PROVIDER_ORDER) {
    const ps: ProviderState = state.providers?.[id] || {};
    const card = document.createElement("div");
    card.className = "provider-card";

    const statusClass = `status-${ps.lastSyncStatus || "never"}`;
    const statusLabels: Record<string, string> = {
      never: "Not synced",
      syncing: "Syncing...",
      success: "Synced",
      error: "Error",
      skipped: "Skipped",
      cancelled: "Cancelled",
    };
    const statusLabel = statusLabels[ps.lastSyncStatus || "never"];

    const logo = PROVIDER_LOGOS[id];
    const count = ps.conversationCount || 0;
    const countText = count === 0 ? "No conversations yet" : `${count} conversation${count === 1 ? "" : "s"}`;
    const lastSync = ps.lastSyncAt ? formatTime(ps.lastSyncAt) : "Never";

    const header = document.createElement("div");
    header.className = "provider-header";

    const nameRow = document.createElement("div");
    nameRow.className = "provider-name-row";

    const logoEl = document.createElement("div");
    logoEl.className = `provider-logo ${logo.cssClass}`;
    logoEl.textContent = logo.letter;

    const nameWrapper = document.createElement("div");
    const nameEl = document.createElement("div");
    nameEl.className = "provider-name";
    nameEl.textContent = PROVIDER_LABELS[id];
    nameWrapper.appendChild(nameEl);

    nameRow.appendChild(logoEl);
    nameRow.appendChild(nameWrapper);

    const statusEl = document.createElement("span");
    statusEl.className = `provider-status ${statusClass}`;
    const dotEl = document.createElement("span");
    dotEl.className = "status-dot";
    statusEl.appendChild(dotEl);
    statusEl.appendChild(document.createTextNode(statusLabel));

    header.appendChild(nameRow);
    header.appendChild(statusEl);

    const countEl = document.createElement("div");
    countEl.className = "provider-count";
    countEl.textContent = count > 0 ? count.toLocaleString() : "—";

    const countLabelEl = document.createElement("div");
    countLabelEl.className = "provider-count-label";
    countLabelEl.textContent = countText;

    const metaEl = document.createElement("div");
    metaEl.className = "provider-meta";
    metaEl.textContent = "Last sync: ";
    const lastSyncSpan = document.createElement("span");
    lastSyncSpan.textContent = lastSync;
    metaEl.appendChild(lastSyncSpan);

    card.appendChild(header);
    card.appendChild(countEl);
    card.appendChild(countLabelEl);
    card.appendChild(metaEl);

    // Delta-sync telemetry (goal 2026-07-26 step 15, #27/#57 requirement 6):
    // "delta: N new / M updated" from the most recent cursor-seeded cycle.
    if (typeof ps.lastDeltaNew === "number" || typeof ps.lastDeltaUpdated === "number") {
      const deltaEl = document.createElement("div");
      deltaEl.className = "provider-meta";
      deltaEl.textContent = `Last delta: ${ps.lastDeltaNew ?? 0} new / ${ps.lastDeltaUpdated ?? 0} updated`;
      card.appendChild(deltaEl);
    }

    if (ps.lastError) {
      const errorEl = document.createElement("div");
      errorEl.className = "provider-error";
      errorEl.textContent = ps.lastError;
      card.appendChild(errorEl);
    }

    container.appendChild(card);
  }

  // M3 fix (adversarial review): drive Cancel-button visibility from actual
  // sync state, not just the popup's own syncAll() click handler -- a
  // scheduled/alarm-triggered sync (or one started from a DIFFERENT popup
  // instance) previously had no way to ever surface a cancel affordance in a
  // freshly-opened popup, since only that one syncAll() call toggled
  // display. This runs on every renderState() poll (every 2s) so it's
  // correct however the sync was started. Mirrors badge.ts's own
  // "actively syncing" definition (isStaleSyncing) so a stuck/stale
  // "syncing" status doesn't leave the button showing forever.
  const cancelBtn = document.getElementById("cancel-sync-btn") as HTMLButtonElement | null;
  if (cancelBtn) {
    const anyActivelySyncing = PROVIDER_ORDER.some((id) => {
      const ps = state.providers?.[id];
      if (!ps || ps.lastSyncStatus !== "syncing") return false;
      return !isStaleSyncing(ps as unknown as ProviderSyncState);
    });
    cancelBtn.style.display = anyActivelySyncing ? "" : "none";
    // MN-follow-up fix (round-2 adversarial review): cancelSync() sets
    // disabled=true while a cancellation is in flight, but nothing ever
    // reset it back -- once a run was cancelled, this button stayed
    // permanently disabled for every LATER sync while the popup remained
    // open. Reset disabled whenever the button is shown for an actively
    // syncing run (no cancellation is in flight for a brand-new "syncing"
    // state).
    if (anyActivelySyncing) cancelBtn.disabled = false;
  }
}

async function syncAll(): Promise<void> {
  const btn = document.getElementById("sync-all-btn") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cancel-sync-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.innerHTML = '<span style="font-size:15px;">&#8635;</span> Syncing...';
  cancelBtn.style.display = "";
  cancelBtn.disabled = false;
  updateProgress("Starting sync...");

  try {
    const result: SyncResult = await chrome.runtime.sendMessage({ action: "syncAll" });
    if (result.error) {
      updateProgress(`Error: ${result.error}`);
    } else {
      const results = result.results || {};
      // MN6 fix (adversarial review, extended here for consistency with the
      // options.ts full-rescrape path): syncAll() returns an empty
      // `results` object when a sync is ALREADY in progress (engine.ts's
      // syncLock guard) -- previously that rendered as an empty summary
      // string, which fell back to "Done," misleadingly implying success.
      if (Object.keys(results).length === 0) {
        updateProgress("A sync is already in progress — try again once it finishes.");
      } else {
        const summary = Object.entries(results)
          .map(([id, r]) => `${PROVIDER_LABELS[id]}: ${r.count} new`)
          .join(", ");
        updateProgress(summary || "Done");
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateProgress(`Error: ${message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span style="font-size:15px;">&#8635;</span> Sync All Now';
    cancelBtn.style.display = "none";
    await renderState();
  }
}

/** Cancel mechanism (CLAUDE.md "Cancel mechanism" rule) -- fires a fire-and-forget message the background service worker's running sync observes at its next pagination/per-conversation-fetch check point. */
async function cancelSync(): Promise<void> {
  const cancelBtn = document.getElementById("cancel-sync-btn") as HTMLButtonElement;
  cancelBtn.disabled = true;
  updateProgress("Cancelling...");
  try {
    await chrome.runtime.sendMessage({ action: "cancelSync" });
  } catch (err) {
    console.error("Cancel request failed:", err);
  }
}

async function exportAll(): Promise<void> {
  const btn = document.getElementById("export-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Exporting...";

  try {
    const result: ExportResult = await chrome.runtime.sendMessage({ action: "export" });
    if (result.error) {
      updateProgress(`Export error: ${result.error}`);
      return;
    }

    const sources = Object.entries(result.stats?.by_source || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    updateProgress(`Exported ${result.stats?.total_conversations || 0} conversations (${sources})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateProgress(`Export error: ${message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Export";
  }
}

function updateCloudSyncStatusEl(el: HTMLElement, status: CloudSyncStatus): void {
  const { text, color } = formatCloudSyncStatus(status);
  el.textContent = text;
  el.style.color = color;
}

function toggleAuthForm(): void {
  const wrapper = document.getElementById("auth-form-wrapper")!;
  const btn = document.getElementById("auth-toggle-btn")!;
  const isOpen = wrapper.classList.toggle("open");
  btn.textContent = isOpen ? "Cancel" : "Sign in to sync to cloud \u25b8";
}

async function renderAuthState(): Promise<void> {
  const loggedOutEl = document.getElementById("auth-logged-out")!;
  const loggedInEl = document.getElementById("auth-logged-in")!;
  const emailEl = document.getElementById("auth-user-email")!;
  const syncStatusEl = document.getElementById("auth-sync-status")!;

  try {
    const authState = await getAuthState();

    if (authState.isLoggedIn) {
      loggedOutEl.style.display = "none";
      loggedInEl.style.display = "block";
      emailEl.textContent = authState.email || "";
      const cloudStatus = await getCloudSyncStatus();
      updateCloudSyncStatusEl(syncStatusEl, cloudStatus);
    } else {
      loggedOutEl.style.display = "block";
      loggedInEl.style.display = "none";
      document.getElementById("auth-form-wrapper")!.classList.remove("open");
      document.getElementById("auth-toggle-btn")!.textContent = "Sign in to sync to cloud \u25b8";
      const result = await chrome.storage.local.get(STORAGE_KEYS.FIRST_RUN_HINT_DISMISSED);
      const dismissed = result[STORAGE_KEYS.FIRST_RUN_HINT_DISMISSED] as boolean | undefined;
      const hintEl = document.getElementById("first-run-hint");
      if (hintEl) hintEl.style.display = dismissed ? "none" : "flex";
    }
  } catch {
    loggedOutEl.style.display = "block";
    loggedInEl.style.display = "none";
  }
}

async function handleLogin(): Promise<void> {
  const emailInput = document.getElementById("auth-email") as HTMLInputElement;
  const passwordInput = document.getElementById("auth-password") as HTMLInputElement;
  const errorEl = document.getElementById("auth-error")!;
  const loginBtn = document.getElementById("auth-login-btn") as HTMLButtonElement;

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    errorEl.textContent = "Email and password are required";
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in...";
  errorEl.textContent = "";

  try {
    await login(email, password);
    passwordInput.value = "";
    await renderAuthState();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorEl.textContent = message;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Sign In";
  }
}

async function handleLogout(): Promise<void> {
  const logoutBtn = document.getElementById("auth-logout-btn") as HTMLButtonElement;
  logoutBtn.disabled = true;

  try {
    await logout();
    await renderAuthState();
  } catch (err) {
    console.error("Logout failed:", err);
  } finally {
    logoutBtn.disabled = false;
  }
}

function updateProgress(text: string): void {
  document.getElementById("progress")!.textContent = text;
}

function formatTime(isoString: string): string {
  if (!isoString) return "Never";
  const d = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}
