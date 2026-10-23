import type { Conversation } from "@membral/core";
import { getAccessToken, getAuthState } from "../auth/auth.js";
import { STORAGE_KEYS } from "../common/constants.js";
import { fetchWithTimeout } from "../common/fetch.js";
import { RateController } from "../common/rate-controller.js";
import { getCloudIdMap } from "./cloud-manifest.js";

// Default target. A hosted build (VITE_MEMBRAL_PROD=1, see build-manifest.ts) points at
// https://membral.me; every other build points at a local Membral (`membral local up`, port 3000).
// VITE_CLOUD_URL overrides both at build time, and the Cloud URL saved in options overrides at runtime.
// The localhost default is assigned inside an `if` block (not a ternary) so the bundler drops the
// literal from builds that set VITE_CLOUD_URL or VITE_MEMBRAL_PROD — the packaging script
// (apps/cloud/scripts/package-extension.mjs) refuses any zip that still contains it.
let DEFAULT_CLOUD_URL: string = import.meta.env.VITE_CLOUD_URL ?? "https://membral.me";
if (import.meta.env.VITE_MEMBRAL_PROD !== "1" && !import.meta.env.VITE_CLOUD_URL) {
  DEFAULT_CLOUD_URL = "http://localhost:3000";
}
export const API_KEY_REJECTED_MESSAGE = "API key rejected: check the key in the extension options";
const LAST_CLOUD_PUSH_KEY = "membral_last_cloud_push_at";
// Round-2 review MED 9: a permanently-over-quota account (e.g. a new user
// with 1,500 conversations against the default conversation_limit=100)
// would otherwise resend the identical capped batch every
// SYNC_INTERVAL_MINUTES forever — atLimit correctly never advances the push
// cursor (advancing would drop the skipped remainder permanently), but
// nothing bounded how OFTEN the doomed re-send happened. This key persists
// when a quota rejection was last seen; QUOTA_BACKOFF_MS gates how soon
// pushToCloud will try again, rather than every sync cycle.
const QUOTA_BACKOFF_UNTIL_KEY = "membral_cloud_quota_backoff_until";
export const QUOTA_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

/**
 * Issue #127: /api/sync now rejects a request whose `conversations[]`
 * exceeds MAX_CONVERSATIONS_PER_REQUEST (apps/cloud/src/lib/sync-validator.ts)
 * — 500, matching this constant exactly. A fresh install / full backfill
 * (no lastCloudPushAt cursor yet) can have a local corpus far larger than
 * one request should carry in one shot, so pushToCloud chunks `deduped`
 * into batches of this size and POSTs them sequentially instead of ever
 * exceeding the server's cap.
 */
export const MAX_SYNC_BATCH_SIZE = 500;

export interface CloudPushResult {
  pushed: boolean;
  synced?: number;
  total?: number;
  atLimit?: boolean;
  error?: string;
}

export interface CloudSyncStatus {
  state: "idle" | "syncing" | "synced" | "error";
  count?: number;
  total?: number;
  atLimit?: boolean;
  error?: string;
  at?: string;
}

export async function getCloudUrl(): Promise<string> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CLOUD_URL);
  return (result[STORAGE_KEYS.CLOUD_URL] as string) || DEFAULT_CLOUD_URL;
}

export async function getCloudSyncStatus(): Promise<CloudSyncStatus> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CLOUD_SYNC_STATUS);
  return (result[STORAGE_KEYS.CLOUD_SYNC_STATUS] as CloudSyncStatus) || { state: "idle" };
}

/** Pure formatting so the popup's atLimit/n-of-N display is unit-testable without a DOM. */
export function formatCloudSyncStatus(status: CloudSyncStatus): { text: string; color: string } {
  const syncedText =
    status.atLimit && status.total !== undefined
      ? `Synced ${status.count ?? 0}/${status.total} (plan limit / rate limited)`
      : `Synced ${status.count ?? 0} to cloud`;
  const text: Record<CloudSyncStatus["state"], string> = {
    idle: "Cloud sync active",
    syncing: "Syncing to cloud…",
    synced: syncedText,
    error: `Cloud sync failed: ${status.error ?? "unknown error"}`,
  };
  const color: Record<CloudSyncStatus["state"], string> = {
    idle: "#666",
    syncing: "#60a5fa",
    synced: status.atLimit ? "#fbbf24" : "#4ade80",
    error: "#f87171",
  };
  return { text: text[status.state], color: color[status.state] };
}

export async function setCloudSyncStatus(status: CloudSyncStatus): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.CLOUD_SYNC_STATUS]: status });
}

async function getLastCloudPushAt(): Promise<string | null> {
  const result = await chrome.storage.local.get(LAST_CLOUD_PUSH_KEY);
  return (result[LAST_CLOUD_PUSH_KEY] as string) || null;
}

async function setLastCloudPushAt(timestamp: string): Promise<void> {
  await chrome.storage.local.set({ [LAST_CLOUD_PUSH_KEY]: timestamp });
}

/** Round-2 review MED 9: null when not backed off, or when a previously-set backoff has expired. */
async function getQuotaBackoffUntil(): Promise<string | null> {
  const result = await chrome.storage.local.get(QUOTA_BACKOFF_UNTIL_KEY);
  const value = (result[QUOTA_BACKOFF_UNTIL_KEY] as string) || null;
  if (!value) return null;
  return new Date(value).getTime() > Date.now() ? value : null;
}

async function setQuotaBackoffUntil(timestamp: string | null): Promise<void> {
  if (timestamp === null) {
    await chrome.storage.local.remove(QUOTA_BACKOFF_UNTIL_KEY);
  } else {
    await chrome.storage.local.set({ [QUOTA_BACKOFF_UNTIL_KEY]: timestamp });
  }
}

function filterDelta(conversations: Conversation[], since: string | null): Conversation[] {
  if (!since) return conversations;
  const sinceDate = new Date(since).getTime();
  return conversations.filter((c) => {
    const syncedAt = c.synced_at ? new Date(c.synced_at).getTime() : 0;
    return syncedAt > sinceDate;
  });
}

function filterCloudDedup(conversations: Conversation[], cloudIdMap: Map<string, string>): Conversation[] {
  if (cloudIdMap.size === 0) return conversations;
  return conversations.filter((conv) => {
    const key = `${conv.source}:${conv.source_id}`;
    const cloudUpdatedAt = cloudIdMap.get(key);
    if (!cloudUpdatedAt) return true;
    const localUpdatedAt = conv.updated_at ?? conv.synced_at ?? "";
    return localUpdatedAt > cloudUpdatedAt;
  });
}

/** Splits `items` into MAX_SYNC_BATCH_SIZE-sized chunks. Always returns at
 * least one (possibly empty) batch, so a `sources`-only heartbeat ping
 * (issue #127, empty `items`) still has exactly one batch to carry it. */
function chunkConversations(items: Conversation[], size: number): Conversation[][] {
  if (items.length === 0) return [[]];
  if (items.length <= size) return [items];
  const out: Conversation[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type BatchOutcome =
  | { kind: "ok"; synced: number; total?: number; atLimit: boolean }
  | { kind: "quota"; message: string }
  | { kind: "error"; message: string };

/**
 * POSTs one batch to /api/sync. On a 429, retries using the shared
 * RateController (CLAUDE.md rate-limit conventions: never retry
 * immediately, proportional multiplier backoff, decay on success, low
 * bounded retry count) — the server's own `Retry-After` header is honored
 * as a FLOOR on top of whatever the controller's own current delay is,
 * never retried sooner than either.
 */
async function postSyncBatch(
  cloudUrl: string,
  token: string,
  batchConversations: Conversation[],
  batchSources: string[],
  rateController: RateController,
  usingApiKey = false,
): Promise<BatchOutcome> {
  for (let attempt = 0; attempt <= rateController.maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(`${cloudUrl}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ conversations: batchConversations, sources: batchSources }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "error", message: `Cloud push error: ${message}` };
    }

    // A stored API key that the server refuses (revoked, mistyped, other stack) will not start
    // working on a retry: report it once and stop; the next scheduled sync tries again.
    if (response.status === 401 && usingApiKey) {
      return { kind: "error", message: API_KEY_REJECTED_MESSAGE };
    }

    if (response.status === 429) {
      rateController.on429();
      if (attempt < rateController.maxRetries) {
        const retryAfterSeconds = Number(response.headers.get("Retry-After"));
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
        // Never sooner than the server-declared Retry-After OR the
        // controller's own current backoff, whichever is longer.
        await delay(Math.max(retryAfterMs, rateController.stats.currentDelayMs));
        continue;
      }
      return { kind: "error", message: "Cloud sync failed: 429 rate limited, retries exhausted" };
    }

    // Issue #127: profiles.conversation_limit enforcement — a distinct,
    // expected condition (not a server malfunction), surfaced with a
    // specific popup message instead of the generic
    // "Cloud sync failed: 402 Payment Required".
    if (response.status === 402) {
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (data.error === "conversation_limit") {
        const limit = typeof data.limit === "number" ? data.limit : undefined;
        const count = typeof data.count === "number" ? data.count : undefined;
        const message =
          limit !== undefined && count !== undefined
            ? `Conversation limit reached (${count}/${limit}) — upgrade your plan to sync more.`
            : "Conversation limit reached — upgrade your plan to sync more.";
        return { kind: "quota", message };
      }
      return { kind: "error", message: `Cloud sync failed: 402 ${response.statusText}` };
    }

    if (!response.ok) {
      return { kind: "error", message: `Cloud sync failed: ${response.status} ${response.statusText}` };
    }

    rateController.onSuccess();
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      kind: "ok",
      synced: typeof data.synced === "number" ? data.synced : 0,
      total: typeof data.total === "number" ? data.total : undefined,
      atLimit: Boolean(data.atLimit),
    };
  }
  // Unreachable (the loop above always returns) — keeps the return type total.
  return { kind: "error", message: "Cloud sync failed: exhausted retries" };
}

/**
 * @param syncedProviderIds provider ids whose sync cycle just completed
 *   SUCCESSFULLY this run — regardless of whether it found any new
 *   conversations (goal 2026-07-26 step 2, MAJOR 2 / #63/#58). Defaults to
 *   `[]` for backward compatibility with the pre-existing "only push when
 *   there's something new" behaviour. When non-empty, a completed cycle that
 *   found nothing new still reaches the server (as `{conversations: [],
 *   sources: syncedProviderIds}`) so its freshness heartbeat gets recorded —
 *   otherwise a genuinely quiet week (real provider, zero new conversations)
 *   is indistinguishable from the sync having silently stopped altogether.
 */
export async function pushToCloud(
  conversations: Conversation[],
  syncedProviderIds: string[] = [],
): Promise<CloudPushResult> {
  if (conversations.length === 0 && syncedProviderIds.length === 0) {
    return { pushed: false };
  }

  const authState = await getAuthState();
  if (!authState.isLoggedIn) {
    return { pushed: false };
  }

  const token = await getAccessToken();
  if (!token) {
    return { pushed: false };
  }

  // Round-2 review MED 9: skip this cycle entirely while backed off from a
  // recent quota rejection — the account is at conversation_limit and
  // nothing about that changes between sync cycles a few minutes apart.
  // atLimit is still reported so the popup keeps showing the plan-limit
  // state during the backoff window.
  const backoffUntil = await getQuotaBackoffUntil();
  if (backoffUntil) {
    return { pushed: false, atLimit: true };
  }

  const cloudUrl = await getCloudUrl();
  const lastPushAt = await getLastCloudPushAt();
  const delta = filterDelta(conversations, lastPushAt);

  const cloudIdMap = await getCloudIdMap(conversations.length, token, cloudUrl);
  const deduped = filterCloudDedup(delta, cloudIdMap);

  // Nothing new AND no completed-cycle sources to report — preserves the
  // original no-op behaviour exactly (no network call to /api/sync at all).
  if (deduped.length === 0 && syncedProviderIds.length === 0) {
    return { pushed: false };
  }

  await setCloudSyncStatus({ state: "syncing", at: new Date().toISOString() });

  // Issue #127: chunk into MAX_SYNC_BATCH_SIZE-sized batches (the server's
  // own per-request conversations[] cap) and POST them sequentially, sharing
  // one RateController across the whole run so a 429 anywhere in the run
  // backs off (and later decays) consistently rather than resetting per
  // batch.
  const batches = chunkConversations(deduped, MAX_SYNC_BATCH_SIZE);
  const rateController = new RateController("cloud-sync");

  let totalSynced = 0;
  let totalReported: number | undefined;
  let atLimit = false;
  let advanceCursor = true;

  for (let i = 0; i < batches.length; i++) {
    const batchConversations = batches[i];
    // `sources` only needs to be reported once per push — attach it to the
    // LAST batch so a full backfill's earlier batches don't each redundantly
    // re-declare it (harmless either way — recordChatHeartbeats upserts —
    // but there's no reason to repeat it).
    const batchSources = i === batches.length - 1 ? syncedProviderIds : [];

    const outcome = await postSyncBatch(
      cloudUrl,
      token,
      batchConversations,
      batchSources,
      rateController,
      authState.kind === "api-key",
    );

    if (outcome.kind === "error") {
      await setCloudSyncStatus({ state: "error", error: outcome.message, at: new Date().toISOString() });
      return { pushed: totalSynced > 0, synced: totalSynced, total: totalReported, atLimit, error: outcome.message };
    }

    if (outcome.kind === "quota") {
      // Nothing in this batch landed at all — the account is fully at its
      // conversation_limit. Never advance the cursor (these conversations
      // must be re-attempted once the user upgrades or frees up room), and
      // stop — further batches would just hit the same wall.
      await setCloudSyncStatus({ state: "error", error: outcome.message, at: new Date().toISOString() });
      // Round-2 review MED 9: back off further attempts for a while rather
      // than retrying this identical doomed batch next cycle.
      await setQuotaBackoffUntil(new Date(Date.now() + QUOTA_BACKOFF_MS).toISOString());
      return {
        pushed: totalSynced > 0,
        synced: totalSynced,
        total: totalReported,
        atLimit: true,
        error: outcome.message,
      };
    }

    totalSynced += outcome.synced;
    if (outcome.total !== undefined) totalReported = (totalReported ?? 0) + outcome.total;

    if (outcome.atLimit) {
      // A partial batch: some rows landed, the rest were skipped for quota
      // reasons. Same reasoning as above — don't advance the cursor, and
      // stop sending further batches (they'd only be skipped too).
      atLimit = true;
      advanceCursor = false;
      // Round-2 review MED 9: same backoff as the full-rejection case above.
      await setQuotaBackoffUntil(new Date(Date.now() + QUOTA_BACKOFF_MS).toISOString());
      break;
    }
  }

  // Only advance the push cursor when every batch was fully confirmed
  // accepted. atLimit means some conversations were never persisted — if we
  // advanced the cursor anyway, filterDelta would exclude those (via their
  // already-past synced_at) from every future sync, permanently dropping them.
  if (advanceCursor) {
    await setLastCloudPushAt(new Date().toISOString());
    // Round-2 review MED 9: a fully-accepted push means the account has
    // headroom again (or never lacked it) — clear any stale backoff so
    // recovery (e.g. the user just upgraded) doesn't wait out the window.
    await setQuotaBackoffUntil(null);
  }

  await setCloudSyncStatus({
    state: "synced",
    count: totalSynced,
    total: totalReported,
    atLimit,
    at: new Date().toISOString(),
  });
  return {
    pushed: true,
    synced: totalSynced,
    total: totalReported,
    atLimit,
  };
}
