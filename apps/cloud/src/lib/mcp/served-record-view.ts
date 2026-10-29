// Compact MCP serialization of `ServedRecord` (feedback F-022/F-023/F-017,
// docs/FEEDBACK.md) plus the session-level ref lookup memory_search and
// memory_recall attach to it.
//
// F-022/F-023: `ServedRecord` (memory/verify.ts) is serialized with every
// field, including nulls, and every served record shows `verified: true,
// confidence: 1` -- neither carries information since only verified records
// are ever ranked above an unverified one and 1 is confidence's default.
// This module is the MCP-tool-only view: the internal `ServedRecord` shape
// (verify.ts, toServedRecord) is unchanged, and every OTHER caller
// (preamble.ts, relevance.ts, session_summary) still gets the full record.
//
// F-017: "most records have ref: null" -- `ref` is the record's OWN receipt
// (its `code_session_issues` row when the record itself is an outcome), not
// what else the session touched. `session_refs` adds the session's other
// refs, restricted to STRUCTURED evidence per the "observed over inferred"
// rule (see MODEL_INFERRED_SOURCE below).

import type { Db } from "@/lib/db/types";
import { blockerAge } from "@/lib/domain/blockers";
import { log } from "@/lib/log";
import { issueLinkPhrase, refLabel, shortRefToken } from "@/lib/memory/ref-label";
import { asOfDay } from "@/lib/memory/serve-filter";
import type { ServedRecord } from "@/lib/memory/verify";

/** memory_search/memory_recall cap (brief: "at most 5 refs per record"). */
const MAX_SESSION_REFS = 5;

/**
 * D-057 (migration 111_session_issues_model_segment.sql): a `code_session_issues`
 * row whose build rung was raised by the model's own reading of the session
 * (lib/memory/session-association.ts, a "model segment") rather than
 * observed branch/PR/commit evidence carries `source: 'model_segment'`.
 * Every other row -- 099's evidence_quote-grounded extractor/observed rows,
 * and every row written before 111 -- carries `source: null`. "Observed
 * over inferred" (MEMORY.md): session_refs excludes model-sourced rows.
 */
const MODEL_INFERRED_SOURCE = "model_segment";

/**
 * D-053/W4 (103_code_session_issues_profile.sql, 108_session_issues_inferred_ref_tier.sql):
 * `tier` records how the row's ref was attached. 103's comment: rows carry
 * "what the session OBSERVABLY did on the ref, folded from its turns'
 * structured actions" -- that is `tier: 'observed'`, backed by a
 * review_verb/build_verb the session actually performed. Every other tier is
 * inference or discussion, not structured evidence: 'discussed' (103, a
 * model-grounded quote or a bare mention, no verb), 'inferred' (105, "a row
 * from a session with no structured actions", extractor-read), 'inferred_ref'
 * (108, the action was observed but "only its ref is inferred" -- the exact
 * thing session_refs serves). "Observed over inferred" (MEMORY.md): keep only
 * the evidence-derived tier, or no tier at all (rows written before 103).
 */
const EVIDENCE_TIER = "observed";

/**
 * A served handoff note is cut to this many characters (about 200 tokens): a note runs to thousands of characters and
 * would crowd the result's token budget. The full note is one `get_code_session` away (the record carries session_id).
 */
export const HANDOFF_SERVED_MAX_CHARS = 800;

export function truncateHandoffText(text: string): string {
  if (text.length <= HANDOFF_SERVED_MAX_CHARS) return text;
  return `${text.slice(0, HANDOFF_SERVED_MAX_CHARS).trimEnd()}… [truncated; open session_id with get_code_session for the full note]`;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/** The MCP-served shape: `ServedRecord`'s fields, minus anything empty, `quote` before `text` (F-003), `verified` only when false, `confidence` only when != 1, plus `session_refs`. Field names that existing callers depend on (id/kind/when/ref/session_id/turn_idx) are unchanged. */
export interface CompactServedRecord {
  id: string;
  kind: ServedRecord["kind"];
  source?: ServedRecord["source"];
  quote?: string;
  text: string;
  ref?: string;
  /** W3 D10: `#123 Title` (ref-label.ts, shared with the preamble); `#123` with no known title. */
  ref_label?: string;
  /** D-071: an MR ref's issue with its basis — "for #12" (stated) or "probably for #12" (inferred). */
  ref_issue?: string;
  /** The ref's forge page when its host is known (never guessed): open it, then check its state live. */
  ref_url?: string;
  session_id: string;
  session_refs?: string[];
  agent_id?: string;
  turn_idx: number;
  turn_role?: ServedRecord["turn_role"];
  repo?: string;
  branch?: string;
  /** The commit the session was on (`head_sha`, full). */
  sha?: string;
  /** Files the record names, at most 5. */
  paths?: string[];
  merged_at?: string;
  when: string;
  /** L2/D-074: the day (UTC) the record's session recorded it: "true when recorded", never current state. */
  as_of: string;
  /** L2: how many distinct sessions told this same fact (paraphrases collapsed into this record). Only when > 1. */
  seen_in?: number;
  /** L2: ids of the same-fact records collapsed into this one; open them with get_code_session. */
  collapsed_ids?: string[];
  /** L2: only with include_superseded or a past date phrase: the record that replaced this one, and the day. */
  superseded_by?: { id: string; on: string };
  /** #436: a blocker's age from `when`, e.g. "3d ago" (lib/domain/blockers.ts). Blockers only. */
  age?: string;
  durable: boolean;
  verified?: false;
  confidence?: number;
  chat_precontext?: string;
}

/** A record's D10 ref fields (migration 117), read beside the served record. */
export interface RecordRefInfo {
  ref_title: string | null;
  ref_issue: string | null;
  ref_issue_basis: string | null;
}

/** One served record -> its compact MCP shape. Pure; `sessionRefs` (already capped/ordered/deduped) is attached only when non-empty; `refInfo` adds `ref_label`/`ref_issue` when the record has a ref. */
export function compactServedRecord(
  record: ServedRecord,
  sessionRefs?: readonly string[],
  refInfo?: RecordRefInfo,
  now: number = Date.now(),
  /** memory_get opens a record whole: a handoff note is not cut to HANDOFF_SERVED_MAX_CHARS. */
  wholeHandoff = false,
): CompactServedRecord {
  const out = {} as CompactServedRecord;
  out.id = record.id;
  out.kind = record.kind;
  if (!isEmpty(record.source)) out.source = record.source;
  if (!isEmpty(record.quote)) out.quote = record.quote as string;
  out.text = (record.kind as string) === "handoff" && !wholeHandoff ? truncateHandoffText(record.text) : record.text;
  if (!isEmpty(record.ref)) {
    out.ref = record.ref as string;
    if (refInfo) {
      // The repo is kept when the ref names another repo than the record's project (`record.repo`).
      out.ref_label = refLabel(shortRefToken(out.ref, record.repo), refInfo.ref_title);
      const phrase = issueLinkPhrase(refInfo.ref_issue, refInfo.ref_issue_basis, record.repo);
      if (phrase) out.ref_issue = phrase;
    }
    if (!isEmpty(record.ref_url)) out.ref_url = record.ref_url as string;
  }
  out.session_id = record.session_id;
  if (sessionRefs && sessionRefs.length > 0) out.session_refs = [...sessionRefs];
  if (!isEmpty(record.agent_id)) out.agent_id = record.agent_id as string;
  out.turn_idx = record.turn_idx;
  if (!isEmpty(record.turn_role)) out.turn_role = record.turn_role;
  if (!isEmpty(record.repo)) out.repo = record.repo as string;
  if (!isEmpty(record.branch)) out.branch = record.branch as string;
  if (!isEmpty(record.sha)) out.sha = record.sha as string;
  if (record.paths && record.paths.length > 0) out.paths = [...record.paths];
  if (!isEmpty(record.merged_at)) out.merged_at = record.merged_at as string;
  out.when = record.when;
  if (record.kind === "blocker") out.age = blockerAge(record.when, now);
  out.as_of = asOfDay(record.when);
  if (record.seen_in && record.seen_in > 1) out.seen_in = record.seen_in;
  if (record.collapsed_ids?.length) out.collapsed_ids = record.collapsed_ids;
  if (record.superseded_by) out.superseded_by = record.superseded_by;
  out.durable = record.durable;
  // Rule (b): only verified records are ever served flagged true (rankAndServe
  // never drops an unverified one -- it ranks last instead), so `verified:
  // true` is the default and carries no information; only the false case is worth a byte.
  if (record.verified === false) out.verified = false;
  // Rule (c): 1 is confidence's write-time default (schema.ts) -- only a
  // non-default value is informative.
  if (record.confidence !== 1) out.confidence = record.confidence;
  if (!isEmpty(record.chat_precontext)) out.chat_precontext = record.chat_precontext as string;
  return out;
}

interface SessionIssueRefRow {
  session_id: string;
  ref: string;
  source: string | null;
  tier: string | null;
}

/**
 * Batched: ONE query for every `session_id` the caller's records carry,
 * deduplicated -- never per record. Rows are already ordered most-recent
 * first (`created_at desc`, then `id desc` to break same-timestamp ties
 * deterministically), so per-session capping while iterating keeps that
 * order without a second sort. Model-sourced rows (D-057) and non-evidence
 * tiers (see EVIDENCE_TIER) are excluded before the cap, never counted
 * against it.
 *
 * Degrade, never fail: prod (migration 110) predates `source` (111). A
 * missing-column error, or any other query/thrown error, is logged once and
 * swallowed -- records are still served, just without `session_refs`, rather
 * than failing the whole memory_search/memory_recall call.
 */
export async function fetchSessionRefs(
  supabase: Db,
  sessionIds: readonly string[],
  userId: string,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return out;

  try {
    const { data, error } = await supabase
      .from("code_session_issues")
      .select("session_id, ref, source, tier")
      .eq("user_id", userId)
      .in("session_id", ids)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (error) {
      log.warn("[session_refs] fetchSessionRefs query failed, serving without session_refs", {
        error: error.message,
      });
      return out;
    }

    for (const row of (data ?? []) as SessionIssueRefRow[]) {
      if (row.source === MODEL_INFERRED_SOURCE) continue; // observed over inferred: exclude model-segment rows
      if (row.tier !== null && row.tier !== EVIDENCE_TIER) continue; // exclude inferred/discussed tiers
      let list = out.get(row.session_id);
      if (!list) {
        list = [];
        out.set(row.session_id, list);
      }
      if (list.length < MAX_SESSION_REFS && !list.includes(row.ref)) list.push(row.ref);
    }
    return out;
  } catch (err) {
    log.warn("[session_refs] fetchSessionRefs threw, serving without session_refs", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

/**
 * W3 D10: `ref_title`/`ref_issue`/`ref_issue_basis` of the records that carry
 * a ref -- ONE query, explicit `user_id` filter. Degrades like
 * fetchSessionRefs: any error serves the records without labels.
 */
export async function fetchRecordRefInfo(
  supabase: Db,
  recordIds: readonly string[],
  userId: string,
): Promise<Map<string, RecordRefInfo>> {
  const ids = [...new Set(recordIds)];
  if (ids.length === 0) return new Map();
  try {
    const { data, error } = await supabase
      .from("session_memories")
      .select("id, ref_title, ref_issue, ref_issue_basis")
      .eq("user_id", userId)
      .in("id", ids);
    if (error) {
      log.warn("[ref_label] fetchRecordRefInfo query failed, serving without ref labels", { error: error.message });
      return new Map();
    }
    return new Map(
      ((data ?? []) as Array<{ id: string } & Partial<RecordRefInfo>>).map((r) => [
        r.id,
        { ref_title: r.ref_title ?? null, ref_issue: r.ref_issue ?? null, ref_issue_basis: r.ref_issue_basis ?? null },
      ]),
    );
  } catch (err) {
    log.warn("[ref_label] fetchRecordRefInfo threw, serving without ref labels", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

/** `ServedRecord[]` -> `CompactServedRecord[]`, with `session_refs` and ref labels attached from batched lookups. What memory_search/memory_recall actually serve. */
export async function compactServedRecords(
  supabase: Db,
  records: readonly ServedRecord[],
  userId: string,
  now: number = Date.now(),
  wholeHandoff = false,
): Promise<CompactServedRecord[]> {
  const [refsBySession, refInfo] = await Promise.all([
    fetchSessionRefs(
      supabase,
      records.map((r) => r.session_id),
      userId,
    ),
    fetchRecordRefInfo(
      supabase,
      records.filter((r) => !isEmpty(r.ref)).map((r) => r.id),
      userId,
    ),
  ]);
  return records.map((r) =>
    compactServedRecord(r, refsBySession.get(r.session_id), refInfo.get(r.id), now, wholeHandoff),
  );
}
