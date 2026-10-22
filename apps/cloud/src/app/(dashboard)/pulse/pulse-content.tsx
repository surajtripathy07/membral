// Pure presentational piece for /pulse ("Today", the home) — split out of
// page.tsx, which owns fetching/state, so the loading/error/empty/normal
// render paths are renderToStaticMarkup-testable without mocking
// fetch/useState. Same precedent as portrait-content.tsx.
//
// UX audit B2 — the page answers "what did I leave open, and what did it
// cost" in one screen:
//   header        "Today" + "All sessions →" / "All chats →"
//   sync line     one collapsed SyncSummary (sync-state-content.tsx); the old
//                 freshness strip's "current through" dates are its tooltip
//   threads       Open threads, the 30-day CostLine, Blockers and Yesterday
//                 (threads-content.tsx)
//
// Deleted from this page, each still reachable:
//   - "Your record" (listed every code session twice — as its mirror
//     conversation and as itself): /code and /conversations, linked from the
//     header.
//   - the AgentWorkPanel charts/tiles: Usage (/code/stats), linked from the
//     CostLine. agent-work-content.tsx stays in place for that page.
//   - the freshness strip: the SyncSummary tooltip and its expanded rows.
//
// A user with no code sessions sees one setup checklist and one line, never
// a stack of empty section headers.
import Link from "next/link";
import { PageFrame } from "@/components/ui/page-frame";
import { sessionDisplayTitle } from "@/lib/code-sessions/view";
import { formatShortDate } from "@/lib/format/dates";
import type { FreshnessMap } from "@/lib/freshness";
import { shapePulseFreshness } from "@/lib/freshness";
import type { PulseRecentCodeSession } from "./code-activity-strip";
import type { FirstRunHistory } from "@/lib/code-sessions/first-run";
import { CostLine } from "./cost-line";
import { FirstRunCard } from "./first-run-card";
import { SyncStatePanel } from "./sync-state-panel";
import type { SessionTitles, ThreadGrouping } from "@/lib/threads/view";
import { type PulseThreads, ThreadsPanel } from "./threads-panel";
import { getAppUrl } from "@/lib/env";
import { installCommand } from "@/lib/install-command";

export interface PulseRecent {
  id: string;
  title: string | null;
  source: string | null;
  date: string | null;
  area_id: string | null;
  area_label: string | null;
  orphan: boolean;
}

/** "today" for a same-calendar-day timestamp, else the compact `formatShortDate`; null -> "—". */
function freshnessDateLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const sameDay =
    then.getFullYear() === now.getFullYear() && then.getMonth() === now.getMonth() && then.getDate() === now.getDate();
  return sameDay ? "today" : formatShortDate(iso);
}

/** The deleted freshness strip, as one tooltip string: "Chat current through Sep 25 · Code current through today". */
export function freshnessTitle(freshness: FreshnessMap | null | undefined, now: Date = new Date()): string {
  if (!freshness) return "";
  return shapePulseFreshness(freshness, now)
    .map((r) => `${r.label} current through ${freshnessDateLabel(r.currentThroughIso, now)}${r.stale ? " (stale)" : ""}`)
    .join(" · ");
}

/** Session id -> the title the session page shows (sessionDisplayTitle), for the thread rows' session links. */
export function buildSessionTitles(recentCode: readonly PulseRecentCodeSession[]): SessionTitles {
  const titles: Record<string, string> = {};
  for (const s of recentCode) titles[s.id] = sessionDisplayTitle(s);
  return titles;
}

export interface PulseContentProps {
  loading: boolean;
  error: string | null;
  recent: PulseRecent[];
  recentCode: PulseRecentCodeSession[];
  /** Per-source freshness stamp — null when unavailable; folds into the sync line's tooltip. */
  freshness?: FreshnessMap | null;
  /** Open threads, Yesterday, Blockers. Null while loading or when /api/pulse carried none. */
  threads?: PulseThreads | null;
  /** Default: grouped by latest session; `?group=repo` on /pulse (page.tsx reads it) groups by repo. */
  threadGrouping?: ThreadGrouping;
  /** `?day=YYYY-MM-DD` for the day section; default yesterday. */
  threadDay?: string | null;
  /** "Your history" first-run card data; null/absent hides it (no sessions, or first upload 7+ days ago). */
  firstRun?: FirstRunHistory | null;
}

const EMPTY_THREADS: PulseThreads = {
  recentThreads: [],
  openThreads: [],
  recurringBlockers: [],
  statsLine: null,
  threadsError: false,
};

const HEADER_LINK = "text-body-sm text-accent hover:underline";

function Header() {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h1 className="text-h2 text-ink">Today</h1>
      <nav className="flex gap-4" aria-label="Browse">
        <Link href="/code" className={HEADER_LINK}>
          All sessions →
        </Link>
        <Link href="/conversations" className={HEADER_LINK}>
          All chats →
        </Link>
      </nav>
    </header>
  );
}

interface ChecklistStep {
  key: string;
  label: string;
  detail: React.ReactNode;
  done: boolean;
}

/** Fresh user (no code sessions): the one setup checklist, in place of every empty block. */
export function SetupChecklist({ hasChats }: { hasChats: boolean }) {
  const steps: ChecklistStep[] = [
    {
      key: "cli",
      label: "Install the plugin or the CLI",
      detail: (
        <>
          <span className="block">Claude Code: run /plugin marketplace add surajtripathy07/membral-plugin, then /plugin install membral@membral. It asks for an API key from Settings.</span>
          <span className="mt-1 block">Other harnesses: install the CLI.</span>
          <code className="mt-1 block rounded-xs bg-sunken px-1.5 py-0.5 font-mono text-label text-ink">
            {installCommand(getAppUrl())}
          </code>
          <Link href="/setup" className="text-accent hover:underline">
            Setup guide
          </Link>
        </>
      ),
      done: false,
    },
    {
      key: "chats",
      label: "Import your chats (optional)",
      detail: (
        <Link href="/import" className="text-accent hover:underline">
          Import a ChatGPT or Claude export →
        </Link>
      ),
      done: hasChats,
    },
    {
      key: "mcp",
      label: "Connect your agent over MCP",
      detail: (
        <Link href="/settings#mcp-configuration" className="text-accent hover:underline">
          MCP configuration →
        </Link>
      ),
      done: false,
    },
  ];
  return (
    <section className="mt-6" data-testid="setup-checklist" aria-labelledby="pulse-setup">
      <h2 id="pulse-setup" className="section-label">
        Get set up
      </h2>
      <ol className="mt-3 rounded-card border border-line bg-surface">
        {steps.map((step, i) => (
          <li key={step.key} className="flex gap-3 border-line-soft border-b px-4 py-3 last:border-b-0">
            <span
              className={`w-5 shrink-0 text-right font-serif text-body tabular-nums ${
                step.done ? "text-ok" : "text-muted"
              }`}
              aria-hidden="true"
            >
              {step.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-body-sm text-ink">
                {step.label}
                {step.done && <span className="sr-only"> (done)</span>}
              </div>
              <div className="mt-1 text-body-sm text-muted">{step.detail}</div>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-body-sm text-muted">Open threads and cost appear after your first session.</p>
    </section>
  );
}

export function PulseContent({
  loading,
  error,
  recent,
  recentCode,
  freshness,
  threads,
  threadGrouping = "session",
  threadDay = null,
  firstRun = null,
}: PulseContentProps) {
  if (loading) {
    return (
      <PageFrame width="read">
        <div className="h-8 w-40 animate-pulse rounded-xs bg-surface" />
        <div className="mt-6 h-5 w-3/4 animate-pulse rounded-xs bg-surface" />
        <div className="mt-8 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static shimmer placeholders
            <div key={i} className="h-10 animate-pulse rounded-xs bg-surface" />
          ))}
        </div>
      </PageFrame>
    );
  }
  if (error) {
    return (
      <PageFrame width="read">
        <p className="text-body-sm text-error">Couldn’t load your pulse: {error}</p>
      </PageFrame>
    );
  }

  const hasCode = recentCode.length > 0 || threads?.hasSessions === true;
  const hasChats = recent.some((r) => r.source !== "claude-code");

  return (
    <PageFrame width="read">
      <Header />
      {(hasCode || hasChats) && (
        <div className="mt-4">
          <SyncStatePanel freshnessTitle={freshnessTitle(freshness)} />
        </div>
      )}
      {hasCode && firstRun && <FirstRunCard history={firstRun} />}
      {hasCode ? (
        <div className="mt-6">
          <ThreadsPanel
            {...(threads ?? EMPTY_THREADS)}
            hasSessions
            sessionTitles={{ ...buildSessionTitles(recentCode), ...(threads?.sessionTitles ?? {}) }}
            costLine={<CostLine />}
            grouping={threadGrouping}
            day={threadDay}
          />
        </div>
      ) : (
        <SetupChecklist hasChats={hasChats} />
      )}
    </PageFrame>
  );
}
