"use client";

// UX pass 2 (review S1/S3/S4): the client-only pieces of Today's blocker
// rows — the "Dismissed · Undo" line that takes keyboard focus when it
// appears, and the quiet "N dismissed" list under Blockers whose Restore
// undoes a dismissal after a reload. Tokens only (docs/design/tokens.md).
import { useEffect, useRef } from "react";
import type { DismissedBlocker } from "@/lib/memory/blocker-dismiss";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

const REASON_WORD: Record<DismissedBlocker["reason"], string> = { resolved: "resolved", ignored: "ignored" };

/** "Dismissed · Undo". Undo takes focus as soon as the server answered (the menu that had focus is gone). */
export function DismissedLine({
  text,
  ready,
  busy,
  onUndo,
}: {
  text: string;
  /** The server returned the retired ids — Undo can act. */
  ready: boolean;
  busy: boolean;
  onUndo: () => void;
}) {
  const undoRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    undoRef.current?.focus();
  }, []);
  const inactive = !ready || busy;
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-body-sm text-muted line-through" title={text}>
        {text}
      </span>
      <span className="shrink-0 text-label text-muted">
        Dismissed ·{" "}
        <button
          ref={undoRef}
          type="button"
          // aria-disabled, not disabled: the button keeps focus while the POST is in flight.
          aria-disabled={inactive}
          onClick={() => {
            if (!inactive) onUndo();
          }}
          className={`rounded-xs hover:underline ${inactive ? "text-muted" : "text-accent"} ${FOCUS_RING}`}
          data-testid="blocker-undo"
        >
          Undo
        </button>
      </span>
    </>
  );
}

/** Quiet list of the user's dismissed blockers with Restore; renders nothing when there are none. */
export function DismissedBlockersList({
  items,
  busy,
  onRestore,
}: {
  items: readonly DismissedBlocker[];
  busy?: ReadonlySet<string>;
  onRestore: (item: DismissedBlocker) => void;
}) {
  if (items.length === 0) return null;
  return (
    <details className="mt-2" data-testid="dismissed-blockers">
      <summary className={`cursor-pointer list-none text-label text-muted hover:text-accent ${FOCUS_RING}`}>
        {items.length} dismissed
      </summary>
      <ul className="mt-2 flex flex-col">
        {items.map((d) => {
          const key = d.ids[0] ?? d.dismissed_at;
          const pending = busy?.has(key) ?? false;
          return (
            <li key={key} className="flex items-center gap-3 border-line-soft border-b py-1.5 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-body-sm text-muted" title={d.quote ?? d.text}>
                {d.quote ?? d.text}
              </span>
              <span className="shrink-0 text-label text-muted">{d.by_agent ? "resolved by agent" : REASON_WORD[d.reason]}</span>
              <button
                type="button"
                aria-disabled={pending}
                onClick={() => {
                  if (!pending) onRestore(d);
                }}
                className={`shrink-0 rounded-xs text-label hover:underline ${pending ? "text-muted" : "text-accent"} ${FOCUS_RING}`}
                data-testid="blocker-restore"
              >
                Restore
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
