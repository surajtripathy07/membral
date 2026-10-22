// Continuation self-recall: when a harness session is continued (Claude Code's
// auto-compaction or `/compact` summary, or a SessionStart `compact`/`resume`),
// serve what THAT session already recorded -- its own decisions, outcomes and
// findings, plus its sub-agents' -- instead of a topic search over a long
// summary. The summary keeps the thread of the work but drops details
// (rulings, measured results, the file a finding was about); the store kept
// them when the session was uploaded earlier.
//
// Data layer only: the session-scoped read and the ranking. prompt-recall.ts
// collapses, caps and renders (it owns the line shape), so this file has no
// import back into it.
//
// The read is a direct filtered select on code_sessions (the unique
// (user_id, source, source_session_id) index and the partial parent index)
// and session_memories by code_session_id -- never memory_search_scored,
// whose cost is a search's, not a lookup's.
//
// The store holds a session only once it has been uploaded (the SessionEnd
// hook, or the sweep for a running session) and extracted, which takes about
// 20 minutes or more. A session continued sooner simply has no records yet,
// and the caller serves nothing from this path.

import type { Db } from "@/lib/db/types";
import { buildServeContext, MEMORY_ROW_COLUMNS, type MemoryRow, type ServedRecord, toServedRecord } from "./verify";

/** The harnesses whose continuation this path understands. Claude Code first. */
export const SELF_RECALL_HARNESSES = ["claude-code"] as const;
export type SelfRecallHarness = (typeof SELF_RECALL_HARNESSES)[number];

export interface SelfRecallTarget {
  /** The harness session id (code_sessions.source_session_id). */
  sourceSessionId: string;
  harness: SelfRecallHarness;
}

/** Ranked candidates handed to the caller, before its dedupe and cap. */
export const SELF_RECALL_CANDIDATES = 40;
/** Sub-agent sessions read per `.in()` chunk (current-work.ts SESSION_ID_CHUNK: an unbounded list overflowed the URL). */
const SESSION_CHUNK = 100;
/** A long session with many sub-agents: at most this many sub-agent sessions are read. */
const MAX_SUBAGENT_SESSIONS = 500;
/** Per chunk, the memory rows read. */
const MEMORY_ROWS_PER_CHUNK = 500;
/** Decisions, outcomes and findings (the design note, "Continuation self-recall"); blockers are left out: they go stale. */
const SELF_KINDS = ["decision", "outcome", "learning"];
/** A ref this path links (#458's ref_url): an issue or a PR/MR. */
const LINKED_REF_KINDS = new Set(["issue", "pr", "mr", "merge_request"]);

type SelfRow = MemoryRow & { priority?: boolean | null };

/**
 * Rank tier, lower first: 0 decisions and outcomes; 1 findings (learnings) that name files; 2 any other record that
 * carries an issue/PR ref; 3 the rest (findings without paths). Pure.
 */
export function selfRecallTier(row: Pick<MemoryRow, "kind" | "paths" | "ref" | "ref_kind">): number {
  if (row.kind === "decision" || row.kind === "outcome") return 0;
  if (row.kind === "learning" && (row.paths ?? []).some((p) => typeof p === "string" && p.trim())) return 1;
  if (row.ref?.trim() && LINKED_REF_KINDS.has((row.ref_kind ?? "").toLowerCase())) return 2;
  return 3;
}

/**
 * Orders a session's rows: tier (selfRecallTier), then priority-flagged first, then the continued session's own rows
 * before its sub-agents', then the later turn first (the latest ruling on a thread is the one that stands), then id
 * for a stable order. Pure.
 */
export function rankSelfRows<T extends SelfRow>(rows: readonly T[], mainSessionIds: ReadonlySet<string>): T[] {
  const key = (r: T) => [
    selfRecallTier(r),
    r.priority ? 0 : 1,
    mainSessionIds.has(r.code_session_id) ? 0 : 1,
    -(r.turn_idx ?? 0),
  ];
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface SelfRecallLoad {
  /** Whether the store has the session at all (false: never uploaded, or another user's). */
  found: boolean;
  /** The session plus sub-agent session count read. */
  sessions: number;
  /** Ranked, served-shape candidates (at most SELF_RECALL_CANDIDATES); verified and live only. */
  records: ServedRecord[];
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * The continued session's own verified, live records and its sub-agents', ranked. User-scoped on every read; a key
 * bound to one code project (codeScopeId) sees the session only when it belongs to that project.
 */
export async function loadSessionSelfRecords(
  db: Db,
  userId: string,
  codeScopeId: string | null,
  target: SelfRecallTarget,
): Promise<SelfRecallLoad> {
  const sessionQuery = (col: "source_session_id" | "parent_source_session_id", limit: number) => {
    let q = db
      .from("code_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("source", target.harness)
      .eq(col, target.sourceSessionId);
    if (codeScopeId) q = q.eq("code_project_id", codeScopeId);
    return q.order("id", { ascending: true }).limit(limit);
  };
  const [mainRes, subRes] = await Promise.all([
    sessionQuery("source_session_id", 1),
    sessionQuery("parent_source_session_id", MAX_SUBAGENT_SESSIONS),
  ]);
  if (mainRes.error) throw new Error(`self recall: session read failed: ${mainRes.error.message}`);
  if (subRes.error) throw new Error(`self recall: sub-agent read failed: ${subRes.error.message}`);
  const mainIds = ((mainRes.data ?? []) as { id: string }[]).map((r) => r.id);
  const subIds = ((subRes.data ?? []) as { id: string }[]).map((r) => r.id).filter((id) => !mainIds.includes(id));
  if (mainIds.length === 0 && subIds.length === 0) return { found: false, sessions: 0, records: [] };

  const allIds = [...mainIds, ...subIds];
  // The main session is read on its own, with its own limit, so a large sub-agent family cannot crowd it out of a
  // shared chunk. Every limited read is ordered (latest turn first, id for ties), never left to the DB's whim.
  const memoryQuery = (ids: string[]) =>
    db
      .from("session_memories")
      .select(`${MEMORY_ROW_COLUMNS}, priority`)
      .eq("user_id", userId)
      .in("code_session_id", ids)
      .in("kind", SELF_KINDS)
      .eq("verified", true)
      .is("retired_at", null)
      .order("turn_idx", { ascending: false })
      .order("id", { ascending: true })
      .limit(MEMORY_ROWS_PER_CHUNK);
  const results = await Promise.all([
    ...(mainIds.length > 0 ? [memoryQuery(mainIds)] : []),
    ...chunks(subIds, SESSION_CHUNK).map(memoryQuery),
  ]);
  const rows: SelfRow[] = [];
  for (const res of results) {
    if (res.error) throw new Error(`self recall: memory read failed: ${res.error.message}`);
    rows.push(...((res.data ?? []) as unknown as SelfRow[]));
  }
  const ranked = rankSelfRows(rows, new Set(mainIds)).slice(0, SELF_RECALL_CANDIDATES);
  if (ranked.length === 0) return { found: true, sessions: allIds.length, records: [] };
  const ctx = await buildServeContext(db, userId, ranked);
  // The stored `verified` flag is the extraction-time receipt check; this path does not re-read turns.
  const records = ranked.map((r) => toServedRecord(r, { verified: r.verified, turn_idx: r.turn_idx }, ctx));
  return { found: true, sessions: allIds.length, records };
}

/** The topic-search fallback's query is cut to this. */
export const CONTINUATION_FOCUS_MAX_CHARS = 800;

/** A section heading in a continuation summary: `4. Pending items:`, `## Next steps`, `**Current work**:`. */
const HEADING_RE =
  /^(?:\d+[.)]\s+([A-Z][^\n]{0,80}?):\s*$|#{1,6}\s+([^\n]{1,80}?)\s*:?\s*$|\*\*([^*\n]{1,80}?):?\*\*:?\s*$)/;
/** Section titles the fallback reads, in the order it reads them: what is next, then what is open, then what was in hand. */
const FOCUS_TITLES: readonly RegExp[] = [/\bnext\b/i, /\bpending\b/i, /\bcurrent work\b/i];
/** The harness's closing instructions (where the transcript lives, how to resume) are not the work. */
const TRAILER_RE = /full transcript at:|^continue the conversation from where it left off/i;

/**
 * The part of a continuation summary the topic-search fallback searches on: the bodies of its "next step", "pending"
 * and "current work" sections, in that order, cut to CONTINUATION_FOCUS_MAX_CHARS; with no such section, the last
 * CONTINUATION_FOCUS_MAX_CHARS characters before the harness's closing instructions. Idempotent on its own output
 * (a heading-free text under the cap comes back unchanged), so the CLI and the route may both apply it. Pure;
 * mirrored in packages/cli/src/prompt-hook.ts.
 */
export function continuationFocusText(summary: string): string {
  const lines = summary.split(/\r?\n/);
  // The harness's closing instructions sit at the END; an earlier quoted pointer in the body must not cut it short.
  const lastIndex = (re: RegExp) => {
    for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i].trim())) return i;
    return -1;
  };
  const pointerAt = lastIndex(/full transcript at:/i);
  const end = pointerAt >= 0 ? pointerAt : lastIndex(TRAILER_RE);
  const body = end >= 0 ? lines.slice(0, end) : lines;
  const sections: { title: string; text: string[] }[] = [];
  let cur: { title: string; text: string[] } | null = null;
  for (const line of body) {
    const m = HEADING_RE.exec(line);
    if (m) {
      cur = { title: (m[1] ?? m[2] ?? m[3] ?? "").trim(), text: [] };
      sections.push(cur);
    } else if (cur) {
      cur.text.push(line);
    }
  }
  const picked: string[] = [];
  for (const title of FOCUS_TITLES) {
    // The LAST non-empty matching section: a summary can quote an earlier one in its body.
    for (let i = sections.length - 1; i >= 0; i--) {
      if (!title.test(sections[i].title)) continue;
      const text = sections[i].text.join("\n").trim();
      if (!text) continue;
      if (!picked.includes(text)) picked.push(text);
      break;
    }
  }
  if (picked.length > 0) return picked.join("\n").slice(0, CONTINUATION_FOCUS_MAX_CHARS).trim();
  return body.join("\n").trim().slice(-CONTINUATION_FOCUS_MAX_CHARS).trim();
}
