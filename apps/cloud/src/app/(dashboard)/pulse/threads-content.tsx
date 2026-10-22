// Today's thread blocks — goal 2026-09-26 W8 / P7 (D-051), reshaped by the
// UX pass (audit B2) and UX pass 2. Pure and renderToStaticMarkup-testable:
// threads-panel.tsx owns the dismiss state and fetches, this file only
// renders what /api/pulse observed. Block order, top to bottom:
//
//   Open threads  B6 threads (≤ 5, sorted by est. spend upstream), grouped
//                 under a once-printed `owner/repo  N` header. ONE line per
//                 row: ref · verbs · newest session title (CSS-truncated to
//                 the row, "×N" when more sessions, every title in its
//                 tooltip) · est. cost · date · "⋯". Every row is open, so
//                 "open · no close seen" is the dot's tooltip, never row text.
//                 The "⋯" menu holds Resolved elsewhere / Not a delivery item.
//   (cost line)   the caller's one-line 30-day spend (cost-line.tsx), slotted
//                 right under the thesis block.
//   Blockers      live blockers (B7), most recurrent first then latest; "seen
//                 N×" only when N > 1; the first 3, then "+N more". "⋯" menu:
//                 Resolved / Ignore; a dismissed row reads "Dismissed · Undo"
//                 until reload.
//   Yesterday     ONE row per (kind, repo#N) a session acted on in the last
//                 ~36 h, its verbs merged; priced rows first by est. cost, then
//                 the "—" rows; the first 5, then "+N more acted on yesterday".
//                 The est. cost is OF THOSE SESSIONS ONLY (F5).
//
// Each row names its session by title (the session page's own title source,
// passed in as `sessionTitles`), linked to the turn that proves the row (B1).
// Refs link only through `forgeUrl` on the host-qualified ref (with the thread's data-derived forge_family); no URL, plain text.
//
// A failed threads read shows an error line, never the all-clear copy (F9).
// Every dollar figure is labelled est. (B11). Tokens only (docs/design/tokens.md).
import Link from "next/link";
import type { ReactNode } from "react";
import { type SessionTitleItem, SessionTitleList, sessionHref } from "@/components/session-title-list";
import { ShowAll } from "@/components/ui/show-all";
import { stripLocalPaths } from "@/lib/code-sessions/view";
import type { ForgeRefKind } from "@/lib/forge/ref-url";
import { forgeUrl } from "@/lib/format/forge-url";
import { fmtUsd, fmtUsdEst } from "@/lib/format/usd";
import {
  type BuildRung,
  DISMISS_LABEL,
  DISMISS_REASONS,
  type DismissReason,
  type RecurringBlocker,
  type ReviewRung,
  type Thread,
  type ThreadSession,
  THREAD_WINDOW_DAYS,
  threadKey,
} from "@/lib/threads/open-threads";
import { DismissedBlockersList, DismissedLine } from "./blocker-controls";
import { RowMenu, type RowMenuItem } from "./row-menu";
import type { DismissedBlocker } from "@/lib/memory/blocker-dismiss";
import type { BlockerRowState, DismissTarget } from "./threads-panel";
import {
  BLOCKER_ACTIONS,
  type BlockerAction,
  BLOCKERS_INITIAL,
  DAY_LOOKBACK_DAYS,
  type DayBounds,
  dayHref,
  dayLabel,
  dayNav,
  fmtDay,
  formatEstCost,
  formatRowCost,
  groupByRepo,
  groupBySession,
  isPlaceholderTitle,
  isViewOnly,
  ladderWords,
  mergeByRef,
  moreLabel,
  observedItemText,
  orderBlockers,
  parseDayParam,
  refIdentity,
  sessionAt,
  sessionRowTitle,
  type SessionTitles,
  sessionTurnHref,
  SESSIONS_PER_PROJECT_INITIAL,
  threadRefLabel,
  type ThreadGrouping,
  UNTITLED_SESSION,
  VIEWED_REFS_INITIAL,
  YESTERDAY_INITIAL,
  yesterdayBounds,
  yesterdayRows,
} from "@/lib/threads/view";

const CHIP_CLASS = "shrink-0 rounded-xs font-mono text-label underline-offset-2";
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function RefChip({ thread, label: override }: { thread: Pick<Thread, "ref" | "refKind" | "title" | "forge_family">; label?: string }) {
  const full = threadRefLabel(thread);
  const label = override ?? full;
  const kindWord = thread.refKind === "merge_request" ? "merge request" : "issue";
  const href = forgeUrl(thread.ref, { kind: thread.refKind, family: thread.forge_family });
  if (!href) {
    return (
      <span className={`${CHIP_CLASS} text-ink`} title={thread.title ?? thread.ref}>
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={thread.title ?? thread.ref}
      aria-label={`${kindWord} ${full} on the forge`}
      className={`${CHIP_CLASS} text-accent hover:underline ${FOCUS_RING} focus-visible:ring-offset-2 focus-visible:ring-offset-canvas`}
    >
      {label}
    </a>
  );
}

export const SESSION_TITLE_CELL = "min-w-0 basis-full sm:basis-0 sm:flex-1";

/** The newest session's title, linked to the turn that proves the row (B1); every other session behind "+N more". */
function SessionTitlesCell({ sessions, titles }: { sessions: readonly ThreadSession[]; titles: SessionTitles }) {
  const items: SessionTitleItem[] = [...sessions].reverse().map((s) => {
    const title = sessionRowTitle(s, titles);
    const tierNote = s.tier === "discussed" ? " (discussed)" : s.tier === "inferred_ref" ? " (linked from your prompt)" : "";
    return {
      id: s.proof_session_id ?? s.id,
      title,
      turnIdx: s.turn_idx,
      hint: sessionAt(s) ? new Date(sessionAt(s) as string).toLocaleString() : title,
      ariaLabel: `open ${title} at turn ${s.turn_idx}${tierNote}`,
    };
  });
  // UX W6: on phone the title takes its own line (basis-full) instead of
  // shrinking to a character or two beside the ref, verbs, cost and date.
  if (items.length === 0) return <span className="min-w-0 flex-1" />;
  return <SessionTitleList items={items} className={SESSION_TITLE_CELL} />;
}

/** The dot's words — every Open threads row is open, so they live in its tooltip, not on the row. */
export const OPEN_MARKER_TITLE = "open · no close seen";

function OpenDot() {
  return (
    <span
      className="inline-flex h-4 w-2 shrink-0 items-center"
      title={OPEN_MARKER_TITLE}
      role="img"
      aria-label={OPEN_MARKER_TITLE}
      data-testid="open-marker"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
    </span>
  );
}

/** The Open threads row's "⋯" items: the two dismiss reasons, keyed (kind, ref). */
export function threadMenuItems(
  thread: Pick<Thread, "ref" | "refKind">,
  onDismiss: (target: DismissTarget) => void,
): RowMenuItem[] {
  return DISMISS_REASONS.map((reason: DismissReason) => ({
    key: reason,
    label: DISMISS_LABEL[reason],
    onSelect: () => onDismiss({ ref: thread.ref, kind: thread.refKind, reason }),
  }));
}


/**
 * One Open threads row: dot · ref | newest session title (CSS-truncated),
 * the verbs as a small muted line under it | cost · date · ⋯, vertically
 * centred. A placeholder title is not shown; the verbs line then stands
 * alone at normal size. The title's tooltip lists every session (and the
 * owner's priority quote, B8, when there is one); "×N" when more than one.
 */
function OpenThreadRow({
  thread,
  now,
  titles,
  onDismiss,
}: {
  thread: Thread;
  now: number;
  titles: SessionTitles;
  onDismiss?: (target: DismissTarget) => void;
}) {
  const words = ladderWords(thread);
  const label = threadRefLabel(thread);
  const newestFirst = [...thread.sessions].reverse();
  const newest = newestFirst[0];
  // A placeholder never shows — not in the row, not in the tooltip (the stored title is untouched).
  const allTitles = newestFirst.map((s) => {
    const t = sessionRowTitle(s, titles);
    return isPlaceholderTitle(t) ? UNTITLED_SESSION : t;
  });
  const title = allTitles[0] && allTitles[0] !== UNTITLED_SESSION ? allTitles[0] : null;
  const tooltip = [...allTitles, ...(thread.priority ? [`you said: \u201c${thread.priority}\u201d`] : [])].join("\n");
  const verbs = (
    <span
      className={`block min-w-0 truncate text-muted ${title ? "text-micro" : "text-body-sm"}`}
      data-testid="thread-verbs"
    >
      {words.join(" · ")}
      {thread.inferred_ref && (
        <span data-testid="inferred-ref" title="No command named this ref; you named it in your prompt before the commit">
          {" "}
          · linked from your prompt
        </span>
      )}
      {thread.note && <span> · {thread.note}</span>}
    </span>
  );
  const badge = allTitles.length > 1 && (
    <span
      className="shrink-0 text-micro text-muted tabular-nums"
      title={tooltip}
      aria-label={`${allTitles.length} sessions: ${allTitles.join("; ")}`}
      data-testid="session-count"
    >
      ×{allTitles.length}
    </span>
  );
  const linkClass = `min-w-0 truncate rounded-xs hover:text-accent ${FOCUS_RING}`;
  return (
    <div
      className="flex min-w-0 items-center gap-2 border-line-soft border-b py-2 last:border-b-0 sm:gap-3"
      data-testid="thread-row"
      data-ref={thread.ref}
      data-kind={thread.refKind}
    >
      <OpenDot />
      <RefChip thread={thread} label={threadRefLabel(thread)} />
      <div className="flex min-w-0 flex-1 flex-col">
        {title ? (
          <>
            <span className="flex min-w-0 items-center gap-2">
              {newest && (
                <Link
                  href={sessionHref(newest.proof_session_id ?? newest.id, newest.turn_idx)}
                  title={tooltip}
                  aria-label={`open ${title} at turn ${newest.turn_idx}`}
                  className={`${linkClass} text-body-sm text-ink-2`}
                  data-testid="thread-title"
                >
                  {title}
                </Link>
              )}
              {badge}
            </span>
            {verbs}
          </>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            {newest ? (
              <Link
                href={sessionHref(newest.proof_session_id ?? newest.id, newest.turn_idx)}
                title={tooltip}
                aria-label={`open the session at turn ${newest.turn_idx}`}
                className={linkClass}
              >
                {verbs}
              </Link>
            ) : (
              verbs
            )}
            {badge}
          </span>
        )}
      </div>
      <span className="shrink-0 text-right text-label text-ink tabular-nums" data-testid="thread-cost">
        {formatRowCost(thread.cost_est_total)}
      </span>
      <span className="w-12 shrink-0 text-right text-label text-muted tabular-nums">
        {fmtDay(thread.last_seen_at, now)}
      </span>
      {onDismiss && <RowMenu label={`Actions for ${label}`} items={threadMenuItems(thread, onDismiss)} />}
    </div>
  );
}


const CHIP = "inline-flex shrink-0 items-center rounded-xs border px-1.5 text-micro leading-4";

function Chip({ children, quiet = false, testId }: { children: ReactNode; quiet?: boolean; testId?: string }) {
  return (
    <span
      className={`${CHIP} ${quiet ? "border-dashed border-line text-muted" : "border-line text-ink-2"}`}
      data-testid={testId ?? "verb-chip"}
    >
      {children}
    </span>
  );
}

/** One ref under its session: [dot] · ref | observed title, then chips (verbs, N commits, +N earlier sessions) | [⋯]. */
function SessionRefRow({
  thread,
  open,
  onDismiss,
}: {
  thread: Thread;
  open: boolean;
  onDismiss?: (target: DismissTarget) => void;
}) {
  const earlier = thread.sessions.length - 1;
  const text = observedItemText(thread);
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-1.5 pl-3 sm:gap-3"
      data-testid="thread-row"
      data-ref={thread.ref}
      data-kind={thread.refKind}
    >
      {open && <OpenDot />}
      <RefChip thread={thread} label={threadRefLabel(thread)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {text && (
          <span className="block min-w-0 truncate text-body-sm text-ink-2" title={text} data-testid="item-text">
            {text}
          </span>
        )}
        <span className="flex min-w-0 flex-wrap items-center gap-1" data-testid="thread-verbs">
          {ladderWords(thread).map((w) => (
            <Chip key={w}>{w}</Chip>
          ))}
          {thread.inferred_ref && (
            <span title="No command named this ref; you named it in your prompt before the commit" data-testid="inferred-ref">
              <Chip quiet>linked from your prompt</Chip>
            </span>
          )}
          {thread.note && <Chip quiet>{thread.note}</Chip>}
          {(thread.commit_count ?? 0) > 0 && (
            <Chip testId="commit-chip">
              {thread.commit_count} commit{thread.commit_count === 1 ? "" : "s"}
            </Chip>
          )}
          {earlier > 0 && (
            <Chip quiet testId="earlier-sessions">
              +{earlier} earlier session{earlier === 1 ? "" : "s"}
            </Chip>
          )}
        </span>
      </div>
      {open && onDismiss && (
        <RowMenu label={`Actions for ${threadRefLabel(thread)}`} items={threadMenuItems(thread, onDismiss)} />
      )}
    </div>
  );
}

/** The session's view-only refs on one line: "viewed" chip + comma-separated ref links (+N more). */
function ViewedLine({ threads }: { threads: readonly Thread[] }) {
  const shown = threads.slice(0, VIEWED_REFS_INITIAL);
  const more = threads.length - shown.length;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 pl-3" data-testid="viewed-line">
      <Chip>viewed</Chip>
      <span className="min-w-0 text-label text-muted">
        {shown.map((t, i) => {
          const label = threadRefLabel(t);
          const href = forgeUrl(t.ref, { kind: t.refKind, family: t.forge_family });
          return (
            <span key={threadKey(t)} data-ref={t.ref}>
              {i > 0 && ", "}
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className={`rounded-xs text-accent hover:underline ${FOCUS_RING}`}>
                  {threadRefLabel(t)}
                </a>
              ) : (
                <span title={label}>{threadRefLabel(t)}</span>
              )}
            </span>
          );
        })}
        {more > 0 && ` +${more} more`}
      </span>
    </div>
  );
}

/** Session grouping: repo header → session header (title, "session $X", last activity) → its refs. */
function SessionGroupedThreads({
  threads,
  now,
  titles,
  open,
  onDismiss,
  testId,
}: {
  threads: readonly Thread[];
  now: number;
  titles: SessionTitles;
  /** Open threads: dot + ⋯ on every ref row; Yesterday: neither, and view-only refs collapse. */
  open: boolean;
  onDismiss?: (target: DismissTarget) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      {groupBySession(threads, titles, now).map((p) => (
        <div key={p.repo ?? ""} data-testid="repo-group">
          <h3 className="flex items-baseline justify-between gap-3 border-line-soft border-b pb-1.5 text-label text-muted">
            <span className="min-w-0 truncate font-mono" data-testid="repo-header">
              {p.repo ?? "other"}
            </span>
            <span className="shrink-0 tabular-nums">{p.sessions.length}</span>
          </h3>
          <ShowAll
            items={p.sessions}
            initial={SESSIONS_PER_PROJECT_INITIAL}
            label={(n) => `+${n} more session${n === 1 ? "" : "s"}`}
            renderItem={(g) => {
              const viewed = open ? [] : g.threads.filter(isViewOnly);
              const rest = open ? g.threads : g.threads.filter((t) => !isViewOnly(t));
              return (
                <div key={g.id} className="border-line-soft border-b py-2 last:border-b-0" data-testid="session-group">
                  <div className="flex min-w-0 items-baseline gap-2 sm:gap-3">
                    <Link
                      href={sessionHref(g.id)}
                      title={g.title}
                      className={`min-w-0 flex-1 truncate rounded-xs text-body-sm text-ink hover:text-accent ${FOCUS_RING}`}
                      data-testid="session-header"
                    >
                      {g.title}
                    </Link>
                    {g.cost !== null && g.cost > 0 && (
                      <span className="shrink-0 text-right text-label text-muted tabular-nums" data-testid="session-cost">
                        session {fmtUsd(g.cost)}
                      </span>
                    )}
                    <span className="w-12 shrink-0 text-right text-label text-muted tabular-nums">
                      {fmtDay(g.last_at, now)}
                    </span>
                  </div>
                  {rest.map((t) => (
                    <SessionRefRow key={threadKey(t)} thread={t} open={open} onDismiss={onDismiss} />
                  ))}
                  {viewed.length > 0 && <ViewedLine threads={viewed} />}
                </div>
              );
            }}
          />
        </div>
      ))}
    </div>
  );
}

/** Open threads, grouped under a once-printed `owner/repo  N` header. */
function OpenThreadGroups({
  threads,
  now,
  titles,
  onDismiss,
}: {
  threads: readonly Thread[];
  now: number;
  titles: SessionTitles;
  onDismiss?: (target: DismissTarget) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {groupByRepo(threads).map((g) => (
        <div key={g.repo ?? ""} data-testid="repo-group">
          <h3 className="flex items-baseline justify-between gap-3 border-line-soft border-b pb-1.5 text-label text-muted">
            <span className="min-w-0 truncate font-mono" data-testid="repo-header">
              {g.repo ?? "other"}
            </span>
            <span className="shrink-0 tabular-nums">{g.threads.length}</span>
          </h3>
          {g.threads.map((t) => (
            <OpenThreadRow key={threadKey(t)} thread={t} now={now} titles={titles} onDismiss={onDismiss} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A Yesterday row: ref · verbs · session titles · est. cost · date (no open marker, no actions). */
function ThreadRow({ thread, now, titles }: { thread: Thread; now: number; titles: SessionTitles }) {
  const words = ladderWords(thread);
  return (
    <div
      className="flex flex-col gap-1 border-line-soft border-b py-2.5 last:border-b-0"
      data-testid="thread-row"
      data-ref={thread.ref}
      data-kind={thread.refKind}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <RefChip thread={thread} />
        <span className="shrink-0 text-body-sm text-ink-2">
          {words.join(" · ")}
          {thread.inferred_ref && (
            <span
              className="text-label text-muted"
              data-testid="inferred-ref"
              title="No command named this ref; you named it in your prompt before the commit"
            >
              {" "}
              · linked from your prompt
            </span>
          )}
          {thread.note && <span className="text-muted"> · {thread.note}</span>}
          {thread.dismissed && (
            <span className="text-muted">
              {" "}
              · dismissed{thread.dismiss_reason ? ` (${DISMISS_LABEL[thread.dismiss_reason].toLowerCase()})` : ""}
            </span>
          )}
        </span>
        <SessionTitlesCell sessions={thread.sessions} titles={titles} />
        <span className="shrink-0 text-right text-label text-ink tabular-nums">
          {formatEstCost(thread.cost_est_total)}
        </span>
        <span className="w-12 shrink-0 text-right text-label text-muted tabular-nums">
          {fmtDay(thread.last_seen_at, now)}
        </span>
      </div>
    </div>
  );
}


/** The blocker row's "⋯" items: Resolved / Ignore. */
export function blockerMenuItems(id: string, onDismissBlocker: (id: string, reason: BlockerAction) => void): RowMenuItem[] {
  return BLOCKER_ACTIONS.map((a) => ({ key: a.reason, label: a.label, onSelect: () => onDismissBlocker(id, a.reason) }));
}

function RowError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span className="basis-full text-label text-error" data-testid="blocker-error">
      {message}
    </span>
  );
}

function BlockerRow({
  blocker: b,
  now,
  state,
  error,
  refocus,
  onDismissBlocker,
  onUndoBlocker,
}: {
  blocker: RecurringBlocker;
  now: number;
  state?: BlockerRowState;
  /** Inline failure text (S4): the last dismiss/undo on this row failed. */
  error?: string;
  /** The row just came back from Undo: its ⋯ takes focus again. */
  refocus?: boolean;
  onDismissBlocker?: (id: string, reason: BlockerAction) => void;
  onUndoBlocker?: (id: string) => void;
}) {
  if (state) {
    return (
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-line-soft border-b py-2.5"
        data-testid="blocker-row"
        data-dismissed="true"
      >
        <DismissedLine
          text={b.quote ?? b.text}
          ready={state.ids.length > 0}
          busy={state.busy}
          onUndo={() => onUndoBlocker?.(b.id)}
        />
        <RowError message={error} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-line-soft border-b py-2.5" data-testid="blocker-row">
      <span className="line-clamp-2 min-w-0 flex-1 text-body-sm text-ink" title={b.quote ?? b.text}>
        {b.quote ? <q>{b.quote}</q> : b.text}
      </span>
      {b.recurrence_count > 1 && (
        <span className="shrink-0 text-label text-muted tabular-nums">seen {b.recurrence_count}×</span>
      )}
      <span className="w-12 shrink-0 text-right text-label text-muted tabular-nums">{fmtDay(b.last_seen_at, now)}</span>
      {b.session_id && (
        <Link
          href={sessionTurnHref(b.session_id, b.turn_idx)}
          aria-label="open the session at this turn"
          className={`rounded-xs px-0.5 text-accent hover:bg-raised ${FOCUS_RING}`}
        >
          ▸
        </Link>
      )}
      {onDismissBlocker && (
        <RowMenu
          label="Actions for this blocker"
          items={blockerMenuItems(b.id, onDismissBlocker)}
          focusOnMount={refocus}
        />
      )}
      <RowError message={error} />
    </div>
  );
}


/**
 * ‹ / › day-nav arrows, split from the label text so the arrows never land inside
 * the `<h2>`'s accessible name (they're chrome around the heading, not part of it —
 * the heading's name must stay exactly `dayLabel()`'s output for the smoke test).
 * › stops at Today, ‹ at the loaded window.
 */
function dayNavArrows(bounds: DayBounds, now: number, grouping: ThreadGrouping): { prev: ReactNode; next: ReactNode } {
  const { prev, next } = dayNav(bounds, now);
  const arrow = `rounded-xs px-1 text-muted hover:text-accent ${FOCUS_RING}`;
  return {
    prev: prev ? (
      <a href={dayHref(prev, grouping)} aria-label="Previous day" className={arrow} data-testid="day-prev">
        ‹
      </a>
    ) : (
      <span aria-disabled="true" className="px-1 text-faint" data-testid="day-prev-disabled">
        ‹
      </span>
    ),
    next: next ? (
      <a href={dayHref(next, grouping)} aria-label="Next day" className={arrow} data-testid="day-next">
        ›
      </a>
    ) : (
      <span aria-disabled="true" aria-label="Next day (none after today)" className="px-1 text-faint" data-testid="day-next-disabled">
        ›
      </span>
    ),
  };
}

function Block({
  id,
  label,
  prevNav,
  nextNav,
  children,
}: { id: string; label: ReactNode; prevNav?: ReactNode; nextNav?: ReactNode; children: ReactNode }) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} className="mt-7 first:mt-0" aria-labelledby={headingId}>
      <div className="inline-flex items-center gap-1" data-testid={prevNav || nextNav ? "day-nav" : undefined}>
        {prevNav}
        <h2 id={headingId} className="section-label">
          {label}
        </h2>
        {nextNav}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function LoadError() {
  return (
    <p className="text-body-sm text-ink-2" role="alert" data-testid="threads-error">
      Couldn't load open threads. Reload to try again.
    </p>
  );
}


export interface ThreadsContentProps {
  recentThreads: readonly Thread[];
  openThreads: readonly Thread[];
  recurringBlockers: readonly RecurringBlocker[];
  /** Carried on the payload but no longer rendered (audit B2: the "Busiest repo" line is deleted). */
  statsLine?: string | null;
  /** The threads read failed (F9): every thread block says so instead of its empty copy. */
  threadsError?: boolean;
  /** Epoch ms; injectable so the Yesterday window is deterministic in tests. */
  now?: number;
  onDismiss?: (target: DismissTarget) => void;
  /**
   * S16: false when the user has no coding sessions at all, so the empty Open
   * threads block welcomes them instead of reading as an all-clear. Defaults
   * to true (the all-clear copy) when the caller doesn't know.
   */
  hasSessions?: boolean;
  /** Session id → title, for the per-row session link (the caller builds it with `sessionDisplayTitle`). */
  sessionTitles?: SessionTitles;
  /** Rendered right after Open threads — Today's one-line 30-day spend. */
  costLine?: ReactNode;
  /** Blockers dismissed in this view (by displayed id): they read "Dismissed · Undo" until reload. */
  blockerStates?: ReadonlyMap<string, BlockerRowState>;
  onDismissBlocker?: (id: string, reason: BlockerAction) => void;
  onUndoBlocker?: (id: string) => void;
  /** Inline failure text per blocker id (S4). */
  blockerErrors?: ReadonlyMap<string, string>;
  /** The blocker just restored by Undo — its ⋯ takes focus back (S3). */
  refocusBlockerId?: string | null;
  /** Written into the Blockers block's persistent live region (S3). */
  blockerAnnouncement?: string;
  /** The user's earlier dismissals, for the "N dismissed" list with Restore (S1). */
  dismissedBlockers?: readonly DismissedBlocker[];
  restoringBlockers?: ReadonlySet<string>;
  onRestoreBlocker?: (item: DismissedBlocker) => void;
  /** Default: Open threads and Yesterday grouped by latest session; `?group=repo` groups by repo. */
  grouping?: ThreadGrouping;
  /** `?day=YYYY-MM-DD` for the day section (viewer's timezone); default yesterday. */
  day?: string | null;
}

export function ThreadsContent({
  recentThreads,
  openThreads,
  recurringBlockers,
  threadsError = false,
  now = Date.now(),
  onDismiss,
  hasSessions = true,
  sessionTitles = {},
  costLine,
  blockerStates,
  onDismissBlocker,
  onUndoBlocker,
  blockerErrors,
  refocusBlockerId = null,
  blockerAnnouncement = "",
  dismissedBlockers = [],
  restoringBlockers,
  onRestoreBlocker,
  grouping = "session",
  day = null,
}: ThreadsContentProps) {
  const dayBounds = parseDayParam(day, now);
  // Review r2 S3: "each ref once on the page" holds for yesterday/today, which sit right under
  // Open threads; an older day lists every ref acted on that day, open or not.
  const recentDay = dayBounds.start >= yesterdayBounds(now).start;
  const yesterday = yesterdayRows(recentThreads, now, threadsError || !recentDay ? [] : openThreads, dayBounds);
  const dayArrows = dayNavArrows(dayBounds, now, grouping);
  const blockers = orderBlockers(recurringBlockers);
  return (
    <div>
      {/* Open threads — B6: committed or above, no close seen; the ≤ 5 picked by est. spend upstream, shown by latest session (or by repo with ?group=repo). The thesis, so first. */}
      <Block id="pulse-open-threads" label="Open threads · 30d">
        {threadsError ? (
          <LoadError />
        ) : openThreads.length > 0 ? (
          grouping === "session" ? (
            <SessionGroupedThreads
              threads={openThreads}
              now={now}
              titles={sessionTitles}
              open
              onDismiss={onDismiss}
              testId="threads-by-session"
            />
          ) : (
            <OpenThreadGroups threads={openThreads} now={now} titles={sessionTitles} onDismiss={onDismiss} />
          )
        ) : hasSessions ? (
          <p className="text-body-sm text-ink-2">Nothing you committed to is still waiting on a close.</p>
        ) : (
          <p className="text-body-sm text-ink-2" data-testid="open-threads-no-sessions">
            No coding sessions yet. Once Membral imports your first one, each issue or merge request you commit to
            shows up here until it closes.
          </p>
        )}
      </Block>

      {costLine && <div className="mt-3">{costLine}</div>}

      {/* Blockers — B7 recurrence is a count; most recurrent first; hidden when there are none (and nothing was dismissed). */}
      {!threadsError && (blockers.length > 0 || dismissedBlockers.length > 0) && (
        <Block id="pulse-blockers" label="Blockers">
          {blockers.length > 0 && (
            <ShowAll
              items={blockers}
              initial={BLOCKERS_INITIAL}
              label={moreLabel(blockers.length > 1 ? " blockers" : "")}
              className="border-line-soft border-t"
              renderItem={(b) => (
                <BlockerRow
                  key={b.id}
                  blocker={b}
                  now={now}
                  state={blockerStates?.get(b.id)}
                  error={blockerErrors?.get(b.id)}
                  refocus={refocusBlockerId === b.id}
                  onDismissBlocker={onDismissBlocker}
                  onUndoBlocker={onUndoBlocker}
                />
              )}
            />
          )}
          {onRestoreBlocker && (
            <DismissedBlockersList items={dismissedBlockers} busy={restoringBlockers} onRestore={onRestoreBlocker} />
          )}
          <p className="sr-only" aria-live="polite" data-testid="blocker-live">
            {blockerAnnouncement}
          </p>
        </Block>
      )}

      {/* Yesterday — B5: discussion rows are here, with their cost, and never carry an open marker. */}
      <Block id="pulse-yesterday" label={dayLabel(dayBounds, now)} prevNav={dayArrows.prev} nextNav={dayArrows.next}>
        {threadsError ? (
          <LoadError />
        ) : yesterday.length > 0 && grouping === "session" ? (
          <SessionGroupedThreads
            threads={yesterday}
            now={now}
            titles={sessionTitles}
            open={false}
            testId="yesterday-by-session"
          />
        ) : yesterday.length > 0 ? (
          <ShowAll
            items={yesterday}
            initial={YESTERDAY_INITIAL}
            label={moreLabel(dayBounds.start === yesterdayBounds(now).start ? " acted on yesterday" : " acted on this day")}
            className="border-line-soft border-t"
            renderItem={(t) => <ThreadRow key={refIdentity(t)} thread={t} now={now} titles={sessionTitles} />}
          />
        ) : (
          <p className="text-body-sm text-ink-2">Nothing acted on this day.</p>
        )}
      </Block>
    </div>
  );
}
