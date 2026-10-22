// Goal 2026-07-26 step 9 "Slice two" — GET /api/agent-stats/issues
//
// Server-aggregating endpoint for /code/stats/issues (ADR 0032 §4 table:
// issue attribution, a tab on /code/stats). Same cookie-auth pattern as
// /api/agent-stats/route.ts (requireUserId, per-user scoping mandatory) —
// copied verbatim rather than shared, matching that file's own precedent of
// not factoring auth into a helper module.
//
// Unlike /api/agent-stats, this endpoint always covers the FULL session
// history (no range param): an issue's total cost/commits should not
// silently drop sessions just because they fall outside a 30-day window,
// and the ADR's table spec for this view doesn't call for a range picker.
//
// Reads code_sessions (same columns as /api/agent-stats), the user's
// code_session_issues rows (which issues each session worked on, written by
// memory extraction — migration 099), and ALL code_session_turns (commits,
// display only), each paginated (Supabase caps a response at 1000 rows), then
// hands them to the pure functions in lib/agent-stats/attribution.ts.
//
// UX W5: each row also carries `sessionRefs` — every session it references,
// titled (lib/code-sessions/session-titles.ts), from one batched lookup.
//
// Sub-agent sessions are priced on their own props.usage (never the parent's
// props.subAgents), so nothing is counted twice, but COUNTED as their parent's
// session (S06): subAgentParents folds each child into the parent it names.
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import type { AgentStatsSessionInput } from "@/lib/agent-stats/aggregate";
import {
  type AttributionTurnInput,
  actionTurnKeys,
  aggregateIssueAttribution,
  issueSessionIds,
  mrBranchesBySession,
  parseCommitEvents,
  type SessionIssueRow,
  type SubAgentLinkRow,
  subAgentParents,
  withIssueSessionRefs,
} from "@/lib/agent-stats/attribution";
import { withRoute } from "@/lib/api/route";
import {
  listAllSessionIssuesForAttribution,
  listAllTurnsForAttribution,
  listSessionsForIssueAttribution,
} from "@/lib/code-sessions/queries";
import { hostlessRefQualifier, qualifyBareRepoRef } from "@/lib/code-sessions/ref-canon";
import { getSessionTitles, lookupTitlesOnce } from "@/lib/code-sessions/session-titles";
import { glabHostsFrom, turnPropsEvidence } from "@/lib/format/forge-url";

type ProjectEmbed = { repo_identity: string | null };

/** Paginated fetch of EVERY turn belonging to the user — `.range()` loop
 * because a single Supabase response is capped at 1000 rows regardless of
 * `.limit()`, and 65 founder-1k sessions carry ~14K turns total.
 *
 * MINOR (fresh adversarial review, 2026-07-26): `sessionIds` is no longer
 * used as a query filter — it was `.in("session_id", sessionIds)` alongside
 * `.eq("user_id", userId)`, but `sessionIds` here is always the caller's
 * FULL set of the user's own session ids (fetched two lines up via that same
 * `.eq("user_id", userId)`), so the `.in()` added a large parameter list to
 * every request for zero additional narrowing — `user_id` alone already
 * scopes this to exactly the same rows. Kept as a parameter (documents the
 * caller's intent / a future caller could legitimately narrow to a subset)
 * but no longer threaded into the query itself. */
async function fetchAllTurns(
  supabase: SupabaseClient,
  userId: string,
  sessionIds: string[],
): Promise<AttributionTurnInput[]> {
  if (sessionIds.length === 0) return [];
  // Review S5: keyset (`id > last`), never offset — a re-import mid-read cannot shift a page.
  try {
    return await listAllTurnsForAttribution(supabase, userId);
  } catch (err) {
    throw new Error(`fetchAllTurns failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchAllSessionIssues(supabase: SupabaseClient, userId: string): Promise<SessionIssueRow[]> {
  // Review S5: keyset by id — a re-derive (delete + insert) between pages can neither drop a
  // session's rows nor read its old and new rows together.
  try {
    return await listAllSessionIssuesForAttribution(supabase, userId);
  } catch (err) {
    throw new Error(`fetchAllSessionIssues failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const GET = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ user, supabase }) => {
    const userId = user.id;
    // Paged like the turns below: one PostgREST response caps at 1000 rows, and
    // a user past 1000 sessions silently lost every later one (and its rows).
    type SessionRow = AgentStatsSessionInput &
      SubAgentLinkRow & { code_projects?: ProjectEmbed | ProjectEmbed[] | null };
    let sessions: SessionRow[];
    try {
      // Review S5: keyset on (started_at, id), then the rows with no started_at.
      sessions = await listSessionsForIssueAttribution<SessionRow>(supabase, userId);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
    // S06: a sub-agent child is counted as its parent's session, never separately.
    const parentOf = subAgentParents(sessions);

    // UX W6: a stored bare `repo#N` (a repo NAME, no owner) is read as the
    // session's own project repo only when the name equals that repo's name —
    // so `membral-personal#118` and `github.com/o/membral-personal#118` are one
    // item, one group. Any other bare name stays as written (its own group).
    const identityBySession = new Map<string, string>();
    for (const s of sessions) {
      const embed = Array.isArray(s.code_projects) ? s.code_projects[0] : s.code_projects;
      if (embed?.repo_identity) identityBySession.set(s.id, embed.repo_identity);
    }

    let turns: AttributionTurnInput[];
    let issueRows: SessionIssueRow[];
    try {
      [turns, issueRows] = await Promise.all([
        fetchAllTurns(
          supabase,
          userId,
          sessions.map((s) => s.id),
        ),
        fetchAllSessionIssues(supabase, userId),
      ]);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }

    const actionAwareSessions = new Set(
      sessions
        .filter((s) => {
          const v = (s.props as { actions_version?: unknown } | null | undefined)?.actions_version;
          return typeof v === "number" && v >= 1;
        })
        .map((s) => s.id),
    );
    // v3 item 6 (d): a stored host-less `owner/repo#N` takes its known host (the user's own
    // project on that repo, else github.com when the row's receipt shows a GitHub source).
    const withHost = hostlessRefQualifier(identityBySession.values());
    issueRows = issueRows.map((r) => {
      const ref = withHost(qualifyBareRepoRef(r.ref, identityBySession.get(r.session_id)), r.evidence_quote);
      return ref === r.ref ? r : { ...r, ref };
    });
    const commits = parseCommitEvents(turns, { actionAwareSessions });
    // v4 item 2: a commit lists under an item only when tied to it (its MR's branch, or its own subject).
    const aggregated = aggregateIssueAttribution(sessions, commits, issueRows, {
      parentOf,
      mrBranches: mrBranchesBySession(turns),
      projectOf: identityBySession,
      actionTurns: actionTurnKeys(turns),
    });

    // UX W5: a title for every session any row references — ONE lookup for the
    // whole table (never per row). A failed lookup leaves rows without titles
    // (the count still renders); it never fails the page.
    const titles = await lookupTitlesOnce([...aggregated.issues, aggregated.unattributed], issueSessionIds, (ids) =>
      getSessionTitles(supabase, userId, ids),
    ).catch(() => new Map());
    const { issues, unattributed, estimated } = withIssueSessionRefs(aggregated, titles);

    // Forge family per host, from data only (forge-url.ts): glab-grammar URLs in actions and
    // evidence quotes, and hosts a `glab` command acted on — so those refs link glab-style.
    const glab_hosts = [
      ...glabHostsFrom([
        ...turns.flatMap((t) =>
          turnPropsEvidence(t.props as Record<string, unknown> | null, identityBySession.get(t.session_id)),
        ),
        ...issueRows.map((r) => ({ text: r.evidence_quote })),
      ]),
    ];

    return NextResponse.json({
      issues,
      unattributed,
      sessions_total: sessions.length - parentOf.size,
      estimated,
      glab_hosts,
    });
  },
);
