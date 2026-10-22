// GET /api/pulse — the /pulse ("Today") page's one read endpoint.
//
// Replaces the `op=pulse` branch of the now-deleted /api/spike catch-all
// (commit 12ce038, "kill list — bridge, api/spike, ee, dead routes gone")
// with a small dedicated route. That commit deleted the ENTIRE api/spike
// file — including the always-on bridged ops (`map`, `pulse`, `tree-node`,
// `node-source-conversations`) alongside the throwaway graph_spike dev
// tooling it was actually aimed at — so /pulse's one fetch (`/api/spike?op=
// pulse`) started 404ing and pulse-page-client.tsx tried to JSON-parse the
// 404 HTML page ("Unexpected token <"). This route restores only what
// pulse-page-client.tsx / pulse-content.tsx actually consume, reusing the
// same lib functions the old branch called (getPulsePayload,
// getCodeSessionCount/getRecentCodeSessions, getFreshnessForUser) — none of
// them were touched by 12ce038, only the route that called them was. No
// bridge/device-heartbeat logic is resurrected (that WAS intentionally
// removed by 12ce038, per the CLAUDE.md rule elsewhere in cloud).
//
// `census` (life_areas/items/conversations/entities counts + identity_line)
// is dropped: grep confirms neither pulse-page-client.tsx nor
// pulse-content.tsx ever read it from the old response (the census UI was
// deleted outright by ADR 0032 §1.2 — see pulse-content.tsx's own header) —
// it was dead weight riding along on the old catch-all, not a field this
// page depends on.
//
// Goal 2026-09-26 W7 / P5: `open_threads`, `recent_threads` and
// `recurring_blockers` (lib/threads) ride along for the Today page's Open
// threads / Yesterday blocks. Served here ONLY — the preamble and the MCP
// tools never read lib/threads (lib/threads/__tests__/preamble-guard.test.ts).
// A user with no code sessions gets empty lists; a threads READ FAILURE is
// logged and sent as `null` on all four thread fields (review F9), so the page
// says it could not load them instead of showing the all-clear copy. Never a 500.
//
// Goal 2026-09-26 W8 / P7: `stats_line` — the one rotating sentence from the
// user's latest `user_stats` row (migration 104, written nightly by W9's cron
// step; formatStatsLine picks the line). A missing row, a read error or a
// malformed row degrades to `null` and the page hides the line.
//
// UX W5: `session_titles` — id → display title for EVERY session a thread
// row references (its folded session and the child that proves it), looked up
// once per request (lib/code-sessions/session-titles.ts). A lookup failure
// degrades to `{}`; the rows still render and link.
//
// Cookie-session auth (requireUserId), same pattern as /api/sync-state and
// /api/agent-stats.
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { getFirstRunHistory } from "@/lib/code-sessions/first-run";
import { getCodeSessionCount, getRecentCodeSessions } from "@/lib/code-sessions/queries";
import { getSessionTitles, threadSessionTitles } from "@/lib/code-sessions/session-titles";
import { hasCodeSessions } from "@/lib/code-sessions/view";
import { getFreshnessForUser } from "@/lib/freshness";
import { log } from "@/lib/log";
import { formatStatsLine, type UserStatsRow } from "@/lib/stats/user-stats";
import { listOpenThreads } from "@/lib/threads/queries";

const USER_STATS_TABLE = "user_stats";

function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

interface PulseRecentChat {
  id: string;
  title: string | null;
  source: string | null;
  date: string | null;
  area_id: null;
  area_label: null;
  orphan: true;
}

/**
 * The newest chat-lane conversations (code mirrors excluded: the code strip
 * carries those), straight from `conversations`. Replaces the graph-derived
 * `kg_read_pulse` slice; there are no areas any more, so area fields are null.
 */
async function readRecentChats(supabase: SupabaseClient, userId: string): Promise<PulseRecentChat[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, source, created_at")
    .eq("user_id", userId)
    .neq("source", "claude-code")
    .order("created_at", { ascending: false })
    .limit(8);
  if (error) throw new Error(`recent conversations read failed: ${error.message}`);
  return ((data ?? []) as { id: string; title: string | null; source: string | null; created_at: string | null }[]).map(
    (r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      date: r.created_at,
      area_id: null,
      area_label: null,
      orphan: true,
    }),
  );
}

/** The latest user_stats row's line, or null. Never throws (B12). */
async function readStatsLine(supabase: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from(USER_STATS_TABLE)
      .select("*")
      .eq("user_id", userId)
      .order("day", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data || typeof data !== "object") return null;
    const raw = data as Record<string, unknown>;
    if (typeof raw.day !== "string") return null;
    // numeric/int columns may arrive as strings from PostgREST; formatStatsLine wants numbers.
    const row = {
      ...raw,
      sessions: asNumber(raw.sessions),
      cost_usd: asNumber(raw.cost_usd),
      commits: asNumber(raw.commits),
      mcp_calls: asNumber(raw.mcp_calls),
      longest_session_seconds: raw.longest_session_seconds === null ? null : asNumber(raw.longest_session_seconds),
      start_hour: raw.start_hour === null || raw.start_hour === undefined ? null : asNumber(raw.start_hour),
    } as unknown as UserStatsRow;
    const line = formatStatsLine(row);
    return typeof line === "string" && line.trim() ? line : null;
  } catch {
    return null;
  }
}

export const GET = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ user, supabase }) => {
    const userId = user.id;
    try {
      // #173: the reads below are independent of each other, so they run
      // concurrently (they used to run one after another, one round trip
      // each). Only the code-session gate orders anything: the recent list
      // and the threads read still wait on the count, and the titles on the
      // threads. Every read but getPulsePayload degrades on its own (as
      // before), so a getPulsePayload failure is still the one 500.
      let threadsFailed = false;
      const codeSide = (async () => {
        // Handoff 0024 directive D: recent code sessions alongside recent
        // conversations, merged client-side into "Your record" (ADR 0032 §3
        // module D). Gate + fetch failure both degrade to an empty list rather
        // than breaking Pulse. Limit matches getPulsePayload's own 8-row cap.
        // W7: open threads (B6), the window's per-ref rows (B5), blockers (B7)
        // and the owner's quotes (B8). Started with the count (#173) but only
        // used when the user has code sessions: with none, its outcome —
        // success or failure — is dropped unlogged, so the output is as if it
        // never ran. A read failure otherwise is logged and sent as null (F9).
        // Wrapped so even a synchronous throw lands in the outcome, never as a 500.
        const threadsRead = Promise.resolve()
          .then(() => listOpenThreads(supabase, userId))
          .then(
            (value) => ({ ok: true as const, value }),
            (err: unknown) => ({ ok: false as const, err }),
          );
        const codeSessionCount = await getCodeSessionCount(supabase, userId).catch(() => 0);
        if (!hasCodeSessions(codeSessionCount)) {
          return {
            recentCodeSessions: [],
            threads: null,
            sessionTitles: {} as Record<string, string>,
            firstRun: null,
          };
        }
        // W5 D4: the "Your history" card; a read failure hides it, never breaks Pulse.
        const [recentCodeSessions, threadsOutcome, firstRun] = await Promise.all([
          getRecentCodeSessions(supabase, userId, 8).catch(() => []),
          threadsRead,
          getFirstRunHistory(supabase, userId, user.created_at).catch(() => null),
        ]);
        let threads: Awaited<ReturnType<typeof listOpenThreads>> | null = null;
        if (threadsOutcome.ok) threads = threadsOutcome.value;
        else {
          threadsFailed = true;
          log.error("pulse: open threads read failed", {
            user_id: userId,
            err: threadsOutcome.err instanceof Error ? threadsOutcome.err.message : String(threadsOutcome.err),
          });
        }
        // UX W5: titles for every session any thread row references, one lookup.
        const sessionTitles = threads
          ? await threadSessionTitles([...threads.open, ...threads.recent], (ids) =>
              getSessionTitles(supabase, userId, ids),
            )
          : {};
        return { recentCodeSessions, threads, sessionTitles, firstRun };
      })();

      const [recent, { recentCodeSessions, threads, sessionTitles, firstRun }, freshness, statsLine] =
        await Promise.all([
          readRecentChats(supabase, userId),
          codeSide,
          // Freshness stamp — getFreshnessForUser degrades to null on any failure
          // so it can never break /pulse itself.
          getFreshnessForUser(userId),
          // W8: the nightly line; null hides it.
          readStatsLine(supabase, userId),
        ]);

      return NextResponse.json({
        recent,
        recent_code_sessions: recentCodeSessions,
        freshness,
        open_threads: threadsFailed ? null : (threads?.open ?? []),
        recent_threads: threadsFailed ? null : (threads?.recent ?? []),
        recurring_blockers: threadsFailed ? null : (threads?.recurring_blockers ?? []),
        stats_line: statsLine,
        session_titles: sessionTitles,
        first_run: firstRun,
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "failed to load pulse" }, { status: 500 });
    }
  },
);
