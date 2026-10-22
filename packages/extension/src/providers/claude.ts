import type { Conversation } from "@membral/core";
import { extractMessages, normalizeConversation } from "@membral/core";
import { DEFAULT_PAGE_SIZE, PROVIDERS } from "../common/constants.js";
import { fetchWithTimeout } from "../common/fetch.js";
import { RateController } from "../common/rate-controller.js";
import type { IsCancelled, OnBatchCallback, ProviderSyncResult, SyncProgress } from "../common/types.js";
import { isAtOrBeforeCursor, type ListTruncationFlag, partitionByChangeStatus, toIsoTimestamp } from "../sync/delta.js";

interface ConvMeta {
  id: string;
  title: string;
  /** M4 fix (adversarial review): retry placeholders carry `null`, never "" -- an empty string is a real (if degenerate) value, `null` unambiguously means "no data yet, prefer whatever the full-conversation fetch reports." */
  created_at: string | null;
  updated_at: string | null;
}

const PROVIDER = PROVIDERS.claude;

async function getSessionCookie(): Promise<string> {
  const cookie = await chrome.cookies.get({
    url: PROVIDER.baseUrl,
    name: "sessionKey",
  });
  if (!cookie) throw new Error("Claude.ai: Not logged in (no sessionKey cookie)");
  return cookie.value;
}

class RateLimitError extends Error {
  constructor(path: string) {
    super(`Claude 429 on ${path}`);
    this.name = "RateLimitError";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apiFetch(path: string, sessionKey: string): Promise<any> {
  const response = await fetchWithTimeout(`${PROVIDER.baseUrl}${path}`, {
    headers: {
      Cookie: `sessionKey=${sessionKey}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 429) {
    throw new RateLimitError(path);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Claude API ${response.status}: ${text.substring(0, 200)}`);
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
  sessionKey: string,
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
        console.log(`Claude ${label}: cancelled during retry backoff, giving up on ${path}`);
        throw lastErr instanceof Error ? lastErr : new Error(`${label} ${path}: cancelled`);
      }
    }
    console.log(`Claude ${label}: ${path}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`);
    try {
      const result = await apiFetch(path, sessionKey);
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

async function getOrgId(sessionKey: string, rc: RateController): Promise<string> {
  const orgs = await fetchWithRetry("/api/organizations", sessionKey, rc, "org");
  const chatOrg = orgs.find(
    (o: { capabilities?: string[]; uuid: string }) =>
      o.capabilities?.includes("chat") || o.capabilities?.includes("claude_pro"),
  );
  if (chatOrg) return chatOrg.uuid;
  if (orgs.length > 0) return orgs[0].uuid;
  throw new Error("Claude.ai: No organization found");
}

/**
 * MN1 fix (adversarial review): a page-count cap independent of the cursor
 * stop-condition. Claude's list endpoint has no documented `order` param we
 * can rely on to guarantee strict newest-first ordering -- the whole-page
 * stop condition below is the primary defense against a single out-of-order
 * or unparseable-timestamp item truncating an otherwise-newer page; this cap
 * is the last-resort backstop against genuinely unbounded pagination (e.g. a
 * persistently-null cursor combined with a pathological amount of history).
 */
const MAX_LIST_PAGES = 500;

/**
 * Exported for unit testing pagination stop-condition + cancel-mid-pagination
 * (goal 2026-07-26 step 15, #27/#57 requirement 7). `truncationFlag` is an
 * optional mutable out-param (#120, sync/delta.ts's ListTruncationFlag) --
 * kept separate from the return value so existing tests that treat it as a
 * plain array are unaffected.
 */
export async function fetchConversationList(
  sessionKey: string,
  orgId: string,
  sinceTimestamp: string | null,
  rc: RateController,
  isCancelled: IsCancelled,
  truncationFlag?: ListTruncationFlag,
): Promise<ConvMeta[]> {
  const conversations: ConvMeta[] = [];
  let offset = 0;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore) {
    if (isCancelled()) {
      console.log("Claude: listing cancelled mid-pagination");
      break;
    }

    pageCount++;
    if (pageCount > MAX_LIST_PAGES) {
      console.warn(`Claude: hit the ${MAX_LIST_PAGES}-page runaway guard -- stopping listing early`);
      if (truncationFlag) truncationFlag.truncated = true;
      break;
    }

    let data: unknown;
    try {
      data = await fetchWithRetry(
        `/api/organizations/${orgId}/chat_conversations?limit=${DEFAULT_PAGE_SIZE}&offset=${offset}`,
        sessionKey,
        rc,
        "list",
        isCancelled,
      );
    } catch (err) {
      // MN5 fix (adversarial review): a cancellation observed mid-retry-backoff
      // surfaces as a thrown error from fetchWithRetry -- treat that the same
      // as the ordinary isCancelled() pagination stop above (clean end, not a
      // sync-level failure), and only that same as ordinary otherwise.
      if (isCancelled()) {
        console.log("Claude: listing cancelled mid-retry-wait");
        break;
      }
      throw err;
    }

    if (!Array.isArray(data) || data.length === 0) {
      hasMore = false;
      break;
    }

    // MN1 fix (adversarial review): the stop condition requires the ENTIRE
    // page to be at-or-before the cursor, not just the first item hit -- one
    // out-of-order item must not truncate the rest of an otherwise-newer
    // page. Only PAGING is gated on the cursor; inclusion is not (B2) --
    // every item not proven old gets fetched.
    let anyNewInPage = false;
    for (const conv of data) {
      const updatedAtIso = toIsoTimestamp(conv.updated_at, false);
      if (isAtOrBeforeCursor(updatedAtIso, sinceTimestamp)) {
        continue;
      }
      anyNewInPage = true;
      conversations.push({
        id: conv.uuid,
        title: conv.name,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
      });
    }

    if (sinceTimestamp && !anyNewInPage) {
      hasMore = false;
      break;
    }

    if (data.length < DEFAULT_PAGE_SIZE) {
      hasMore = false;
    }
    offset += DEFAULT_PAGE_SIZE;

    if (hasMore) {
      if (isCancelled()) break;
      // MN4 fix (adversarial review): pace list-page requests the same way
      // chatgpt.ts already does between its pages -- previously Claude's
      // listing had no inter-page wait at all.
      await rc.wait(isCancelled);
    }
  }

  return conversations;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchFullConversation(
  sessionKey: string,
  orgId: string,
  conversationId: string,
  rc: RateController,
  isCancelled?: IsCancelled,
): Promise<any> {
  return fetchWithRetry(
    `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`,
    sessionKey,
    rc,
    "fetch",
    isCancelled,
  );
}

// Content-block rendering and message extraction used to live here as
// private copies; they're now shared with the bulk export importer
// (packages/core/src/importers/claude-export.ts) since the live backend API
// and the official `conversations.json` export use the exact same
// `chat_messages`/content-block shape. Re-exported so this module stays the
// single import path other extension code (and this file's own tests) use
// for it.
export { extractMessages };

export type SyncResult = ProviderSyncResult;

export async function sync(
  sinceTimestamp: string | null,
  onProgress: (p: SyncProgress) => void = () => {},
  onBatch: OnBatchCallback = async () => {},
  retryIds: string[] = [],
  known: Map<string, string> = new Map(),
  isCancelled: IsCancelled = () => false,
): Promise<SyncResult> {
  onProgress({ status: "authenticating", detail: "Reading session cookie..." });
  const sessionKey = await getSessionCookie();

  const rc = new RateController("Claude");

  onProgress({ status: "fetching_org", detail: "Getting organization..." });
  const orgId = await getOrgId(sessionKey, rc);

  onProgress({ status: "listing", detail: "Fetching conversation list..." });
  const truncationFlag: ListTruncationFlag = { truncated: false };
  const fullList = await fetchConversationList(sessionKey, orgId, sinceTimestamp, rc, isCancelled, truncationFlag);

  const { newIds, updatedIds } = partitionByChangeStatus(
    fullList.map((c) => ({ id: c.id, updatedAtIso: toIsoTimestamp(c.updated_at, false) })),
    known,
  );
  const changedIds = new Set([...newIds, ...updatedIds]);
  const convList = fullList.filter((c) => changedIds.has(c.id));
  const unchangedCount = fullList.length - convList.length;
  if (unchangedCount > 0) {
    console.log(
      `Claude: skipping ${unchangedCount} unchanged conversations (${newIds.length} new, ${updatedIds.length} updated to fetch)`,
    );
  }

  // M4 fix (adversarial review): retry placeholders carry `null`, never ""
  // -- an empty string still had to pass through normalizer.toISO, and while
  // it happens to also resolve to null there, `null` says the intent plainly
  // and can't accidentally regress to a falsy-but-real placeholder later.
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
    // branch (convList is empty, or we're cancelled before ever attempting a
    // fetch) -- newCount/updatedCount must report what was CAPTURED, not
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
      console.log(`Claude: cancelled with ${remaining.length} conversation(s) left to fetch — queued for retry`);
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
      const raw = await fetchFullConversation(sessionKey, orgId, convMeta.id, rc, isCancelled);
      const messages = extractMessages(raw);

      const conv = normalizeConversation({
        source: "claude",
        source_id: convMeta.id,
        title: raw.name || convMeta.title,
        created_at: raw.created_at || convMeta.created_at,
        updated_at: raw.updated_at || convMeta.updated_at,
        model: raw.model || null,
        messages,
        metadata: {
          url: `${PROVIDER.baseUrl}/chat/${convMeta.id}`,
          ...(raw.project_uuid && { project_id: raw.project_uuid }),
        },
      });
      pendingBatch.push(conv);
      normalized.push(conv);
      if (newIdSet.has(convMeta.id)) capturedNewCount++;
      else if (updatedIdSet.has(convMeta.id)) capturedUpdatedCount++;
    } catch (err) {
      failedIds.push(convMeta.id);
      if (err instanceof RateLimitError) {
        console.warn(`Claude: Rate limited on ${convMeta.id} after ${rc.maxRetries + 1} attempts, moving on`);
      } else {
        console.error(`Claude: Failed to fetch conversation ${convMeta.id}:`, err);
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
    console.warn(`Claude: ${failedIds.length}/${convList.length} conversations failed — will retry on next sync`);
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
