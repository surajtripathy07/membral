// L2 (docs/design/current-truth-recall.md section 3, D-078): the one serve-time filter every reader shares.
//   1. currentOnly: hide a record only while the record that replaced it is live.
//   2. groupSameFact / collapseSameFact: paraphrase sets become one line with a session count, the survivor chosen by
//      REAL SESSION TIME (newest session wins), never by insert order (calibration/BACKFILL-CHECK.md finding 4).
//   3. asOfDay: the absolute day every served line carries ("as of 2026-10-04").
// Pure; no I/O. The L1 columns (`valid_to`, `superseded_by`, `supersede_kind`, migration 124) are optional on every
// row: a row without them (a schema before 124, or a record no link touches) is never hidden by them, so the filter
// is a no-op there (see currentOnly).
import { sameThing } from "./dedupe";

/** The fields grouping reads. `code_project_id` keeps a decision in one repo from absorbing another repo's. */
export interface SameFactRow {
  id: string;
  kind: string;
  text: string;
  ref: string | null;
  code_project_id: string;
  code_session_id: string;
  created_at: string;
  verified?: boolean;
  /** L1: set (to the surviving record's id) on a `duplicates` target; groups it with that record whatever the text says. */
  duplicate_of?: string | null;
}

/** `YYYY-MM-DD` of an ISO timestamp (UTC), or "" when it does not parse. */
export function asOfDay(iso: string | null | undefined): string {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

/**
 * Groups rows (given best-ranked first) that say the same thing: a row joins the first earlier group whose leader
 * passes sameThing with it AND shares kind and project. Group order follows each group's best-ranked member. Pure.
 */
export function groupSameFact<T extends SameFactRow>(
  rows: readonly T[],
  /** Extra same-fact test (the embedding rule), tried when the text rule says no. Called only for one project and kind. */
  similar?: (leader: T, r: T) => boolean,
): T[][] {
  // L1: a row linked `duplicates` to another row of this set joins that row's group (following the chain to its root),
  // in addition to the text/vector rules below. A link whose target is not in the set does nothing here.
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const rootOf = (r: T): T => {
    let cur = r;
    for (let hop = 0; hop < 5; hop++) {
      const next = cur.duplicate_of ? byId.get(cur.duplicate_of) : undefined;
      if (!next || next.id === r.id) break;
      cur = next;
    }
    return cur;
  };
  const absorbed: T[] = [];
  const groups: T[][] = [];
  for (const r of rows) {
    if (rootOf(r).id !== r.id) {
      absorbed.push(r);
      continue;
    }
    const g = groups.find(
      (x) =>
        x[0].code_project_id === r.code_project_id &&
        x[0].kind === r.kind &&
        // Complete linkage: a row joins only if it is the same fact as EVERY member, so "migration 118" and
        // "migration 119" can never both ride on a third row that matches each.
        x.every((m) => sameThing(m, r) || (similar?.(m, r) ?? false)),
    );
    if (g) g.push(r);
    else groups.push([r]);
  }
  for (const r of absorbed) {
    const root = rootOf(r);
    const g = groups.find((x) => x.some((m) => m.id === root.id));
    if (g) g.push(r);
    else groups.push([r]);
  }
  return groups;
}

/**
 * The survivor of one group: the member from the newest session (`sessionTime`, an epoch ms; a member with no known
 * session time falls back to its created_at), verified members first when any is verified; ties go to created_at,
 * then id. Never insert order alone. Pure.
 */
export function pickSurvivor<T extends SameFactRow>(group: readonly T[], sessionTime: (r: T) => number | undefined): T {
  const pool = group.some((r) => r.verified) ? group.filter((r) => r.verified) : group;
  const t = (r: T) => sessionTime(r) ?? (Date.parse(r.created_at) || 0);
  return pool.reduce((a, b) => {
    if (t(b) !== t(a)) return t(b) > t(a) ? b : a;
    const ca = Date.parse(a.created_at) || 0;
    const cb = Date.parse(b.created_at) || 0;
    if (cb !== ca) return cb > ca ? b : a;
    return b.id < a.id ? b : a;
  });
}

/**
 * Collapses same-fact rows: one survivor per group, in the order of the group's best-ranked member, with `seenIn`
 * (distinct sessions in the group) keyed by the survivor id and `collapsed` (survivor id -> the ids it absorbed).
 * `sessionTime` is the real time of the row's session. Pure.
 */
export function collapseSameFact<T extends SameFactRow>(
  rows: readonly T[],
  sessionTime: (r: T) => number | undefined,
): { rows: T[]; seenIn: Map<string, number>; collapsed: Map<string, string[]> } {
  const seenIn = new Map<string, number>();
  const collapsed = new Map<string, string[]>();
  const out = groupSameFact(rows).map((g) => {
    const s = pickSurvivor(g, sessionTime);
    if (g.length > 1) {
      seenIn.set(s.id, new Set(g.map((m) => m.code_session_id)).size);
      collapsed.set(
        s.id,
        g.filter((m) => m.id !== s.id).map((m) => m.id),
      );
    }
    return s;
  });
  return { rows: out, seenIn, collapsed };
}

/** What currentOnly reads from a row; every field optional so a row from before L1 passes through untouched. */
export interface ValidityRow {
  id: string;
  /** Set by a newer record that replaced this one (a live `supersedes` pointer, migration 084, read in the pool). */
  supersededBy?: { id: string; at: string } | null;
  /** L1 columns (migration 124); absent on a schema without them. */
  valid_to?: string | null;
  superseded_by?: string | null;
  supersede_kind?: string | null;
}

export interface CurrentOnlyOptions {
  /** `include_superseded`: serve replaced records too (each carries its replacement for rendering). */
  includeSuperseded?: boolean;
  /**
   * A date phrase's window end (ms): a replaced record is still served when its replacement came after this
   * moment, i.e. it was current then (L9 validity-at-time). Ignored when includeSuperseded.
   */
  asOfMs?: number;
  /** Is this replacement id live? Default: yes (a replacement that is not in the pool is assumed live). */
  isLive?: (id: string) => boolean;
}

/**
 * Hides a row while the row that replaced it is live. Two sources of "replaced": the pool's own `supersedes`
 * pointers (`supersededBy`, set by markSuperseded), and L1's `valid_to`/`superseded_by` columns when they exist.
 * With includeSuperseded nothing is hidden; with asOfMs a row stays if its replacement is newer than that moment.
 * Pure; the same array is returned when nothing changes.
 */
export function currentOnly<T extends ValidityRow>(rows: readonly T[], opts: CurrentOnlyOptions = {}): T[] {
  if (opts.includeSuperseded) return [...rows];
  const live = opts.isLive ?? (() => true);
  return rows.filter((r) => {
    const by = r.supersededBy ?? (r.valid_to && r.superseded_by ? { id: r.superseded_by, at: r.valid_to } : null);
    if (!by || !live(by.id)) return true;
    if (opts.asOfMs !== undefined && Date.parse(by.at) > opts.asOfMs) return true;
    return false;
  });
}

/**
 * Attaches `supersededBy` to every row some live row supersedes: `external` (a lookup outside the pool, id -> its
 * replacement) wins, then the pool's own `supersedes` pointers. Pure.
 */
export function markSuperseded<T extends { id: string; supersedes?: string | null; created_at: string }>(
  rows: readonly T[],
  external: ReadonlyMap<string, { id: string; at: string }> = new Map(),
): Array<T & { supersededBy: { id: string; at: string } | null }> {
  const by = new Map<string, { id: string; at: string }>();
  for (const r of rows) if (r.supersedes) by.set(r.supersedes, { id: r.id, at: r.created_at });
  return rows.map((r) => ({ ...r, supersededBy: external.get(r.id) ?? by.get(r.id) ?? null }));
}
