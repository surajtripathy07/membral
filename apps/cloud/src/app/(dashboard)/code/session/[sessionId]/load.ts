// /code/session/[sessionId] data loading (G3 step 3D-4): the page's load
// section moved verbatim into a named loader — the awaits AND the synchronous
// computations between them (edges, groupSessionTurns, sessionPageTitle, the
// forge evidence, the sub-agent matching), with the same `.catch` handlers.
// #173: after the session-detail gate (a missing session is still notFound()
// before any other read starts), the five independent reads run together —
// facts, usage, issue rows, children, parent — and only the tool-use index
// still waits, on the children. `sessionId`/`loadAll`/`aroundTurn` come
// from the page, which resolves `params`/`searchParams` before calling this.
import { notFound, redirect } from "next/navigation";
import { aggregateAgentStats } from "@/lib/agent-stats/aggregate";
import {
  type ChildSessionRow,
  getCodeSessionDetail,
  getCodeSessionFacts,
  getCodeSessionUsageRow,
  getParentSessionForChild,
  getSessionToolUseIndex,
  listChildSessions,
  listSessionIssuesForSessionPage,
} from "@/lib/code-sessions/queries";
import {
  buildSubAgentTree,
  type ChildSessionForMatch,
  groupSessionTurns,
  matchChildSessionsToTurns,
  sessionPageTitle,
  shapeSessionFacts,
  type ToolUseTurnRef,
} from "@/lib/code-sessions/view";
import { type ForgeEvidence, glabHostsFrom } from "@/lib/format/forge-url";
import { createClient } from "@/lib/supabase/server";
import { computeThreads, type ThreadIssueRow } from "@/lib/threads/open-threads";
import { windowEdgeLinks } from "./window-edges";

export type CodeSessionPageData = Awaited<ReturnType<typeof loadCodeSessionPage>>;

/** Everything the session page renders: auth, the detail gate, then the independent reads concurrently. */
export async function loadCodeSessionPage(sessionId: string, loadAll: boolean, aroundTurn: number | null) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const detail = await getCodeSessionDetail(supabase, user.id, sessionId, loadAll, aroundTurn);
  if (!detail) notFound();

  const { session, turns, turnsTotal, truncated, subAgentSpawnIndex, window: turnWin } = detail;
  const edges = turnWin ? windowEdgeLinks(sessionId, turnWin) : null;
  const isSubAgentSession = session.parent_source_session_id !== null;
  const groups = groupSessionTurns(turns);
  const projectName = session.project_display_name || session.project_repo_identity || "Unknown project";
  const pageTitle = sessionPageTitle({
    title: session.title,
    summary: session.summary,
    gitBranch: session.git_branch,
    turnCount: session.turn_count,
    startedAt: session.started_at,
  });

  // #173: every read below needs only the gate's `session`, so they start
  // together (they used to run one after another). Each keeps the handler it
  // had: a failure degrades that one section and never breaks the page.
  const childrenRead = listChildSessions(supabase, user.id, session.source, session.source_session_id).catch(
    (): ChildSessionRow[] => [],
  );
  const [factsRow, usageRow, issuesResult, childRows, allToolUses, parentSession] = await Promise.all([
    // GitHub issue #87: the P2a code graph's first UI read for a session —
    // never let this break the page (a query failure degrades to no facts
    // strip, same as a session predating the Stage-1 build).
    getCodeSessionFacts(supabase, user.id, sessionId).catch(() => null),
    // #93: see the per-model breakdown comment below; a failed read is "no row".
    getCodeSessionUsageRow(supabase, user.id, sessionId).catch(() => null),
    // B6 session refs (below): a thrown read is handled like a returned error.
    Promise.resolve(listSessionIssuesForSessionPage(supabase, user.id, sessionId)).catch((error: unknown) => ({
      data: null,
      error,
    })),
    // Migration 089 — this session's own sub-agent children (never break the
    // page: a child-lookup failure just means no inline links / section).
    childrenRead,
    // D2: with the capped window, a spawn turn can sit in the unloaded turns —
    // index every tool_use turn's id (idx + one jsonb field) so matching is
    // session-wide; only needed when the page is truncated and has children,
    // so this one still waits on the children read.
    childrenRead.then((rows): Promise<ToolUseTurnRef[] | undefined> | undefined =>
      truncated && rows.length > 0
        ? getSessionToolUseIndex(supabase, user.id, sessionId).catch(() => undefined)
        : undefined,
    ),
    // This session is itself a sub-agent's transcript — resolve its parent for
    // the breadcrumb (never break the page: a lookup failure just means no
    // breadcrumb).
    session.parent_source_session_id
      ? getParentSessionForChild(supabase, user.id, session.source, session.parent_source_session_id).catch(() => null)
      : null,
  ]);

  const sessionFacts = shapeSessionFacts(factsRow);

  // #93 (usage visibility that reconciles) — per-model breakdown for THIS
  // session, main transcript + sub-agents. Reuses aggregateAgentStats with a
  // single-row array (the SAME pricing/grouping path as /code/stats and
  // /pulse) rather than a second implementation — see
  // lib/code-sessions/queries.ts's getCodeSessionUsageRow doc comment for
  // why this is a separate query from getCodeSessionDetail above (`props`
  // isn't selected there). Never let this break the page.
  let sessionAggregate: ReturnType<typeof aggregateAgentStats> | null = null;
  try {
    if (usageRow) {
      const day = (usageRow.started_at ?? session.started_at ?? new Date().toISOString()).slice(0, 10);
      sessionAggregate = aggregateAgentStats([usageRow], { tz: "UTC", startDate: day, endDate: day });
    }
  } catch {
    sessionAggregate = null;
  }
  const sessionModelBreakdown = sessionAggregate?.by_model ?? [];
  // W9/D6: the header's whole-session total — the number the page's four
  // per-model rows never added up before. B6: this is the header's ONLY
  // cost figure now (see session-facts.tsx's header comment); the
  // main-vs-sub-agent split renders as a labelled breakdown beside it, both
  // live-computed from the SAME aggregateAgentStats call — never the
  // code_kg_nodes mirror's cached props.est_cost_usd (cost-consistency.md #5,
  // ADR 0032 §1.3).
  const sessionTotalCostUsd = sessionAggregate?.totals.cost_usd ?? 0;
  const sessionSubAgentCostUsd = sessionAggregate?.totals.subagent_cost_usd ?? 0;

  // UX audit B6 "ADD a one-line SessionRefsLine": this session's own
  // `code_session_issues` rows (the same table Today's open-threads engine
  // reads, migration 103/107 columns), fed through the exported
  // `computeThreads` — the ladder/closure math lives there once; this page
  // only supplies the one session's rows instead of duplicating that logic.
  // Never let a read/compute failure break the page.
  let sessionRefs: ReturnType<typeof computeThreads>["recent"] = [];
  // Forge family per host from this page's own data (forge-url.ts): glab-grammar
  // URLs and `glab` commands in the loaded turns, plus the issue rows' quotes below.
  const forgeEvidence: ForgeEvidence[] = [];
  for (const t of turns) {
    for (const a of t.actions ?? []) {
      forgeEvidence.push({ text: a.url, ref: a.ref, digest: t.inputDigest, identity: session.project_repo_identity });
    }
  }
  let glabHosts: string[] = [...glabHostsFrom(forgeEvidence)];
  try {
    const { data, error } = issuesResult;
    if (error) throw error;
    const issues = (data ?? []) as ThreadIssueRow[];
    glabHosts = [...glabHostsFrom([...forgeEvidence, ...issues.map((r) => ({ text: r.evidence_quote }))])];
    if (issues.length > 0) {
      const result = computeThreads({
        issues,
        glabHosts,
        sessions: [
          {
            id: sessionId,
            code_project_id: session.code_project_id,
            started_at: session.started_at,
            git_branch: session.git_branch,
            turn_count: session.turn_count,
            parent_source_session_id: session.parent_source_session_id,
            source: session.source,
            source_session_id: session.source_session_id,
            cost_usd: sessionTotalCostUsd > 0 ? sessionTotalCostUsd : null,
          },
        ],
      });
      sessionRefs = result.recent;
    }
  } catch {
    sessionRefs = [];
  }

  const childrenForMatch: ChildSessionForMatch[] = childRows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    parentAgentId: row.parent_agent_id,
    agentType: row.agent_type,
    description: row.description,
    toolUseId: row.tool_use_id,
    turnCount: row.turn_count,
  }));
  const {
    byTurnIdx: subAgentsByTurnIdx,
    hidden: hiddenSubAgents,
    unmatched: unmatchedSubAgents,
  } = matchChildSessionsToTurns(turns, childrenForMatch, {
    allToolUses,
    toolUseIdByAgentId: subAgentSpawnIndex,
  });
  const subAgentTree = buildSubAgentTree(unmatchedSubAgents);

  return {
    session,
    turns,
    turnsTotal,
    truncated,
    edges,
    isSubAgentSession,
    groups,
    projectName,
    pageTitle,
    sessionFacts,
    sessionModelBreakdown,
    sessionTotalCostUsd,
    sessionSubAgentCostUsd,
    sessionRefs,
    glabHosts,
    subAgentsByTurnIdx,
    hiddenSubAgents,
    subAgentTree,
    parentSession,
  };
}
