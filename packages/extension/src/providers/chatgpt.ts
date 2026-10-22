import type { Conversation } from "@membral/core";
import { normalizeConversation, treeToLinearMessages as treeToLinearMessagesCore } from "@membral/core";
import { PROVIDERS } from "../common/constants.js";
import { fetchWithTimeout } from "../common/fetch.js";
import { RateController } from "../common/rate-controller.js";
import type { IsCancelled, OnBatchCallback, ProviderSyncResult, SyncProgress } from "../common/types.js";
import { isAtOrBeforeCursor, type ListTruncationFlag, partitionByChangeStatus, toIsoTimestamp } from "../sync/delta.js";

const PROVIDER = PROVIDERS.chatgpt;

interface ConvMeta {
  id: string;
  title: string;
  /**
   * M4 fix (adversarial review): retry placeholders carry `null`, never the
   * epoch-0 sentinel (0) that used to sit here -- `toISO(0)` normalizes to
   * "1970-01-01...", which then becomes load-bearing once pushed to the
   * cloud manifest and re-used to seed the NEXT cycle's cursor. `null`
   * unambiguously means "no data yet, prefer whatever the full-conversation
   * fetch reports."
   */
  created_at: string | number | null;
  updated_at: string | number | null;
}

async function buildCookieHeader(): Promise<string> {
  const dotDomain = await chrome.cookies.getAll({ domain: ".chatgpt.com" });
  const bareDomain = await chrome.cookies.getAll({ domain: "chatgpt.com" });
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const c of [...dotDomain, ...bareDomain]) {
    const key = `${c.name}|${c.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      parts.push(`${c.name}=${c.value}`);
    }
  }

  if (parts.length === 0) throw new Error("ChatGPT: Not logged in (no cookies)");
  return parts.join("; ");
}

function getOaiDeviceId(cookieHeader: string): string | undefined {
  const match = cookieHeader.match(/oai-did=([^;]+)/);
  return match ? match[1] : undefined;
}

async function getAccessToken(cookieHeader: string): Promise<string> {
  const response = await fetchWithTimeout(`${PROVIDER.baseUrl}/api/auth/session`, {
    headers: {
      Cookie: cookieHeader,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
  });

  if (!response.ok) throw new Error(`ChatGPT: Session fetch failed (${response.status})`);

  const text = await response.text();
  if (!text || text === "{}") throw new Error("ChatGPT: Empty session response -- cookies may be expired");

  let data: { accessToken?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`ChatGPT: Invalid session JSON: ${text.substring(0, 100)}`);
  }

  if (!data.accessToken) throw new Error("ChatGPT: No access token in session response");
  return data.accessToken;
}

class RateLimitError extends Error {
  constructor(path: string) {
    super(`ChatGPT 429 on ${path}`);
    this.name = "RateLimitError";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apiFetch(path: string, accessToken: string, cookieHeader: string): Promise<any> {
  const deviceId = getOaiDeviceId(cookieHeader);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Cookie: cookieHeader,
    "Content-Type": "application/json",
    Accept: "*/*",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    "oai-language": "en-US",
    Referer: "https://chatgpt.com/",
  };
  if (deviceId) headers["oai-device-id"] = deviceId;

  const response = await fetchWithTimeout(`${PROVIDER.baseUrl}${path}`, { headers });

  if (response.status === 429) {
    throw new RateLimitError(path);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ChatGPT API ${response.status}: ${text.substring(0, 200)}`);
  }

  return response.json();
}

/**
 * MN5 fix (adversarial review): `isCancelled` is optional and, when given,
 * makes the inter-attempt backoff wait cancellation-aware (RateController.wait
 * resolves early instead of blocking for the full up-to-120s delay), and a
 * cancellation observed between attempts stops retrying immediately rather
 * than burning through the remaining backoff/retry budget for no reason.
 */
async function fetchWithRetry(
  path: string,
  accessToken: string,
  cookieHeader: string,
  rc: RateController,
  label: string,
  isCancelled?: IsCancelled,
): Promise<// eslint-disable-next-line @typescript-eslint/no-explicit-any
any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= rc.maxRetries; attempt++) {
    if (attempt > 0) {
      await rc.wait(isCancelled);
      if (isCancelled?.()) {
        console.log(`ChatGPT ${label}: cancelled during retry backoff, giving up on ${path}`);
        throw lastErr instanceof Error ? lastErr : new Error(`${label} ${path}: cancelled`);
      }
    }
    console.log(`ChatGPT ${label}: ${path}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`);
    try {
      const result = await apiFetch(path, accessToken, cookieHeader);
      rc.onSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      if (err instanceof RateLimitError) {
        rc.on429();
        if (attempt === rc.maxRetries) throw err;
        continue;
      }
      throw err;
    }
  }
}

/**
 * MN1 fix (adversarial review): a page-count cap independent of the cursor
 * stop-condition -- the primary defense against a single out-of-order or
 * unparseable-timestamp item truncating an otherwise-newer page is the
 * whole-page stop condition below; this cap is the last-resort backstop
 * against genuinely unbounded pagination.
 */
const MAX_LIST_PAGES = 500;

/**
 * Exported for unit testing pagination stop-condition + cancel-mid-pagination
 * (mirrors claude.ts's fetchConversationList export) -- including the
 * sync-window cutoff (#120), which is just another `sinceTimestamp` value
 * from this function's point of view, and the epoch-seconds `update_time`
 * conversion CLAUDE.md's Extension Runtime Rules call out explicitly.
 */
export async function fetchConversationList(
  accessToken: string,
  cookieHeader: string,
  sinceTimestamp: string | null,
  onProgress: (p: SyncProgress) => void,
  rc: RateController,
  isCancelled: IsCancelled,
  truncationFlag?: ListTruncationFlag,
): Promise<ConvMeta[]> {
  const conversations: ConvMeta[] = [];
  let offset = 0;
  const limit = 100;
  let pageCount = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isCancelled()) {
      console.log("ChatGPT: listing cancelled mid-pagination");
      break;
    }

    pageCount++;
    if (pageCount > MAX_LIST_PAGES) {
      console.warn(`ChatGPT: hit the ${MAX_LIST_PAGES}-page runaway guard -- stopping listing early`);
      if (truncationFlag) truncationFlag.truncated = true;
      break;
    }

    // biome-ignore lint/suspicious/noExplicitAny: raw provider payload
    let data: any;
    try {
      data = await fetchWithRetry(
        `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`,
        accessToken,
        cookieHeader,
        rc,
        "list",
        isCancelled,
      );
    } catch (err) {
      // MN5 fix (adversarial review): a cancellation observed mid-retry-backoff
      // surfaces as a thrown error from fetchWithRetry -- treat that the same
      // as the ordinary isCancelled() pagination stop above (clean end, not a
      // sync-level failure).
      if (isCancelled()) {
        console.log("ChatGPT: listing cancelled mid-retry-wait");
        break;
      }
      throw err;
    }

    const items = data.items || [];
    const reportedTotal = typeof data.total === "number" ? data.total : "?";
    onProgress({ status: "listing", detail: `Listed ${offset + items.length} / ${reportedTotal} conversations...` });

    if (items.length === 0) break;

    if (items.length > 0) {
      const first = items[0];
      console.log(
        `ChatGPT list[0]: id=${first.id} update_time=${first.update_time} (${typeof first.update_time}) title="${(first.title || "").substring(0, 40)}"${sinceTimestamp ? ` since=${sinceTimestamp}` : ""}`,
      );
    }

    // MN1 fix (adversarial review): the stop condition requires the ENTIRE
    // page to be at-or-before the cursor, not just the first item hit -- one
    // out-of-order item must not truncate the rest of an otherwise-newer
    // page (B2's fix). Only PAGING is gated on the cursor; inclusion is not
    // -- every item not proven old gets included.
    let anyNewInPage = false;
    for (const conv of items) {
      // ChatGPT's update_time is epoch seconds -- always convert to ISO
      // before comparing with the (already-ISO) cursor (CLAUDE.md rule).
      const updatedAtIso = toIsoTimestamp(conv.update_time, true);
      if (isAtOrBeforeCursor(updatedAtIso, sinceTimestamp)) {
        continue;
      }
      anyNewInPage = true;
      conversations.push({
        id: conv.id,
        title: conv.title,
        created_at: conv.create_time,
        updated_at: conv.update_time,
      });
    }

    if (sinceTimestamp && !anyNewInPage) {
      console.log(`ChatGPT: entire page at-or-before cursor (${sinceTimestamp}), stopping`);
      break;
    }

    // If we got fewer items than requested, we've hit the end
    if (items.length < limit) break;

    offset += items.length;
    if (isCancelled()) break;
    await rc.wait(isCancelled);
  }

  return conversations;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchFullConversation(
  accessToken: string,
  cookieHeader: string,
  conversationId: string,
  rc: RateController,
  isCancelled?: IsCancelled,
): Promise<any> {
  return fetchWithRetry(
    `/backend-api/conversation/${conversationId}`,
    accessToken,
    cookieHeader,
    rc,
    "fetch",
    isCancelled,
  );
}

// Tree-walk (mapping -> active branch) and content rendering used to live
// here as private copies; they're now shared with the bulk export importer
// (packages/core/src/importers/chatgpt-export.ts) since the live backend API
// and the official `conversations.json` export use the exact same shape.
// Re-exported so this module stays the single import path other extension
// code (and this file's own tests) use for them.
export { renderChatgptContent } from "@membral/core";

const treeToLinearMessages = treeToLinearMessagesCore;

/**
 * M4 fix (adversarial review): resolve the timestamps to normalize a fetched
 * conversation with by preferring the FULL conversation payload's OWN
 * create_time/update_time over the list-derived convMeta stand-in --
 * previously convMeta.updated_at won unconditionally (chatgpt.ts:419's old
 * code), which was fine for normally-listed items but wrong for retry items,
 * whose convMeta carried an epoch-0 placeholder that became load-bearing
 * once pushed to the cloud manifest and re-used to seed the next cycle's
 * cursor. `??` (not `||`) so a legitimate epoch-seconds value of 0 from the
 * raw payload is still honored -- only null/undefined fall through to
 * convMeta.
 */
export function resolveConvTimestamps(
  raw: { create_time?: string | number | null; update_time?: string | number | null },
  convMeta: { created_at: string | number | null; updated_at: string | number | null },
): { created_at: string | number | null; updated_at: string | number | null } {
  return {
    created_at: raw.create_time ?? convMeta.created_at,
    updated_at: raw.update_time ?? convMeta.updated_at,
  };
}

export type SyncResult = ProviderSyncResult;

export async function sync(
  sinceTimestamp: string | null,
  onProgress: (p: SyncProgress) => void = () => {},
  onBatch: OnBatchCallback = async () => {},
  retryIds: string[] = [],
  known: Map<string, string> = new Map(),
  isCancelled: IsCancelled = () => false,
): Promise<SyncResult> {
  onProgress({ status: "authenticating", detail: "Reading cookies..." });
  const cookieHeader = await buildCookieHeader();

  onProgress({ status: "authenticating", detail: "Getting access token..." });
  const accessToken = await getAccessToken(cookieHeader);

  const rc = new RateController("ChatGPT");

  console.log(`ChatGPT sync: sinceTimestamp=${sinceTimestamp}, retryIds=${retryIds.length}, known=${known.size}`);
  onProgress({ status: "listing", detail: "Fetching conversation list..." });
  const truncationFlag: ListTruncationFlag = { truncated: false };
  const fullList = await fetchConversationList(
    accessToken,
    cookieHeader,
    sinceTimestamp,
    onProgress,
    rc,
    isCancelled,
    truncationFlag,
  );

  const { newIds, updatedIds } = partitionByChangeStatus(
    fullList.map((c) => ({ id: c.id, updatedAtIso: toIsoTimestamp(c.updated_at, true) })),
    known,
  );
  const changedIds = new Set([...newIds, ...updatedIds]);
  const convList = fullList.filter((c) => changedIds.has(c.id));
  const unchangedCount = fullList.length - convList.length;
  if (unchangedCount > 0) {
    console.log(
      `ChatGPT: skipping ${unchangedCount} unchanged conversations (${newIds.length} new, ${updatedIds.length} updated to fetch)`,
    );
  }

  // M4 fix (adversarial review): retry placeholders carry `null`, never the
  // epoch-0 sentinel that used to sit here.
  const retryMetas: ConvMeta[] = retryIds
    .filter((id) => !convList.some((c) => c.id === id))
    .map((id) => ({ id, title: "", created_at: null, updated_at: null }));
  if (retryMetas.length > 0) {
    convList.push(...retryMetas);
  }

  if (convList.length === 0 || isCancelled()) {
    const cancelled = isCancelled();
    onProgress({
      status: cancelled ? "cancelled" : "done",
      detail: cancelled ? "Sync cancelled" : "No new conversations to sync",
    });
    // MN2 fix (adversarial review): nothing was actually fetched in this
    // branch -- newCount/updatedCount must report what was CAPTURED, not
    // what listing merely found, so 0/0 here rather than newIds.length/
    // updatedIds.length.
    return {
      conversations: [],
      failedIds: [],
      newCount: 0,
      updatedCount: 0,
      cancelled,
      listTruncated: truncationFlag.truncated,
    };
  }

  onProgress({
    status: "fetching",
    detail: `Fetching ${convList.length} conversations...`,
    total: convList.length,
    current: 0,
  });

  // MN2 fix (adversarial review): delta telemetry must count conversations
  // actually CAPTURED (fetched + normalized), not merely listed as
  // new/updated -- a fetch that fails must not be counted as delivered.
  const newIdSet = new Set(newIds);
  const updatedIdSet = new Set(updatedIds);
  let capturedNewCount = 0;
  let capturedUpdatedCount = 0;

  const normalized: Conversation[] = [];
  const failedIds: string[] = [];
  const SAVE_EVERY = 50;
  let pendingBatch: Conversation[] = [];
  let cancelled = false;

  for (let i = 0; i < convList.length; i++) {
    if (isCancelled()) {
      cancelled = true;
      const remaining = convList.slice(i).map((c) => c.id);
      failedIds.push(...remaining);
      console.log(`ChatGPT: cancelled with ${remaining.length} conversation(s) left to fetch — queued for retry`);
      break;
    }

    const convMeta = convList[i];
    onProgress({
      status: "fetching",
      detail: `Fetching ${i + 1} of ${convList.length}... (${failedIds.length} failed, delay ${rc.stats.currentDelayMs}ms)`,
      current: i + 1,
      total: convList.length,
    });

    try {
      const raw = await fetchFullConversation(accessToken, cookieHeader, convMeta.id, rc, isCancelled);
      const messages = treeToLinearMessages(raw);
      const { created_at, updated_at } = resolveConvTimestamps(raw, convMeta);
      const conv = normalizeConversation({
        source: "chatgpt",
        source_id: convMeta.id,
        title: raw.title || convMeta.title,
        created_at,
        updated_at,
        model: (messages.find((m) => m.metadata?.model)?.metadata?.model as string) || null,
        messages,
        metadata: { url: `${PROVIDER.baseUrl}/c/${convMeta.id}` },
      });
      pendingBatch.push(conv);
      normalized.push(conv);
      if (newIdSet.has(convMeta.id)) capturedNewCount++;
      else if (updatedIdSet.has(convMeta.id)) capturedUpdatedCount++;
    } catch (err) {
      failedIds.push(convMeta.id);
      if (err instanceof RateLimitError) {
        console.warn(`ChatGPT: Rate limited on ${convMeta.id} after ${rc.maxRetries + 1} attempts, moving on`);
      } else {
        console.error(`ChatGPT: Failed to fetch conversation ${convMeta.id}:`, err);
        rc.onError();
      }
    }

    if (pendingBatch.length >= SAVE_EVERY) {
      await onBatch(pendingBatch);
      pendingBatch = [];
    }

    await rc.wait(isCancelled);
  }

  if (pendingBatch.length > 0) {
    await onBatch(pendingBatch);
  }

  rc.logSummary();

  if (failedIds.length > 0) {
    console.warn(`ChatGPT: ${failedIds.length}/${convList.length} conversations failed — will retry on next sync`);
  }

  onProgress({
    status: cancelled ? "cancelled" : "done",
    detail: cancelled
      ? `Cancelled after ${normalized.length} conversations`
      : `Synced ${normalized.length} conversations`,
  });
  return {
    conversations: normalized,
    failedIds,
    newCount: capturedNewCount,
    updatedCount: capturedUpdatedCount,
    cancelled,
    listTruncated: truncationFlag.truncated,
  };
}

export const provider = {
  id: PROVIDER.id,
  name: PROVIDER.name,
  sync,
};
