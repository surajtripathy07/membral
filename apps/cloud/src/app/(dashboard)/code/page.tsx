// /code — CodeProjects list (ADR 0021 Q6, P1d).
//
// Server component, same shape as /conversations: an auth check, an RLS-
// scoped Supabase read via lib/code-sessions/queries.ts, then a plain render
// — no client fetch, no bespoke "second-brain" design tokens.
//
// W9 (2026-09-12 refocus goal, D9, priority issue P1): the baseline critique
// called this "the entry point to the whole primary lane [that] shows no
// cost, no model, no dollar figure anywhere" — PRODUCT.md's differentiator
// is cost attached to outcomes, and this page showed none. Now leads with a
// 30-day summary strip (reusing aggregateAgentStats exactly as /code/stats
// does) and every card states its own 30-day turns/files/cost instead of an
// LLM-written paragraph. The count gate that redirected a zero-session
// account to /pulse is gone — the empty state below does the onboarding a
// hidden nav entry used to.
import { PageFrame } from "@/components/ui/page-frame";
import Link from "next/link";
import { cookies } from "next/headers";
import { type AgentStatsSessionInput, aggregateAgentStats } from "@/lib/agent-stats/aggregate";
import { getCodeProjectsPage, listRecentUsageRows } from "@/lib/code-sessions/queries";
import { fmtUsdEst, SPEND_TRANSCRIPT_TITLE } from "@/lib/format/usd";
import { canonicalize, resolveProjectCanonical } from "@/lib/memory/project-aliases";
import { createClient } from "@/lib/supabase/server";
import { dayKeyInZone, getServerTimeZone } from "@/lib/util/timezone";
import { ProjectList } from "./project-list";
import type { ProjectCardStats } from "./project-list.logic";
import { getAppUrl } from "@/lib/env";
import { installCommand } from "@/lib/install-command";

const PAGE_SIZE = 20;
const CARD_STATS_WINDOW_DAYS = 30;

export default async function CodePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // #173: the projects page, the alias seed+resolve chain and the 30-day
  // usage read are independent, so they start together (they ran one after
  // another). Each keeps its old failure rule: the projects read still
  // throws, the other two still degrade (see their comments below).
  const since = new Date(Date.now() - CARD_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const aliasRead = (async () => {
    await supabase.rpc("project_alias_seed", { p_user: user.id });
    return resolveProjectCanonical(supabase, user.id);
  })();
  const usageRead = listRecentUsageRows<
    AgentStatsSessionInput & { code_project_id: string; files_touched: string[] | null }
  >(supabase, user.id, {
    since,
    select: "id, code_project_id, started_at, turn_count, user_turn_count, files_touched, props",
    paginate: true,
  });
  const [projectsSettled, aliasSettled, usageSettled] = await Promise.allSettled([
    getCodeProjectsPage(supabase, user.id, page, PAGE_SIZE),
    aliasRead,
    usageRead,
  ]);
  if (projectsSettled.status === "rejected") throw projectsSettled.reason;
  const { projects, total, totalPages } = projectsSettled.value;
  // Captured once, server-side, and passed to the client ProjectList as a
  // fixed prop — never `new Date()` inside a "use client" component, which
  // renders once during SSR and again on hydration and can compute a
  // different relative-date bucket each time (hydration mismatch).
  const now = new Date().toISOString();

  // migration 060/063 (W7/D8): project_aliases clubs raw labels like
  // `dev/membral` / `surajtripathy07/membral` / `surajtripathy07/membral-personal`
  // into one canonical — resolved here, server-side, and passed down as a
  // plain id -> label map so ProjectList (client) can group the already-
  // fetched page without its own round trip. A third real seed call site
  // (migration 063 finding #2, alongside POST /api/code-sessions and GET
  // /api/memory/projects/merge) — cheap/idempotent, session-authenticated,
  // so no guard relaxation needed here. Never let a failure of either call
  // break this page (migration 063 finding #10): canonicalLabels just falls
  // back to {} (every project its own group, pre-060 rendering).
  let canonicalLabels: Record<string, string> = {};
  try {
    if (aliasSettled.status === "rejected") throw aliasSettled.reason;
    const aliasMap = aliasSettled.value;
    for (const p of projects) {
      canonicalLabels[p.id] = canonicalize(p.display_name || p.repo_identity, aliasMap);
    }
  } catch {
    canonicalLabels = {};
  }

  // W9/D9 — the header summary strip's 30-day total, account-wide (same
  // aggregateAgentStats pricing/grouping path as /code/stats and the
  // project detail page's cost section — never a second implementation of
  // "what did this cost"). Never let this break the page.
  // D-061 (#166): one timezone rule, the browser's own zone, read from the
  // membral_tz cookie a client mount in the dashboard layout keeps in sync
  // (see lib/util/timezone.ts) — falls back to UTC for a first-ever load.
  const tz = getServerTimeZone(await cookies());
  let totalCostUsd: number | null = null;
  const cardStats: Record<string, ProjectCardStats> = {};
  try {
    if (usageSettled.status === "rejected") throw usageSettled.reason;
    const { data, error } = usageSettled.value;
    if (error) throw error;
    const rows = data ?? [];
    const startDate = dayKeyInZone(since, tz);
    const endDate = dayKeyInZone(new Date(), tz);
    totalCostUsd = aggregateAgentStats(rows, { tz, startDate, endDate }).totals.cost_usd;

    // Per-project card line: <N> turns · <M> files · $<cost> (30d) — scoped
    // to this page's own projects only (cheap to slice from the same
    // account-wide batch already fetched above).
    const byProject = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = byProject.get(row.code_project_id) ?? [];
      bucket.push(row);
      byProject.set(row.code_project_id, bucket);
    }
    for (const p of projects) {
      const projectRows = byProject.get(p.id) ?? [];
      const turns = projectRows.reduce((sum, r) => sum + (r.turn_count ?? 0), 0);
      const files = new Set(projectRows.flatMap((r) => r.files_touched ?? [])).size;
      const costUsd =
        projectRows.length > 0 ? aggregateAgentStats(projectRows, { tz, startDate, endDate }).totals.cost_usd : null;
      cardStats[p.id] = { turns, files, costUsd };
    }
  } catch {
    totalCostUsd = null;
  }

  return (
    <PageFrame width="data" className="space-y-6">
      <div>
        <h1 className="text-h1 font-semibold text-ink">Sessions</h1>
        <p className="mt-1 text-body text-muted">Every session from every harness, grouped by project.</p>
        <p className="mt-3 text-body-sm tabular-nums text-ink-2">
          {total} project{total === 1 ? "" : "s"}
          {" · "}
          <span className="text-accent" title={SPEND_TRANSCRIPT_TITLE}>{fmtUsdEst(totalCostUsd)}</span> in the last {CARD_STATS_WINDOW_DAYS} days
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="mx-auto max-w-md rounded-card border border-line border-dashed p-6 text-center">
          <p className="text-h3 font-medium text-ink">No sessions yet</p>
          <p className="mt-2 text-body-sm text-muted">
            Membral captures a coding session when it ends. Set up a harness and the next one lands here.
          </p>
          <p className="mt-3 rounded-sm bg-sunken px-3 py-2 font-mono text-label text-ink-2">
            {installCommand(getAppUrl())}
          </p>
          <p className="mt-4 text-label text-muted">
            Working in ChatGPT or Claude.ai instead?{" "}
            <Link href="/import" className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas">
              Import a chat export →
            </Link>
          </p>
        </div>
      ) : (
        <ProjectList projects={projects} now={now} canonicalLabels={canonicalLabels} cardStats={cardStats} />
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-line pt-4">
          {page > 1 ? (
            <Link
              href={`/code?page=${page - 1}`}
              className="rounded-sm border border-line-strong px-3 py-1.5 text-body-sm text-ink-2 transition-colors hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-label text-muted">
            Page {page} of {totalPages} · {total} project{total === 1 ? "" : "s"}
          </span>
          {page < totalPages ? (
            <Link
              href={`/code?page=${page + 1}`}
              className="rounded-sm border border-line-strong px-3 py-1.5 text-body-sm text-ink-2 transition-colors hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </PageFrame>
  );
}
