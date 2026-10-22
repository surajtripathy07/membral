"use client";

// UX pass 2: the one "⋯" row menu on Today (Open threads, Blockers). Rare
// actions live here instead of a button bar on every row; the trigger is
// always visible so the actions are findable without hovering.
//
// Keyboard: the trigger is a <button> (Enter/Space open it), `aria-expanded`
// tracks state, focus moves to the first item on open, ArrowUp/ArrowDown move
// between items (roving: items are out of the tab order), Escape closes and
// returns focus to the trigger, a click outside or tabbing away closes. Tokens only (docs/design/tokens.md).
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

export interface RowMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
}

/** What a key does inside the open menu. Pure, so the keyboard contract is unit-testable without a DOM. */
export function menuKeyAction(key: string): "close" | "next" | "prev" | "none" {
  if (key === "Escape") return "close";
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "prev";
  return "none";
}

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function RowMenu({
  label,
  items,
  defaultOpen = false,
  focusOnMount = false,
}: {
  label: string;
  items: readonly RowMenuItem[];
  /** Render open (tests: renderToStaticMarkup has no clicks). */
  defaultOpen?: boolean;
  /** Focus the trigger when it mounts — the row just came back from Undo, so keyboard focus returns to it. */
  focusOnMount?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const menuId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (focusOnMount) triggerRef.current?.focus();
  }, [focusOnMount]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const action = menuKeyAction(e.key);
    if (action === "none") return;
    e.preventDefault();
    if (action === "close") return close(true);
    const buttons = itemRefs.current.filter((b): b is HTMLButtonElement => !!b);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = action === "next" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <span
      ref={rootRef}
      className="relative shrink-0"
      data-testid="row-menu"
      onBlur={(e) => {
        // Tab / Shift-Tab out of the menu closes it (focus never sits outside an open menu).
        if (open && !rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={open ? onKeyDown : undefined}
        className={`rounded-xs px-1.5 text-body-sm text-muted leading-none hover:bg-raised hover:text-ink ${FOCUS_RING}`}
      >
        ⋯
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="absolute top-full right-0 z-10 mt-1 flex min-w-44 flex-col rounded-xs border border-line bg-surface py-1 shadow-sm"
        >
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-item={item.key}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className={`px-3 py-1.5 text-left text-body-sm text-ink-2 hover:bg-raised hover:text-ink ${FOCUS_RING}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
