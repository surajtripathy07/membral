"use client";

// Toolbar (sort + client-side search) and consistent-height cards for the
// /code project list — the maintainer's "very crowded, too much
// information" verdict applied to this page too: fixed-height cards so a
// long summary or a missing one doesn't make the grid ragged, plus a way to
// find one project among many without a server round-trip.
//
// `projects` is the same server-fetched page.tsx already loads via
// getCodeProjectsPage (unchanged query/RPC) — sort/search operate over
// exactly that loaded page, client-side, per the design brief.
//
// W9 (2026-09-12 refocus goal, D9): the LLM-written summary paragraph
// ("The project focuses on...", 40% boilerplate across 18 cards) is gone,
// replaced by one line of real data (`cardStats`, computed server-side in
// page.tsx from the same aggregateAgentStats path as /code/stats). Cards
// are outlined on canvas instead of filled, so an 18-card grid recedes
// instead of competing. Names never truncate at the owner boundary — owner
// and repo render on their own lines. The sb-reveal stagger (capped at 10
// cards, so it broke on an 18-card grid) is dropped.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ListRow } from "@/components/ui/list-row";
import { ShowAll } from "@/components/ui/show-all";
import type { CodeProjectListRow } from "@/lib/code-sessions/queries";
import { formatRelativeDate } from "@/lib/format/dates";
import { fmtUsd } from "@/lib/format/usd";
import {
  EMPTY_CARD_STATS,
  groupProjects,
  isInactive,
  type ProjectCardStats,
  type ProjectGroup,
  projectName,
  SORT_LABELS,
  type SortKey,
  sortGroups,
  sortProjects,
  splitOwnerRepo,
} from "./project-list.logic";


// W9 fix pass 2 (after-critique finding #4): a failed 30-day usage query and
// a project that genuinely had no activity in the window used to render the
// IDENTICAL "0 turns · 0 files · $0.00" line — a silent failure was
// indistinguishable from real data. `stats` is `undefined` only when
// page.tsx's query threw (cardStats stayed empty); a project the query
// actually covered always has an entry, even an all-zero one.
//
// UX audit B8: last-active now rides the same line (no more separate
// `mt-auto` row and the blank band it left above it), and cost goes through
// the shared `fmtUsd` — the same formatter the /code header total and every
// other money figure use, so "$1,577" never disagrees with "$1577.12".
function CardStatsLine({ stats, lastActive }: { stats: ProjectCardStats | undefined; lastActive: string }) {
  const usage = !stats ? (
    <span className="text-muted">usage unavailable</span>
  ) : isInactive(stats) ? (
    <span className="text-muted">no activity in 30d</span>
  ) : (
    <span className="text-ink-2">
      {stats.turns} turn{stats.turns === 1 ? "" : "s"} · {stats.files} file{stats.files === 1 ? "" : "s"} ·{" "}
      <span className="text-accent">{fmtUsd(stats.costUsd)}</span>
    </span>
  );
  return (
    <div className="flex items-center justify-between gap-2 text-body-sm">
      {usage}
      <span className="shrink-0 text-micro tabular-nums text-muted">{lastActive}</span>
    </div>
  );
}

function ProjectCard({ project: p, now, stats }: { project: CodeProjectListRow; now: Date; stats: ProjectCardStats | undefined }) {
  const { owner, repo } = splitOwnerRepo(projectName(p));
  return (
    <Link
      href={`/code/${p.id}`}
      className="flex flex-col gap-1.5 rounded-card border border-line bg-canvas p-4 transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {owner && <span className="block truncate text-micro text-muted">{owner}/</span>}
          <span className="block truncate text-body font-medium text-ink">{repo}</span>
        </div>
        <span className="shrink-0 text-label tabular-nums text-muted">
          {p.session_count} session{p.session_count === 1 ? "" : "s"}
        </span>
      </div>
      <CardStatsLine stats={stats} lastActive={`last active ${formatRelativeDate(p.last_active_at, now)}`} />
    </Link>
  );
}

/** Phone: one line per project — name · $ · sessions · last active — instead of the same card shrunk to fit. */
function ProjectListRowItem({ project: p, now, stats }: { project: CodeProjectListRow; now: Date; stats: ProjectCardStats | undefined }) {
  return (
    <ListRow href={`/code/${p.id}`}>
      <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-ink">{projectName(p)}</span>
      <span className="shrink-0 text-micro tabular-nums text-muted">
        {stats && !isInactive(stats) ? <span className="text-accent">{fmtUsd(stats.costUsd)}</span> : "—"} · {p.session_count} session
        {p.session_count === 1 ? "" : "s"} · {formatRelativeDate(p.last_active_at, now)}
      </span>
    </ListRow>
  );
}

/**
 * A clubbed project (migration 060, W7/D8): 2+ code_projects rows whose
 * display_name/repo_identity resolve to the same project_aliases canonical
 * label — e.g. `dev/membral` / `surajtripathy07/membral` /
 * `surajtripathy07/membral-personal`, all the same underlying repo checked
 * out under a renamed/relinked remote over time. Session counts and "last
 * active" aggregate across every member; the card links to the most-active
 * member's own project page (still a real, working /code/[projectId] link),
 * with the rest shown as chips so the per-project page is always one click
 * away too.
 */
function GroupCard({ group, now, stats }: { group: ProjectGroup; now: Date; stats: ProjectCardStats | undefined }) {
  const others = group.members.filter((m) => m.id !== group.primary.id);
  const { owner, repo } = splitOwnerRepo(group.label);
  return (
    <div className="flex flex-col gap-1.5 rounded-card border border-line bg-canvas p-4">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/code/${group.primary.id}`} className="min-w-0 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas">
          {owner && <span className="block truncate text-micro text-muted">{owner}/</span>}
          <span className="block truncate text-body font-medium text-ink">{repo}</span>
        </Link>
        <span className="shrink-0 text-label tabular-nums text-muted">
          {group.sessionCount} session{group.sessionCount === 1 ? "" : "s"}
        </span>
      </div>
      <span
        className="inline-flex w-fit items-center rounded-xs border border-line px-1.5 py-0.5 text-micro text-ink-2"
        title="These project labels were clubbed together (project_aliases) as the same underlying repo."
      >
        {group.members.length} labels merged
      </span>
      <div className="flex flex-wrap gap-1.5 overflow-hidden">
        {others.map((m) => (
          <Link
            key={m.id}
            href={`/code/${m.id}`}
            className="truncate rounded-xs border border-line px-1.5 py-0.5 text-micro text-muted hover:border-line-strong hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            title={m.repo_identity}
          >
            {projectName(m)}
          </Link>
        ))}
      </div>
      <CardStatsLine stats={stats} lastActive={`last active ${formatRelativeDate(group.lastActiveAt, now)}`} />
    </div>
  );
}

/** Phone row for a clubbed group — same one-liner as a single project, "N labels merged" folds into the name. */
function GroupListRowItem({ group, now, stats }: { group: ProjectGroup; now: Date; stats: ProjectCardStats | undefined }) {
  return (
    <ListRow href={`/code/${group.primary.id}`}>
      <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-ink">
        {group.label} <span className="text-micro text-muted">({group.members.length} merged)</span>
      </span>
      <span className="shrink-0 text-micro tabular-nums text-muted">
        {stats && !isInactive(stats) ? <span className="text-accent">{fmtUsd(stats.costUsd)}</span> : "—"} · {group.sessionCount} session
        {group.sessionCount === 1 ? "" : "s"} · {formatRelativeDate(group.lastActiveAt, now)}
      </span>
    </ListRow>
  );
}

export function ProjectList({
  projects,
  now,
  canonicalLabels = {},
  cardStats = {},
}: {
  projects: CodeProjectListRow[];
  now: string;
  /** project id -> project_aliases-resolved canonical label (migration 060, W7/D8). Missing/empty = no grouping (every project its own group). */
  canonicalLabels?: Record<string, string>;
  /** project id -> 30-day turns/files/cost, computed server-side in page.tsx. Missing = zeroed line (a query failure degrades gracefully, same posture as the rest of this page's reads). */
  cardStats?: Record<string, ProjectCardStats>;
}) {
  const [sort, setSort] = useState<SortKey>("recent");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search (GitHub-style), unless the user is already typing in
  // a form field somewhere on the page.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  // Parsed once from a server-captured ISO string, never `new Date()` here —
  // this is a client component, so it renders once during SSR and again on
  // hydration; each of those calling `new Date()` independently is what
  // caused a live hydration mismatch in the sibling sessions-timeline.tsx
  // (relative-date bucket flipping between the two passes). A prop is fixed
  // at the moment the server rendered, so both passes agree.
  const nowDate = new Date(now);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base = needle
      ? projects.filter((p) => [projectName(p), p.repo_identity, p.summary].some((f) => f?.toLowerCase().includes(needle)))
      : projects;
    return sortProjects(base, sort);
  }, [projects, sort, query]);

  const groups = useMemo(() => sortGroups(groupProjects(filtered, canonicalLabels), sort), [filtered, canonicalLabels, sort]);

  // `undefined` (not a zeroed object) only when EVERY member's usage query
  // failed — same "unavailable" vs "genuinely zero" distinction as a single
  // card (CardStatsLine's own doc comment).
  function groupStats(group: ProjectGroup): ProjectCardStats | undefined {
    if (group.members.every((m) => cardStats[m.id] === undefined)) return undefined;
    return group.members.reduce<ProjectCardStats>(
      (acc, m) => {
        const s = cardStats[m.id] ?? EMPTY_CARD_STATS;
        return { turns: acc.turns + s.turns, files: acc.files + s.files, costUsd: (acc.costUsd ?? 0) + (s.costUsd ?? 0) };
      },
      { turns: 0, files: 0, costUsd: 0 },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            autoFocus={false}
            autoComplete="off"
            spellCheck={false}
            aria-label="Search projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects… (press /)"
            className="w-full rounded-sm border border-line-strong bg-surface py-2 pl-9 pr-3 text-body text-ink placeholder-muted transition focus:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          />
        </div>
        <div role="group" aria-label="Sort by" className="flex items-center gap-1 rounded-sm border border-line p-0.5 text-label">
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              aria-current={sort === key ? "true" : undefined}
              className={`rounded-xs px-2.5 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
                sort === key ? "bg-accent-soft text-accent" : "text-muted hover:text-ink-2"
              }`}
            >
              {SORT_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-card border border-line bg-surface p-6 text-body text-muted">No projects match &ldquo;{query}&rdquo;.</div>
      ) : (
        <>
          {/* UX audit B8: no activity in 30d goes behind "Show N inactive"
              instead of taking a full-size card in the main grid, on both
              layouts below. */}
          {(() => {
            const resolved = groups.map((g) => ({
              group: g,
              stats: g.members.length === 1 ? cardStats[g.primary.id] : groupStats(g),
            }));
            const active = resolved.filter((r) => !isInactive(r.stats));
            const inactive = resolved.filter((r) => isInactive(r.stats));
            return (
              <>
                {/* Desktop/tablet: the card grid. */}
                <div className="hidden md:block">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {active.map(({ group: g, stats }) =>
                      g.members.length === 1 ? (
                        <ProjectCard key={g.primary.id} project={g.primary} now={nowDate} stats={stats} />
                      ) : (
                        <GroupCard key={g.label} group={g} now={nowDate} stats={stats} />
                      ),
                    )}
                  </div>
                  {inactive.length > 0 && (
                    <ShowAll
                      items={inactive}
                      initial={0}
                      label={(n) => `Show ${n} inactive`}
                      className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 [&>button]:col-span-full"
                      renderItem={({ group: g, stats }) =>
                        g.members.length === 1 ? (
                          <ProjectCard key={g.primary.id} project={g.primary} now={nowDate} stats={stats} />
                        ) : (
                          <GroupCard key={g.label} group={g} now={nowDate} stats={stats} />
                        )
                      }
                    />
                  )}
                </div>

                {/* Phone: a one-line row per project instead of a shrunk card. */}
                <div className="md:hidden">
                  <div>
                    {active.map(({ group: g, stats }) =>
                      g.members.length === 1 ? (
                        <ProjectListRowItem key={g.primary.id} project={g.primary} now={nowDate} stats={stats} />
                      ) : (
                        <GroupListRowItem key={g.label} group={g} now={nowDate} stats={stats} />
                      ),
                    )}
                  </div>
                  {inactive.length > 0 && (
                    <ShowAll
                      items={inactive}
                      initial={0}
                      label={(n) => `Show ${n} inactive`}
                      renderItem={({ group: g, stats }) =>
                        g.members.length === 1 ? (
                          <ProjectListRowItem key={g.primary.id} project={g.primary} now={nowDate} stats={stats} />
                        ) : (
                          <GroupListRowItem key={g.label} group={g} now={nowDate} stats={stats} />
                        )
                      }
                    />
                  )}
                </div>
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
