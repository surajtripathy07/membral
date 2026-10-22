// G2 step 2.4a: the pure half of `insertMemoryRecords` (write/io.ts). Given the
// records and the rows this session already has for their content hashes,
// `planInsert` decides which batch each record goes in, which rows get their
// `rerun` reason set back, and which recurrence roots to count. write/io.ts keeps
// every read and write, in the same order as before.
import { RERUN_RETIRE_REASON, UNVERIFIED_RETIRE_PREFIX } from "@/lib/domain/retire-reasons";
import { embeddingModelField } from "@/lib/llm/embedding-client";
import { toVectorString } from "../embed";
import type { EmbeddedGroundedRecord } from "../merge";

export interface InsertedRow {
  id: string;
  content_hash: string;
  retired_at?: string | null;
  verified?: boolean;
}

/** Retire reasons a re-derived, now-GROUNDED record may lift (review v6 M4a): the fact is back, verified, from the same session. */
function isLiftableRetireReason(reason: string | null): boolean {
  return reason === RERUN_RETIRE_REASON || isRetiredUnverified(reason);
}

/** The `retire_reason` stored for a record that failed grounding: `unverified:<reason>`, or bare `unverified` when the reason is unknown. */
export function unverifiedRetireReason(reason: string | null | undefined): string {
  return reason ? `${UNVERIFIED_RETIRE_PREFIX}:${reason}` : UNVERIFIED_RETIRE_PREFIX;
}

/** A record ready for `insertMemoryRecords`; `retireReason` inserts it retired for that reason (wins over a grounding failure). */
export type InsertableRecord = EmbeddedGroundedRecord & {
  retireReason?: string;
  /** B7: the id of the earliest live row (another session, same kind) this record recurs; set by `dropCrossSessionDuplicates`, written to `recurs_of`. */
  recursOf?: string;
  /** e2e review N2: false on a second, distinct record of one session in a chain this session already counted — written with `recurs_of`, never counted again. */
  countsRecurrence?: boolean;
};

/** True when a row's `retire_reason` marks it retired by grounding (the only kind `--reverify` may bring back). */
export function isRetiredUnverified(retireReason: string | null): boolean {
  return retireReason === UNVERIFIED_RETIRE_PREFIX || (retireReason ?? "").startsWith(`${UNVERIFIED_RETIRE_PREFIX}:`);
}

export type InsertRow = Record<string, unknown> & { content_hash: string; kind: string };

/** A row this session already holds for one of the records' content hashes. */
export type ExistingRow = InsertedRow & { retire_reason: string | null };

/** The columns every row of one `insertMemoryRecords` call shares; `retiredAt` stamps rows inserted retired. */
export interface InsertContext {
  userId: string;
  codeProjectId: string;
  sessionId: string;
  branch: string | null;
  retiredAt: string;
  /** The session's `short_title`, written as `session_title` (migration 122: lexical index only). */
  sessionTitle?: string | null;
}

/** What `insertMemoryRecords` writes, in the order it writes it. */
export interface InsertPlan {
  keepLive: InsertRow[];
  lift: InsertRow[];
  insertRetired: InsertRow[];
  /** Existing rows returned as-is, no write. */
  matchedOnly: InsertedRow[];
  /** `unverified:<reason>` -> ids of rows retired `rerun` to re-tag with it. */
  reasonBack: Map<string, string[]>;
  /** Recurrence root id -> how many new facts of this session recur it. */
  recurrenceIncrements: Map<string, number>;
}

function retireReasonFor(r: InsertableRecord): string | null {
  return r.retireReason ?? (r.verified ? null : unverifiedRetireReason(r.unverifiedReason));
}

function toRow(r: InsertableRecord, ctx: InsertContext): InsertRow {
  const retireReason = retireReasonFor(r);
  return {
    user_id: ctx.userId,
    code_session_id: ctx.sessionId,
    code_project_id: ctx.codeProjectId,
    agent_id: null,
    source: "extractor" as const,
    kind: r.kind,
    text: r.text,
    quote: r.quote,
    turn_idx: r.turn_idx,
    turn_role: r.turn_role,
    ref: r.ref,
    ref_kind: r.ref_kind,
    // Migration 117 (D10): grounded in merge.ts's groundRecord; null otherwise.
    ref_title: r.ref_title ?? null,
    ref_issue: r.ref_issue ?? null,
    ref_issue_basis: r.ref_issue ? (r.ref_issue_basis ?? null) : null,
    branch: ctx.branch,
    head_sha: null, // design §2: "no head sha captured today"
    thread: r.thread,
    // Migration 122: the key is sent only with a title, so an untitled session's
    // insert works against a pre-122 database.
    ...(ctx.sessionTitle ? { session_title: ctx.sessionTitle } : {}),
    paths: r.paths,
    verified: r.verified,
    durable: r.durable,
    scope: r.scope,
    confidence: r.confidence,
    content_hash: r.contentHash,
    // Migration 108: the extractor's own read of the owner's words, ground-
    // truth-gated in merge.ts's groundRecord (user-turn only) — never a
    // heuristic applied here.
    priority: r.priority === true,
    // step2d finding 8: `null` when this record's embed batch failed
    // (embed.ts) — the column is nullable; never a fabricated zero vector,
    // which would look like a real (and wrong) embedding to cosine dedupe.
    embedding: r.embedding ? toVectorString(r.embedding) : null,
    // Migration 118 (D-072): a non-default family is recorded with its vector.
    // The default family omits the key (NULL means default), so the hosted
    // app works against a pre-118 database.
    ...embeddingModelField(r.embedding !== null && r.embedding !== undefined),
    // R2-m4: every row carries the key (column-homogeneous batches).
    extraction_pass: r.userPass ? "user" : null,
    // B7: the earliest live row (another session, same kind) this record
    // recurs, or null. Always present so the batch stays column-homogeneous.
    recurs_of: r.recursOf ?? null,
    ...(retireReason === null ? {} : { retired_at: ctx.retiredAt, retire_reason: retireReason }),
  };
}

/**
 * Review v6 M4: the upsert target (user, session, content_hash) can hit a
 * row from an earlier run. Merge rule, per candidate:
 *   verified,   no row / live row      -> upsert (row stays live)
 *   verified,   row retired rerun|unverified -> upsert AND un-retire (the
 *               same fact re-derived and grounded again; M4a)
 *   verified,   row retired otherwise (duplicate, preference_assistant_turn,
 *               pre-086 NULL) -> upsert, stays retired (never resurrected)
 *   verified + explicit retireReason (P8 resolved_in_session),
 *               no row / live row / row retired rerun|unverified
 *                                      -> upsert retired with that reason
 *   verified + explicit retireReason, row retired otherwise -> NO write
 *   unverified, no row                 -> insert already retired (decision B;
 *               an explicit retireReason wins over `unverified:<reason>`)
 *   unverified, any existing row       -> NO write: an ungrounded re-extraction
 *               never overwrites or retires an existing row (M4b) — except
 *               a row retired `rerun`, whose reason alone is set back to
 *               `unverified:<reason>` (R2-m3: a --force run re-tags the old
 *               extraction's unverified rows `rerun` BEFORE this insert; a
 *               fact this run re-derives is this run's again, and stays
 *               open to --reverify)
 * Each batch is column-homogeneous: a mixed-key batch upsert would null out
 * `retired_at` on rows that never set it.
 *
 * B7: count each recurrence on the chain's earliest row. Only a record this
 * session had NO prior row for (any state) counts — a re-run or --force
 * re-deriving the same fact must not bump the count a second time.
 */
export function planInsert(
  records: InsertableRecord[],
  existing: ReadonlyMap<string, ExistingRow>,
  ctx: InsertContext,
): InsertPlan {
  const keepLive: InsertRow[] = [];
  const lift: InsertRow[] = [];
  const insertRetired: InsertRow[] = [];
  const matchedOnly: InsertedRow[] = [];
  const reasonBack = new Map<string, string[]>();
  for (const r of records) {
    const prior = existing.get(r.contentHash);
    if (r.verified && r.retireReason) {
      if (!prior?.retired_at || isLiftableRetireReason(prior.retire_reason)) {
        insertRetired.push(toRow(r, ctx));
      } else {
        matchedOnly.push(prior);
      }
    } else if (r.verified) {
      if (prior?.retired_at && isLiftableRetireReason(prior.retire_reason)) {
        lift.push({ ...toRow(r, ctx), retired_at: null, retire_reason: null });
      } else {
        keepLive.push(toRow(r, ctx));
      }
    } else if (prior) {
      matchedOnly.push(prior);
      if (prior.retired_at && prior.retire_reason === RERUN_RETIRE_REASON) {
        const reason = retireReasonFor(r) ?? unverifiedRetireReason(r.unverifiedReason);
        reasonBack.set(reason, [...(reasonBack.get(reason) ?? []), prior.id]);
      }
    } else {
      insertRetired.push(toRow(r, ctx));
    }
  }

  const recurrenceIncrements = new Map<string, number>();
  for (const r of records) {
    if (r.recursOf && r.countsRecurrence !== false && r.verified && !r.retireReason && !existing.has(r.contentHash)) {
      recurrenceIncrements.set(r.recursOf, (recurrenceIncrements.get(r.recursOf) ?? 0) + 1);
    }
  }

  return { keepLive, lift, insertRetired, matchedOnly, reasonBack, recurrenceIncrements };
}
