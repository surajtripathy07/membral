// /code/session/[sessionId] — session detail (ADR 0021 Q6, P1d).
//
// THE USER SPINE AS THE NARRATIVE (ADR non-negotiable #5): user prose turns
// render prominent and in order; everything else (assistant prose/thinking,
// tool_use, tool_result) collapses beneath the most recent user turn in a
// <details> — visible on demand, never the default view. groupSessionTurns
// (lib/code-sessions/view.ts) does the grouping; this file only renders it.
//
// W9 (2026-09-12 refocus goal, D9): the page that scored highest in the
// baseline critique — changed the least. Title fallback moved to
// sessionPageTitle (never an absolute path in an <h1>); the four per-model
// costs now sum to one total in the header. UX W5: the whole page sits in
// PageFrame's read width (max-w-3xl) like every other reading page, so the
// spine and the header share one left edge.
import { PageFrame } from "@/components/ui/page-frame";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/device-auth";
import { ModelBreakdownTable } from "@/lib/agent-stats/model-breakdown-table";
import { Disclosure } from "@/components/ui/disclosure";
import { parseTurnParam, type CodeSessionRow } from "@/lib/code-sessions/queries";
import {
  type ChildSessionForMatch,
  parentBreadcrumbLabel,
  type SpineGroup,
  turnCountsLabel,
} from "@/lib/code-sessions/view";
import { formatDuration } from "@/lib/format/durations";
import { fmtUsd } from "@/lib/format/usd";
import { loadCodeSessionPage } from "./load";
import { PromptText } from "./prompt-text";
import { SessionFacts } from "./session-facts";
import { SessionRefsLine } from "./session-refs-line";
import { SubAgentsDisclosure } from "./sub-agent-sections";
import { ActivityLine } from "./turn-activity";
import { TurnAnchorBootstrap, TurnAnchorScroll } from "./turn-anchor-scroll";
import { EDGE_LINK } from "./window-edges";

function SpineGroupView({
  group,
  index,
  subAgentsByTurnIdx,
  isSubAgentSession,
  projectIdentity,
  glabHosts,
}: {
  group: SpineGroup;
  index: number;
  subAgentsByTurnIdx: Map<number, ChildSessionForMatch>;
  isSubAgentSession: boolean;
  projectIdentity: string | null;
  glabHosts: readonly string[];
}) {
  return (
    <div
      id={group.anchor ? `turn-${group.anchor.idx}` : undefined}
      className="relative scroll-mt-24 pl-6"
    >
      <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-accent" />
      {index > 0 && <span className="absolute left-[3px] top-[-8px] h-3 w-px bg-line" />}
      {group.anchor ? (
        <PromptText text={group.anchor.text ?? ""} fromParentAgent={isSubAgentSession} />
      ) : (
        <div className="rounded-card border border-line-soft bg-raised p-4">
          <p className="text-body-sm font-medium text-ink-2">No prompt recorded</p>
          <p className="mt-1 text-micro text-muted">
            This session was started by a hook or a sub-agent, so there is no opening message. Its{" "}
            {group.activity.length} step{group.activity.length === 1 ? "" : "s"} are below.
          </p>
        </div>
      )}
      {group.activity.length > 0 && (
        <details className="mt-1.5 group">
          <summary className="cursor-pointer select-none text-label text-muted hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
            {group.anchor ? `${group.activity.length} step${group.activity.length === 1 ? "" : "s"}` : "Show steps"}
          </summary>
          <div className="mt-1.5 space-y-0.5 border-l border-line pl-3">
            {group.activity.map((turn) => (
              <ActivityLine
                key={turn.idx}
                turn={turn}
                subAgent={subAgentsByTurnIdx.get(turn.idx)}
                projectIdentity={projectIdentity}
                glabHosts={glabHosts}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function sessionHeaderMeta(session: CodeSessionRow) {
  const started = session.started_at ? new Date(session.started_at).toLocaleString() : "unknown start";
  return started;
}

export default async function CodeSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ all?: string; turn?: string }>;
}) {
  const { sessionId } = await params;
  // A non-uuid segment (e.g. /code/issues) is a 404, never a Postgres uuid-cast 500.
  if (!isUuid(sessionId)) notFound();
  const sp = await searchParams;
  const loadAll = sp.all === "1";
  // v4 item 6: a deep link (`?turn=N#turn-N`) loads the activity window around that turn.
  const aroundTurn = loadAll ? null : parseTurnParam(sp.turn);

  const {
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
  } = await loadCodeSessionPage(sessionId, loadAll, aroundTurn);

  return (
    <PageFrame width="read" className="space-y-6">
      <nav className="flex items-center gap-2 text-body-sm text-muted">
        <Link href="/code" className="hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas">
          Sessions
        </Link>
        <span>/</span>
        <Link
          href={`/code/${session.code_project_id}`}
          className="truncate hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          {projectName}
        </Link>
      </nav>

      {parentSession && (
        <nav className="text-body-sm text-muted">
          <Link
            href={`/code/session/${parentSession.id}`}
            className="hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            ← Sub-agent of{" "}
            {parentBreadcrumbLabel({
              title: parentSession.title,
              summary: parentSession.summary,
              gitBranch: parentSession.git_branch,
              turnCount: parentSession.turn_count,
              startedAt: parentSession.started_at,
              firstPrompt: parentSession.first_prompt,
            })}
          </Link>
        </nav>
      )}

      <header className="rounded-card border border-line bg-surface p-6">
        {/* B6 done-criteria budget: a single line (same truncate pattern the
            project page's own h1 already uses), not a 2-line wrap. */}
        <h1 className="line-clamp-2 break-words text-h1 font-semibold text-ink" title={pageTitle}>
          {pageTitle}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-label tabular-nums text-muted">
          {session.subAgent?.agentType && (
            <span className="text-accent">
              {session.subAgent.agentType}
            </span>
          )}
          {session.subAgent?.model && (
            <span className="text-ink-2">{session.subAgent.model}</span>
          )}
          {session.git_branch && (
            <span className="font-mono text-ink-2">{session.git_branch}</span>
          )}
          <span>{sessionHeaderMeta(session)}</span>
          <span>{formatDuration(session.duration_seconds)}</span>
          <span>
            {turnCountsLabel({
              turnCount: session.turn_count,
              userTurnCount: session.user_turn_count,
              toolCount: session.tool_count,
              isSubAgent: isSubAgentSession,
            })}
          </span>
          {/* B6 done-criteria: exactly one "$" figure in the header. Live
              whole-session total (main + sub-agents), never the
              code_kg_nodes mirror. The sub-agent slice renders as a
              labelled breakdown right beside it, not a second bare cost. */}
          {sessionTotalCostUsd > 0 && (
            <span className="text-ink">
              {fmtUsd(sessionTotalCostUsd)}
              {sessionSubAgentCostUsd > 0 && (
                <span className="ml-1.5 text-muted">incl. sub-agents {fmtUsd(sessionSubAgentCostUsd)}</span>
              )}
            </span>
          )}
        </div>
        {session.subAgent?.description && <p className="mt-2 text-body-sm text-ink-2">{session.subAgent.description}</p>}
        <SessionRefsLine refs={sessionRefs} />
        <SessionFacts facts={sessionFacts} />
        {sessionModelBreakdown.length > 0 && (
          <div className="mt-2">
            <Disclosure summary="By model" count={sessionModelBreakdown.length}>
              <p className="text-micro text-muted">this session · main transcript + sub-agents</p>
              <div className="mt-2">
                <ModelBreakdownTable byModel={sessionModelBreakdown} />
              </div>
            </Disclosure>
          </div>
        )}
        {truncated && (
          // UX audit B6: truncation is not a warning — a neutral muted line
          // (was a `warn`-tinted box below the header); folded into the
          // header itself so it shares its padding instead of its own
          // bordered box and gap (B6's header-height budget).
          <p className="mt-2 flex items-center justify-between text-label text-muted">
            <span>
              Showing {turns.length} of {turnsTotal} turns.
            </span>
            {!loadAll && (
              <Link
                href={`/code/session/${sessionId}?all=1${aroundTurn !== null ? `#turn-${aroundTurn}` : ""}`}
                className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                show all →
              </Link>
            )}
          </p>
        )}
      </header>

      <div className="max-w-3xl">
        <section className="space-y-5 rounded-card border border-line bg-surface p-6">
          {edges?.earlier && (
            <Link href={edges.earlier} className={EDGE_LINK} data-testid="turns-earlier">
              ↑ Show earlier turns
            </Link>
          )}
          {groups.length === 0 ? (
            <p className="text-body text-muted">No turns recorded for this session.</p>
          ) : (
            groups.map((g, i) => (
              <SpineGroupView
                key={g.anchor?.idx ?? `pre-${i}`}
                group={g}
                index={i}
                subAgentsByTurnIdx={subAgentsByTurnIdx}
                isSubAgentSession={isSubAgentSession}
                projectIdentity={session.project_repo_identity}
                glabHosts={glabHosts}
              />
            ))
          )}
          {edges?.later && (
            <Link href={edges.later} className={EDGE_LINK} data-testid="turns-later">
              ↓ Show later turns
            </Link>
          )}
        </section>
      </div>

      <SubAgentsDisclosure hidden={hiddenSubAgents} tree={subAgentTree} sessionId={sessionId} />
      <TurnAnchorBootstrap turn={aroundTurn} />
      <TurnAnchorScroll turn={aroundTurn} />
    </PageFrame>
  );
}
