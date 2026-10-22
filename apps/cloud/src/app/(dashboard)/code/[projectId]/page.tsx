// /code/[projectId] — CodeProject detail (ADR 0021 Q6, P1d).
//
// W9 (2026-09-12 refocus goal, D9 — the biggest structural cut): the
// baseline critique scored this page 17/40 ("Poor") for rendering the same
// memory content twice (memory-section.tsx AND the now-deleted
// project-memory.tsx, both headed "MEMORY") and burying the cost table
// below ~80 cards. Reordered to answer three questions, above the fold, in
// order: WHAT IS THIS (header, now with cost in its stats strip) → WHAT DID
// IT COST (cost-section.tsx, moved directly under the header) → WHAT
// HAPPENED (the sessions timeline). WHAT TO REMEMBER (memory-section.tsx,
// capped at 5) and RAW ACTIVITY (project-facts.tsx, collapsed) follow.
// project-memory.tsx (the duplicate), the right rail's "People" card, and
// the "Related" cross-link pills are deleted, not just hidden.
//
// Data sources and RPC calls are unchanged from the prior version — this is
// an information-design pass, not a data-model change.
import { PageFrame } from "@/components/ui/page-frame";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isUuid } from "@/lib/device-auth";
import { type AgentStatsAggregate, type AgentStatsSessionInput, aggregateAgentStats } from "@/lib/agent-stats/aggregate";
import { getCodeProjectDetail, getCodeProjectFacts, listRecentUsageRows } from "@/lib/code-sessions/queries";
import { parseCodeProjectRollup, shapeProjectFacts } from "@/lib/code-sessions/view";
import { formatRelativeDate } from "@/lib/format/dates";
import { formatDuration } from "@/lib/format/durations";
import { fmtUsdEst, SPEND_TRANSCRIPT_TITLE } from "@/lib/format/usd";
import { parseStoredPatterns } from "@/lib/patterns/storage";
import { createClient } from "@/lib/supabase/server";
import { dayKeyInZone, getServerTimeZone } from "@/lib/util/timezone";
import { Section } from "@/components/ui/section";
import { ProjectCostSection } from "./cost-section";
import { MemorySection } from "./memory-section";
import { PatternCard } from "./pattern-card";
import { ProjectFacts } from "./project-facts";
import { ProjectSummary } from "./project-summary";
import { SessionsTimeline } from "./sessions-timeline";

// W11/D12 — the $/model section below is a fixed 30-day window (goal's own
// spec: "shows the per-project breakdown by model ... for the last 30
// days"), UTC-bucketed same as aggregateAgentStats' other UTC-default
// callers — no tz param on this page, unlike /pulse's tz-aware range picker.
const COST_SECTION_WINDOW_DAYS = 30;

// Generous headroom over the "designed for hundreds" comment this page
// inherited (one real founder-1k project sat at 56 sessions) — one query,
// same shape as before, just a bigger page size. If a project ever exceeds
// this, the timeline says so (see SessionsTimeline's "Showing the N most
// recent of..." line) and the header's turns/active-time stats become a
// floor over the loaded batch rather than the true total — both stated
// honestly rather than silently wrong.
const SESSIONS_FETCH_CAP = 200;

function SideCard({ title, warn, children }: { title: string; warn?: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-card border p-4 ${warn ? "border-warn bg-surface" : "border-line bg-surface"}`}>
      <h2 className={`mb-2 section-label ${warn ? "text-warn" : ""}`}>{title}</h2>
      {children}
    </div>
  );
}

/** Presentational-only remote shortening (not a lib helper — a one-off
 *  string transform for the header, unlike shortenSessionPath which needs
 *  its own tested rules for the Activity details/timeline file lists). */
function shortRemote(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
}

export default async function CodeProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  // A non-uuid segment (e.g. /code/issues) is a 404, never a Postgres uuid-cast 500.
  if (!isUuid(projectId)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const detail = await getCodeProjectDetail(supabase, user.id, projectId, 1, SESSIONS_FETCH_CAP);
  if (!detail) notFound();

  const { project, sessions, sessionsTotal } = detail;
  const rollup = parseCodeProjectRollup(project.props);
  const name = project.display_name || project.repo_identity;
  // Goal 2026-09-26 P9: repeated tool sequences the nightly step stored
  // (≤ 3) with their drafted skills — a tolerant read, never throws.
  const patterns = parseStoredPatterns(project.props);

  // GitHub issue #87: the P2a code graph's first UI read. Never let a facts
  // read break the page — a query failure degrades to "no facts section"
  // exactly like a project with zero code_kg rows (pre-Stage-1-build).
  const projectFactsResult = await getCodeProjectFacts(supabase, user.id, projectId).catch(() => ({
    rows: [],
    trueCounts: {},
  }));
  const projectFacts = shapeProjectFacts(projectFactsResult.rows, projectFactsResult.trueCounts);

  // W11/D12 — $/model section: this project's own code_sessions over the
  // last 30 days, priced+grouped by aggregateAgentStats (same pricing path
  // as /pulse and /api/agent-stats — ADR 0032 §1.3 finding 4: never the
  // code-KG mirror's cached est_cost_usd). Never let this break the page —
  // degrades to "no cost section" the same way the facts read above does.
  const costSince = new Date(Date.now() - COST_SECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // D-061 (#166): one timezone rule, the browser's own zone, read from the
  // membral_tz cookie (see lib/util/timezone.ts) — falls back to UTC.
  const tz = getServerTimeZone(await cookies());
  let costAggregate: AgentStatsAggregate | null = null;
  try {
    const { data, error } = await listRecentUsageRows<AgentStatsSessionInput>(supabase, user.id, {
      since: costSince,
      projectId,
      select: "id, started_at, turn_count, user_turn_count, props",
      paginate: true,
    });
    if (error) throw error;
    const rows = data ?? [];
    const endDate = dayKeyInZone(new Date(), tz);
    const startDate = dayKeyInZone(costSince, tz);
    costAggregate = aggregateAgentStats(rows, { tz, startDate, endDate });
  } catch {
    costAggregate = null;
  }

  // Header stats strip: sessions + last active are TRUE totals (straight off
  // the project row); turns + total active time are summed over the loaded
  // session batch — exact whenever sessionsTotal <= SESSIONS_FETCH_CAP (the
  // common case), else a floor (the hover title says so).
  const loadedAllSessions = sessions.length >= sessionsTotal;
  const totalTurns = sessions.reduce((sum, s) => sum + s.turn_count, 0);
  const totalActiveSeconds = sessions.reduce((sum, s) => sum + (s.duration_seconds ?? 0), 0);
  const statsTitle = loadedAllSessions ? undefined : `across the ${sessions.length} most recently loaded sessions`;

  const hasRightColumn = !!rollup.key_decisions || !!rollup.open_threads;

  // Captured once, server-side, and passed to the client SessionsTimeline as
  // a fixed prop — never `new Date()` inside a "use client" component (it
  // renders once during SSR and again on hydration; each pass calling
  // `new Date()` independently produced a live React hydration mismatch,
  // both for the locale-formatted absolute-date title — see
  // formatAbsoluteUtc's doc — and for the relative "Nd ago" bucket, which
  // can flip between the two passes if they land on opposite sides of a day
  // boundary).
  const now = new Date().toISOString();

  return (
    <PageFrame width="data" className="space-y-6">
      <nav className="flex items-center gap-2 text-body-sm text-muted">
        <Link href="/code" className="hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas">
          Sessions
        </Link>
        <span>/</span>
        <span className="truncate text-ink-2">{name}</span>
      </nav>

      {/* 1. WHAT IS THIS AND WHERE DOES IT STAND */}
      <header className="rounded-card border border-line bg-surface p-6">
        <div className="min-w-0">
          <h1 className="truncate text-h1 font-semibold text-ink">{name}</h1>
          {project.remote_url ? (
            <a
              href={project.remote_url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block truncate font-mono text-micro text-muted hover:text-accent"
            >
              {shortRemote(project.remote_url)}
            </a>
          ) : (
            <p className="mt-1 truncate font-mono text-micro text-muted">{project.repo_identity}</p>
          )}
        </div>

        {rollup.status === "ok" && rollup.summary ? (
          <ProjectSummary summary={rollup.summary} whatBuilt={rollup.what_built} />
        ) : rollup.status === "failed" ? (
          <p className="mt-3 text-label italic text-muted">
            Summary could not be generated — {project.session_count} session{project.session_count === 1 ? "" : "s"} imported
          </p>
        ) : (
          <p className="mt-3 text-label italic text-muted">
            Summary not generated yet — {project.session_count} session{project.session_count === 1 ? "" : "s"} imported
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-label tabular-nums text-muted">
          <span>
            <span className="text-ink-2">{project.session_count}</span> session{project.session_count === 1 ? "" : "s"}
          </span>
          <span title={statsTitle}>
            <span className="text-ink-2">{formatDuration(totalActiveSeconds)}</span> active
          </span>
          <span title={statsTitle}>
            {/* item 7 (round-3 review): this page is an async Server Component
             * (see device-keys-list.tsx's formatDate comment for the same
             * hydration-mismatch mechanism) — a bare toLocaleString() resolves
             * the runtime's default locale, which differs between Node (SSR)
             * and the browser (hydration). Pinned to "en-US" for a
             * deterministic render on both passes. */}
            <span className="text-ink-2">{totalTurns.toLocaleString("en-US")}</span> turns
          </span>
          {costAggregate && costAggregate.totals.cost_usd !== null && costAggregate.totals.cost_usd > 0 && (
            // Cost-consistency finding #3 (docs/cost-consistency.md): labeled
            // "this project" so it's never read as competing with the
            // account-wide total on Sessions/Usage. fmtUsdEst (§3.8, W6: est. on every derived total).
            <span className="text-accent" title={SPEND_TRANSCRIPT_TITLE}>{fmtUsdEst(costAggregate.totals.cost_usd)} · this project · 30d</span>
          )}
          <span>last active {formatRelativeDate(project.last_active_at)}</span>
        </div>

        {/* 2. WHAT DID IT COST — a collapsed "by model" drill-down next to
            the total above (was its own always-expanded card here). */}
        <div className="mt-3">
          <ProjectCostSection aggregate={costAggregate} />
        </div>
      </header>

      {/* 2b. WHAT YOU KEEP DOING — "you ran X → Y → Z in N sessions — draft a
          skill?" (P9). Renders nothing until the nightly step found a pattern. */}
      <PatternCard patterns={patterns} now={now} />

      <div className={hasRightColumn ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]" : undefined}>
        {/* 3. WHAT HAPPENED */}
        <div className="min-w-0 space-y-3">
          <h2 className="section-label">Sessions ({sessionsTotal})</h2>
          <SessionsTimeline sessions={sessions} sessionsTotal={sessionsTotal} now={now} />
        </div>

        {/* Right rail: only Key decisions / Open threads now (People and the
            duplicated Memory card are gone). */}
        {hasRightColumn && (
          <div className="space-y-4">
            {rollup.key_decisions && (
              <SideCard title="Key decisions">
                <p className="text-body-sm leading-relaxed text-ink-2">{rollup.key_decisions}</p>
              </SideCard>
            )}
            {rollup.open_threads && (
              <SideCard title="Open threads" warn>
                <p className="text-body-sm leading-relaxed text-ink-2">{rollup.open_threads}</p>
              </SideCard>
            )}
          </div>
        )}
      </div>

      {/* 4. WHAT TO REMEMBER */}
      <Section label="Memory">
        <MemorySection projectName={name} projectId={projectId} />
      </Section>

      {/* 5. RAW ACTIVITY — collapsed by default, last on the page. */}
      <ProjectFacts facts={projectFacts} recurringFilesTools={rollup.recurring_files_tools} />
    </PageFrame>
  );
}
