// Pure (non-React) logic moved verbatim out of issues-content.tsx (step
// 3D-5, docs/archive/goals/2026-09-28_g3-edges_goal.md, D7) — ref parsing/grouping/labelling and
// small formatters the component's JSX calls. Zero behaviour change: locked
// by __tests__/issues-content.render.test.tsx (recorded before this move)
// and __tests__/issues-content.logic.test.ts (a table per function, for
// future moves). `repoGroupKey`/`groupByRepo` stay re-exported from
// issues-content.tsx so existing imports (issues-content.test.tsx) keep working.

import type { IssueAttribution } from "@/lib/agent-stats/attribution";
import type { ItemKind } from "@/lib/code-sessions/ref-canon";
import { canonicalItemRef } from "@/lib/code-sessions/ref-canon";
import { refLabel } from "@/lib/format/ref-label";

/** A real (positive, finite) estimate — the gate for the mentions-without-work fold and the "est." tag. */
export function hasCost(n: number | null): n is number {
  return n !== null && Number.isFinite(n) && n > 0;
}

export function formatTokens(t: IssueAttribution["tokens"]): string {
  const total = t.input + t.output + t.cache_read + t.cache_creation;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
  return total.toLocaleString("en-US");
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

export const ROLE_LABEL: Record<NonNullable<IssueAttribution["role"]>, string> = {
  worked_on: "worked on",
  discussed: "discussed",
  referenced: "referenced",
};

/** v4 item 2: the tied commits no sha or subject was recorded for, as one line — never a placeholder row each. */
export function untitledLine(n: number | undefined): string | null {
  if (!n || n <= 0) return null;
  return `+${n} commit${n === 1 ? "" : "s"} without a recorded subject`;
}

// UX audit B1 (docs §2, "drop the github.com/ prefix and show owner/repo#n,
// grouped under a repo sub-header"): reuses canonicalItemRef (ref-canon.ts)
// for the ref SHAPE, same convention forge-url.ts documents for itself — no
// new ref regex here either.
export function segmentsToParts(prefix: string, number: number): { host: string | null; path: string; number: number } {
  const segments = prefix.split("/").filter(Boolean);
  const hasHost = segments.length >= 3 && segments[0].includes(".");
  return {
    host: hasHost ? segments[0] : null,
    path: (hasHost ? segments.slice(1) : segments).join("/") || prefix,
    number,
  };
}

export function parsedPrefix(
  issue: string,
  kind: IssueAttribution["kind"],
): { host: string | null; path: string; number: number } | null {
  const canonical = canonicalItemRef(issue, null, (kind ?? "issue") as ItemKind);
  if (canonical) {
    const at = canonical.ref.lastIndexOf("#");
    return segmentsToParts(canonical.ref.slice(0, at), canonical.number);
  }
  // Fallback, DISPLAY grouping only: canonicalItemRef's grammar wants a
  // multi-segment path, so a bare "repo#N" (no owner, this product's own
  // dogfood corpus has plenty) comes back null — split on the trailing
  // marker ourselves rather than let every such ref become its own
  // one-row "group." Ref identity/merging elsewhere still goes through
  // canonicalItemRef untouched; this never feeds back into it.
  const m = issue.match(/^(.*)[#!](\d+)$/);
  if (!m) return null;
  return segmentsToParts(m[1], Number(m[2]));
}

/** The sub-header rows group under: the repo path alone, host dropped. */
export function repoGroupLabel(issue: string, kind: IssueAttribution["kind"]): string {
  const parsed = parsedPrefix(issue, kind);
  return parsed ? parsed.path || issue : issue;
}

/**
 * UX W6: the group KEY is host + owner/repo, lower-cased — the label alone
 * (host dropped) is only what the sub-header prints. A host-less
 * `owner/repo` folds into the one host-qualified group with that same
 * owner/repo; a bare repo name (no owner — the route already qualified the
 * ones that name the session's own project) stays its own group, labelled as
 * written.
 */
export function repoGroupKey(
  issue: string,
  kind: IssueAttribution["kind"],
): { key: string; host: string | null; path: string } {
  const parsed = parsedPrefix(issue, kind);
  const path = (parsed ? parsed.path || issue : issue).toLowerCase();
  const host = parsed?.host ? parsed.host.toLowerCase() : null;
  return { key: host ? `${host}/${path}` : path, host, path };
}

/**
 * The compact per-row label: the shared D-065 rule (`refLabel`, also Today's chips) — `#N` on
 * github.com, `#N` / `!N` (issue / MR) on a glab-family host in `glabHosts`, `owner/repo#N` on any
 * other host. `glabHosts` is the same set the row's link uses, so label and link agree.
 */
export function compactRefLabel(
  issue: string,
  kind: IssueAttribution["kind"],
  glabHosts: readonly string[] = [],
): string {
  return refLabel(issue, { kind, glabHosts });
}

export function groupByRepo(rows: IssueAttribution[]): { key: string; repo: string; rows: IssueAttribution[] }[] {
  const keyed = rows.map((row) => ({ row, k: row.issue ? repoGroupKey(row.issue, row.kind) : null }));
  // owner/repo path -> the host-qualified keys seen for it.
  const hostKeys = new Map<string, Set<string>>();
  for (const { k } of keyed) {
    if (!k?.host) continue;
    const set = hostKeys.get(k.path) ?? new Set<string>();
    set.add(k.key);
    hostKeys.set(k.path, set);
  }
  const groups = new Map<string, { key: string; repo: string; rows: IssueAttribution[] }>();
  for (const { row, k } of keyed) {
    let key = "\u0000other";
    let label = "Other";
    if (k && row.issue) {
      const only = !k.host ? hostKeys.get(k.path) : undefined;
      key = only && only.size === 1 ? [...only][0] : k.key;
      label = repoGroupLabel(row.issue, row.kind);
    }
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { key, repo: label, rows: [row] });
  }
  return [...groups.values()];
}

/** UX audit B1 ("'referenced' rows with 0 sessions and no cost collapse
 * behind 'Show N mentions without work'"): a mention that never became work
 * still counts toward T1's "what did the harness touch," but earns no row
 * of its own on the first screen. */
export function isMentionWithoutWork(row: IssueAttribution): boolean {
  return row.role === "referenced" && row.sessions === 0 && !hasCost(row.costUsd);
}
