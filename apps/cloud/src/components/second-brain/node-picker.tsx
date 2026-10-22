"use client";

/**
 * Searchable node picker modal (issue #60, phase 1) — used by "Move to" and
 * "Merge into". The caller passes an already-filtered list (see
 * lib/second-brain/edit-targets: moveTargets / mergeTargets) plus a confirm
 * label; this component owns only search + selection + keyboard nav. Escape
 * closes; the search box autofocuses; every row is a real button.
 */
import { useMemo, useState } from "react";
import { filterByQuery, type PickerNode } from "@/lib/second-brain/edit-targets";
import { displayKind, displayLabel } from "@/lib/second-brain/palette";

export function NodePicker({
  title,
  subtitle,
  nodes,
  confirmHint,
  emptyHint,
  onPick,
  onClose,
}: {
  title: string;
  subtitle?: string;
  nodes: PickerNode[];
  // Optional per-target hint text shown under the confirm — e.g. merge summary.
  confirmHint?: (node: PickerNode) => string;
  emptyHint?: string;
  onPick: (node: PickerNode) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PickerNode | null>(null);
  const filtered = useMemo(() => filterByQuery(nodes, query), [nodes, query]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: overlay click-catcher; dialog stops propagation */}
      <button type="button" aria-label="Close" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 flex max-h-[70vh] w-[520px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl"
      >
        <div className="border-border-soft border-b px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="m-0 font-serif text-lg text-ink">{title}</h2>
              {subtitle && <p className="mt-1 text-[12.5px] text-ink-muted">{subtitle}</p>}
            </div>
            <button
              type="button"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-raised hover:text-ink"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          {/* biome-ignore lint/a11y/noAutofocus: search should focus on open */}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="mt-3 w-full rounded-lg border border-border-strong bg-raised px-3 py-2 text-[13px] text-ink outline-none focus:border-focus"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-ink-muted">{emptyHint ?? "Nothing to show."}</div>
          ) : (
            filtered.map((n) => {
              const isSel = selected?.id === n.id;
              const kindBadge = displayKind(n.kind) ?? (n.type === "LifeArea" ? "area" : null);
              const fallbackLabel = n.type === "LifeArea" ? "Unnamed area" : "Unnamed item";
              return (
                <button
                  type="button"
                  key={n.id}
                  onClick={() => setSelected(n)}
                  aria-pressed={isSel}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                    isSel ? "bg-focus/15 text-ink" : "text-ink-2 hover:bg-raised"
                  }`}
                >
                  <span className="flex-1 truncate text-[13px]">{displayLabel(n.label, fallbackLabel)}</span>
                  {kindBadge && (
                    <span className="shrink-0 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-ink-muted capitalize">
                      {kindBadge}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="border-border-soft border-t px-5 py-4">
          {selected && confirmHint && (
            <p className="mb-3 text-[12.5px] text-ink-2 leading-relaxed">{confirmHint(selected)}</p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-border-strong px-3.5 py-2 font-medium text-ink-2 text-sm transition hover:border-zinc-600 hover:text-ink"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!selected}
              className="rounded-lg bg-brand px-3.5 py-2 font-medium text-sm text-white transition disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => selected && onPick(selected)}
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
