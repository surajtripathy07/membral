// G2 step 2.4b: the pure recurrence planners behind write/io.ts. Every function
// here decides on rows write/io.ts has already fetched; the reads, the writes and
// the log lines stay in write/io.ts (dropCrossSessionDuplicates,
// fetchOpenBlockersForRecurrence, carryRetiredRootCounts,
// incrementRecurrenceCounts), in the order they ran before.
import { RECURRENCE_KINDS } from "@/lib/domain/recurrence";
import { vectorThreshold } from "@/lib/llm/embedding-family";
import { parseVector } from "@/lib/llm/vector";
import { cosineSimilarity } from "../embed";
import { normalizeForDedup } from "../merge";
import type { InsertableRecord } from "./insert";

/** A live row of another session, as the cross-session dedup compares against it. */
export type LiveRow = {
  id: string;
  norm: string;
  embedding: number[];
  createdAt: string;
  recursOf: string | null;
};

/** A row of the per-kind live read in `dropCrossSessionDuplicates`. */
export type FetchedLiveRow = {
  id: string;
  code_session_id: string;
  text: string;
  embedding: unknown;
  created_at?: string | null;
  recurs_of?: string | null;
};

/** One `log.info` line the caller emits, in order, with its own user/session fields first. */
export interface RecurrenceNote {
  msg: string;
  fields: { kind: string; existing_id?: string; recurs_of?: string };
}

/**
 * The fetched rows of one kind as `LiveRow`s, minus this session's own; `ids`
 * is every row id (this session's too) — a chain root outside the union of
 * `ids` is retired (or beyond the read window) and never takes the count.
 */
export function toLiveRows(rows: FetchedLiveRow[], sessionId: string): { rows: LiveRow[]; ids: string[] } {
  const ids: string[] = [];
  const out = rows
    .filter((row) => {
      ids.push(row.id);
      return row.code_session_id !== sessionId;
    })
    .map((row) => ({
      id: row.id,
      norm: normalizeForDedup(row.text),
      embedding: parseVector(row.embedding),
      createdAt: row.created_at ?? "",
      recursOf: row.recurs_of ?? null,
    }));
  return { rows: out, ids };
}

/** The pure half of `dropCrossSessionDuplicates` (its doc comment states the rule). */
export function planCrossSessionDedup<T extends InsertableRecord>(
  records: T[],
  liveByKind: Map<string, LiveRow[]>,
  liveIds: Set<string>,
): { kept: T[]; deduped: number; recurrences: number; notes: RecurrenceNote[] } {
  const headedLive = (r: T) => r.verified && !r.retireReason;
  const kept: T[] = [];
  const notes: RecurrenceNote[] = [];
  let deduped = 0;
  let recurrences = 0;
  /** Chain roots this batch already counted, with the texts kept on each: one session is one sighting (e2e A-B4 — a session that states the wall twice). */
  const chainsCounted = new Map<string, Set<string>>();
  // L8: the cosine cuts are calibrated per embedding family; an uncalibrated model matches on text only.
  const dupCut = records.length > 0 ? vectorThreshold("cross_session_dedup") : null;
  const recurrenceCut = records.length > 0 ? vectorThreshold("recurrence") : null;
  const vectorsOn = dupCut !== null;
  for (const r of records) {
    const live = headedLive(r) ? (liveByKind.get(r.kind) ?? []) : [];
    const norm = normalizeForDedup(r.text);
    const comparable = vectorsOn && r.embedding !== null && r.embedding.length > 0;
    const cos = (c: LiveRow): number =>
      comparable && c.embedding.length === (r.embedding as number[]).length
        ? cosineSimilarity(r.embedding as number[], c.embedding)
        : -1;
    const match = live.find((c) => c.norm === norm || (dupCut !== null && cos(c) >= dupCut));
    if (match) {
      deduped++;
      notes.push({
        msg: "memory: record deduped against a live record from another session",
        fields: { kind: r.kind, existing_id: match.id },
      });
      continue;
    }
    if (RECURRENCE_KINDS.includes(r.kind as string)) {
      // The extraction call's in-context judgement first (prompt v12); the
      // cosine band only when it named no offered blocker.
      let root: LiveRow | null = r.recursOfHint ? (live.find((c) => c.id === r.recursOfHint) ?? null) : null;
      if (!root && comparable && recurrenceCut !== null) {
        for (const c of live) {
          if (cos(c) < recurrenceCut) continue;
          if (!root || (c.createdAt && (!root.createdAt || c.createdAt < root.createdAt))) root = c;
        }
      }
      if (root) {
        const recursOf = root.recursOf && liveIds.has(root.recursOf) ? root.recursOf : root.id;
        const textsInChain = chainsCounted.get(recursOf);
        if (textsInChain) {
          if (textsInChain.has(norm)) {
            deduped++;
            notes.push({
              msg: "memory: record dropped — this session already recorded the same text in this chain",
              fields: { kind: r.kind, recurs_of: recursOf },
            });
            continue;
          }
          // e2e review N2: a distinct record is kept (never data loss); the chain is counted once per session.
          textsInChain.add(norm);
          notes.push({
            msg: "memory: record kept in a chain this session already counted — not counted again",
            fields: { kind: r.kind, recurs_of: recursOf },
          });
          kept.push({ ...r, recursOf, countsRecurrence: false });
          continue;
        }
        chainsCounted.set(recursOf, new Set([norm]));
        recurrences++;
        notes.push({
          msg: "memory: record kept as a recurrence of a live record from another session",
          fields: { kind: r.kind, recurs_of: recursOf },
        });
        kept.push({ ...r, recursOf });
        continue;
      }
    }
    kept.push(r);
  }
  return { kept, deduped, recurrences, notes };
}

/** A row of the live-blocker read in `fetchOpenBlockersForRecurrence`. */
export type FetchedOpenBlockerRow = {
  id: string;
  code_session_id: string;
  text: string;
  created_at?: string | null;
  recurs_of?: string | null;
  recurrence_count?: number | null;
};

/** The pure half of `fetchOpenBlockersForRecurrence` (its doc comment states the rule). May throw on a malformed row; the caller's catch offers nothing. */
export function planOpenBlockerOffers(
  rows: FetchedOpenBlockerRow[],
  sessionId: string,
  cap: number,
): Array<{ id: string; text: string }> {
  const liveIds = new Set(rows.map((r) => r.id));
  const chains = new Map<string, { id: string; text: string; newest: string; count: number; members: number }>();
  for (const r of rows) {
    if (!r?.id || typeof r.text !== "string") continue;
    const key = r.recurs_of && liveIds.has(r.recurs_of) ? r.recurs_of : r.id;
    const at = r.created_at ?? "";
    const c = chains.get(key) ?? { id: key, text: r.text, newest: at, count: 1, members: 0 };
    if (at > c.newest) {
      c.newest = at;
      c.text = r.text;
    }
    c.count = Math.max(c.count, r.recurrence_count ?? 1);
    if (r.code_session_id !== sessionId) c.members++;
    chains.set(key, c);
  }
  return [...chains.values()]
    .filter((c) => c.members > 0)
    .sort((a, b) => Math.max(b.count, b.members) - Math.max(a.count, a.members) || (a.newest < b.newest ? 1 : -1))
    .slice(0, cap)
    .map(({ id, text }) => ({ id, text }));
}

/**
 * Review N2 (see `carryRetiredRootCounts`): for each live re-rooted row, the
 * count it takes from its retired old root — only when larger than its own.
 */
export function planCarriedRootCounts(
  rows: Array<{ id: string; recurs_of: string | null; recurrence_count: number | null }>,
  olds: Array<{ id: string; recurrence_count: number | null }>,
): Array<{ id: string; count: number }> {
  const oldCount = new Map(olds.map((o) => [o.id, o.recurrence_count ?? 1]));
  const out: Array<{ id: string; count: number }> = [];
  for (const r of rows) {
    const carried = oldCount.get(r.recurs_of as string);
    if (carried === undefined || carried <= (r.recurrence_count ?? 1)) continue;
    out.push({ id: r.id, count: carried });
  }
  return out;
}

/** The read-then-write fallback of `incrementRecurrenceCounts`: each live root's next count. */
export function planFallbackCounts(
  rows: Array<{ id: string; recurrence_count: number | null }>,
  increments: Map<string, number>,
): Array<{ id: string; count: number }> {
  return rows.map((row) => ({
    id: row.id,
    count: (typeof row.recurrence_count === "number" ? row.recurrence_count : 1) + (increments.get(row.id) ?? 0),
  }));
}
