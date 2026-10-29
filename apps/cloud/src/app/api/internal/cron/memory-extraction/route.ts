// GET /api/internal/cron/memory-extraction — restarts memory extraction for
// every user with claimable work (goal 2026-09-24 review B1). Extraction
// stops when a run is killed (its lease then expires), when the global daily
// ceiling or a budget read failed closed (row released to 'pending'), when
// a trigger POST failed, or when an extract-next invocation ran out of time.
// Each call kicks ONE extract-next per user that still has a 'pending' row
// or an expired 'running' lease; that invocation drains sessions in a loop
// while its time lasts and never calls itself (issue #339). The platform
// cron calls this once a day; an external scheduler may call it every few
// minutes with ?kick=1.
//
// MODES (issue #339): `?kick=1` (exactly "1") is kick-only — list, back off,
// kick, and skip reconcile, user_stats and patterns, which are daily work.
// Anything else is the full daily run below. Both modes apply the per-user
// failure backoff (extraction-backoff.ts) to their kicks.
//
// P10 round 3 R3-M1: before listing, it reconciles the queue
// (reconcileMemoryExtractionQueue): recent sessions whose upload-time
// enqueue failed, or whose turns grew since their last extraction, are
// queued through the same enqueue RPC. A reconcile failure is logged and
// the run still kicks the chains already waiting.
//
// Goal 2026-09-26 P8: after the chains are kicked, one more step derives
// YESTERDAY's user_stats row per user (deriveUserStatsForDay, migration
// 104) from code_sessions / turns / issues / mcp_tool_calls. It runs only
// while the time budget holds, and its failure is logged and reported in
// the summary — never a non-200 for the run.
//
// Goal 2026-09-26 P9: one more step after that derives per-project
// repeated tool sequences and their drafted skills into
// code_projects.props.patterns (derivePatternsNightly) — same guards: time
// budget, failure logged into the summary, never a non-200.
//
// AUTH: same as /api/internal/cron/advance — Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET`; 503 when CRON_SECRET is unset, 403
// on a mismatch.
import { type NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api/auth";
import { log } from "@/lib/log";
import { CRON_TIME_BUDGET_MS, kickExtraction } from "@/lib/memory/extraction-kick";
import { type DerivePatternsSummary, derivePatternsNightly } from "@/lib/patterns/derive";
import { type DeriveUserStatsSummary, deriveUserStatsForDay } from "@/lib/stats/derive-user-stats";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req, {
    logPrefix: "cron/memory-extraction",
    notConfigured: "CRON_SECRET not configured",
    forbidden: "Forbidden",
  });
  if (denied) return denied;

  const mode: "kick" | "full" = req.nextUrl.searchParams.get("kick") === "1" ? "kick" : "full";
  // The claim/kick path lives in lib/memory/extraction-kick.ts: the in-process loop (instrumentation.ts) calls the same function.
  const kicked = await kickExtraction(mode);
  if (!kicked.ok) return NextResponse.json({ ok: false, mode, error: kicked.error }, { status: 500 });
  const { startedAt, supabase, reconciled, kickSummary } = kicked;
  if (mode === "kick") {
    return NextResponse.json({ ok: true, ...kickSummary });
  }

  // P8: yesterday's personal stats, one row per user with a session that day.
  let stats: DeriveUserStatsSummary | null = null;
  let statsError: string | null = null;
  if (Date.now() - startedAt > CRON_TIME_BUDGET_MS) {
    statsError = "skipped: time budget";
    log.warn("cron/memory-extraction: user_stats skipped — time budget spent on kicks");
  } else {
    try {
      stats = await deriveUserStatsForDay(supabase);
    } catch (err) {
      statsError = err instanceof Error ? err.message : String(err);
      log.error("cron/memory-extraction: user_stats derivation failed — chains were still kicked", {
        err: statsError,
      });
    }
  }

  // P9: repeated tool sequences per project → props.patterns (+ skill drafts).
  let patterns: DerivePatternsSummary | null = null;
  let patternsError: string | null = null;
  if (Date.now() - startedAt > CRON_TIME_BUDGET_MS) {
    patternsError = "skipped: time budget";
    log.warn("cron/memory-extraction: patterns skipped — time budget spent");
  } else {
    try {
      patterns = await derivePatternsNightly(supabase, { deadlineMs: startedAt + CRON_TIME_BUDGET_MS });
    } catch (err) {
      patternsError = err instanceof Error ? err.message : String(err);
      log.error("cron/memory-extraction: patterns derivation failed — chains and stats were still run", {
        err: patternsError,
      });
    }
  }

  const summary = {
    ...kickSummary,
    reconciled_ensured: reconciled?.ensured ?? 0,
    reconciled_requeued: reconciled?.requeued ?? 0,
    reconcile_failed_users: reconciled ? reconciled.failedUsers : null,
    stats_day: stats?.day ?? null,
    stats_users: stats?.users ?? 0,
    stats_sessions: stats?.sessions ?? 0,
    stats_error: statsError,
    patterns_users: patterns?.users ?? 0,
    patterns_projects: patterns?.projects ?? 0,
    patterns_found: patterns?.patterns ?? 0,
    patterns_drafted: patterns?.drafted ?? 0,
    patterns_failed_users: patterns?.failedUsers ?? 0,
    patterns_error: patternsError,
  };
  log.info("cron/memory-extraction: done", { ...summary, duration_ms: Date.now() - startedAt });
  return NextResponse.json({ ok: true, ...summary });
}
