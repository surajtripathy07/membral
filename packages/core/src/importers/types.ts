/**
 * Shared intermediate message shape produced by the ChatGPT/Claude tree-walk
 * and content-rendering functions, before `normalizeConversation` turns them
 * into `Message[]`. `timestamp` is left un-normalized (epoch seconds for
 * ChatGPT, an ISO string for Claude) — `normalizeConversation` -> `toISO`
 * handles both.
 */
export interface RawImportedMessage {
  role: string;
  content: string;
  timestamp: number | string | null | undefined;
  metadata: Record<string, unknown>;
}

/** One conversation entry from an export that couldn't be parsed/normalized. */
export interface SkippedItem {
  id: string;
  reason: string;
}
