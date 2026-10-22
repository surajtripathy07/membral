"use client";

// The primary body of the redesigned /code/[projectId] page (design brief:
// "WHAT HAPPENED" — question 2 of 3, above the fold). Recent-first, one
// compact row per session; a row expands client-side, ONE AT A TIME
// (accordion), to show that session's files instead of dumping every path
// into the timeline by default (maintainer verdict on the old page: "very
// crowded, too much information").
//
// `sessions` is already the full recent-first batch the server fetched (see
// page.tsx's SESSIONS_FETCH_CAP comment) — no client fetch here, just local
// slicing for a cheap "Show more" (no network round-trip) instead of the old
// full-page-reload Prev/Next.
//
// Per-session `files_touched` is the RAW path list (code_sessions.files_touched
// — unlike the graph-native code_kg_nodes keys ProjectFacts reads, these are
// never cwd-canonicalized at write time), and the list row doesn't carry the
// session's cwd (not selected by getCodeProjectDetail) — shortenSessionPath
// is called with cwd=null here, which still degrades gracefully onto its
// memory/scratchpad/fallback rules. Per-session tool usage isn't in this row
// shape at all (only /code/session/[id] has it), so the expanded panel links
// out to the full session instead of fabricating a tools list.
//
// UX W5: each row carries its whole-session cost (`costUsd`, priced live in
// getCodeProjectDetail through sessionLiveCostUsd — the session header's own
// path), shown with the one money formatter, fmtUsd.
import Link from "next/link";
import { useState } from "react";
import type { CodeSessionListRow } from "@/lib/code-sessions/queries";
import { formatAbsoluteUtc, formatRelativeDate } from "@/lib/format/dates";
import { formatDuration } from "@/lib/format/durations";
import { fmtUsd } from "@/lib/format/usd";
import { looksLikeGeneratedNoProseSummary, sessionDisplayTitle, shortenSessionPath } from "@/lib/code-sessions/view";

// UX audit B4: first render shows 10 (was 20), so the fold sits inside the
// page's 2.5vp target instead of past it.
const SHOWN_STEP = 10;
const MAX_FILES_SHOWN = 20;

function BranchGlyph() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <circle cx="4" cy="3" r="1.6" strokeWidth="1.3" />
      <circle cx="4" cy="13" r="1.6" strokeWidth="1.3" />
      <circle cx="12" cy="7" r="1.6" strokeWidth="1.3" />
      <path strokeWidth="1.3" d="M4 4.6v6.8M4 7c0 2.5 2 3.5 4.5 3.5H10M12 5.4V8.6" />
    </svg>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function SessionFiles({ files }: { files: string[] }) {
  if (files.length === 0) return <p className="text-micro text-muted">No files recorded for this session.</p>;

  const shaped = files.map((f) => ({ path: f, shortened: shortenSessionPath(f, null) }));
  const source = shaped.filter((s) => s.shortened.group === "source");
  const scratch = shaped.filter((s) => s.shortened.group === "scratch");
  const visibleSource = source.slice(0, MAX_FILES_SHOWN);
  const extraSource = source.length - visibleSource.length;

  return (
    <div>
      {visibleSource.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleSource.map(({ path, shortened }) => (
            <span key={path} className="truncate rounded-xs border border-line px-1.5 py-0.5 font-mono text-micro text-ink-2" title={path}>
              {shortened.display}
            </span>
          ))}
          {extraSource > 0 && <span className="text-micro text-muted">+{extraSource} more</span>}
        </div>
      )}
      {scratch.length > 0 && (
        <details className={visibleSource.length > 0 ? "mt-1.5" : ""}>
          <summary className="cursor-pointer text-micro text-muted hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
            +{scratch.length} scratch/notes
          </summary>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {scratch.map(({ path, shortened }) => (
              <span key={path} className="truncate rounded-xs border border-line px-1.5 py-0.5 font-mono text-micro text-ink-2" title={path}>
                {shortened.display}
              </span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function SessionRow({
  session: s,
  expanded,
  onToggle,
  now,
}: {
  session: CodeSessionListRow;
  expanded: boolean;
  onToggle: () => void;
  /** ISO timestamp, captured ONCE by the server component and passed down
   *  as a prop (never recomputed with `new Date()` in this client
   *  component) — the relative-date bucket ("2d ago" vs "3d ago") must be
   *  identical between the SSR pass and the hydration pass, and the only
   *  way to guarantee that is to never let them each call `new Date()` at
   *  their own separate wall-clock moment. */
  now: Date;
}) {
  // W9 (2026-09-12 refocus goal, D9): "Untitled session" (sessionDisplayTitle's
  // neutral placeholder) — and summarize.ts's machine "no recorded prose"
  // sentence, which can embed an absolute filesystem path
  // (looksLikeGeneratedNoProseSummary, same guard sessionPageTitle uses) —
  // both become `<branch> · <N> turns` on this row when there's no real
  // title/summary to derive one from. A branch and a turn count is more
  // useful than either, and this row already has both.
  const title = sessionDisplayTitle(s);
  const rowTitle =
    title === "Untitled session" || looksLikeGeneratedNoProseSummary(title)
      ? [s.git_branch, `${s.turn_count} turn${s.turn_count === 1 ? "" : "s"}`].filter(Boolean).join(" · ")
      : title;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <ChevronGlyph open={expanded} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body text-ink">{rowTitle}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro tabular-nums text-muted">
            {s.git_branch && (
              <span className="inline-flex items-center gap-1 font-mono">
                <BranchGlyph /> {s.git_branch}
              </span>
            )}
            <span>{formatDuration(s.duration_seconds)}</span>
            <span>
              {s.turn_count} turns ({s.user_turn_count} yours)
            </span>
          </div>
        </div>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-label tabular-nums text-ink" data-testid="session-cost" title="Whole session, incl. sub-agents">
            {fmtUsd(s.costUsd ?? null)}
          </span>
          <span className="text-label tabular-nums text-muted" title={formatAbsoluteUtc(s.started_at)}>
            {formatRelativeDate(s.started_at, now)}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="border-t border-line-soft bg-sunken px-4 py-3 pl-10">
          <p className="mb-1.5 text-micro text-muted">
            {s.files_touched?.length ?? 0} file{(s.files_touched?.length ?? 0) === 1 ? "" : "s"} touched
          </p>
          <SessionFiles files={s.files_touched ?? []} />
          <Link
            href={`/code/session/${s.id}`}
            className="mt-2.5 inline-block text-label text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Open full session — tools, cost, transcript →
          </Link>
        </div>
      )}
    </div>
  );
}

export function SessionsTimeline({
  sessions,
  sessionsTotal,
  now,
}: {
  sessions: CodeSessionListRow[];
  sessionsTotal: number;
  /** ISO timestamp from the server component's own render — see SessionRow's
   *  `now` doc. Parsed once here (not per-row) and passed down as a Date. */
  now: string;
}) {
  const [shownCount, setShownCount] = useState(SHOWN_STEP);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const nowDate = new Date(now);

  if (sessions.length === 0) {
    return <div className="rounded-card border border-line bg-surface p-6 text-body text-muted">No sessions in this project.</div>;
  }

  // UX audit B4: "fold 0-turn sessions into one row" — a session with no
  // turns recorded has nothing a SessionRow can expand into (SessionFiles
  // degrades to "no files recorded" and the branch/duration line is the only
  // content), so it is worth one shared line rather than N identical rows.
  const nonEmpty = sessions.filter((s) => s.turn_count > 0);
  const emptyCount = sessions.length - nonEmpty.length;

  const visible = nonEmpty.slice(0, shownCount);
  const remaining = nonEmpty.length - visible.length;

  return (
    <div>
      <div className="divide-y divide-line-soft rounded-card border border-line bg-surface">
        {visible.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            expanded={expandedId === s.id}
            onToggle={() => setExpandedId((cur) => (cur === s.id ? null : s.id))}
            now={nowDate}
          />
        ))}
      </div>
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setShownCount((c) => c + SHOWN_STEP)}
          className="mt-3 rounded-sm border border-line-strong px-3 py-1.5 text-body-sm text-ink-2 transition-colors hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          Show {Math.min(SHOWN_STEP, remaining)} more ({remaining} left)
        </button>
      )}
      {emptyCount > 0 && (
        <p className="mt-3 text-label text-muted">
          {emptyCount} empty session{emptyCount === 1 ? "" : "s"} (0 turns).
        </p>
      )}
      {sessions.length < sessionsTotal && (
        <p className="mt-3 text-label text-muted">
          Showing the {sessions.length} most recent of {sessionsTotal} sessions.
        </p>
      )}
    </div>
  );
}
