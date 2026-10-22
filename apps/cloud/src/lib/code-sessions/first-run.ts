// The "Your history" first-run card's data (W5 D4). A new user's first upload brings in up to 30 days of
// past sessions; for the account's first week /pulse says what arrived: sessions per harness, the sub-agent
// share, the span of the uploaded sessions and how many memories extraction has produced so far.
//
// "New user" = the auth account is under 7 days old (no query: the caller passes user.created_at). Older
// accounts run no reads at all. For new ones every read is user-scoped (explicit .eq("user_id") on top of
// RLS), names its columns, and is an exact count or a one-row index lookup, so nothing scans rows:
//   - one head count per known harness, plus a head count of all rows (the remainder is "other"),
//   - one head count where parent_source_session_id is not null (sub-agents),
//   - earliest / latest started_at (user_id, started_at index, migration 105),
//   - one head count of memories (every origin).
import { HARNESS_IDS, harnessDisplayName } from "@membral/core";
import type { TypedDb } from "@/lib/db/types";

export const FIRST_RUN_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export interface FirstRunHistory {
  total: number;
  /** `label` is the display name, resolved here because @membral/core is server-only (client bundles cannot import it). */
  perHarness: { source: string; label: string; count: number }[];
  subAgents: number;
  /** ISO timestamps of the earliest / latest session start, null when no row carries one. */
  earliestStart: string | null;
  latestStart: string | null;
  memoryCount: number;
}

/** True while the account is under 7 days old (an unparseable date counts as not new). */
export function isNewAccount(accountCreatedAt: string | null | undefined, now: Date): boolean {
  const t = accountCreatedAt ? Date.parse(accountCreatedAt) : Number.NaN;
  return !Number.isNaN(t) && now.getTime() - t < FIRST_RUN_WINDOW_DAYS * DAY_MS;
}

/** The card's data, or null when it should be hidden (account 7+ days old, or no sessions). Throws on a read error. */
export async function getFirstRunHistory(
  supabase: TypedDb,
  userId: string,
  accountCreatedAt: string | null | undefined,
  now: Date = new Date(),
): Promise<FirstRunHistory | null> {
  if (!isNewAccount(accountCreatedAt, now)) return null;

  const countRows = () =>
    supabase.from("code_sessions").select("id", { count: "exact", head: true }).eq("user_id", userId);
  const startedAt = (ascending: boolean) =>
    supabase
      .from("code_sessions")
      .select("started_at")
      .eq("user_id", userId)
      .not("started_at", "is", null)
      .order("started_at", { ascending })
      .limit(1);

  const [all, subs, earliest, latest, memories, ...perSource] = await Promise.all([
    countRows(),
    countRows().not("parent_source_session_id", "is", null),
    startedAt(true),
    startedAt(false),
    supabase.from("memories").select("id", { count: "exact", head: true }).eq("user_id", userId),
    ...HARNESS_IDS.map((source) => countRows().eq("source", source)),
  ]);
  for (const r of [all, subs, earliest, latest, ...perSource]) if (r.error) throw new Error(r.error.message);

  const total = all.count ?? 0;
  if (total === 0) return null;
  const perHarness: { source: string; label: string; count: number }[] = HARNESS_IDS.map((source, i) => ({
    source: source as string,
    label: harnessDisplayName(source),
    count: perSource[i].count ?? 0,
  })).filter((h) => h.count > 0);
  const other = total - perHarness.reduce((n, h) => n + h.count, 0);
  if (other > 0) perHarness.push({ source: "other", label: "other", count: other });
  perHarness.sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

  return {
    total,
    perHarness,
    subAgents: subs.count ?? 0,
    earliestStart: earliest.data?.[0]?.started_at ?? null,
    latestStart: latest.data?.[0]?.started_at ?? null,
    memoryCount: memories.error ? 0 : (memories.count ?? 0),
  };
}
