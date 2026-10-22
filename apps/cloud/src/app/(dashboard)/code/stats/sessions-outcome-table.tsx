// #93 (usage visibility that reconciles) — per-session outcome link on
// /code/stats: each recent session's branch, the issues memory extraction
// recorded it working on (code_session_issues), and its commits, or "no
// outcome recorded" when there is neither.
// Not a new attribution mechanism — page.tsx hands this the same
// SessionOutcome shape groupCommitEventsBySession/parseCommitEvents already
// produce for /code/stats/issues. Plain server-renderable component (no
// "use client"), same precedent as session-facts.tsx / issues-content.tsx.
//
// W9 (2026-09-12 refocus goal, D9): a no-outcome row renders the literal
// "no outcome recorded" text (D6 requires it visible, not sr-only-only) at
// the quietest token that still carries information — text-micro/text-muted,
// not text-faint (tokens.md's contrast rule: faint is decorative-only).
//
// Goal 2026-09-26 W2 (P0b, P0d): an issue/MR chip is a link to its forge page
// when refToUrl can name one (else it stays a span), and rows are grouped
// under one header row per project (first-appearance order, so the newest
// project's group comes first) instead of repeating the project cell.
import Link from "next/link";
import type { SessionOutcome } from "@/lib/agent-stats/attribution";
import type { RecentSessionForStatsRow } from "@/lib/code-sessions/queries";
import { Disclosure } from "@/components/ui/disclosure";
import { formatDateOrUnknown } from "@/lib/format/dates";
import { forgeUrl } from "@/lib/format/forge-url";
import { fmtUsd } from "@/lib/format/usd";

export interface SessionOutcomeRowData {
  session: RecentSessionForStatsRow;
  outcome: SessionOutcome;
  /** UX audit B3 ("add a cost column") — page.tsx costs this session from
   * the SAME rows/props its window-total aggregate already paid for.
   * Optional: undefined/null render as "—", never "$0.00". */
  costUsd?: number | null;
  /** UX W5: the session's display title (session-titles.ts); null falls back to the date alone. */
  title?: string | null;
}


function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

const CHIP_CLASS = "rounded-xs text-accent underline-offset-2 hover:underline";

/** The chip text: a glab-family merge request reads `!N` (the stored ref says `#N` for both kinds). */
export function refChipLabel(refText: string, kind: "issue" | "merge_request"): string {
  if (kind !== "merge_request") return refText;
  const host = refText.split("/")[0] ?? "";
  return /(^|\.)github\./i.test(host) ? refText : refText.replace(/#(\d+)$/, "!$1");
}

/** An issue/MR chip: an external link when the ref names a forge page, a plain span otherwise. */
export function IssueRefChip({ refText, kind }: { refText: string; kind: "issue" | "merge_request" }) {
  const href = forgeUrl(refText);
  const label = refChipLabel(refText, kind);
  if (!href) return <span className={CHIP_CLASS}>{label}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`${kind === "merge_request" ? "merge request" : "issue"} ${label}`}
      className={`${CHIP_CLASS} hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface`}
    >
      {label}
    </a>
  );
}

function projectLabel(session: RecentSessionForStatsRow): string {
  return session.project_display_name || session.project_repo_identity || "Unknown project";
}

/** Rows grouped by project in first-appearance order (rows arrive newest first). */
export function groupRowsByProject(rows: SessionOutcomeRowData[]): { projectId: string; rows: SessionOutcomeRowData[] }[] {
  const groups = new Map<string, SessionOutcomeRowData[]>();
  for (const row of rows) {
    const list = groups.get(row.session.code_project_id) ?? [];
    list.push(row);
    groups.set(row.session.code_project_id, list);
  }
  return [...groups].map(([projectId, rows]) => ({ projectId, rows }));
}

function OutcomeCell({ outcome }: { outcome: SessionOutcome }) {
  if (outcome.issues.length === 0 && outcome.commits.length === 0) {
    return <span className="text-micro text-muted">no outcome recorded</span>;
  }
  const recorded = outcome.commits.filter((c) => c.sha || c.subject.trim());
  const untitled = outcome.commits.length - recorded.length;
  return (
    <div className="space-y-1">
      {outcome.issues.length > 0 && (
        <div className="flex flex-wrap gap-1.5 font-mono text-micro">
          {outcome.issues.map((i) => (
            <IssueRefChip key={`${i.kind}:${i.ref}`} refText={i.ref} kind={i.kind} />
          ))}
        </div>
      )}
      {outcome.commits.length > 0 && (
        <ul className="space-y-0.5">
          {/* v4 item 2: a commit with neither sha nor subject is never a placeholder row — it is counted. */}
          {recorded.slice(0, 3).map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: sha may repeat (null) within a row; (sha,i) is stable for this static list
            <li key={`${c.sha ?? "nosha"}-${i}`} className="flex items-baseline gap-2 whitespace-normal text-micro">
              <span className="shrink-0 font-mono text-muted tabular-nums">{shortSha(c.sha)}</span>
              {c.subject && <span className="break-words text-ink-2">{c.subject}</span>}
            </li>
          ))}
          {recorded.length > 3 && <li className="text-micro text-muted">+{recorded.length - 3} more commit(s)</li>}
          {untitled > 0 && (
            <li className="text-micro text-muted">
              +{untitled} commit{untitled === 1 ? "" : "s"} without a recorded subject
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** null/undefined sorts after every priced row (never guessed as 0). */
function byCostDesc(a: SessionOutcomeRowData, b: SessionOutcomeRowData): number {
  const av = a.costUsd ?? Number.NEGATIVE_INFINITY;
  const bv = b.costUsd ?? Number.NEGATIVE_INFINITY;
  return bv - av;
}

function hasOutcome(outcome: SessionOutcome): boolean {
  return outcome.issues.length > 0 || outcome.commits.length > 0;
}

function sumCost(rows: SessionOutcomeRowData[]): number | null {
  const priced = rows.map((r) => r.costUsd).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  return priced.length > 0 ? priced.reduce((a, b) => a + b, 0) : null;
}

// Real table at `md:` and above; below it, ONE compact block per row (same
// fix as issues-content.tsx's IssueRow — a per-field stacked layout blew
// past the phone height target on a large account).
const CELL = "hidden md:table-cell md:py-3";

function SessionRow({ session, outcome, costUsd, title, label, focusRing }: { session: RecentSessionForStatsRow; outcome: SessionOutcome; costUsd?: number | null; title?: string | null; label: string; focusRing: string }) {
  const date = formatDateOrUnknown(session.started_at);
  const sessionLink = (
    <span className="block min-w-0 max-w-[20rem]">
      <Link
        href={`/code/session/${session.id}`}
        title={title ?? date}
        aria-label={`${title ? `${title}, ` : ""}${date} session on ${label}${session.git_branch ? `, branch ${session.git_branch}` : ""}`}
        className={`block truncate text-accent hover:underline ${focusRing}`}
      >
        {title || date}
      </Link>
      {title && <span className="block text-micro text-muted">{date}</span>}
    </span>
  );
  return (
    <tr className="block border-line-soft border-t py-2 align-top md:table-row md:border-t md:py-0">
      <td className={`${CELL} pr-4`}>{sessionLink}</td>
      <td className={`${CELL} pr-4 font-mono text-micro text-ink-2`}>{session.git_branch || "—"}</td>
      <td className={`${CELL} pr-4 tabular-nums text-ink`}>{fmtUsd(costUsd ?? null)}</td>
      <td className={CELL}>
        <OutcomeCell outcome={outcome} />
      </td>

      {/* Phone-only compact block, same row data in 3 lines. */}
      <td className="block px-4 py-1.5 md:hidden">
        <div>{sessionLink}</div>
        <div className="mt-0.5 font-mono text-micro text-muted">
          {session.git_branch || "—"} · {fmtUsd(costUsd ?? null)}
        </div>
        <div className="mt-1">
          <OutcomeCell outcome={outcome} />
        </div>
      </td>
    </tr>
  );
}

/** UX audit B3 ("collapse runs of 'no outcome recorded' into one row per
 * project"): a lone no-outcome session still renders inline (nothing to
 * collapse); two or more fold into one Disclosure summing their cost. */
function NoOutcomeRows({ rows, label, focusRing }: { rows: SessionOutcomeRowData[]; label: string; focusRing: string }) {
  if (rows.length <= 1) {
    return (
      <>
        {rows.map((row) => (
          <SessionRow key={row.session.id} session={row.session} outcome={row.outcome} costUsd={row.costUsd} title={row.title} label={label} focusRing={focusRing} />
        ))}
      </>
    );
  }
  const total = sumCost(rows);
  return (
    <tr className="block border-line-soft border-t py-2 align-top md:table-row md:border-t md:py-0">
      <td colSpan={4} className="block px-4 py-1.5 md:table-cell md:py-3">
        <Disclosure summary={`${rows.length} sessions · no outcome recorded · ${fmtUsd(total)}`}>
          <table className="mt-2 w-full text-body-sm">
            <tbody>
              {rows.map((row) => (
                <SessionRow key={row.session.id} session={row.session} outcome={row.outcome} costUsd={row.costUsd} title={row.title} label={label} focusRing={focusRing} />
              ))}
            </tbody>
          </table>
        </Disclosure>
      </td>
    </tr>
  );
}

export function SessionsOutcomeTable({ rows }: { rows: SessionOutcomeRowData[] }) {
  if (rows.length === 0) {
    return <div className="rounded-card border border-line bg-surface p-6 text-body text-muted">No sessions in this window yet.</div>;
  }

  const groups = groupRowsByProject(rows);
  const focusRing =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

  return (
    <div>
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="block w-full text-body-sm md:table">
          <thead className="hidden md:table-header-group">
            <tr className="text-left text-muted">
              <th scope="col" className="py-2 pr-4 pl-4 font-normal">Session</th>
              <th scope="col" className="py-2 pr-4 font-normal">Branch</th>
              <th scope="col" className="py-2 pr-4 font-normal">Cost</th>
              <th scope="col" className="py-2 pr-4 font-normal">Outcome</th>
            </tr>
          </thead>
          {groups.map((group) => {
            const label = projectLabel(group.rows[0].session);
            const sorted = [...group.rows].sort(byCostDesc);
            const withOutcome = sorted.filter((r) => hasOutcome(r.outcome));
            const withoutOutcome = sorted.filter((r) => !hasOutcome(r.outcome));
            return (
              <tbody key={group.projectId} className="block md:table-row-group">
                <tr className="block border-line border-t bg-raised md:table-row">
                  <th scope="rowgroup" colSpan={4} className="block py-2 pr-4 pl-4 text-left font-medium text-ink md:table-cell">
                    <Link href={`/code/${group.projectId}`} className={`hover:text-accent ${focusRing}`}>
                      {label}
                    </Link>
                    <span className="ml-2 font-normal text-micro text-muted tabular-nums">
                      {group.rows.length} session{group.rows.length === 1 ? "" : "s"}
                    </span>
                  </th>
                </tr>
                {withOutcome.map((row) => (
                  <SessionRow key={row.session.id} session={row.session} outcome={row.outcome} costUsd={row.costUsd} title={row.title} label={label} focusRing={focusRing} />
                ))}
                <NoOutcomeRows rows={withoutOutcome} label={label} focusRing={focusRing} />
              </tbody>
            );
          })}
        </table>
      </div>
      <p className="mt-2 text-micro text-muted">
        Issues come from reading each session during memory extraction; commits are those made during the session.
      </p>
    </div>
  );
}
