import type { ExportMetadata } from "@membral/core";
import { getAllConversationsForExport, getSyncState } from "../common/storage.js";

interface ExportResult {
  url: string;
  filename: string;
  stats: ExportMetadata;
}

/**
 * Export all synced conversations as a JSON data URL for download.
 * Returns { url, filename, stats } -- caller is responsible for triggering download.
 */
export async function exportAsJson(): Promise<ExportResult> {
  const conversations = await getAllConversationsForExport();
  const syncState = await getSyncState();

  const metadata: ExportMetadata = {
    exported_at: new Date().toISOString(),
    last_sync_at: syncState.lastFullSyncAt,
    total_conversations: conversations.length,
    by_source: {},
  };

  for (const convo of conversations) {
    metadata.by_source[convo.source] = (metadata.by_source[convo.source] || 0) + 1;
  }

  const exportData = { metadata, conversations };

  const jsonStr = JSON.stringify(exportData, null, 2);
  const base64 = btoa(unescape(encodeURIComponent(jsonStr)));
  const url = `data:application/json;base64,${base64}`;
  const date = new Date().toISOString().split("T")[0];
  const filename = `membral-export-${date}.json`;

  return { url, filename, stats: metadata };
}
