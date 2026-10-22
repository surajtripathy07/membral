// Goal 2026-07-26 step 9 slice two — pure render half of the Issues tab
// (fetch/state lives in issues-panel.tsx, same page.tsx ÷ *-content.tsx
// split as pulse's agent-work-content.tsx). Table: issue/MR ref, the role
// and observed verbs the sessions reached on it (goal 2026-09-26 W4: derived
// from tool calls, never from the model), every session that touched it,
// sessions that only discussed or mentioned it, tokens, $ (an estimate by
// turn share, labelled "est." — B11), and the commits tied to that item
// (v4: on its MR's branch, or naming it in their subject — short shas + subjects). Respects `sensitive`: renders commit
// SUBJECTS ONLY — never diffs, file paths, or anything beyond what the
// subject line itself carries (attribution.ts's parser never extracts those
// fields at all).
//
// UX audit B1 (docs §2 "/code/stats/issues"): the ref column drops its host
// prefix and groups under a repo sub-header (§4 B1's "removes the two-line
// wrap on every row"); the commits column — 80% of the old page height —
// shows 2 inline then a Disclosure (attribution v3, maintainer: cost no
// observed issue claims is not shown as an item at all — no "Unattributed"
// line; the API keeps the field); "referenced" rows with no sessions and no cost sit
// behind one "mentions without work" Disclosure. Money via fmtUsd/fmtUsdEst
// only (maintainer note); a ref links only through forgeUrl on the
// host-qualified ref (maintainer note) — GitHub, or a host the user's data
// shows is glab-family (`glab_hosts`); any other host renders plain text,
// same posture forge-url.ts itself documents.
import type { IssueAttribution } from "@/lib/agent-stats/attribution";
import { SessionTitleList } from "@/components/session-title-list";
import { Card } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { formatDateAt } from "@/lib/format/dates";
import { forgeUrl } from "@/lib/format/forge-url";
import { fmtUsdEst } from "@/lib/format/usd";
import {
  compactRefLabel,
  formatTokens,
  groupByRepo,
  isMentionWithoutWork,
  ROLE_LABEL,
  shortSha,
  untitledLine,
} from "./issues-content.logic";


export interface IssuesApiPayload {
  issues: IssueAttribution[];
  unattributed: IssueAttribution;
  sessions_total: number;
  /** B11: every per-ref figure is an estimate (cost x turn share). */
  estimated?: true;
  /** Hosts the user's data shows are glab-family (forge-url.ts `glabHostsFrom`) — their refs link glab-style. */
  glab_hosts?: string[];
}

export interface IssuesContentProps {
  loading: boolean;
  error: string | null;
  data: IssuesApiPayload | null;
}

/** `role · review_verb · build_verb`, e.g. "worked on · reviewed · committed" — verbs as the profile names them, underscores spaced. */
function RoleCell({ row }: { row: IssueAttribution }) {
  if (!row.role) return <span className="text-muted">—</span>;
  const verbs = [row.reviewVerb, row.buildVerb].filter((v): v is string => !!v).map((v) => v.replace(/_/g, " "));
  return (
    <span className="text-ink-2">
      <span data-role={row.role}>{ROLE_LABEL[row.role]}</span>
      {verbs.map((v) => (
        <span key={v} className="text-muted">
          {" · "}
          {v}
        </span>
      ))}
      {row.inferredRef && (
        <span className="text-label text-muted" data-testid="inferred-ref" title="No command named this ref; you named it in your prompt before the commit (D-053)">
          {" · linked from your prompt"}
        </span>
      )}
    </span>
  );
}

function CommitRow({ c }: { c: IssueAttribution["commits"][number] }) {
  return (
    <li className="flex items-baseline gap-2 font-mono text-label">
      <span className="text-accent tabular-nums">{shortSha(c.sha)}</span>
      {c.subject && <span className="truncate text-ink-2">{c.subject}</span>}
      <span className="shrink-0 text-muted">{formatDateAt(c.at)}</span>
    </li>
  );
}

/** UX audit B1 (a long commit list was 80% of the old page height): the first 2 commits show inline, the rest sit behind one
 * Disclosure — every commit stays reachable, none dropped silently. */
function CommitList({ commits, untitled }: { commits: IssueAttribution["commits"]; untitled?: number }) {
  const untitledText = untitledLine(untitled);
  if (commits.length === 0 && !untitledText) return <span className="text-muted">—</span>;
  const shown = commits.slice(0, 2);
  const rest = commits.slice(2);
  return (
    <div>
      {untitledText && commits.length === 0 && <p className="font-mono text-label text-muted">{untitledText}</p>}
      <ul className="space-y-1">
        {shown.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sha may repeat (null) within a row; (sha,i) is stable for this static list
          <CommitRow key={`${c.sha ?? "nosha"}-${i}`} c={c} />
        ))}
      </ul>
      {rest.length > 0 && (
        <Disclosure summary={`+${rest.length} commit${rest.length === 1 ? "" : "s"}`} className="mt-1">
          <ul className="space-y-1">
            {rest.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: sha may repeat (null) within a row; (sha,i) is stable for this static list
              <CommitRow key={`${c.sha ?? "nosha"}-${i}`} c={c} />
            ))}
          </ul>
        </Disclosure>
      )}
      {untitledText && commits.length > 0 && <p className="mt-1 font-mono text-label text-muted">{untitledText}</p>}
    </div>
  );
}

// Goal 2026-09-26 W2 (P0b, P0d): the ref is a link to its forge page only
// via forgeUrl on the host-qualified ref (maintainer note) — a ref with no
// resolvable host, or a host forgeUrl doesn't know, renders plain text
// rather than a wrong or broken link.
function IssueLabel({
  issue,
  kind,
  label,
  glabHosts,
}: {
  issue: string | null;
  kind: IssueAttribution["kind"];
  label: string;
  glabHosts: readonly string[];
}) {
  const href = issue ? forgeUrl(issue, { kind: kind === "merge_request" ? "merge_request" : "issue", glabHosts }) : null;
  if (!href) return <span>{label}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      {label}
    </a>
  );
}

// Responsive layout (primitive doc §3.7, "never scroll a table sideways
// inside a card"): the real 7-column table renders at `md:` and above; below
// it, ONE compact 3-line block per row replaces 7 stacked fields (an early
// version stacked every <td> as its own line — a founder-sized issue list
// hit 8,392px on phone against a 3,400px target, so this folds sessions,
// mentions, tokens and cost onto a single muted line instead).
const CELL = "hidden py-2 pr-4 md:table-cell";
const ISSUE_COL_CLASS = "min-w-[18rem]";

/** UX W5: the row's sessions by title (first one, then "+N more"); the bare count only when no title reached the page. */
function SessionsCell({ row }: { row: IssueAttribution }) {
  const refs = row.sessionRefs ?? [];
  if (refs.length === 0) {
    const n = Math.max(row.sessions, row.sessionIds?.length ?? 0);
    return <span className="text-muted tabular-nums">{n > 0 ? `${n} session${n === 1 ? "" : "s"}` : "—"}</span>;
  }
  return (
    <SessionTitleList
      items={refs.map((r) => ({
        // The link opens the session whose turn shows the action — a sub-agent child when the work ran there.
        id: r.target_session_id ?? r.id,
        title: r.title,
        turnIdx: r.turn_idx,
        hint: r.started_at ? new Date(r.started_at).toLocaleString() : r.title,
      }))}
    />
  );
}

function IssueRow({ row, label, glabHosts }: { row: IssueAttribution; label: string; glabHosts: readonly string[] }) {
  return (
    <tr className="block border-line border-t py-2 align-top md:table-row md:border-t md:py-0">
      <td className={`hidden py-2 pr-4 pl-4 font-mono text-ink break-words md:table-cell ${ISSUE_COL_CLASS}`}>
        <IssueLabel issue={row.issue} kind={row.kind} label={label} glabHosts={glabHosts} />
        {row.kind === "merge_request" && <span className="ml-2 text-label text-muted">MR</span>}
      </td>
      <td className={CELL}>
        <RoleCell row={row} />
      </td>
      <td className={`${CELL} max-w-[16rem] text-ink-2`}>
        <SessionsCell row={row} />
      </td>
      <td className={`${CELL} text-ink-2 tabular-nums`}>{row.mentions}</td>
      <td className={`${CELL} text-ink-2 tabular-nums`}>{formatTokens(row.tokens)}</td>
      <td className={`${CELL} text-ink tabular-nums`}>{fmtUsdEst(row.costUsd)}</td>
      <td className="hidden py-2 md:table-cell">
        <CommitList commits={row.commits} untitled={row.untitledCommits} />
      </td>

      {/* Phone-only compact block (audit §2 B1: "ref / role · $ · sessions"). */}
      <td className="block px-4 py-0 md:hidden">
        <div className="flex flex-wrap items-baseline gap-1.5 font-mono text-ink">
          <IssueLabel issue={row.issue} kind={row.kind} label={label} glabHosts={glabHosts} />
          {row.kind === "merge_request" && <span className="text-label text-muted">MR</span>}
        </div>
        <div className="mt-0.5 text-micro text-muted">
          <RoleCell row={row} /> · {fmtUsdEst(row.costUsd)}
        </div>
        <div className="mt-0.5 min-w-0">
          <SessionsCell row={row} />
        </div>
        {row.commits.length + (row.untitledCommits ?? 0) > 0 && (
          <Disclosure
            summary={`${row.commits.length + (row.untitledCommits ?? 0)} commit${row.commits.length + (row.untitledCommits ?? 0) === 1 ? "" : "s"}`}
            className="mt-1"
          >
            <CommitList commits={row.commits} untitled={row.untitledCommits} />
          </Disclosure>
        )}
      </td>
    </tr>
  );
}

export function IssuesContent({ loading, error, data }: IssuesContentProps) {
  if (loading && !data) {
    return (
      <Card padding={6}>
        <div className="h-6 w-48 animate-pulse rounded bg-raised" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card padding={6} className="text-sm text-muted">
        Issue attribution unavailable — try again shortly.
      </Card>
    );
  }

  if (!data || data.issues.length === 0) {
    return (
      <Card padding={6} className="text-sm text-muted">
        {data && data.sessions_total > 0 ? "No issue or MR was worked on in your sessions yet." : "No coding sessions yet."}
      </Card>
    );
  }

  const shown = data.issues.filter((row) => !isMentionWithoutWork(row));
  const hiddenMentions = data.issues.filter(isMentionWithoutWork);
  const groups = groupByRepo(shown);
  const glabHosts = data.glab_hosts ?? [];

  return (
    <div>
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="block w-full text-body-sm md:table">
          <thead className="hidden md:table-header-group">
            <tr className="text-left text-muted">
              <th className={`py-2 pr-4 pl-4 font-normal ${ISSUE_COL_CLASS}`}>Issue</th>
              <th className="py-2 pr-4 font-normal">Role</th>
              <th className="py-2 pr-4 font-normal">Sessions</th>
              <th className="py-2 pr-4 font-normal">Mentions</th>
              <th className="py-2 pr-4 font-normal">Tokens</th>
              <th className="py-2 pr-4 font-normal">Cost (est.)</th>
              <th className="py-2 font-normal">Commits</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.key} className="block md:table-row-group">
              <tr className="block border-line border-t bg-raised md:table-row">
                <th scope="rowgroup" colSpan={7} className="block py-2 pr-4 pl-4 text-left font-medium text-ink md:table-cell">
                  {group.repo}
                </th>
              </tr>
              {group.rows.map((row) => (
                <IssueRow
                  key={`${row.kind}:${row.issue}`}
                  row={row}
                  label={row.issue ? compactRefLabel(row.issue, row.kind, glabHosts) : ""}
                  glabHosts={glabHosts}
                />
              ))}
            </tbody>
          ))}
        </table>
      </div>

      {hiddenMentions.length > 0 && (
        <Disclosure summary={`Show ${hiddenMentions.length} mention${hiddenMentions.length === 1 ? "" : "s"} without work`} className="mt-3 px-1">
          <ul className="space-y-1 text-body-sm">
            {hiddenMentions.map((row) => (
              <li key={`${row.kind}:${row.issue}`} className="flex items-center gap-2">
                <IssueLabel issue={row.issue} kind={row.kind} label={row.issue ? compactRefLabel(row.issue, row.kind, glabHosts) : ""} glabHosts={glabHosts} />
                <span className="text-muted">
                  {row.mentions} mention{row.mentions === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      <p className="mt-3 px-1 text-label text-muted" data-testid="issues-footnote">
        Cost is shown only where a session's work on an issue was observed.
      </p>
    </div>
  );
}
