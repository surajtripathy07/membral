// L1: the Supabase-backed ReconSource (reads only) and the memo read. No write lives here: the plan is applied as SQL
// by scripts/memory/reconcile.ts behind its guards.
import type { Db } from "@/lib/db/types";
import { toVectorString } from "@/lib/llm/vector";
import { selectAllRows } from "@/lib/util/pagination";
import { pairKey } from "./candidates";
import { type ReconSource, type ScopeRow, toVec } from "./engine";
import type { PlannedLink, PlannedProjection } from "./plan";
import { isMissingColumn } from "./validity";
import { RECONCILE_PROMPT_VERSION } from "./verdict";

const CHUNK = 100;

/** Hybrid-search reads that errored in this process (the candidate list then falls back to cosine + ref). */
export const hybridFailures = { count: 0 };

interface RawScope {
  id: string;
  kind: string;
  text: string;
  ref: string | null;
  code_project_id: string;
  code_session_id: string;
  user_id: string;
  turn_idx: number | null;
  created_at: string;
  embedding: unknown;
  valid_to?: string | null;
  superseded_by?: string | null;
}

export function supabaseSource(supabase: Db, userId: string, projectId: string | null): ReconSource {
  return {
    async scope() {
      const read = (cols: string) =>
        selectAllRows<RawScope>((from, to) => {
          let q = supabase
            .from("session_memories")
            .select(cols)
            .eq("user_id", userId)
            .is("retired_at", null)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(from, to);
          if (projectId) q = q.eq("code_project_id", projectId);
          return q as unknown as PromiseLike<{ data: RawScope[] | null; error: { message: string } | null }>;
        });
      const base = "id, kind, text, ref, code_project_id, code_session_id, user_id, turn_idx, created_at, embedding";
      let data: RawScope[];
      try {
        data = await read(`${base}, valid_to, superseded_by`);
      } catch (err) {
        if (!isMissingColumn({ message: err instanceof Error ? err.message : String(err) })) throw err;
        data = await read(base);
      }
      return data.map((r) => ({
        id: r.id,
        kind: r.kind,
        text: r.text,
        ref: r.ref,
        code_project_id: r.code_project_id,
        code_session_id: r.code_session_id,
        user_id: r.user_id,
        turn_idx: r.turn_idx,
        created_at: r.created_at,
        embedding: toVec(r.embedding),
        valid_to: r.valid_to ?? null,
        superseded_by: r.superseded_by ?? null,
      }));
    },

    async sessionStarts(ids) {
      const out = new Map<string, number>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { data, error } = await supabase
          .from("code_sessions")
          .select("id, started_at")
          .eq("user_id", userId)
          .in("id", ids.slice(i, i + CHUNK));
        if (error) throw new Error(`reconcile: session read failed: ${error.message}`);
        for (const r of (data ?? []) as Array<{ id: string; started_at: string | null }>) {
          const t = Date.parse(r.started_at ?? "");
          if (Number.isFinite(t)) out.set(r.id, t);
        }
      }
      return out;
    },

    async hybrid(rec: ScopeRow, kinds, n) {
      const { data, error } = await supabase.rpc("memory_search_scored", {
        p_user_id: userId,
        p_query: rec.text,
        p_query_embedding: rec.embedding.length > 0 ? toVectorString(rec.embedding) : null,
        p_code_project_id: rec.code_project_id,
        p_kinds: [...kinds],
        p_scope: null,
        p_path: null,
        p_include_retired: false,
        p_limit: n + 1,
      });
      if (error) {
        // A timeout here must not stop a run: the cosine and ref sources still offer candidates (recall measured separately).
        hybridFailures.count++;
        return [];
      }
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => id !== rec.id);
    },

    async turnTimes(refs) {
      const out = new Map<string, number>();
      const bySession = new Map<string, Set<number>>();
      for (const r of refs) {
        const set = bySession.get(r.session) ?? new Set<number>();
        set.add(r.idx);
        bySession.set(r.session, set);
      }
      const sessions = [...bySession.keys()];
      for (let i = 0; i < sessions.length; i += 25) {
        const chunk = sessions.slice(i, i + 25);
        const idxs = [...new Set(chunk.flatMap((sid) => [...(bySession.get(sid) ?? [])]))];
        const rows = await selectAllRows<{ session_id: string; idx: number; ts: string | null }>((from, to) =>
          supabase
            .from("code_session_turns")
            .select("session_id, idx, ts")
            .eq("user_id", userId)
            .in("session_id", chunk)
            .in("idx", idxs)
            .order("session_id", { ascending: true })
            .order("idx", { ascending: true })
            .range(from, to),
        );
        for (const r of rows) {
          const t = Date.parse(r.ts ?? "");
          if (Number.isFinite(t)) out.set(`${r.session_id}:${r.idx}`, t);
        }
      }
      return out;
    },

    async turns(sessionId) {
      const rows = await selectAllRows<{ idx: number; text: string | null; kind: string }>((from, to) =>
        supabase
          .from("code_session_turns")
          .select("idx, text, kind")
          .eq("kind", "prose")
          .eq("user_id", userId)
          .eq("session_id", sessionId)
          .order("idx", { ascending: true })
          .range(from, to),
      );
      return rows;
    },
  };
}

/** Pairs already judged under this prompt version (memo). A store without memory_links reads as none. */
export async function readMemo(supabase: Db, userId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const rows = await selectAllRows<{ from_id: string; to_id: string }>((from, to) =>
      supabase
        .from("memory_links")
        .select("from_id, to_id")
        .eq("user_id", userId)
        .eq("prompt_version", RECONCILE_PROMPT_VERSION)
        .order("created_at", { ascending: true })
        .range(from, to),
    );
    for (const r of rows) out.add(pairKey(r.from_id, r.to_id));
  } catch {
    // no table (before migration 124): nothing memoised
  }
  return out;
}

/**
 * Dry-run memo: stores every judged pair so a rerun never re-asks, and NEVER projects. Proposed hiding links keep their
 * relation but are stored with verified=false (so nothing downstream can treat them as applied); abstentions are
 * stored as 'unrelated'. The rpc is called with an empty projection list; superseded_by/valid_to are not touched.
 */
export async function writeDryRunMemo(
  supabase: Db,
  userId: string,
  meta: { runId: string; model: string; promptVersion: string },
  batch: ReadonlyArray<{
    from_id: string;
    to_id: string;
    relation: string;
    session_id: string;
    link: { quote: string | null; turn_idx: number | null } | null;
  }>,
): Promise<number> {
  if (batch.length === 0) return 0;
  const args = {
    p_user_id: userId,
    p_run_id: meta.runId,
    p_model: meta.model,
    p_prompt_version: meta.promptVersion,
    p_links: batch.map((b) => ({
      from_id: b.from_id,
      to_id: b.to_id,
      relation: b.relation,
      quote: b.link?.quote ?? null,
      session_id: b.session_id,
      turn_idx: b.link?.turn_idx ?? null,
      verified: false,
    })),
    p_projections: [],
  };
  // The store can blip (the first v2 run died on one empty-message error): retry a few times before giving up.
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const { error } = await supabase.rpc("apply_memory_reconciliation", args);
      if (!error) return batch.length;
      last = error.message || JSON.stringify(error);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`reconcile: dry-run memo failed: ${last}`);
}

/**
 * The live-path writer: ONE rpc (migration 124's apply_memory_reconciliation) stores every judged pair and sets the
 * projection in a single transaction, so a link never exists without its projection. `shouldStop` is checked before
 * the call (a timed-out pass writes nothing). Service role only. Throws on error (the caller swallows it).
 */
export async function writePlan(
  supabase: Db,
  userId: string,
  meta: { runId: string; model: string; promptVersion: string },
  links: ReadonlyArray<PlannedLink>,
  memo: ReadonlyArray<{ from_id: string; to_id: string; session_id: string }>,
  projections: ReadonlyArray<PlannedProjection>,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  if (shouldStop()) return 0;
  const have = new Set(links.map((l) => `${l.from_id}|${l.to_id}`));
  const rows = [
    ...links.map((l) => ({
      from_id: l.from_id,
      to_id: l.to_id,
      relation: l.relation,
      quote: l.quote,
      session_id: l.session_id,
      turn_idx: l.turn_idx,
      verified: l.verified,
    })),
    ...memo
      .filter((m) => !have.has(`${m.from_id}|${m.to_id}`))
      .map((m) => ({ ...m, relation: "unrelated", quote: null, turn_idx: null, verified: false })),
  ];
  if (rows.length === 0 && projections.length === 0) return 0;
  const { data, error } = await supabase.rpc("apply_memory_reconciliation", {
    p_user_id: userId,
    p_run_id: meta.runId,
    p_model: meta.model,
    p_prompt_version: meta.promptVersion,
    p_links: rows,
    p_projections: projections.map((p) => ({
      id: p.id,
      superseded_by: p.superseded_by,
      supersede_kind: p.supersede_kind,
      valid_to: p.valid_to,
    })),
  });
  if (error) throw new Error(`reconcile: apply failed: ${error.message}`);
  return Number(data ?? 0);
}
