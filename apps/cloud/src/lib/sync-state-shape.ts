// Sync State panel — pure response shaping. Takes already-fetched
// raw signals (no Supabase calls in this file) and produces exactly the JSON
// GET /api/sync-state returns, applying the state rules from
// sync-state-rules.ts. Kept separate from that file so the two testing
// grains stay distinct: sync-state-rules.test.ts covers the state decision
// trees in isolation; sync-state-shape.test.ts covers assembling those
// decisions into the real response shape (note text, field omission, etc.)
// — both without touching Supabase. app/api/sync-state/route.ts is the only
// caller and owns 100% of the I/O.
import { deriveChatSourceState, deriveCodeHarnessState, type SyncSourceState } from "./sync-state-rules";

// ---------------------------------------------------------------------------
// Raw inputs — what the route fetches from Supabase, normalized to plain
// values (nulls for anything missing/unavailable, never a thrown error).
// ---------------------------------------------------------------------------

export interface RawChatSourceSignal {
  source: "claude" | "chatgpt" | "grok";
  conversations: number;
  /** greatest(sync_heartbeats.last_item_at, max(conversations.updated_at)) for this source. */
  lastItemAt: string | null;
  /** sync_heartbeats.last_run_at for this source. */
  lastRunAt: string | null;
  /** A sync_heartbeats row exists OR conversations exist for this source (pre-heartbeat data). */
  hasEverSeen: boolean;
}

export interface RawCodeHarnessSignal {
  /** code_sessions.source for this harness, e.g. 'claude-code'. */
  harness: string;
  /** Distinct code_project_id values seen for this harness. */
  projects: number;
  sessions: number;
  lastSessionAt: string | null;
  /** The shared sync_heartbeats source='code' last_run_at — one heartbeat covers every harness today. */
  lastRunAt: string | null;
  hasHeartbeat: boolean;
}

export interface RawSyncStateInputs {
  chat: RawChatSourceSignal[];
  code: RawCodeHarnessSignal[];
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface ChatSourceOut {
  source: "claude" | "chatgpt" | "grok";
  conversations: number;
  lastItemAt: string | null;
  lastRunAt: string | null;
  state: SyncSourceState;
  note?: string;
}

export interface CodeHarnessOut {
  harness: string;
  projects: number;
  sessions: number;
  lastSessionAt: string | null;
  state: SyncSourceState;
  note?: string;
}

export interface SyncStateResponse {
  chat: ChatSourceOut[];
  code: CodeHarnessOut[];
}

// ---------------------------------------------------------------------------
// Notes — short, factual context a bare state pill + timestamp can't convey
// on its own. Deliberately sparse: most states need no note (the pill + the
// relative timestamps the panel renders from lastRunAt/lastItemAt already
// say enough).
// ---------------------------------------------------------------------------

function chatOrCodeNote(state: SyncSourceState): string | undefined {
  if (state === "quiet") return "sync is running, but no new items have arrived in a while";
  return undefined;
}

export function shapeChatSource(raw: RawChatSourceSignal, now: Date = new Date()): ChatSourceOut {
  const state = deriveChatSourceState(raw, now);
  return {
    source: raw.source,
    conversations: raw.conversations,
    lastItemAt: raw.lastItemAt,
    lastRunAt: raw.lastRunAt,
    state,
    note: chatOrCodeNote(state),
  };
}

export function shapeCodeHarness(raw: RawCodeHarnessSignal, now: Date = new Date()): CodeHarnessOut {
  const state = deriveCodeHarnessState(
    { hasEverSeen: raw.hasHeartbeat || raw.sessions > 0, lastRunAt: raw.lastRunAt, lastItemAt: raw.lastSessionAt },
    now,
  );
  return {
    harness: raw.harness,
    projects: raw.projects,
    sessions: raw.sessions,
    lastSessionAt: raw.lastSessionAt,
    state,
    note: chatOrCodeNote(state),
  };
}

export function shapeSyncState(raw: RawSyncStateInputs, now: Date = new Date()): SyncStateResponse {
  return {
    chat: raw.chat.map((c) => shapeChatSource(c, now)),
    code: raw.code.map((c) => shapeCodeHarness(c, now)),
  };
}
