// GET /api/health — liveness/readiness probe (issue #72).
//
// No auth: it's a probe. It must not leak anything sensitive — it reports only
// coarse "ok"/"down" strings, never env values, tokens, or error text.
//
//   200 { status: "ok",       checks: { supabase: "ok"   } }  when Supabase reachable
//   503 { status: "degraded", checks: { supabase: "down" } }  when not
//
// Local stack only (MEMBRAL_LOCAL=1, VERCEL unset): the body also carries
// `llm` (lib/local/llm-status.ts) — provider/model names and on/off flags,
// never keys or URLs.
//
// Supabase liveness drives the HTTP status.

import { NextResponse } from "next/server";
import { pingConversations } from "@/lib/conversations/queries";
import { tryServiceClient } from "@/lib/db/clients";
import { localLlmStatus } from "@/lib/local/llm-status";
import { isLocalMode } from "@/lib/local/mode";
import { log, requestId } from "@/lib/log";

// Never cache a health probe — every hit must actually check.
export const dynamic = "force-dynamic";

type CheckState = "ok" | "down";

/**
 * Cheapest reachability check we can make: a HEAD count against a core table.
 * PostgREST answering at all (even with a benign error) proves reachability;
 * a network failure rejects the promise. Isolated for unit-test mocking.
 */
async function pingSupabase(): Promise<CheckState> {
  try {
    const supabase = tryServiceClient();
    if (!supabase) return "down";
    const { error } = await pingConversations(supabase);
    return error ? "down" : "ok";
  } catch {
    return "down";
  }
}

export async function GET(req: Request) {
  const rid = requestId(req);
  const rlog = log.withContext({ request_id: rid, route: "/api/health" });

  const supabase = await pingSupabase();
  const healthy = supabase === "ok";

  const checks: Record<string, CheckState> = { supabase };

  rlog.info("health_check", { healthy, supabase });

  // Local stack only (W7 design §10): which LLM is configured and whether
  // extraction runs — env-derived, no network. Hosted output is unchanged.
  const body = isLocalMode()
    ? { status: healthy ? "ok" : "degraded", checks, llm: localLlmStatus() }
    : { status: healthy ? "ok" : "degraded", checks };

  return NextResponse.json(body, { status: healthy ? 200 : 503, headers: { "x-request-id": rid } });
}
