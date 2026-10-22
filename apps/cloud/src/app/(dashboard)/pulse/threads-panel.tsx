"use client";

// State half of Today's thread blocks (goal 2026-09-26 W8 / P7) — the
// panel ÷ content split at module grain (agent-work-panel.tsx ÷
// agent-work-content.tsx). /api/pulse already delivered the threads via
// pulse-page-client.tsx; the only state here is which open threads the
// reader dismissed in this view, so a row leaves the list the moment the
// button is pressed and comes back if POST /api/threads/dismiss fails.
//
// UX pass 2: blockers too — "Resolved" / "Ignore" POST to
// /api/threads/blockers/dismiss; the row stays, reading "Dismissed · Undo",
// until reload; Undo DELETEs the ids the dismissal retired.
//
// `dismissThread` / `dismissBlockerRow` / `undoBlockerRow` are plain async functions over two state callbacks rather
// than a hook so the optimistic-remove / restore-on-failure behaviour is
// testable without a DOM (vitest runs in the node environment here).
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { DismissedBlocker } from "@/lib/memory/blocker-dismiss";
import type { ForgeRefKind } from "@/lib/forge/ref-url";
import {
  type DismissReason,
  type RecurringBlocker,
  type Thread,
  threadKey,
} from "@/lib/threads/open-threads";
import { ThreadsContent } from "./threads-content";
import type { BlockerAction, SessionTitles, ThreadGrouping } from "@/lib/threads/view";

export const DISMISS_ENDPOINT = "/api/threads/dismiss";

export interface DismissTarget {
  ref: string;
  kind: ForgeRefKind;
  reason: DismissReason;
}

export interface DismissThreadOptions extends DismissTarget {
  /** Hide the row now (optimistic), by `threadKey` — kind and ref (F1). */
  markDismissed: (key: string) => void;
  /** Bring the row back when the server said no. */
  unmarkDismissed: (key: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Optimistically hides the thread, POSTs `{ref, kind, reason}` to
 * /api/threads/dismiss and restores the row if the request fails or returns a
 * non-2xx status. Resolves to whether the dismissal stuck. Never throws.
 */
export async function dismissThread({
  ref,
  kind,
  reason,
  markDismissed,
  unmarkDismissed,
  fetchImpl = fetch,
}: DismissThreadOptions): Promise<boolean> {
  const key = threadKey({ ref, kind });
  markDismissed(key);
  try {
    const res = await fetchImpl(DISMISS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref, kind, reason }),
    });
    if (!res.ok) throw new Error(`dismiss failed (status ${res.status})`);
    return true;
  } catch {
    unmarkDismissed(key);
    return false;
  }
}

export const BLOCKER_DISMISS_ENDPOINT = "/api/threads/blockers/dismiss";

/** A blocker dismissed in this view: the ids the server retired (empty until it answers) and whether Undo is in flight. */
export interface BlockerRowState {
  ids: readonly string[];
  busy: boolean;
}

export interface BlockerStateOps {
  set: (id: string, state: BlockerRowState) => void;
  clear: (id: string) => void;
  /** Inline failure text for the row (S4); null clears it. */
  fail?: (id: string, message: string | null) => void;
  fetchImpl?: typeof fetch;
}

export const DISMISS_FAILED = "Couldn't dismiss — try again.";
export const UNDO_FAILED = "Couldn't undo — try again.";
export const RESTORE_FAILED = "Couldn't restore — try again.";

/**
 * Optimistically marks the blocker dismissed, POSTs `{id, reason}` and keeps
 * the retired ids for Undo; restores the row with an inline error if the
 * request fails. Never throws.
 */
export async function dismissBlockerRow(
  id: string,
  reason: BlockerAction,
  { set, clear, fail, fetchImpl = fetch }: BlockerStateOps,
): Promise<boolean> {
  fail?.(id, null);
  set(id, { ids: [], busy: true });
  try {
    const res = await fetchImpl(BLOCKER_DISMISS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, reason }),
    });
    if (!res.ok) throw new Error(`dismiss failed (status ${res.status})`);
    const body = (await res.json()) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [id];
    set(id, { ids, busy: false });
    return true;
  } catch {
    clear(id);
    fail?.(id, DISMISS_FAILED);
    return false;
  }
}

/** DELETE `{ids}` — Undo and Restore share it. Resolves to whether the server lifted anything. Never throws. */
export async function restoreBlockerIds(ids: readonly string[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (ids.length === 0) return false;
  try {
    const res = await fetchImpl(BLOCKER_DISMISS_ENDPOINT, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Undo: DELETEs the retired ids; on success the row is live again, on failure it stays dismissed with an inline error. Never throws. */
export async function undoBlockerRow(
  id: string,
  state: BlockerRowState,
  { set, clear, fail, fetchImpl = fetch }: BlockerStateOps,
): Promise<boolean> {
  if (state.ids.length === 0) return false;
  fail?.(id, null);
  set(id, { ...state, busy: true });
  if (await restoreBlockerIds(state.ids, fetchImpl)) {
    clear(id);
    return true;
  }
  set(id, { ...state, busy: false });
  fail?.(id, UNDO_FAILED);
  return false;
}

/** The user's earlier dismissals (GET), for the "N dismissed" list. An unreadable answer is an empty list. Never throws. */
export async function loadDismissedBlockers(fetchImpl: typeof fetch = fetch): Promise<DismissedBlocker[]> {
  try {
    const res = await fetchImpl(BLOCKER_DISMISS_ENDPOINT, { method: "GET" });
    if (!res.ok) return [];
    const body = (await res.json()) as { dismissed?: unknown };
    return Array.isArray(body.dismissed) ? (body.dismissed as DismissedBlocker[]) : [];
  } catch {
    return [];
  }
}

/** `open` minus the threads dismissed in this view, matched on (kind, ref). */
export function withoutDismissed(open: readonly Thread[], dismissed: ReadonlySet<string>): Thread[] {
  return open.filter((t) => !dismissed.has(threadKey(t)));
}

/** What /api/pulse delivers for the thread blocks (pulse-page-client.tsx shapes it). */
export interface PulseThreads {
  recentThreads: readonly Thread[];
  openThreads: readonly Thread[];
  recurringBlockers: readonly RecurringBlocker[];
  statsLine: string | null;
  /** The threads read failed server-side: show that, never the all-clear copy (F9). */
  threadsError: boolean;
  /** The user has at least one recent code session (welcome copy vs all-clear copy in ThreadsContent). */
  hasSessions?: boolean;
  /** UX W5: id → title for every session any thread row references (/api/pulse `session_titles`). */
  sessionTitles?: SessionTitles;
}

export type ThreadsPanelProps = PulseThreads & {
  /** Default: grouped by latest session; `?group=repo` groups by repo. */
  grouping?: ThreadGrouping;
  /** `?day=YYYY-MM-DD` for the day section. */
  day?: string | null;
  /** Today's one-line 30-day spend, slotted right after Open threads. */
  costLine?: ReactNode;
};

export function ThreadsPanel(props: ThreadsPanelProps) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const markDismissed = useCallback((key: string) => {
    setDismissed((prev) => new Set([...prev, key]));
  }, []);
  const unmarkDismissed = useCallback((key: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);
  const [blockerStates, setBlockerStates] = useState<ReadonlyMap<string, BlockerRowState>>(() => new Map());
  const [blockerErrors, setBlockerErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [refocusBlockerId, setRefocusBlockerId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dismissedList, setDismissedList] = useState<readonly DismissedBlocker[]>([]);
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let live = true;
    void loadDismissedBlockers().then((list) => {
      if (live) setDismissedList(list);
    });
    return () => {
      live = false;
    };
  }, []);

  const setBlocker = useCallback((id: string, state: BlockerRowState) => {
    setBlockerStates((prev) => new Map(prev).set(id, state));
  }, []);
  const clearBlocker = useCallback((id: string) => {
    setBlockerStates((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const failBlocker = useCallback((id: string, message: string | null) => {
    setBlockerErrors((prev) => {
      const next = new Map(prev);
      if (message) next.set(id, message);
      else next.delete(id);
      return next;
    });
    if (message) setAnnouncement(message);
  }, []);
  const onDismissBlocker = useCallback(
    (id: string, reason: BlockerAction) => {
      setRefocusBlockerId(null);
      void dismissBlockerRow(id, reason, { set: setBlocker, clear: clearBlocker, fail: failBlocker }).then((ok) => {
        if (ok) setAnnouncement(reason === "ignored" ? "Blocker ignored." : "Blocker marked resolved.");
        else setRefocusBlockerId(id);
      });
    },
    [setBlocker, clearBlocker, failBlocker],
  );
  const onUndoBlocker = useCallback(
    (id: string) => {
      const state = blockerStates.get(id);
      if (!state) return;
      void undoBlockerRow(id, state, { set: setBlocker, clear: clearBlocker, fail: failBlocker }).then((ok) => {
        if (!ok) return;
        setRefocusBlockerId(id);
        setAnnouncement("Blocker restored.");
      });
    },
    [blockerStates, setBlocker, clearBlocker, failBlocker],
  );
  const onRestoreBlocker = useCallback((item: DismissedBlocker) => {
    const key = item.ids[0] ?? item.dismissed_at;
    setRestoring((prev) => new Set(prev).add(key));
    void restoreBlockerIds(item.ids).then((ok) => {
      setRestoring((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (ok) {
        setDismissedList((prev) => prev.filter((d) => d !== item));
        setAnnouncement("Blocker restored. It shows under Blockers on the next load.");
      } else {
        setAnnouncement(RESTORE_FAILED);
      }
    });
  }, []);

  const onDismiss = useCallback(
    (target: DismissTarget) => {
      void dismissThread({ ...target, markDismissed, unmarkDismissed });
    },
    [markDismissed, unmarkDismissed],
  );

  return (
    <ThreadsContent
      {...props}
      openThreads={withoutDismissed(props.openThreads, dismissed)}
      onDismiss={onDismiss}
      blockerStates={blockerStates}
      onDismissBlocker={onDismissBlocker}
      onUndoBlocker={onUndoBlocker}
      blockerErrors={blockerErrors}
      refocusBlockerId={refocusBlockerId}
      blockerAnnouncement={announcement}
      dismissedBlockers={dismissedList}
      restoringBlockers={restoring}
      onRestoreBlocker={onRestoreBlocker}
    />
  );
}
