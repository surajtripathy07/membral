// L1: turns accepted links into a plan: the memory_links rows, the projection on the older records, the 10% / 400
// hiding caps, and the undo SQL. Pure; the writes live in io.ts / scripts/memory/reconcile.ts.
import { type AcceptedLink, HIDING_RELATIONS, type HidingRelation, type OrientedPair } from "./verdict";

export const MAX_HIDE_FRACTION = 0.1;
export const MAX_HIDE_TOTAL = 400;

export interface PlannedLink {
  from_id: string;
  to_id: string;
  relation: AcceptedLink["relation"];
  quote: string | null;
  verified: boolean;
  session_id: string;
  turn_idx: number | null;
  /** from's session start (ISO), the moment the older record stops being current. */
  from_started_at: string | null;
  project_id: string;
  /** Audit fields of the judge's reasons (plan.json only; memory_links has no column for them). */
  subject?: string | null;
  replacing_state_quote?: string | null;
  shared_artifact?: string | null;
}

export interface PlannedProjection {
  id: string;
  project_id: string;
  superseded_by: string;
  supersede_kind: HidingRelation;
  valid_to: string;
}

export function plannedLink(pair: OrientedPair, acc: AcceptedLink): PlannedLink {
  return {
    from_id: pair.from.id,
    to_id: pair.to.id,
    relation: acc.relation,
    quote: acc.quote,
    verified: acc.verified,
    session_id: pair.from.code_session_id,
    turn_idx: acc.turn_idx,
    from_started_at: pair.from.sessionStart !== undefined ? new Date(pair.from.sessionStart).toISOString() : null,
    project_id: pair.from.code_project_id,
    ...(acc.subject ? { subject: acc.subject } : {}),
    ...(acc.replacing_state_quote ? { replacing_state_quote: acc.replacing_state_quote } : {}),
    ...(acc.shared_artifact ? { shared_artifact: acc.shared_artifact } : {}),
  };
}

const isHiding = (r: string): r is HidingRelation => (HIDING_RELATIONS as readonly string[]).includes(r);

/**
 * One projection per older record from the verified hiding links: the OLDEST replacement wins (earliest
 * from_started_at, then smallest from_id), the same rule the search path applies, so valid_to is the first moment the
 * record stopped being current. A replacement that is itself retired (`retiredIds`) or that would hide a record already replaced by
 * it (a 2-cycle) is skipped, and a link whose from is missing a start time cannot set valid_to and is skipped. Pure.
 */
export function projectionFor(
  links: readonly PlannedLink[],
  retiredIds: ReadonlySet<string> = new Set(),
): PlannedProjection[] {
  const best = new Map<string, PlannedLink>();
  for (const l of links) {
    if (!l.verified || !isHiding(l.relation) || !l.from_started_at) continue;
    if (retiredIds.has(l.from_id) || l.from_id === l.to_id) continue;
    const cur = best.get(l.to_id);
    if (
      !cur ||
      Date.parse(l.from_started_at) < Date.parse(cur.from_started_at ?? "") ||
      (l.from_started_at === cur.from_started_at && l.from_id < cur.from_id)
    )
      best.set(l.to_id, l);
  }
  // Drop a mutual pair (A hides B and B hides A) entirely: orientation makes it impossible, this is the belt.
  const out: PlannedProjection[] = [];
  for (const [to, l] of best) {
    if (best.get(l.from_id)?.from_id === to) continue;
    out.push({
      id: to,
      project_id: l.project_id,
      superseded_by: l.from_id,
      supersede_kind: l.relation as HidingRelation,
      valid_to: l.from_started_at as string,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface CapCheck {
  ok: boolean;
  reason: string | null;
  hidden: number;
  live: number;
  fraction: number;
}

/** Aborts when the plan would hide more than 10% of the live records in scope or more than 400 in total. Pure. */
export function capCheck(hidden: number, live: number): CapCheck {
  const fraction = live > 0 ? hidden / live : hidden > 0 ? 1 : 0;
  if (hidden > MAX_HIDE_TOTAL)
    return { ok: false, reason: `plan hides ${hidden} records (cap ${MAX_HIDE_TOTAL})`, hidden, live, fraction };
  if (fraction > MAX_HIDE_FRACTION)
    return {
      ok: false,
      reason: `plan hides ${(fraction * 100).toFixed(1)}% of ${live} live records (cap ${MAX_HIDE_FRACTION * 100}%)`,
      hidden,
      live,
      fraction,
    };
  return { ok: true, reason: null, hidden, live, fraction };
}

/**
 * The caps applied per project (a project's hides over ITS live records) and in total; with a --since scope the hides
 * also may not exceed 10% of the records considered. Pure.
 */
export function capCheckScoped(
  projections: ReadonlyArray<{ project_id: string }>,
  liveByProject: Readonly<Record<string, number>>,
  considered?: number,
): CapCheck {
  const per = new Map<string, number>();
  for (const p of projections) per.set(p.project_id, (per.get(p.project_id) ?? 0) + 1);
  for (const [project, hidden] of per) {
    const c = capCheck(hidden, liveByProject[project] ?? 0);
    if (!c.ok) return { ...c, reason: `project ${project}: ${c.reason}` };
  }
  const total = capCheck(projections.length, considered ?? Object.values(liveByProject).reduce((a, b) => a + b, 0));
  return total;
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** SQL that reverses a run: clears each projection only where it still points at the planned replacement. Pure. */
export function undoSql(runId: string, userId: string, projections: readonly PlannedProjection[]): string {
  const lines = projections.map(
    (p) =>
      `update public.session_memories set superseded_by = null, supersede_kind = null, valid_to = null where user_id = ${q(userId)} and id = ${q(p.id)} and superseded_by = ${q(p.superseded_by)};`,
  );
  return [
    "begin;",
    ...lines,
    `update public.memory_links set undone_at = now() where user_id = ${q(userId)} and run_id = ${q(runId)} and undone_at is null;`,
    "commit;",
    "",
  ].join("\n");
}

/** SQL that applies a run in ONE transaction (links, then the projection). Pure; written to disk before any apply. */
export function applySql(
  runId: string,
  userId: string,
  model: string,
  promptVersion: string,
  links: readonly PlannedLink[],
  projections: readonly PlannedProjection[],
  /** Every judged pair, abstentions included, so a resumed run never re-asks (stored as relation 'unrelated'). */
  memo: ReadonlyArray<{ from_id: string; to_id: string; session_id: string }> = [],
): string {
  const have = new Set(links.map((l) => `${l.from_id}|${l.to_id}`));
  const abstained: PlannedLink[] = memo
    .filter((m) => !have.has(`${m.from_id}|${m.to_id}`))
    .map((m) => ({
      ...m,
      relation: "unrelated" as const,
      quote: null,
      verified: false,
      turn_idx: null,
      from_started_at: null,
      project_id: "",
    }));
  const rows = [...links, ...abstained].map(
    (l) =>
      `(${q(userId)}, ${q(l.from_id)}, ${q(l.to_id)}, ${q(l.relation)}, ${l.quote ? q(l.quote) : "null"}, ${q(l.session_id)}, ${l.turn_idx ?? "null"}, ${l.verified}, ${q(model)}, ${q(promptVersion)}, ${q(runId)})`,
  );
  const ins = rows.length
    ? [
        "insert into public.memory_links (user_id, from_id, to_id, relation, quote, session_id, turn_idx, verified, model, prompt_version, run_id) values",
        rows.join(",\n"),
        "on conflict (user_id, from_id, to_id, prompt_version) do update set relation = excluded.relation, quote = excluded.quote, session_id = excluded.session_id, turn_idx = excluded.turn_idx, verified = excluded.verified, model = excluded.model, run_id = excluded.run_id, undone_at = null where excluded.relation in ('supersedes', 'resolves', 'duplicates') and (memory_links.relation = 'unrelated' or memory_links.undone_at is not null or memory_links.relation = excluded.relation);",
      ]
    : [];
  const upd = projections.map(
    (p) =>
      `update public.session_memories set superseded_by = ${q(p.superseded_by)}, supersede_kind = ${q(p.supersede_kind)}, valid_to = ${q(p.valid_to)} where user_id = ${q(userId)} and id = ${q(p.id)} and retired_at is null and valid_to is null and exists (select 1 from public.session_memories r where r.id = ${q(p.superseded_by)} and r.user_id = ${q(userId)} and r.retired_at is null) and exists (select 1 from public.memory_links k where k.user_id = ${q(userId)} and k.from_id = ${q(p.superseded_by)} and k.to_id = ${q(p.id)} and k.verified and k.undone_at is null and k.relation = ${q(p.supersede_kind)});`,
  );
  return ["begin;", ...ins, ...upd, "commit;", ""].join("\n");
}
