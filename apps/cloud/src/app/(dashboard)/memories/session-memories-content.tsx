// /memories, "From sessions" tab: memory v1 records (session_memories),
// the primary view. Server-rendered from URL params; the filter bar is a
// plain GET form, so there is no client state. Pure render -- page.tsx
// fetches.
import { PageFrame } from "@/components/ui/page-frame";
import Link from "next/link";
import type { BrowseSessionMemory, MemoryProjectOption } from "@/lib/memory/session-memories-browse";
import { MEMORY_KINDS, type MemoryKind } from "@/lib/memory/schema";
import { SessionMemoryCard } from "./session-memory-card";

export interface SessionMemoriesFilters {
  project: MemoryProjectOption | null;
  kind: MemoryKind | null;
  q: string;
  page: number;
}

/** A /memories href with the given params (empty ones dropped). */
export function memoriesHref(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `/memories?${s}` : "/memories";
}

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

/**
 * UX W6 (audit /memories: "Kind becomes a chip row with counts"): one link
 * per kind, the word (never a glyph) and its live count, keeping the project
 * and search; the active kind is marked and "All" clears it.
 */
export function KindChips({
  filters,
  counts,
}: {
  filters: SessionMemoriesFilters;
  counts: Partial<Record<MemoryKind, number>> | null;
}) {
  const keep = { project: filters.project?.id, q: filters.q || null };
  const total = counts ? MEMORY_KINDS.reduce((sum, k) => sum + (counts[k] ?? 0), 0) : null;
  const chip = (active: boolean) =>
    `rounded-sm px-2 py-1 text-label transition ${FOCUS} ${
      active ? "bg-accent-soft text-accent" : "text-muted hover:bg-raised hover:text-ink-2"
    }`;
  return (
    <nav aria-label="Memory kinds" className="mb-3 flex flex-wrap gap-1" data-testid="kind-chips">
      <Link href={memoriesHref(keep)} className={chip(!filters.kind)} aria-current={!filters.kind ? "true" : undefined}>
        All{total !== null && <span className="ml-1 tabular-nums">{total}</span>}
      </Link>
      {MEMORY_KINDS.map((k) => {
        const n = counts?.[k];
        return (
          <Link
            key={k}
            href={memoriesHref({ ...keep, kind: k })}
            className={chip(filters.kind === k)}
            aria-current={filters.kind === k ? "true" : undefined}
          >
            {KIND_PLURAL[k]}
            {typeof n === "number" && <span className="ml-1 tabular-nums">{n}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

const KIND_PLURAL: Record<MemoryKind, string> = {
  preference: "Preferences",
  decision: "Decisions",
  learning: "Learnings",
  blocker: "Blockers",
  outcome: "Outcomes",
};

const FIELD = `rounded-sm border border-line bg-surface px-2 py-1.5 text-body-sm text-ink ${FOCUS}`;

export function SessionMemoriesContent({
  records,
  projects,
  filters,
  hasMore,
  kindCounts = null,
  degraded,
  error,
  now,
}: {
  records: BrowseSessionMemory[];
  projects: MemoryProjectOption[];
  filters: SessionMemoriesFilters;
  hasMore: boolean;
  /** Live records per kind for the chip row (scoped to the project filter); null when the count read failed. */
  kindCounts?: Partial<Record<MemoryKind, number>> | null;
  degraded?: string;
  error?: string | null;
  now?: Date;
}) {
  const searching = filters.q.length > 0;
  const filtered = searching || !!filters.project || !!filters.kind;
  const base = { project: filters.project?.id, kind: filters.kind, q: filters.q || null };

  return (
    <PageFrame width="read">
      <header className="mb-4">
        <h1 className="text-h1 font-semibold text-ink">Memories</h1>
        <p className="mt-1 text-body-sm text-muted">
          What Membral remembered from your coding sessions. Each memory links to the session turn it came from.
        </p>
      </header>

      <form method="get" action="/memories" className="mb-4 flex flex-wrap items-end gap-2" role="search">
        <label className="flex flex-col gap-1 text-micro text-muted">
          Project
          <select name="project" defaultValue={filters.project?.id ?? ""} className={FIELD}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {filters.kind && <input type="hidden" name="kind" value={filters.kind} />}
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-micro text-muted">
          Search
          <input type="search" name="q" defaultValue={filters.q} placeholder="e.g. pnpm, cache key" className={FIELD} />
        </label>
        <button
          type="submit"
          className={`rounded-sm bg-accent px-3 py-1.5 text-body-sm font-medium text-accent-ink hover:opacity-90 ${FOCUS}`}
        >
          Apply
        </button>
        {filtered && (
          <Link href="/memories" className={`px-2 py-1.5 text-body-sm text-muted hover:text-ink-2 ${FOCUS}`}>
            Clear
          </Link>
        )}
      </form>

      <KindChips filters={filters} counts={kindCounts} />

      {error && (
        <p role="alert" className="mb-3 rounded-sm border border-line bg-raised px-3 py-2 text-body-sm text-error">
          {error}
        </p>
      )}
      {degraded && <p className="mb-3 text-micro text-muted">{degraded}</p>}
      {searching && !error && (
        <p className="mb-2 text-micro text-muted">
          {records.length === 0 ? "No" : `Top ${records.length}`} match{records.length === 1 ? "" : "es"} for &ldquo;
          {filters.q}&rdquo;, most relevant first
        </p>
      )}

      {records.length === 0 && !error ? (
        <p className="rounded-card border border-line-soft bg-surface px-4 py-6 text-body-sm text-muted">
          {filtered
            ? "No memories match these filters."
            : "Nothing remembered yet. Memories are extracted from your coding sessions after they upload."}
        </p>
      ) : (
        <div>
          {records.map((r) => (
            <SessionMemoryCard key={r.id} record={r} showProject={!filters.project} now={now} />
          ))}
        </div>
      )}

      {!searching && (filters.page > 1 || hasMore) && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-between text-body-sm">
          {filters.page > 1 ? (
            <Link href={memoriesHref({ ...base, page: filters.page - 1 === 1 ? null : filters.page - 1 })} className={`text-accent hover:underline ${FOCUS}`}>
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-micro text-muted">Page {filters.page}</span>
          {hasMore ? (
            <Link href={memoriesHref({ ...base, page: filters.page + 1 })} className={`text-accent hover:underline ${FOCUS}`}>
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </PageFrame>
  );
}
