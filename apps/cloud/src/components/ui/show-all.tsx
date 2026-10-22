"use client";

// UX audit B0 (docs section 3.3): the one "reveal the rest" pattern for
// every capped list (Today's Yesterday feed, sessions, project memories,
// device sign-ins, …). Rule: no list renders more than 10 items (5 on
// Today) before this. The hidden count is ALWAYS shown — nothing is ever
// cut silently — and the caller can override the button text via `label`.
import { useState } from "react";
import type { ReactNode } from "react";

export interface ShowAllProps<T> {
  items: readonly T[];
  /** How many items render before the "show all" control appears. */
  initial: number;
  /** Items revealed per click. Omit to reveal every remaining item at once. */
  step?: number;
  /** Button text for the hidden count; defaults to `"+{n} more …"`. */
  label?: (hiddenCount: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
}

function defaultLabel(hiddenCount: number): string {
  return `+${hiddenCount} more …`;
}

export function ShowAll<T>({ items, initial, step, label = defaultLabel, renderItem, className = "" }: ShowAllProps<T>) {
  const [shown, setShown] = useState(Math.min(initial, items.length));
  const hiddenCount = items.length - shown;

  return (
    <div className={className}>
      {items.slice(0, shown).map((item, index) => renderItem(item, index))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShown((current) => Math.min(items.length, current + (step ?? hiddenCount)))}
          className="mt-2 text-body-sm text-accent hover:underline"
        >
          {label(hiddenCount)}
        </button>
      )}
    </div>
  );
}
