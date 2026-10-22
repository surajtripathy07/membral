// "Membral on Membral" signals (goal 2026-10-10 recall-precision, box 9, §W3b
// bullet 2). No LLM: counts over what is already stored, per session and per
// ISO week, for one user.
//
// SOURCES (each scoped by user_id; the service client bypasses RLS, the
// cookie client is held to each table's select-own policy):
//   served / used / ignored / pending — memory_recall_events, same unit and
//       same status rules as lib/memory/served-used.ts (records, not calls;
//       summarizeServedUsed is reused for the totals). Week = served_at.
//   empty / empty_below_floor / empty_no_match — memory_recall_events rows of
//       tool memory_search with no record_ids. The reason is empty_reason
//       (migration 126); an empty row without one (before 126, or a caller
//       that did not run the floor) counts in `empty` only.
//   confirmed / contradicted — served_record_verdicts (migration 125), the
//       extraction pass's verdict per served record. Week = created_at.
//   hook (calls / injected / empty / budget_hit / timeout / errors) —
//       code_sessions.props.hook_outcomes, the CLI prompt hook's per-session
//       summary sent with the upload (old CLIs send none). Week = ended_at.
//   feedback by sentiment — session_feedback (migration 125). Week = created_at.
//
// A missing table or column (a database before 125/126) reads as zero for
// that source, never an error.
import type { Db } from "@/lib/db/types";
import { type AgreementSummary, type QuestionnaireRow, summarizeAgreement } from "@/lib/memory/questionnaire";
import { summarizeServedUsed } from "@/lib/memory/served-used";
import { selectAllRows } from "@/lib/util/pagination";

export const DOGFOOD_SENTIMENTS = ["wrong", "stale", "missing", "noise", "slow", "useful"] as const;
export type DogfoodSentiment = (typeof DOGFOOD_SENTIMENTS)[number];
const HOOK_KEYS = ["calls", "injected", "empty", "budget_hit", "timeout", "errors"] as const;
export type HookCounts = Record<(typeof HOOK_KEYS)[number], number>;
export const DOGFOOD_QUOTE_LIMIT = 10;

export interface DogfoodCounts {
  served: number;
  used: number;
  ignored: number;
  pending: number;
  /** Served but never linked to an uploaded session: served = used + ignored + pending + unlinked. */
  unlinked: number;
  confirmed: number;
  contradicted: number;
  empty: number;
  empty_below_floor: number;
  empty_no_match: number;
  hook: HookCounts;
  feedback: Record<DogfoodSentiment, number> & { total: number };
}

export interface DogfoodQuote {
  id: string;
  sentiment: string;
  surface: string | null;
  quote: string;
  code_session_id: string;
  turn_idx: number;
  created_at: string;
}

export interface DogfoodSignals {
  days: number;
  since: string;
  totals: DogfoodCounts;
  /** ISO week ("2026-W41") → counts, oldest first. */
  weeks: Array<{ week: string } & DogfoodCounts>;
  /** One row per session with any signal, most recent signal first. */
  sessions: Array<{ code_session_id: string; last_at: string } & DogfoodCounts>;
  /** The latest feedback quotes, newest first (at most DOGFOOD_QUOTE_LIMIT). */
  quotes: DogfoodQuote[];
  /**
   * Session-end questionnaire: self-report vs judge agreement per question
   * (mean Jaccard, lib/memory/questionnaire.ts), over sessions with both
   * answers; overall and per ISO week. Absent from summarizeDogfood's pure output.
   */
  agreement?: { totals: AgreementSummary; weeks: Array<{ week: string } & AgreementSummary> };
}

export interface EventRow {
  id: string;
  tool: string | null;
  surface: string | null;
  record_ids: string[] | null;
  influenced_edit: boolean | null;
  influenced_quote: boolean | null;
  influence_checked_at: string | null;
  served_at: string;
  code_session_id: string | null;
  empty_reason?: string | null;
}
export interface VerdictRow {
  code_session_id: string;
  verdict: string;
  created_at: string;
}
export interface FeedbackRow extends DogfoodQuote {}
export interface HookRow {
  id: string;
  ended_at: string | null;
  hook_outcomes: unknown;
}

export const zeroCounts = (): DogfoodCounts => ({
  served: 0,
  used: 0,
  ignored: 0,
  pending: 0,
  unlinked: 0,
  confirmed: 0,
  contradicted: 0,
  empty: 0,
  empty_below_floor: 0,
  empty_no_match: 0,
  hook: { calls: 0, injected: 0, empty: 0, budget_hit: 0, timeout: 0, errors: 0 },
  feedback: { wrong: 0, stale: 0, missing: 0, noise: 0, slow: 0, useful: 0, total: 0 },
});

/** ISO-8601 week of a timestamp, e.g. "2026-W41" (UTC). Pure. */
export function isoWeek(at: string | Date): string {
  const d = new Date(typeof at === "string" ? Date.parse(at) : at.getTime());
  const day = d.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

/** Pure aggregation over already-read rows, exported for tests. */
export function summarizeDogfood(
  input: { events: EventRow[]; verdicts: VerdictRow[]; feedback: FeedbackRow[]; hooks: HookRow[] },
  days: number,
  since: string,
): DogfoodSignals {
  const totals = zeroCounts();
  const weeks = new Map<string, DogfoodCounts>();
  const sessions = new Map<string, { counts: DogfoodCounts; last_at: string }>();
  const buckets = (at: string, sessionId: string | null): DogfoodCounts[] => {
    const out = [totals];
    const wk = isoWeek(at);
    const w = weeks.get(wk) ?? zeroCounts();
    weeks.set(wk, w);
    out.push(w);
    if (sessionId) {
      const s = sessions.get(sessionId) ?? { counts: zeroCounts(), last_at: at };
      if (at > s.last_at) s.last_at = at;
      sessions.set(sessionId, s);
      out.push(s.counts);
    }
    return out;
  };

  for (const e of input.events) {
    const n = e.record_ids?.length ?? 0;
    if (n === 0) {
      if (e.tool !== "memory_search") continue;
      for (const c of buckets(e.served_at, e.code_session_id)) {
        c.empty += 1;
        if (e.empty_reason === "below_floor") c.empty_below_floor += 1;
        if (e.empty_reason === "no_match") c.empty_no_match += 1;
      }
      continue;
    }
    // served-used.ts owns the status rule; reuse it per event.
    const t = summarizeServedUsed([e], days, since).totals;
    for (const c of buckets(e.served_at, e.code_session_id)) {
      c.served += t.served;
      c.used += t.used;
      c.ignored += t.ignored;
      c.pending += t.pending;
      c.unlinked += t.unlinked;
    }
  }
  for (const v of input.verdicts) {
    if (v.verdict !== "confirmed" && v.verdict !== "contradicted") continue;
    const key = v.verdict;
    for (const c of buckets(v.created_at, v.code_session_id)) c[key] += 1;
  }
  for (const f of input.feedback) {
    const s = f.sentiment as DogfoodSentiment;
    for (const c of buckets(f.created_at, f.code_session_id)) {
      if ((DOGFOOD_SENTIMENTS as readonly string[]).includes(s)) c.feedback[s] += 1;
      c.feedback.total += 1;
    }
  }
  for (const h of input.hooks) {
    if (!h.ended_at || !h.hook_outcomes || typeof h.hook_outcomes !== "object") continue;
    const o = h.hook_outcomes as Record<string, unknown>;
    for (const c of buckets(h.ended_at, h.id)) for (const k of HOOK_KEYS) c.hook[k] += num(o[k]);
  }

  const quotes = [...input.feedback]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
    .slice(0, DOGFOOD_QUOTE_LIMIT)
    .map(({ id, sentiment, surface, quote, code_session_id, turn_idx, created_at }) => ({
      id,
      sentiment,
      surface,
      quote,
      code_session_id,
      turn_idx,
      created_at,
    }));
  return {
    days,
    since,
    totals,
    weeks: [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, c]) => ({ week, ...c })),
    sessions: [...sessions.entries()]
      .sort((a, b) => b[1].last_at.localeCompare(a[1].last_at) || a[0].localeCompare(b[0]))
      .map(([code_session_id, s]) => ({ code_session_id, last_at: s.last_at, ...s.counts })),
    quotes,
  };
}

/** A read that fails because the table/column does not exist yet (pre-125/126 database). */
export function isMissingRelation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /does not exist|could not find|schema cache/i.test(msg);
}

async function orEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (err) {
    if (isMissingRelation(err)) return [];
    throw err;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every dogfood signal for `userId` over the last `days` days. */
export async function getDogfoodSignals(
  db: Db,
  userId: string,
  days: number,
  now: Date = new Date(),
): Promise<DogfoodSignals> {
  return (await getDogfoodSignalsWindows(db, userId, [days], now))[0] as DogfoodSignals;
}

/**
 * Several windows (e.g. 7 and 30 days) from ONE read of the widest: each
 * narrower window is the same rows filtered by timestamp, so the five queries
 * run once, not once per window. Results are in the order of `windows`.
 */
export async function getDogfoodSignalsWindows(
  db: Db,
  userId: string,
  windows: readonly number[],
  now: Date = new Date(),
): Promise<DogfoodSignals[]> {
  const widest = Math.max(...windows);
  const since = new Date(now.getTime() - widest * DAY_MS).toISOString();
  const eventCols =
    "id, tool, surface, record_ids, influenced_edit, influenced_quote, influence_checked_at, served_at, code_session_id";
  const readEvents = (cols: string) =>
    selectAllRows<EventRow>(
      (from, to) =>
        db
          .from("memory_recall_events")
          .select(cols)
          .eq("user_id", userId)
          .gte("served_at", since)
          .order("served_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: EventRow[] | null; error: { message: string } | null }>,
    );
  const [events, verdicts, feedback, hooks, questionnaires] = await Promise.all([
    // Before migration 126 the empty_reason column is absent: read without it.
    readEvents(`${eventCols}, empty_reason`).catch((err) => {
      if (isMissingRelation(err)) return readEvents(eventCols);
      throw err;
    }),
    orEmpty(() =>
      selectAllRows<VerdictRow>((from, to) =>
        db
          .from("served_record_verdicts")
          .select("code_session_id, verdict, created_at")
          .eq("user_id", userId)
          .gte("created_at", since)
          .neq("verdict", "unused")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      ),
    ),
    orEmpty(() =>
      selectAllRows<FeedbackRow>((from, to) =>
        db
          .from("session_feedback")
          .select("id, sentiment, surface, quote, code_session_id, turn_idx, created_at")
          .eq("user_id", userId)
          .gte("created_at", since)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      ),
    ),
    orEmpty(() =>
      selectAllRows<HookRow>(
        (from, to) =>
          db
            .from("code_sessions")
            .select("id, ended_at, hook_outcomes:props->hook_outcomes")
            .eq("user_id", userId)
            .gte("ended_at", since)
            .not("props->hook_outcomes", "is", null)
            .order("ended_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<{ data: HookRow[] | null; error: { message: string } | null }>,
      ),
    ),
    // Before migration 127: no rows, agreement n=0.
    orEmpty(() =>
      selectAllRows<QuestionnaireRow>(
        (from, to) =>
          db
            .from("session_questionnaires")
            .select("source_session_id, source, answers, created_at")
            .eq("user_id", userId)
            .gte("created_at", since)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: QuestionnaireRow[] | null;
            error: { message: string } | null;
          }>,
      ),
    ),
  ]);
  return windows.map((days) => {
    const from = new Date(now.getTime() - days * DAY_MS).toISOString();
    const inWindow = <T>(rows: T[], at: (r: T) => string | null | undefined): T[] =>
      days === widest ? rows : rows.filter((r) => (at(r) ?? "") >= from);
    return {
      ...summarizeDogfood(
        {
          events: inWindow(events, (r) => r.served_at),
          verdicts: inWindow(verdicts, (r) => r.created_at),
          feedback: inWindow(feedback, (r) => r.created_at),
          hooks: inWindow(hooks, (r) => r.ended_at),
        },
        days,
        from,
      ),
      agreement: summarizeAgreement(
        inWindow(questionnaires, (r) => r.created_at),
        isoWeek,
      ),
    };
  });
}

export interface DogfoodCandidate {
  id: string;
  text: string;
  record_quote: string | null;
  quote: string | null;
  code_session_id: string;
  turn_idx: number | null;
  contradicted_at: string;
}

/** Served records the extraction pass judged contradicted, newest first (W3b bullet 5). */
export async function getContradictedCandidates(
  db: Db,
  userId: string,
  days: number,
  now: Date = new Date(),
): Promise<DogfoodCandidate[]> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  type Row = {
    memory_id: string;
    quote: string | null;
    turn_idx: number | null;
    code_session_id: string;
    updated_at: string;
    session_memories: { text: string; quote: string | null } | null;
  };
  const rows = await orEmpty(() =>
    selectAllRows<Row>(
      (from, to) =>
        db
          .from("served_record_verdicts")
          .select("memory_id, quote, turn_idx, code_session_id, updated_at, session_memories(text, quote)")
          .eq("user_id", userId)
          .eq("verdict", "contradicted")
          .gte("updated_at", since)
          .order("updated_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
    ),
  );
  return rows.map((r) => ({
    id: r.memory_id,
    text: r.session_memories?.text ?? "",
    record_quote: r.session_memories?.quote ?? null,
    quote: r.quote,
    code_session_id: r.code_session_id,
    turn_idx: r.turn_idx,
    contradicted_at: r.updated_at,
  }));
}
