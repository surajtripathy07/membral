// Nightly personal stats (goal 2026-09-26 P8) — the DB half.
//
// deriveUserStatsForDay(supabase, day) reads one UTC day's code_sessions,
// their turns and issues, that day's mcp_tool_calls, and upserts one
// user_stats row (migration 104) per user who had a top-level session.
// Called with no day (the cron), it re-derives the last RECENT_DAYS UTC days
// ending yesterday: a session synced late (laptop offline past the 03:30
// run) is still counted on its own day. The upsert on (user_id, day) makes
// every re-derivation idempotent.
// The maths is deriveUserStats() in ./user-stats.ts; this file only queries
// and writes. Called from /api/internal/cron/memory-extraction after the
// chains are kicked; a failure here is logged by the caller and never fails
// the cron run.
import type { Db } from "@/lib/db/types";
import { selectAllRows } from "@/lib/util/pagination";
import {
  deriveUserStats,
  type UserStatsIssueRow,
  type UserStatsMcpCallRow,
  type UserStatsProjectRow,
  type UserStatsRow,
  type UserStatsSessionRow,
  type UserStatsTurnRow,
} from "./user-stats";

export const USER_STATS_TABLE = "user_stats";

/** PostgREST `in (...)` lists are URL-encoded; keep them well under the URL cap. */
const IN_CHUNK = 100;

/** How many UTC days (ending yesterday) the cron re-derives each run, so late-synced sessions land. */
export const RECENT_DAYS = 3;

export interface DeriveUserStatsSummary {
  /** The newest day derived (yesterday for the cron). */
  day: string;
  /** user_stats rows written, summed over `days`. */
  users: number;
  /** Sessions read, summed over `days`. */
  sessions: number;
  /** Every day derived, oldest first. */
  days?: string[];
}

/** YYYY-MM-DD of the UTC day before `now`. */
export function yesterdayUtc(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.toISOString().slice(0, 10);
}

/** The `n` UTC days ending yesterday, oldest first. */
export function recentDaysUtc(n: number = RECENT_DAYS, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let back = n; back >= 1; back--) {
    out.push(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back)).toISOString().slice(0, 10),
    );
  }
  return out;
}

function dayBounds(day: string): { from: string; to: string } {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(start)) throw new Error(`deriveUserStatsForDay: invalid day ${JSON.stringify(day)}`);
  return { from: new Date(start).toISOString(), to: new Date(start + 86_400_000).toISOString() };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function selectIn<Row>(
  supabase: Db,
  table: string,
  column: string,
  ids: string[],
  select: string,
  orderBy: string,
): Promise<Row[]> {
  const out: Row[] = [];
  for (const chunk of chunks(ids, IN_CHUNK)) {
    const rows = await selectAllRows<Row>(
      (from, to) =>
        // A dynamic select string types as GenericStringError[]; the caller's Row is the truth.
        supabase.from(table).select(select).in(column, chunk).order(orderBy).range(from, to) as unknown as PromiseLike<{
          data: Row[] | null;
          error: { message: string } | null;
        }>,
    );
    out.push(...rows);
  }
  return out;
}

/**
 * Derive one UTC day, or — with no `day` — each of the last RECENT_DAYS days
 * ending yesterday (late-synced sessions). Idempotent: upsert on (user_id, day).
 */
export async function deriveUserStatsForDay(supabase: Db, day?: string): Promise<DeriveUserStatsSummary> {
  if (day !== undefined) return deriveOneDay(supabase, day);
  const days = recentDaysUtc();
  let users = 0;
  let sessions = 0;
  for (const d of days) {
    const one = await deriveOneDay(supabase, d);
    users += one.users;
    sessions += one.sessions;
  }
  return { day: days[days.length - 1], users, sessions, days };
}

/**
 * First session ever per user, in one grouped query (migration 105's
 * `user_first_session_at`); falls back to one ordered query per user when
 * the RPC is not deployed yet.
 */
async function firstSessionsAt(supabase: Db, userIds: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const id of userIds) out[id] = null;
  const { data, error } = await supabase.rpc("user_first_session_at", { p_user_ids: userIds });
  if (!error && Array.isArray(data)) {
    for (const r of data as Array<{ user_id?: string; first_at?: string | null }>) {
      if (r.user_id && r.user_id in out) out[r.user_id] = r.first_at ?? null;
    }
    return out;
  }
  for (const userId of userIds) {
    const { data: rows, error: qErr } = await supabase
      .from("code_sessions")
      .select("started_at")
      .eq("user_id", userId)
      .not("started_at", "is", null)
      .order("started_at", { ascending: true })
      .limit(1);
    if (qErr) throw new Error(qErr.message);
    out[userId] = (rows?.[0] as { started_at?: string | null } | undefined)?.started_at ?? null;
  }
  return out;
}

async function deriveOneDay(supabase: Db, day: string): Promise<DeriveUserStatsSummary> {
  const { from, to } = dayBounds(day);

  const sessions = await selectAllRows<UserStatsSessionRow>((a, b) =>
    supabase
      .from("code_sessions")
      .select(
        "id, user_id, code_project_id, parent_source_session_id, started_at, ended_at, duration_seconds, turn_count, user_turn_count, tool_count, model, props",
      )
      .gte("started_at", from)
      .lt("started_at", to)
      .order("id")
      .range(a, b),
  );
  if (sessions.length === 0) return { day, users: 0, sessions: 0 };

  const sessionIds = sessions.map((s) => s.id);
  const projectIds = [...new Set(sessions.map((s) => s.code_project_id).filter((id): id is string => Boolean(id)))];
  const userIds = [...new Set(sessions.map((s) => s.user_id))];

  const [turns, issues, projects, mcpCalls] = await Promise.all([
    selectIn<UserStatsTurnRow>(
      supabase,
      "code_session_turns",
      "session_id",
      sessionIds,
      "session_id, role, kind, tool_name, file_path, props",
      "id",
    ),
    selectIn<UserStatsIssueRow>(
      supabase,
      "code_session_issues",
      "session_id",
      sessionIds,
      "session_id, ref, role",
      "id",
    ),
    selectIn<UserStatsProjectRow>(supabase, "code_projects", "id", projectIds, "id, repo_identity, display_name", "id"),
    (async () => {
      const out: UserStatsMcpCallRow[] = [];
      for (const chunk of chunks(userIds, IN_CHUNK)) {
        const rows = await selectAllRows<UserStatsMcpCallRow>((a, b) =>
          supabase
            .from("mcp_tool_calls")
            .select("user_id, tool, ok")
            .in("user_id", chunk)
            .gte("created_at", from)
            .lt("created_at", to)
            .order("id")
            .range(a, b),
        );
        out.push(...rows);
      }
      return out;
    })(),
  ]);

  const firstSessionAt = await firstSessionsAt(supabase, userIds);

  const rows: UserStatsRow[] = deriveUserStats({ day, sessions, turns, issues, mcpCalls, projects, firstSessionAt });
  if (rows.length > 0) {
    const { error } = await supabase.from(USER_STATS_TABLE).upsert(rows, { onConflict: "user_id,day" });
    if (error) throw new Error(error.message);
  }
  return { day, users: rows.length, sessions: sessions.length };
}
