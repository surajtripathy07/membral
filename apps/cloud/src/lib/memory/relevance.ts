// POST /api/memory/relevance (docs/design/memory-v1.md §4): the first
// `UserPromptSubmit` call. "The server runs `memory_search(query = first
// prompt, project)` and returns <= 6 hits with the `recall_token`" plus the
// repo's open blockers (<= 10) into the outbox -- the second half of the
// push split (SessionStart gets the header + preferences via preamble.ts;
// the first prompt gets this).
import type { Db } from "@/lib/db/types";
import { blockerFreshCutoff } from "@/lib/domain/blockers";
import { renderRecordLine } from "./preamble";
import { mintRecallToken } from "./recall-token";
import { memorySearch, resolveProjectId } from "./search";
import { buildServeContext, type MemoryRow, type ServedRecord, toServedRecord, verifyRecords } from "./verify";

export interface RelevanceArgs {
  prompt: string;
  repo: string;
  recall_token?: string;
}

export interface RelevanceResult {
  lines: string[];
  recall_token: string;
  open_blockers: ServedRecord[];
}

const MAX_HITS = 6;
const MAX_OPEN_BLOCKERS = 10;

export async function buildRelevance(
  supabase: Db,
  userId: string,
  codeScopeId: string | null,
  args: RelevanceArgs,
): Promise<RelevanceResult> {
  const projectId = await resolveProjectId(supabase, userId, args.repo, codeScopeId);
  const recallToken = args.recall_token ?? mintRecallToken(userId, projectId);

  const { records } = await memorySearch(supabase, userId, codeScopeId, {
    query: args.prompt,
    project: args.repo,
    recall_token: recallToken,
    limit: MAX_HITS,
  });

  const openBlockers = projectId ? await fetchOpenBlockers(supabase, userId, projectId) : [];

  return {
    lines: records.map((r) => renderRecordLine(r)),
    recall_token: recallToken,
    open_blockers: openBlockers,
  };
}

async function fetchOpenBlockers(supabase: Db, userId: string, projectId: string): Promise<ServedRecord[]> {
  const { data, error } = await supabase
    .from("session_memories")
    .select("*")
    .eq("user_id", userId)
    .eq("code_project_id", projectId)
    .eq("kind", "blocker")
    .is("retired_at", null)
    // #436: only fresh blockers (lib/domain/blockers.ts), as on every surface.
    .gte("created_at", blockerFreshCutoff())
    .order("created_at", { ascending: false })
    .limit(MAX_OPEN_BLOCKERS);
  if (error) throw new Error(`relevance: open blockers lookup failed: ${error.message}`);

  const rows = (data ?? []) as MemoryRow[];
  const verifyMap = await verifyRecords(
    supabase,
    rows.map((r) => ({
      id: r.id,
      code_session_id: r.code_session_id,
      turn_idx: r.turn_idx,
      kind: r.kind,
      text: r.text,
      quote: r.quote,
      ref: r.ref,
    })),
  );
  const ctx = await buildServeContext(supabase, userId, rows);
  return rows.map((r) => toServedRecord(r, verifyMap.get(r.id) ?? { verified: false, turn_idx: r.turn_idx }, ctx));
}
