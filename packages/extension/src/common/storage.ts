import type { Conversation, ProviderSyncState, SyncState } from "@membral/core";
import type { AutoExportSettings } from "../sync/auto-export.js";
import { PROVIDERS, STORAGE_KEYS } from "./constants.js";

export interface Settings {
  syncIntervalMinutes: number;
  enabledProviders: string[];
  autoExport?: AutoExportSettings;
  /**
   * Sync window in days (#120), persisted from the options page's "Sync
   * window" control -- e.g. 30 for "Last 30 days". `null` means "All
   * history" (no floor) -- a deliberate choice that must be preserved, not
   * collapsed to the default. Optional/undefined for pre-#120 stored
   * settings (or a settings blob that was never re-saved).
   *
   * MINOR fix (adversarial review): every consumer resolves this via
   * common/constants.ts's resolveSyncWindowDays() -- NEVER a bare
   * `?? DEFAULT_SYNC_WINDOW_DAYS` here or at any call site. `??` treats
   * `null` and `undefined` identically, which would silently collapse an
   * explicit "All history" choice back down to the 30-day default; this
   * getter deliberately does NOT backfill/coalesce the value itself, so
   * that mistake can't be made by accident by reading it directly.
   */
  syncWindowDays?: number | null;
}

function defaultSyncState(): SyncState {
  const providers: Record<string, ProviderSyncState> = {};
  for (const id of Object.keys(PROVIDERS)) {
    providers[id] = {
      lastSyncAt: null,
      lastSyncStatus: "never",
      lastError: null,
      conversationCount: 0,
    };
  }
  return { providers, lastFullSyncAt: null };
}

// --- Sync State ---

export async function getSyncState(): Promise<SyncState> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SYNC_STATE);
  return (result[STORAGE_KEYS.SYNC_STATE] as SyncState) || defaultSyncState();
}

/**
 * M1 fix (adversarial review): a partial update is a spread-merge over the
 * existing provider state, so an explicit `undefined` value in `updates`
 * (e.g. `failedIds: undefined` meant as "nothing changed here") would
 * otherwise OVERWRITE and clear whatever was already stored for that field --
 * `{ ...old, ...{ failedIds: undefined } }` evaluates to `failedIds:
 * undefined`, not "key absent." Strip keys whose value is `undefined` before
 * merging so a partial update can only ever ADD/CHANGE fields, never wipe
 * one out from under it. Fields that genuinely need clearing (e.g.
 * `syncStartedAt`, `failedIds`) must pass `null` explicitly -- `null` is a
 * real value and survives the strip.
 */
export async function updateProviderSyncState(providerId: string, updates: Partial<ProviderSyncState>): Promise<void> {
  const state = await getSyncState();
  const clean: Partial<ProviderSyncState> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      (clean as Record<string, unknown>)[key] = value;
    }
  }
  state.providers[providerId] = { ...state.providers[providerId], ...clean };
  await chrome.storage.local.set({ [STORAGE_KEYS.SYNC_STATE]: state });
}

export async function setLastFullSyncAt(timestamp: string): Promise<void> {
  const state = await getSyncState();
  state.lastFullSyncAt = timestamp;
  await chrome.storage.local.set({ [STORAGE_KEYS.SYNC_STATE]: state });
}

// --- Conversations ---
// Each conversation is stored as its own key: "conv:source:source_id"
// A separate index key tracks all conversation keys for enumeration.

const CONV_PREFIX = "conv:";
const CONV_INDEX_KEY = "membral_conv_index";
/**
 * M2 fix (adversarial review): a lightweight `source:source_id` -> updated_at
 * index, maintained incrementally alongside CONV_INDEX_KEY so
 * getKnownUpdatedAtByProvider never has to materialize the entire corpus
 * (message bodies included) in the MV3 service worker on every sync cycle.
 */
const UPDATED_AT_INDEX_KEY = "membral_updated_at_index";

async function updateUpdatedAtIndex(convos: Conversation[]): Promise<void> {
  if (convos.length === 0) return;
  const result = await chrome.storage.local.get(UPDATED_AT_INDEX_KEY);
  const index: Record<string, string> = (result[UPDATED_AT_INDEX_KEY] as Record<string, string>) || {};
  for (const convo of convos) {
    if (!convo.updated_at) continue;
    index[`${convo.source}:${convo.source_id}`] = convo.updated_at;
  }
  await chrome.storage.local.set({ [UPDATED_AT_INDEX_KEY]: index });
}

/**
 * Read the updated_at index, lazily building it once from the full
 * materialized corpus if it doesn't exist yet OR is incomplete (a
 * pre-existing install that predates this index -- the exact expensive path
 * this index exists to avoid, paid at most once and then persisted).
 *
 * Follow-up fix (round-2 adversarial review): the earlier version
 * short-circuited on mere EXISTENCE of the index key. A legacy install
 * (existing corpus, no index yet) whose first write happens via a path that
 * bypasses getKnownUpdatedAtByProvider's normal producers (e.g. a forceFull
 * re-scrape, or a JSON import writing conversations directly) could seal a
 * PARTIAL index on its very first incremental write -- after that, this
 * function saw a present-but-partial index and never ran the full-corpus
 * migration, permanently hiding whatever conversations predated it. Gate the
 * early return on completeness (index covers every entry in the conversation
 * index) instead of mere presence; otherwise rebuild from the full corpus
 * once, merged with whatever was already in the index so freshly-written
 * entries aren't lost.
 */
async function getOrBuildUpdatedAtIndex(): Promise<Record<string, string>> {
  const result = await chrome.storage.local.get([UPDATED_AT_INDEX_KEY, CONV_INDEX_KEY]);
  const existing = (result[UPDATED_AT_INDEX_KEY] as Record<string, string> | undefined) || {};
  const convKeys: string[] = (result[CONV_INDEX_KEY] as string[]) || [];
  if (Object.keys(existing).length >= convKeys.length) return existing;

  const conversations = await getConversations();
  const rebuilt: Record<string, string> = {};
  for (const [key, conv] of Object.entries(conversations)) {
    if (conv.updated_at) rebuilt[key] = conv.updated_at;
  }
  const merged = { ...existing, ...rebuilt };
  await chrome.storage.local.set({ [UPDATED_AT_INDEX_KEY]: merged });
  return merged;
}

export async function getConversations(): Promise<Record<string, Conversation>> {
  const result = await chrome.storage.local.get(CONV_INDEX_KEY);
  const keys: string[] = (result[CONV_INDEX_KEY] as string[]) || [];
  if (keys.length === 0) {
    // Migration: check if old single-blob format exists
    const old = await chrome.storage.local.get(STORAGE_KEYS.CONVERSATIONS);
    const oldData = old[STORAGE_KEYS.CONVERSATIONS] as Record<string, Conversation> | undefined;
    if (oldData && Object.keys(oldData).length > 0) {
      // Migrate to per-key storage
      await saveConversationsBatch(Object.values(oldData));
      await chrome.storage.local.remove(STORAGE_KEYS.CONVERSATIONS);
      return getConversations();
    }
    return {};
  }
  const storageKeys = keys.map((k) => CONV_PREFIX + k);
  const data = await chrome.storage.local.get(storageKeys);
  const conversations: Record<string, Conversation> = {};
  for (const k of keys) {
    const conv = data[CONV_PREFIX + k] as Conversation | undefined;
    if (conv) conversations[k] = conv;
  }
  return conversations;
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  const key = `${conversation.source}:${conversation.source_id}`;
  // Store conversation under its own key
  await chrome.storage.local.set({ [CONV_PREFIX + key]: conversation });
  // Update index
  const result = await chrome.storage.local.get(CONV_INDEX_KEY);
  const keys: string[] = (result[CONV_INDEX_KEY] as string[]) || [];
  if (!keys.includes(key)) {
    keys.push(key);
    await chrome.storage.local.set({ [CONV_INDEX_KEY]: keys });
  }
  await updateUpdatedAtIndex([conversation]);
}

export async function saveConversationsBatch(convos: Conversation[]): Promise<void> {
  if (convos.length === 0) return;
  // Write all conversations in one set call (each under its own key)
  const toSet: Record<string, Conversation> = {};
  const newKeys: string[] = [];
  for (const convo of convos) {
    const key = `${convo.source}:${convo.source_id}`;
    toSet[CONV_PREFIX + key] = convo;
    newKeys.push(key);
  }
  await chrome.storage.local.set(toSet);
  // Update index
  const result = await chrome.storage.local.get(CONV_INDEX_KEY);
  const existingKeys: string[] = (result[CONV_INDEX_KEY] as string[]) || [];
  const keySet = new Set(existingKeys);
  for (const k of newKeys) keySet.add(k);
  await chrome.storage.local.set({ [CONV_INDEX_KEY]: [...keySet] });
  await updateUpdatedAtIndex(convos);
}

export async function getConversationCountByProvider(providerId: string): Promise<number> {
  const result = await chrome.storage.local.get(CONV_INDEX_KEY);
  const keys: string[] = (result[CONV_INDEX_KEY] as string[]) || [];
  return keys.filter((k) => k.startsWith(providerId + ":")).length;
}

export async function getExistingSourceIds(providerId: string): Promise<Set<string>> {
  const result = await chrome.storage.local.get(CONV_INDEX_KEY);
  const keys: string[] = (result[CONV_INDEX_KEY] as string[]) || [];
  const prefix = providerId + ":";
  const ids = new Set<string>();
  for (const k of keys) {
    if (k.startsWith(prefix)) ids.add(k.slice(prefix.length));
  }
  return ids;
}

/**
 * Locally known source_id -> updated_at for a provider (goal 2026-07-26 step
 * 15, #27/#57). Unlike getExistingSourceIds (id membership only), this
 * carries the timestamp needed for changed-vs-known partitioning
 * (sync/delta.ts's partitionByChangeStatus) — a conversation whose id we
 * already have locally but whose remote updated_at has moved on must still
 * be re-fetched, not skipped.
 *
 * M2 fix (adversarial review): reads the lightweight UPDATED_AT_INDEX_KEY
 * (maintained incrementally by saveConversation/saveConversationsBatch)
 * instead of calling getConversations(), which materializes every stored
 * conversation INCLUDING full message bodies in the MV3 service worker --
 * hundreds of MB at real-world corpus sizes, on every single sync cycle.
 */
export async function getKnownUpdatedAtByProvider(providerId: string): Promise<Map<string, string>> {
  const index = await getOrBuildUpdatedAtIndex();
  const prefix = providerId + ":";
  const known = new Map<string, string>();
  for (const [key, updatedAt] of Object.entries(index)) {
    if (!key.startsWith(prefix)) continue;
    known.set(key.slice(prefix.length), updatedAt);
  }
  return known;
}

export async function getAllConversationsForExport(): Promise<Conversation[]> {
  const conversations = await getConversations();
  return Object.values(conversations).sort(
    (a, b) => new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime(),
  );
}

// --- Settings ---

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return (
    (result[STORAGE_KEYS.SETTINGS] as Settings) || {
      syncIntervalMinutes: 24 * 60,
      enabledProviders: ["claude", "chatgpt"],
    }
  );
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

// --- Storage Key Migration (llm_sync_* → membral_*) ---

export async function migrateStorageKeys(): Promise<void> {
  const OLD_PREFIX = "llm_sync_";
  const NEW_PREFIX = "membral_";
  const OLD_CONV_INDEX = "llm_sync_conv_index";
  const NEW_CONV_INDEX = "membral_conv_index";

  // Check if migration needed
  const result = await chrome.storage.local.get(OLD_CONV_INDEX);
  if (!result[OLD_CONV_INDEX]) return; // Already migrated or fresh install

  // Migrate conv index
  const oldIndex = result[OLD_CONV_INDEX];
  await chrome.storage.local.set({ [NEW_CONV_INDEX]: oldIndex });
  await chrome.storage.local.remove(OLD_CONV_INDEX);

  // Migrate storage keys
  const oldKeys = [
    "llm_sync_conversations",
    "llm_sync_state",
    "llm_sync_settings",
    "llm_sync_auth",
    "llm_sync_cloud_url",
  ];
  const oldData = await chrome.storage.local.get(oldKeys);
  const newData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(oldData)) {
    const newKey = key.replace(OLD_PREFIX, NEW_PREFIX);
    newData[newKey] = value;
  }
  if (Object.keys(newData).length > 0) {
    await chrome.storage.local.set(newData);
    await chrome.storage.local.remove(oldKeys);
  }
}
