// POST /api/code-sessions/known — "which of these sessions do you already
// have, unchanged?" The CLI (packages/cli/src/known-sessions.ts) asks this
// before uploading and skips every session listed, so an interrupted or
// repeated import only re-sends what the server is missing. The database is
// the single source of truth for "already uploaded" — no local ledger.
//
// Body:     { sessions: [{ source, source_session_id, turn_count, ended_at, actions_version? }] }
//           (max KNOWN_SESSIONS_MAX_BATCH = 500)
// Response: { known: number[] } — indexes into `sessions` whose code_sessions
//           row (this user, same source + source_session_id) has the same
//           turn_count and the same ended_at to the second (null == null).
//           A probe carrying actions_version (issue #171) is also not
//           known when the row's props.actions_version is older (null or
//           missing = older), so a parser upgrade reaches stored sessions.
//           An older CLI re-uploading a changed session writes its lower
//           version back, so a newer CLI re-imports that session once more
//           (correct; it loops only if two CLIs keep alternating).
//           A row mid-import (content_hash still the "" pending sentinel,
//           lib/code-sessions/import.ts) is never reported as known.
//
// The match rule and the probe derivation live in @membral/core
// (sessions/known.ts), which the ingest also uses for turn_count.
//
// AUTH: same as the ingest (authenticateCodeSessionsWrite) — the question
// only makes sense for a caller that is about to write. Own rate-limit
// bucket (codeSessionsKnown) so the check never eats the ingest's budget.
import { isKnownStoredSession, KNOWN_SESSIONS_MAX_BATCH } from "@membral/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute } from "@/lib/api/route";
import { CODE_SESSIONS_WRITE_AUTH, getCodeSessionsServiceClient } from "@/lib/code-sessions/auth";
import { getKnownSessionDigests } from "@/lib/code-sessions/queries";
import { readTextBodyWithLimit } from "@/lib/http-body";
import { log, requestId } from "@/lib/log";
import { userBucket } from "@/lib/rate-limit";

// 500 probes of a few hundred bytes each; generous headroom.
const MAX_BODY_BYTES = 1024 * 1024;

// PostgREST filters travel in the URL, and the local gateway answers 414
// past ~8 KB (measured: 100 sub-agent ids pass, 150 fail). So the `in`
// filter is split into chunks whose encoded ids stay under this budget, and
// the chunks run concurrently.
const MAX_IN_FILTER_CHARS = 4000;

const KnownProbeSchema = z.object({
  source: z.string().min(1).max(64),
  source_session_id: z.string().min(1).max(2000),
  turn_count: z.number().int().min(0),
  ended_at: z.string().max(64).nullable(),
  actions_version: z.number().int().min(1).optional(),
});

const KnownSessionsRequestSchema = z.object({
  sessions: z.array(KnownProbeSchema).max(KNOWN_SESSIONS_MAX_BATCH),
});

interface StoredRow {
  source: string;
  source_session_id: string;
  turn_count: number | null;
  ended_at: string | null;
  content_hash: string | null;
  actions_version: unknown;
}

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const id of ids) {
    const cost = encodeURIComponent(id).length + 8; // quotes + comma, encoded
    if (current.length > 0 && size + cost > MAX_IN_FILTER_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(id);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export const POST = withRoute(
  {
    auth: CODE_SESSIONS_WRITE_AUTH,
    rateLimit: { name: "codeSessionsKnown", bucket: ({ userId }) => userBucket("codeSessionsKnown", userId) },
  },
  async ({ req, userId }) => {
    const rlog = log.withContext({ request_id: requestId(req), route: "/api/code-sessions/known", user_id: userId });

    let rawText: string;
    try {
      const result = await readTextBodyWithLimit(req.body, MAX_BODY_BYTES);
      if ("tooLarge" in result) {
        return NextResponse.json({ error: "Request body too large" }, { status: 413 });
      }
      rawText = result.text;
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = KnownSessionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: `Invalid request body — expected { sessions: [{ source, source_session_id, turn_count, ended_at }] } (max ${KNOWN_SESSIONS_MAX_BATCH})`,
          detail: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        { status: 400 },
      );
    }

    const { sessions } = parsed.data;
    if (sessions.length === 0) return NextResponse.json({ known: [] });

    const supabase = getCodeSessionsServiceClient();
    const ids = [...new Set(sessions.map((s) => s.source_session_id))];
    const results = await Promise.all(chunkIds(ids).map((chunk) => getKnownSessionDigests(supabase, userId, chunk)));

    const stored = new Map<string, StoredRow>();
    for (const res of results) {
      if (res.error) {
        rlog.error("known-sessions lookup failed", { err: res.error.message });
        return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
      }
      for (const row of (res.data ?? []) as StoredRow[]) {
        stored.set(`${row.source}\u0000${row.source_session_id}`, row);
      }
    }

    const known: number[] = [];
    sessions.forEach((probe, index) => {
      const row = stored.get(`${probe.source}\u0000${probe.source_session_id}`);
      if (!row || !row.content_hash) return; // absent, or mid-import (pending sentinel)
      if (isKnownStoredSession(probe, row)) known.push(index);
    });

    return NextResponse.json({ known });
  },
);
