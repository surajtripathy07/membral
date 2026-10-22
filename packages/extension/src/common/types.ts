import type { Conversation } from "@membral/core";

export interface SyncProgress {
  status: string;
  detail: string;
  current?: number;
  total?: number;
}

export type OnBatchCallback = (conversations: Conversation[]) => Promise<void>;

/** Checked at pagination and per-conversation-fetch boundaries so a sync can be cancelled mid-run (CLAUDE.md "Cancel mechanism" rule). */
export type IsCancelled = () => boolean;

/**
 * Result of a single provider's sync() call (goal 2026-07-26 step 15,
 * #27/#57) — shared shape so engine.ts doesn't duplicate it per provider.
 */
export interface ProviderSyncResult {
  conversations: Conversation[];
  failedIds: string[];
  /** Count of listed conversations partitioned as brand-new this cycle (sync/delta.ts's partitionByChangeStatus). */
  newCount: number;
  /** Count of listed conversations partitioned as already-known-but-changed this cycle. */
  updatedCount: number;
  /** True if isCancelled() was observed true before the provider finished — some listed conversations may not have been fetched (queued into failedIds for retry). */
  cancelled: boolean;
  /**
   * True if the provider's listing pagination hit its runaway page-count
   * guard (chatgpt.ts / claude.ts's MAX_LIST_PAGES) before hitting a real
   * stop condition (adversarial-review NOTE, #120) -- listing stopped
   * WITHOUT confirming it actually reached `sinceTimestamp`. engine.ts uses
   * this to avoid persisting the sync-window floor it asked for as
   * "achieved": doing so would durably record coverage that was never
   * actually verified, and a later widen could never re-trigger to fix it.
   * Defaults to false for a normal, non-truncated listing.
   */
  listTruncated: boolean;
}
