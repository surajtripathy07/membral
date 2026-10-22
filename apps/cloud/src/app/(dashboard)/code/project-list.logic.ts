// Pure (non-React) logic moved verbatim out of project-list.tsx (step 3D-5,
// docs/archive/goals/2026-09-28_g3-edges_goal.md, D7) — sorting, grouping and the project-name/stat
// helpers the component's JSX calls. Zero behaviour change: locked by
// __tests__/project-list.render.test.tsx (recorded before this move) and
// __tests__/project-list.logic.test.ts (a table per function, for future
// moves).
import type { CodeProjectListRow } from "@/lib/code-sessions/queries";

export type SortKey = "recent" | "sessions" | "name";

export const SORT_LABELS: Record<SortKey, string> = { recent: "Recent", sessions: "Most sessions", name: "Name" };

export interface ProjectCardStats {
  turns: number;
  files: number;
  costUsd: number | null;
}

export const EMPTY_CARD_STATS: ProjectCardStats = { turns: 0, files: 0, costUsd: null };

export function projectName(p: CodeProjectListRow): string {
  return p.display_name || p.repo_identity;
}

/** Splits "owner/repo" so the card can render each on its own line — the
 * repo half (the distinguishing half of a name like
 * `surajtripathy07/membral-personal`) never gets truncated away. Falls back
 * to a single line when there's no "/" to split on. */
export function splitOwnerRepo(name: string): { owner: string | null; repo: string } {
  const i = name.indexOf("/");
  if (i === -1) return { owner: null, repo: name };
  return { owner: name.slice(0, i), repo: name.slice(i + 1) };
}

export function sortProjects(projects: CodeProjectListRow[], sort: SortKey): CodeProjectListRow[] {
  const sorted = [...projects];
  if (sort === "sessions") sorted.sort((a, b) => b.session_count - a.session_count);
  else if (sort === "name") sorted.sort((a, b) => projectName(a).localeCompare(projectName(b)));
  else sorted.sort((a, b) => (b.last_active_at ?? "").localeCompare(a.last_active_at ?? ""));
  return sorted;
}

// migration 060 (W7/D8): one row per canonical project label — a project
// with no alias (the common case) is its own singleton group and renders
// exactly like before; a clubbed group (e.g. `dev/membral` /
// `surajtripathy07/membral` / `surajtripathy07/membral-personal`, all
// project_aliases-resolved to one canonical) aggregates session_count and
// last_active_at across its members and shows them as chips.
export interface ProjectGroup {
  label: string;
  members: CodeProjectListRow[];
  sessionCount: number;
  lastActiveAt: string | null;
  /** The member the group's primary link goes to — most sessions, ties broken by most recent activity. Per-project page keeps working (this is always a real project id). */
  primary: CodeProjectListRow;
}

export function groupProjects(projects: CodeProjectListRow[], canonicalLabels: Record<string, string>): ProjectGroup[] {
  const byLabel = new Map<string, CodeProjectListRow[]>();
  for (const p of projects) {
    const label = canonicalLabels[p.id] ?? projectName(p);
    const bucket = byLabel.get(label) ?? [];
    bucket.push(p);
    byLabel.set(label, bucket);
  }
  return [...byLabel.entries()].map(([label, members]) => {
    const sessionCount = members.reduce((sum, m) => sum + m.session_count, 0);
    const lastActiveAt = members.reduce<string | null>(
      (latest, m) => (!latest || (m.last_active_at ?? "") > latest ? (m.last_active_at ?? latest) : latest),
      null,
    );
    const primary = [...members].sort(
      (a, b) => b.session_count - a.session_count || (b.last_active_at ?? "").localeCompare(a.last_active_at ?? ""),
    )[0];
    return { label, members, sessionCount, lastActiveAt, primary };
  });
}

export function sortGroups(groups: ProjectGroup[], sort: SortKey): ProjectGroup[] {
  const sorted = [...groups];
  if (sort === "sessions") sorted.sort((a, b) => b.sessionCount - a.sessionCount);
  else if (sort === "name") sorted.sort((a, b) => a.label.localeCompare(b.label));
  else sorted.sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));
  return sorted;
}

/** True only when a real 30-day usage query ran and found nothing (never for a failed query — `stats === undefined` — which stays visible as "usage unavailable" rather than silently landing in the inactive group with the genuinely-idle ones). */
export function isInactive(stats: ProjectCardStats | undefined): boolean {
  return !!stats && stats.turns === 0 && stats.files === 0;
}
