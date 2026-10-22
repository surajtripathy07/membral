// Memory section for /code/[projectId].
//
// UX audit B4: was 37 cards (8 per kind × 4 kinds, plus 5 chat claims) — a
// full memory browser embedded in a page whose job is "what happened and
// what it cost". Memory owns browsing (`/memories`); this section is now a
// one-line count summary (per kind, linking out) plus the project's top 3
// recurring blockers, deduped and sorted the way Today groups them, plus one
// "Open in Memory →" link. The chat-claims block ("From chats") is DELETED
// here per the audit's verdict — still reachable at
// `/memories?tab=chats&project=<name>` — since the chat lane ranks second
// and doesn't belong on a code project page.
//
// Fetched here, server-side, because page.tsx hands this section only the
// project's display name; the project is resolved by that name
// (lib/memory/session-memories-browse.ts's loadProjectMemoryGroups) unless
// `projectId` is passed. A read failure degrades to "no session memories",
// never a page error.
import Link from "next/link";
import { normalizeQuote, orderBlockers, sessionTurnHref } from "@/lib/threads/view";
import { stripMarkdown } from "@/lib/conversation-view";
import { formatDayEnUs } from "@/lib/format/dates";
import type { RecurringBlocker } from "@/lib/threads/open-threads";
import { log } from "@/lib/log";
import {
  type BrowseSessionMemory,
  loadProjectMemoryGroups,
  type ProjectMemoryGroups,
} from "@/lib/memory/session-memories-browse";
import { createClient } from "@/lib/supabase/server";

const PER_KIND_CAP = 8;

const TOP_BLOCKERS = 3;

const LINK =
  "text-label text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

/**
 * The loaded blocker rows are already newest-first and capped to
 * `PER_KIND_CAP` (session-memories-browse.ts's `groupProjectMemories`), so
 * duplicate text within that window collapses to one row with a recurrence
 * count — same shape (`RecurringBlocker`) and the same sort Today's
 * `orderBlockers` already applies (recurrence desc, ties latest first). No
 * new grouping helper: only the count-by-text step has no existing home,
 * since Today's recurrence count comes from a DB chain (`recurs_of`) this
 * page's memory query doesn't select.
 */
export function dedupeBlockers(records: readonly BrowseSessionMemory[]): RecurringBlocker[] {
  const byText = new Map<string, RecurringBlocker>();
  for (const r of records) {
    // UX W6: Today's normalization (whitespace + trailing punctuation), on the
    // markdown-stripped text, so "**X** —" and "X" count as one blocker.
    const key = normalizeQuote(blockerText(r.text)).toLowerCase();
    const existing = byText.get(key);
    if (existing) {
      existing.recurrence_count += 1;
      continue;
    }
    byText.set(key, {
      id: r.id,
      text: r.text,
      quote: r.quote,
      ref: r.ref,
      recurrence_count: 1,
      session_id: r.code_session_id,
      turn_idx: r.turn_idx,
      last_seen_at: r.created_at,
    });
  }
  return orderBlockers([...byText.values()]);
}

/** UX W6: a blocker row prints the blocker's TEXT as plain prose — markdown stripped, one line. */
export function blockerText(text: string): string {
  return stripMarkdown(text).replace(/\s+/g, " ").trim();
}

/** Pure render of the grouped session memories (exported for tests). */
export function SessionMemoriesBlock({ grouped, projectId }: { grouped: ProjectMemoryGroups; projectId: string }) {
  const viewAll = `/memories?project=${encodeURIComponent(projectId)}`;
  if (grouped.total === 0) {
    return (
      <p className="text-body-sm text-muted" data-testid="project-session-memories">
        Nothing remembered from this project&rsquo;s sessions yet. Memories are extracted after a session uploads.
      </p>
    );
  }

  const blockerGroup = grouped.groups.find((g) => g.kind === "blocker");
  const topBlockers = blockerGroup ? dedupeBlockers(blockerGroup.records).slice(0, TOP_BLOCKERS) : [];

  return (
    <div data-testid="project-session-memories">
      <p className="text-body-sm text-ink-2">
        {grouped.groups.map((g, i) => (
          <span key={g.kind}>
            {i > 0 && " · "}
            <Link href={`${viewAll}&kind=${g.kind}`} className={LINK}>
              {g.total} {g.total === 1 ? g.label.toLowerCase().replace(/s$/, "") : g.label.toLowerCase()}
            </Link>
          </span>
        ))}
        {grouped.outcomeCount > 0 && (
          <span>
            {" · "}
            <Link href={`${viewAll}&kind=outcome`} className={LINK}>
              {grouped.outcomeCount} outcome{grouped.outcomeCount === 1 ? "" : "s"}
            </Link>
          </span>
        )}
      </p>
      {topBlockers.length > 0 && (
        <div className="mt-3">
          <h3 className="section-label">Top open blockers</h3>
          <ul className="mt-1 flex flex-col divide-y divide-line-soft border-t border-line-soft" data-testid="project-top-blockers">
            {topBlockers.map((b) => {
              const text = blockerText(b.text);
              const quote = b.quote && normalizeQuote(b.quote) !== normalizeQuote(b.text) ? b.quote : undefined;
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-testid="project-blocker-row">
                  <span className="line-clamp-2 min-w-0 flex-1 text-body-sm text-ink" title={quote}>
                    {text}
                  </span>
                  {b.recurrence_count > 1 && (
                    <span className="shrink-0 text-label text-muted tabular-nums">seen {b.recurrence_count}×</span>
                  )}
                  {b.last_seen_at && (
                    <span className="w-12 shrink-0 text-right text-label text-muted tabular-nums">{formatDayEnUs(b.last_seen_at)}</span>
                  )}
                  {b.session_id && (
                    <Link
                      href={sessionTurnHref(b.session_id, b.turn_idx)}
                      aria-label="open the session at this turn"
                      className="rounded-xs px-0.5 text-accent hover:bg-raised"
                    >
                      ▸
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <Link href={viewAll} className={`mt-2 inline-block ${LINK}`}>
        Open in Memory →
      </Link>
    </div>
  );
}

async function loadGroups(projectName: string, projectId?: string | null) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { project, grouped } = await loadProjectMemoryGroups(supabase, user.id, {
      projectId,
      projectName,
      cap: PER_KIND_CAP,
    });
    return project ? { projectId: project.id, grouped } : null;
  } catch (e) {
    log.warn("project memory section: session memories read failed", { error: (e as Error).message });
    return null;
  }
}

export async function MemorySection({
  projectName,
  projectId,
}: {
  projectName: string;
  /** Preferred over resolving by name; page.tsx does not pass it yet. */
  projectId?: string | null;
}) {
  const session = await loadGroups(projectName, projectId);
  if (!session) return null;
  return <SessionMemoriesBlock grouped={session.grouped} projectId={session.projectId} />;
}
