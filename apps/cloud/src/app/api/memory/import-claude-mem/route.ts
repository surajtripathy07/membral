// POST /api/memory/import-claude-mem — `membral import claude-mem` (goal
// 2026-10-25 box 3.2). Body { observations: [...] } (<= 100, Zod-validated);
// each observation becomes a session_memories row (source "claude-mem") linked
// to the CALLER's code_session whose source_session_id equals claude-mem's
// content_session_id. No such session -> skipped and counted, never invented.
// A quote is stored only when the shared grounding predicate (lib/memory/grounding.ts)
// finds the observation's text in one of that session's owner/assistant prose turns.
// Text is redacted (secrets, phone/email) and length-capped here as well as in the CLI.
// Idempotent: unique (user_id, code_session_id, content_hash), conflicts ignored. On a
// re-run, a stored row that is still unquoted is UPGRADED (quote, verified, turn) when a
// quote is now found (user-scoped; only rows still verified=false, source claude-mem).
// Dedupe key: the CLI sends rawHash (sha256 of the raw, pre-redaction fields) and the content_hash is built
// from it, so changing redaction rules or caps later does not re-insert; an older CLI without rawHash falls
// back to hashing the redacted text (a rule change then needs a cleanup pass for those rows).
// created_at is always written (observation time, else request time) so a mixed batch never upserts NULL.
// Work is bounded: <= 100 observations over <= 25 sessions, the newest MAX_GROUNDING_TURNS prose turns read per session (<= MAX_TURN_ROWS_PER_REQUEST in all), exact match only.
//
// AUTH: Bearer Supabase JWT or an UNSCOPED lls_ key (a scoped key is a read
// lens, never a write grant: 403). Every query below filters on user_id; the
// service client bypasses RLS, so that filter is the isolation.
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { CODE_SESSIONS_WRITE_AUTH, getCodeSessionsServiceClient } from "@/lib/code-sessions/auth";
import { readTextBodyWithLimit } from "@/lib/http-body";
import { log, requestId } from "@/lib/log";
import {
  claudeMemImportBodySchema,
  MAX_BODY_BYTES,
  MAX_GROUNDING_TURNS,
  type MappedRow,
  mapObservation,
  type PreparedTurns,
  prepareTurns,
  type SessionRef,
  type StoredTurn,
} from "@/lib/memory/import-claude-mem";
import { userBucket } from "@/lib/rate-limit";
import { selectAllRows } from "@/lib/util/pagination";

const ROUTE = "/api/memory/import-claude-mem";
/** Total turn rows one request may read across its sessions (25 x 5,000 would be 125k). */
const MAX_TURN_ROWS_PER_REQUEST = 50_000;
export const maxDuration = 60;

export const POST = withRoute(
  {
    auth: CODE_SESSIONS_WRITE_AUTH,
    requestId: true,
    rateLimit: { name: "importBulk", bucket: ({ userId }) => userBucket("importClaudeMem", userId) },
  },
  async ({ req, userId, rid: routeRid }) => {
    const rid = routeRid ?? requestId(req);
    const rlog = log.withContext({ request_id: rid, route: ROUTE, user_id: userId });
    const hdrs = { "x-request-id": rid };

    let rawText: string;
    try {
      const result = await readTextBodyWithLimit(req.body, MAX_BODY_BYTES);
      if ("tooLarge" in result) {
        return NextResponse.json({ error: "Request body too large" }, { status: 413, headers: hdrs });
      }
      rawText = result.text;
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: hdrs });
    }
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: hdrs });
    }
    const parsed = claudeMemImportBodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues.slice(0, 5).map((i) => i.message) },
        { status: 400, headers: hdrs },
      );
    }
    const observations = parsed.data.observations;
    const db = getCodeSessionsServiceClient();

    try {
      const ids = [...new Set(observations.map((o) => o.contentSessionId))];
      // Only Claude Code sessions: claude-mem records Claude Code hooks, and source_session_id is unique per
      // (user, source), so another harness could reuse the id. Ordered so the pick is deterministic.
      const sessRes = await db
        .from("code_sessions")
        .select("id, code_project_id, source_session_id, short_title, title, parent_source_session_id")
        .eq("user_id", userId)
        .eq("source", "claude-code")
        .in("source_session_id", ids)
        .order("id", { ascending: true });
      if (sessRes.error) throw new Error(`session lookup failed: ${sessRes.error.message}`);
      const sessions = new Map<string, SessionRef>();
      for (const s of (sessRes.data ?? []) as SessionRef[]) {
        if (!sessions.has(s.source_session_id)) sessions.set(s.source_session_id, s);
      }

      const turnsBySession = new Map<string, PreparedTurns>();
      let rowBudget = MAX_TURN_ROWS_PER_REQUEST;
      for (const s of sessions.values()) {
        // Newest MAX_GROUNDING_TURNS prose turns only (idx DESC, one extra row to detect truncation), paged past
        // PostgREST's 1000-row cap, then flipped back to ascending. A request-wide row budget bounds the total read;
        // a session past it is imported unanchored (counted in skipped_grounding), never failed.
        const limit = Math.min(MAX_GROUNDING_TURNS + 1, rowBudget);
        if (limit <= 0) {
          turnsBySession.set(s.id, prepareTurns([], true));
          continue;
        }
        const newestFirst = await selectAllRows<StoredTurn>((from, to) =>
          from >= limit
            ? Promise.resolve({ data: [], error: null })
            : db
                .from("code_session_turns")
                .select("idx, role, kind, text, props")
                .eq("user_id", userId)
                .eq("session_id", s.id)
                .eq("kind", "prose")
                .not("text", "is", null)
                .order("idx", { ascending: false })
                .range(from, Math.min(to, limit - 1)),
        );
        const budgetBound = limit < MAX_GROUNDING_TURNS + 1;
        const truncated = budgetBound ? newestFirst.length >= limit : newestFirst.length > MAX_GROUNDING_TURNS;
        const kept = newestFirst.slice(0, MAX_GROUNDING_TURNS).reverse();
        rowBudget -= kept.length;
        turnsBySession.set(s.id, prepareTurns(kept, truncated));
      }

      const now = new Date();
      let unmatched = 0;
      let invalid = 0;
      let skippedGrounding = 0;
      let mapped = 0;
      const rows = new Map<string, MappedRow>();
      for (const o of observations) {
        const session = sessions.get(o.contentSessionId);
        if (!session) {
          unmatched++;
          continue;
        }
        const prepared = turnsBySession.get(session.id) ?? prepareTurns([]);
        const row = mapObservation(userId, session, prepared, o, now);
        if (!row) {
          invalid++;
          continue;
        }
        // Unquoted from a session whose older turns were not scanned: imported, but not re-anchored.
        mapped++;
        if (prepared.truncated && row.quote === null) skippedGrounding++;
        rows.set(`${row.code_session_id}:${row.content_hash}`, row);
      }
      const toWrite = [...rows.values()];

      let inserted = 0;
      let requoted = 0;
      let upgraded = 0;
      if (toWrite.length > 0) {
        const up = await db
          .from("session_memories")
          .upsert(toWrite, { onConflict: "user_id,code_session_id,content_hash", ignoreDuplicates: true })
          .select("code_session_id, content_hash");
        if (up.error) throw new Error(`insert failed: ${up.error.message}`);
        const fresh = new Set((up.data ?? []).map((r) => `${r.code_session_id}:${r.content_hash}`));
        inserted = fresh.size;
        for (const [key, row] of rows) {
          if (fresh.has(key)) {
            if (row.quote !== null) requoted++;
            continue;
          }
          // Already stored: promote it only if it is still unquoted and a quote is found now.
          if (row.quote === null) continue;
          const upd = await db
            .from("session_memories")
            .update({ quote: row.quote, verified: true, turn_idx: row.turn_idx, turn_role: row.turn_role })
            .eq("user_id", userId)
            .eq("code_session_id", row.code_session_id)
            .eq("content_hash", row.content_hash)
            .eq("source", "claude-mem")
            .eq("verified", false)
            .is("retired_at", null)
            .select("id");
          if (upd.error) throw new Error(`upgrade failed: ${upd.error.message}`);
          upgraded += upd.data?.length ?? 0;
        }
      }
      return NextResponse.json(
        {
          received: observations.length,
          inserted,
          // Includes in-request collapses (same content twice in one batch), but not rows that were upgraded.
          duplicates: mapped - inserted - upgraded,
          unmatched,
          invalid,
          requoted,
          upgraded,
          skipped_grounding: skippedGrounding,
        },
        { headers: hdrs },
      );
    } catch (err) {
      rlog.error("claude-mem import failed", { err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "claude-mem import failed" }, { status: 500, headers: hdrs });
    }
  },
);
