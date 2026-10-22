// Served-and-used counts per recall surface (goal 2026-10-10 recall-precision,
// box 7 / L7). Read side of memory_recall_events (migration 113) joined to the
// verdict lib/memory/influence.ts writes after a session's turns are imported.
//
// UNIT. Counts are RECORDS, not calls: an event that served 5 records adds 5
// to `served` (memory_recall_events.record_ids.length). A record served twice
// in the window counts twice, because each serving is a separate chance to be
// used.
//
// STATUS of an event (all its records share it):
//   used    — influence_checked_at is set and influenced_quote OR
//             influenced_edit is true. This is CO-OCCURRENCE (a served quote
//             appeared verbatim in an assistant turn, or a served record's
//             path was edited), not proof the record caused anything; UI copy
//             says "used (quoted or edited after serving)", never "helped".
//   ignored — influence_checked_at is set and both flags are false: the
//             session was imported and reconciled and neither signal fired.
//   pending — influence_checked_at is null and the event is under 24 h old:
//             the session may still be uploaded and reconciled.
//   unlinked — influence_checked_at is null and the event is 24 h old or
//             older: it was never linked to an uploaded session (unlinked MCP
//             event, session never uploaded), so it will not be reconciled.
//
// EXCLUDED. `session_summary` events (tool === "session_summary") are not
// counted in any column: influence.ts never reconciles them, so they would sit
// in pending forever.
//
// Always scoped by user_id (the service client bypasses RLS).
import type { Db } from "@/lib/db/types";
import { selectAllRows } from "@/lib/util/pagination";

export const SERVED_USED_DEFAULT_DAYS = 7;
export const SERVED_USED_MAX_DAYS = 90;
const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;
const SURFACE_ORDER = ["mcp", "preamble", "prompt_hook"] as const;

export interface ServedUsedCounts {
  served: number;
  used: number;
  ignored: number;
  pending: number;
  unlinked: number;
}

export interface ServedUsedSurface extends ServedUsedCounts {
  surface: string;
}

export interface ServedUsedSummary {
  days: number;
  since: string;
  totals: ServedUsedCounts;
  /** Surfaces that served at least one record in the window, mcp/preamble/prompt_hook first. */
  surfaces: ServedUsedSurface[];
}

interface EventRow {
  id: string;
  tool?: string | null;
  served_at?: string | null;
  surface: string | null;
  record_ids: string[] | null;
  influenced_edit: boolean | null;
  influenced_quote: boolean | null;
  influence_checked_at: string | null;
}

const zero = (): ServedUsedCounts => ({ served: 0, used: 0, ignored: 0, pending: 0, unlinked: 0 });

export function resolveServedUsedDays(raw: string | number | null | undefined): number {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n) || n < 1) return SERVED_USED_DEFAULT_DAYS;
  return Math.min(Math.trunc(n), SERVED_USED_MAX_DAYS);
}

/** Pure aggregation, exported for tests. */
export function summarizeServedUsed(
  rows: EventRow[],
  days: number,
  since: string,
  now: Date = new Date(),
): ServedUsedSummary {
  const unlinkedBefore = now.getTime() - PENDING_WINDOW_MS;
  const by = new Map<string, ServedUsedCounts>();
  const totals = zero();
  for (const row of rows) {
    const n = row.record_ids?.length ?? 0;
    if (n === 0 || row.tool === "session_summary") continue;
    const surface = row.surface as string;
    const c = by.get(surface) ?? zero();
    by.set(surface, c);
    let key: keyof ServedUsedCounts;
    if (row.influence_checked_at == null) {
      const servedAt = row.served_at ? Date.parse(row.served_at) : Number.NaN;
      key = Number.isFinite(servedAt) && servedAt >= unlinkedBefore ? "pending" : "unlinked";
    } else key = row.influenced_quote || row.influenced_edit ? "used" : "ignored";
    c.served += n;
    c[key] += n;
    totals.served += n;
    totals[key] += n;
  }
  const rank = (s: string) => {
    const i = (SURFACE_ORDER as readonly string[]).indexOf(s);
    return i === -1 ? SURFACE_ORDER.length : i;
  };
  const surfaces = [...by.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([surface, c]) => ({ surface, ...c }));
  return { days, since, totals, surfaces };
}

/** Served/used/ignored/pending/unlinked record counts per surface for `userId` over the last `days` days. */
export async function getServedAndUsed(
  db: Db,
  userId: string,
  days: number = SERVED_USED_DEFAULT_DAYS,
  now: Date = new Date(),
): Promise<ServedUsedSummary> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await selectAllRows<EventRow>((from, to) =>
    db
      .from("memory_recall_events")
      .select("id, tool, served_at, surface, record_ids, influenced_edit, influenced_quote, influence_checked_at")
      .eq("user_id", userId)
      .gte("served_at", since)
      .order("served_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  return summarizeServedUsed(rows, days, since, now);
}
