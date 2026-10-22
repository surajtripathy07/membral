export interface Provider {
  id: string;
  name: string;
  domain: string;
  baseUrl: string;
  enabled: boolean;
}

export type MessageRole = "user" | "assistant" | "system" | "unknown";

export interface Message {
  role: MessageRole;
  content: string;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  source: string;
  source_id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
  model: string | null;
  messages: Message[];
  metadata: Record<string, unknown>;
  synced_at: string;
}

export interface ProviderSyncState {
  lastSyncAt: string | null;
  lastSyncStatus: "never" | "syncing" | "success" | "error" | "cancelled";
  lastError: string | null;
  conversationCount: number;
  /**
   * Ids queued for retry on the next cycle. Optional/undefined means "leave
   * whatever is already stored untouched" (updateProviderSyncState strips
   * `undefined` from partial updates -- M1 fix, adversarial review);
   * explicit `null` is the only way to actually clear a previously-stored
   * queue.
   */
  failedIds?: string[] | null;
  /**
   * When lastSyncStatus flipped to "syncing" (goal 2026-07-26 step 2, MAJOR 4
   * / #63/#58 — adversarial review): an MV3 service-worker termination
   * mid-sync can leave a provider permanently stuck at "syncing" with no
   * further writes ever coming, since nothing else clears it. Extension
   * badge logic (common/badge.ts) uses this to detect a stale "syncing" and
   * stop treating it as "currently syncing." Cleared (null) once the sync
   * settles into "success", "error", or "cancelled". Optional/undefined for
   * pre-migration stored state — treated the same as a stale syncing (no
   * start time recorded = no evidence it's still actually running).
   */
  syncStartedAt?: string | null;
  /**
   * Delta-sync telemetry from the most recent cycle (goal 2026-07-26 step 15,
   * #27/#57): counts of conversations the cursor-seeded listing found as
   * brand-new vs already-known-but-changed, so the popup can show
   * "delta: N new / M updated" instead of just a raw total. Undefined for
   * pre-delta-sync stored state or a cycle that errored before listing
   * completed.
   */
  lastDeltaNew?: number;
  lastDeltaUpdated?: number;
  /**
   * The sync-window floor (ISO 8601) actually enforced on the most recent
   * completed (non-cancelled, non-forceFull) cycle -- #120. `null` means "no
   * floor" (the user's window is "All history", or this provider is
   * otherwise known to have no further backfill possible). Compared against
   * the newly-computed window cutoff on the next cycle (sync/delta.ts's
   * isWideningSyncWindow) to detect the user widening the window (e.g.
   * 30 days -> 90 days/All): a widen relaxes the pagination stop condition
   * for that one cycle so the newly-included older range gets listed and
   * backfilled, instead of trusting the delta cursor's "everything before
   * this is already known" assumption, which only holds back to whatever
   * floor was actually enforced last time. Undefined for pre-#120 stored
   * state (treated the same as null -- nothing to widen into, normal
   * cursor+window combination applies).
   */
  syncWindowFloorIso?: string | null;
}

export interface SyncState {
  providers: Record<string, ProviderSyncState>;
  lastFullSyncAt: string | null;
}

export interface ExportMetadata {
  exported_at: string;
  last_sync_at: string | null;
  total_conversations: number;
  by_source: Record<string, number>;
}

// NOTE: the flat `Memory`/`MemoryType` model and the "Rich Memory System (v2)"
// (`ConversationAnalysis`, `UserProfile`, and subtypes) that used to live here
// were removed with `packages/mcp-local` (#40 — mcp-local deprecation). Their
// only writers were mcp-local's `--analyze`/`--synthesize` entry points, and
// grepping apps/cloud + packages/cli + packages/extension confirmed no other
// consumer imported them. The memory model going forward is the knowledge
// graph in `apps/cloud/src/lib/kg/` (see `GraphNode`/`GraphEdge`/`MemoryKind`
// exported from `./graph.js` below) and the cloud `memories` table.
