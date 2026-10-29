// `session_summary` (docs/design/memory-v1.md §4): session header + the
// session's JOURNEY -- its `thread`s in order from the first user prompt,
// each with its turn range, its records (outcomes first) and the files
// touched in that range. Threadless records land in a trailing "unsorted"
// group. "The journey is assembled from turn receipts alone -- no second
// extraction, no extra call" -- every field below comes from `code_sessions`
// + `session_memories` + one batched `code_session_turns` file-path read,
// never a fresh LLM pass.
//
// Spend attribution (2026-09-13, §4): the header carries `cost_usd` for the
// whole session, computed by `computeCost` (lib/code-sessions/price-table.ts)
// against `code_sessions.props.usage` -- the SAME function render.ts's
// header already calls, reused rather than duplicated, so a re-price of the
// table (`PRICE_TABLE_VERSION`) changes both call sites at once. `null` when
// `props.usage` is missing or malformed (`computeCost` returns `undefined`),
// never a thrown error or a fabricated number. Each `outcome` record in the
// journey additionally carries that same `cost_usd` alongside its `ref` --
// duplicated onto every outcome (not just the header) so "what did this
// session's spend deliver" is answerable by reading one record, without a
// second join back to the header. Every other kind's `cost_usd` is left
// `undefined` -- a decision/blocker/learning/preference didn't "cost" the
// spend, it was produced alongside it.

import type { RawUsage } from "@membral/core";
import { computeCost } from "@/lib/code-sessions/price-table";
import type { Db } from "@/lib/db/types";
import { isFreshBlocker } from "@/lib/domain/blockers";
import { handoffFeatureEnabled } from "@/lib/env";
import { rankRecords } from "./rank";
import { MEMORY_KINDS } from "./schema";
import { recordRecallEvent, resolveProjectId } from "./search";
import { buildServeContext, type MemoryRow, type ServedRecord, toServedRecord, verifyRecords } from "./verify";

export interface SessionSummaryArgs {
  session_id?: string;
  last?: boolean;
  repo?: string;
  recall_token?: string;
}

export interface SessionHeader {
  id: string;
  repo: string | null;
  branch: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  turn_count: number;
  user_turn_count: number;
  tool_count: number;
  model: string | null;
  files_touched: string[];
  memory_extraction: unknown;
  /** Session cost in USD (`computeCost`, price-table.ts), or `null` when `props.usage` is missing/malformed. See this file's header comment. */
  cost_usd: number | null;
}

/** A journey record, with `cost_usd` attached only for `kind === "outcome"` (see this file's header comment). */
export interface JourneyRecord extends ServedRecord {
  cost_usd?: number | null;
}

export interface JourneyThread {
  thread: string | null; // null for the trailing "unsorted" group
  turn_range: [number, number] | null;
  records: JourneyRecord[];
  files_touched: string[];
}

export interface SessionSummaryResult {
  header: SessionHeader;
  journey: JourneyThread[];
}

interface CodeSessionRow {
  id: string;
  code_project_id: string;
  git_branch: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  turn_count: number;
  user_turn_count: number;
  tool_count: number;
  files_touched: string[] | null;
  props: Record<string, unknown> | null;
}

async function resolveSession(
  supabase: Db,
  userId: string,
  codeScopeId: string | null,
  args: SessionSummaryArgs,
): Promise<CodeSessionRow | null> {
  const cols =
    "id, code_project_id, git_branch, model, started_at, ended_at, duration_seconds, turn_count, user_turn_count, tool_count, files_touched, props";

  if (args.session_id) {
    const { data, error } = await supabase
      .from("code_sessions")
      .select(cols)
      .eq("user_id", userId)
      .eq("id", args.session_id)
      .maybeSingle();
    if (error) throw new Error(`session_summary: code_sessions lookup failed: ${error.message}`);
    const row = data as CodeSessionRow | null;
    if (!row) return null;
    // Cross-project guard (mirrors code-tools.ts's getCodeSession): a scoped
    // key must never resolve a session outside its bound project.
    if (codeScopeId && row.code_project_id !== codeScopeId) return null;
    return row;
  }

  if (args.last) {
    const projectId = await resolveProjectId(supabase, userId, args.repo, codeScopeId);
    if (args.repo && !projectId) return null;
    // "last" means the last top-level session, never a sub-agent's (089).
    let query = supabase.from("code_sessions").select(cols).eq("user_id", userId).is("parent_source_session_id", null);
    if (projectId) query = query.eq("code_project_id", projectId);
    const { data, error } = await query.order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`session_summary: code_sessions last lookup failed: ${error.message}`);
    return (data as CodeSessionRow | null) ?? null;
  }

  throw new Error("session_summary: either session_id or last:true is required");
}

export async function sessionSummary(
  supabase: Db,
  userId: string,
  codeScopeId: string | null,
  args: SessionSummaryArgs,
): Promise<SessionSummaryResult | null> {
  const session = await resolveSession(supabase, userId, codeScopeId, args);
  if (!session) return null;

  let memoriesQuery = supabase
    .from("session_memories")
    .select("*")
    .eq("user_id", userId)
    .eq("code_session_id", session.id);
  // Not `handoff` (migration 136): the synthesized note is a summary of these records, never one of them. With both
  // handoff flags off no note is written, so the query keeps its pre-handoff shape (no kind filter).
  if (handoffFeatureEnabled()) memoriesQuery = memoriesQuery.in("kind", MEMORY_KINDS);
  const [{ data: repoRows, error: repoErr }, { data: memoryRows, error: memErr }, { data: turnRows, error: turnErr }] =
    await Promise.all([
      supabase.from("code_projects").select("id, display_name, repo_identity").eq("id", session.code_project_id),
      memoriesQuery.is("retired_at", null),
      supabase
        .from("code_session_turns")
        .select("idx, file_path")
        .eq("session_id", session.id)
        .not("file_path", "is", null)
        .order("idx", { ascending: true }),
    ]);
  if (repoErr) throw new Error(`session_summary: code_projects lookup failed: ${repoErr.message}`);
  if (memErr) throw new Error(`session_summary: session_memories lookup failed: ${memErr.message}`);
  if (turnErr) throw new Error(`session_summary: code_session_turns lookup failed: ${turnErr.message}`);

  const repo = (repoRows ?? [])[0] as { id: string; display_name: string | null; repo_identity: string } | undefined;
  const cost = computeCost(session.props?.usage as RawUsage | undefined, session.model ?? undefined);
  const header: SessionHeader = {
    id: session.id,
    repo: repo ? (repo.display_name ?? repo.repo_identity) : null,
    branch: session.git_branch,
    started_at: session.started_at,
    ended_at: session.ended_at,
    duration_seconds: session.duration_seconds,
    turn_count: session.turn_count,
    user_turn_count: session.user_turn_count,
    tool_count: session.tool_count,
    model: session.model,
    files_touched: session.files_touched ?? [],
    memory_extraction: session.props?.memory_extraction ?? null,
    cost_usd: cost ? cost.amount : null,
  };

  // Exclude records superseded by another live record of this session (rule 4).
  // #436: a blocker older than BLOCKER_FRESH_DAYS is old on every surface.
  const now = Date.now();
  const rows = ((memoryRows ?? []) as MemoryRow[]).filter((r) => isFreshBlocker(r, now));
  const supersededIds = new Set(rows.map((r) => r.supersedes).filter((id): id is string => !!id));
  const liveRows = rows.filter((r) => !supersededIds.has(r.id));

  const verifyMap = await verifyRecords(
    supabase,
    liveRows.map((r) => ({
      id: r.id,
      code_session_id: r.code_session_id,
      turn_idx: r.turn_idx,
      kind: r.kind,
      text: r.text,
      quote: r.quote,
      ref: r.ref,
    })),
  );
  const ctx = await buildServeContext(supabase, userId, liveRows);

  const byThread = new Map<string | null, MemoryRow[]>();
  for (const r of liveRows) {
    const key = r.thread ?? null;
    const arr = byThread.get(key) ?? [];
    arr.push(r);
    byThread.set(key, arr);
  }

  const filesByIdx = (turnRows ?? []) as { idx: number; file_path: string }[];
  const filesInRange = (lo: number, hi: number): string[] => {
    const set = new Set<string>();
    for (const t of filesByIdx) if (t.idx >= lo && t.idx <= hi) set.add(t.file_path);
    return [...set];
  };

  const orderGroup = (group: MemoryRow[]): JourneyRecord[] => {
    const rankable = group.map((r) => ({
      id: r.id,
      kind: r.kind,
      source: r.source,
      turn_role: r.turn_role,
      agent_id: r.agent_id,
      verified: verifyMap.get(r.id)?.verified ?? false,
      paths: r.paths,
      created_at: r.created_at,
    }));
    const orderedIds = rankRecords(rankable, "tool").map((r) => r.id);
    const byId = new Map(group.map((r) => [r.id, r] as const));
    return orderedIds
      .map((id) => byId.get(id))
      .filter((r): r is MemoryRow => !!r)
      .map((r): JourneyRecord => {
        const served = toServedRecord(r, verifyMap.get(r.id) ?? { verified: false, turn_idx: r.turn_idx }, ctx);
        // Spend attribution (2026-09-13, §4): only an outcome carries the
        // session's cost -- see this file's header comment.
        return r.kind === "outcome" ? { ...served, cost_usd: header.cost_usd } : served;
      });
  };

  const threadKeys = [...byThread.keys()].filter((k): k is string => k !== null);
  threadKeys.sort((a, b) => {
    const minA = Math.min(...(byThread.get(a) ?? []).map((r) => r.turn_idx));
    const minB = Math.min(...(byThread.get(b) ?? []).map((r) => r.turn_idx));
    return minA - minB;
  });

  const journey: JourneyThread[] = threadKeys.map((thread) => {
    const group = byThread.get(thread) ?? [];
    const idxs = group.map((r) => r.turn_idx);
    const lo = Math.min(...idxs);
    const hi = Math.max(...idxs);
    return { thread, turn_range: [lo, hi], records: orderGroup(group), files_touched: filesInRange(lo, hi) };
  });

  const unsorted = byThread.get(null) ?? [];
  if (unsorted.length > 0) {
    journey.push({ thread: null, turn_range: null, records: orderGroup(unsorted), files_touched: [] });
  }

  await recordRecallEvent(supabase, userId, "session_summary", {
    recordIds: liveRows.map((r) => r.id),
    recallToken: args.recall_token,
    codeSessionId: session.id,
  });

  return { header, journey };
}
