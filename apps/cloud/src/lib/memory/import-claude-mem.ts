// claude-mem observations -> Membral memory records (goal 2026-10-25 box 3.2).
// Pure mapping and re-anchoring live here; the route does the I/O.
//
// What an imported record is: source "claude-mem", linked to the user's Membral
// code_session whose source_session_id equals claude-mem's content_session_id
// (an observation with no such session is skipped, never invented), and carrying
// a QUOTE only when the observation text appears verbatim in one of that
// session's stored turns (re-anchor); otherwise quote is null, verified false.
//
// Embeddings: left null. insertMemoryRecords takes an embedding from its caller
// and this path calls no paid API; keyword search (text_fts) still finds these.
import { createHash } from "node:crypto";
import { redactPii, redactSecrets } from "@membral/core";
import { z } from "zod";
import { type GroundingTurn, groundAgainstTurns } from "./grounding";
import { normalizeQuote } from "./normalize";

export const CLAUDE_MEM_SOURCE = "claude-mem";
export const MAX_OBSERVATIONS_PER_REQUEST = 100;
/** Bounds the turn reads and grounding work one request can trigger. */
export const MAX_SESSIONS_PER_REQUEST = 25;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** A quote longer than this is not stored; such an observation is imported un-quoted. */
export const MAX_QUOTE_CHARS = 2000;
/** Below this an exact match proves nothing (a short phrase matches anywhere). */
export const MIN_ANCHOR_CHARS = 20;
/** Most recent prose turns scanned per session for an anchor; older ones are not (bounds the work per request). */
export const MAX_GROUNDING_TURNS = 5_000;
export const MAX_TEXT_CHARS = 4000;
export const MAX_TITLE_CHARS = 500;
/** Hard ceiling on a raw field before redaction; anything longer is a malformed request, not a long note. */
const MAX_RAW_FIELD_CHARS = 100_000;

/** Redact credentials and phone/email shapes, then cap: a long field is truncated, never a reason to reject the batch. */
export function cleanText(s: string, cap: number): string {
  return redactPii(redactSecrets(s)).slice(0, cap);
}
const field = (cap: number) =>
  z
    .string()
    .max(MAX_RAW_FIELD_CHARS)
    .transform((s) => cleanText(s, cap));

export const claudeMemObservationSchema = z.object({
  contentSessionId: z.string().min(1).max(200),
  type: z.string().min(1).max(64),
  title: field(MAX_TITLE_CHARS).nullable(),
  narrative: field(MAX_TEXT_CHARS).nullable(),
  body: field(MAX_TEXT_CHARS).nullable(),
  promptNumber: z.number().int().min(0).max(1_000_000).nullable(),
  createdAt: z.string().max(64).nullable(),
  /** sha256 hex of the RAW (pre-redaction, pre-cap) title/narrative/body, computed by the CLI. Optional for older CLIs. */
  rawHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullish(),
});
export const claudeMemImportBodySchema = z
  .object({
    observations: z.array(claudeMemObservationSchema).min(1).max(MAX_OBSERVATIONS_PER_REQUEST),
  })
  .refine((b) => new Set(b.observations.map((o) => o.contentSessionId)).size <= MAX_SESSIONS_PER_REQUEST, {
    message: `at most ${MAX_SESSIONS_PER_REQUEST} distinct sessions per request`,
  });
export type ClaudeMemObservationInput = z.infer<typeof claudeMemObservationSchema>;

export type MemoryKind = "outcome" | "decision" | "learning" | "blocker" | "preference";

/**
 * claude-mem observation type -> Membral kind. Closest meaning, never "outcome"
 * (needs a ref) or "preference" (needs a user turn). Unknown types -> learning.
 *   decision -> decision;  bugfix, feature, refactor, change, discovery -> learning
 */
const KIND_BY_TYPE: Record<string, MemoryKind> = {
  decision: "decision",
  bugfix: "learning",
  feature: "learning",
  refactor: "learning",
  change: "learning",
  discovery: "learning",
};
export function kindForType(type: string): MemoryKind {
  return KIND_BY_TYPE[type.toLowerCase()] ?? "learning";
}

export function recordText(o: Pick<ClaudeMemObservationInput, "title" | "narrative" | "body">): string {
  const detail = o.narrative ?? o.body ?? "";
  return (o.title && detail ? `${o.title}: ${detail}` : o.title || detail).slice(0, MAX_TEXT_CHARS);
}

/**
 * Stable per observation content, so a re-run hits unique (user_id, code_session_id, content_hash).
 * Hashes the CLI's rawHash (over the raw text, so a later change to redaction rules or caps does not
 * change the hash and insert duplicates); an older CLI sends none and the redacted text is hashed instead.
 */
export function contentHashFor(kind: MemoryKind, text: string, rawHash?: string | null): string {
  return createHash("sha256")
    .update(`${CLAUDE_MEM_SOURCE}\0${kind}\0${rawHash ? `raw:${rawHash}` : text}`)
    .digest("hex");
}

export interface StoredTurn {
  idx: number;
  role: string;
  kind?: string | null;
  text: string | null;
  props?: Record<string, unknown> | null;
}
export interface Anchor {
  quote: string;
  idx: number;
  role: "user" | "assistant";
}

/** A turn a quote may be taken from: prose, with text, that the owner or the assistant actually said (not a compaction summary, shell output or caveat). */
function isQuotableTurn(t: StoredTurn): boolean {
  return t.kind === "prose" && !!t.text && !t.props?.nonOwner;
}

const REDACTION_MARKER = /\[redacted\]/i;
/** Earliest plausible observation time; anything older is a bad clock or a zero epoch. */
const MIN_CREATED_AT_MS = Date.UTC(2000, 0, 1);

/** A session's turns normalised ONCE (PII-redacted, then normalizeQuote, exactly as quoteMatchesTurnText does). */
export interface PreparedTurns {
  all: StoredTurn[];
  quotable: GroundingTurn[];
  norm: string[];
  /** True when older prose turns were dropped to fit MAX_GROUNDING_TURNS: positions and anchors are then unreliable. */
  truncated: boolean;
}
export function prepareTurns(turns: StoredTurn[], truncated = false): PreparedTurns {
  let all = turns;
  if (all.length > MAX_GROUNDING_TURNS) {
    all = all.slice(-MAX_GROUNDING_TURNS);
    truncated = true;
  }
  const quotable = all.filter(isQuotableTurn).map((t) => ({
    idx: t.idx,
    role: t.role,
    text: t.text,
    props: t.props ?? null,
  }));
  return { all, quotable, norm: quotable.map((t) => normalizeQuote(redactPii(t.text ?? ""))), truncated };
}
const preparedCache = new WeakMap<StoredTurn[], PreparedTurns>();
function preparedFor(turns: StoredTurn[] | PreparedTurns): PreparedTurns {
  if (!Array.isArray(turns)) return turns;
  let p = preparedCache.get(turns);
  if (!p) {
    p = prepareTurns(turns);
    preparedCache.set(turns, p);
  }
  return p;
}

/**
 * Re-anchor via the ONE grounding predicate (grounding.ts), so an imported quote is exactly as trustworthy as an
 * extracted one: normalised match, specificity gate for decision/learning, receipt repaired to the turn that has it.
 * Exact text only (the goal: no quote unless re-anchored by exact match): turns whose normalised text does not
 * contain the candidate are never handed to the predicate, so its fuzzy snap fallbacks (steps c/d, linear in turns
 * with a costly tokenise each) cannot run. Work is O(turns) string includes per candidate, turns normalised once.
 * `turn_role` is "user" only when the grounded turn is a main-session user prose turn (the owner's voice);
 * in a sub-agent session a user turn is the parent agent's brief, so it is recorded as "assistant".
 */
export function findAnchor(
  o: Pick<ClaudeMemObservationInput, "narrative" | "body">,
  turns: StoredTurn[] | PreparedTurns,
  ctx: { kind: MemoryKind; text: string; citedIdx: number; subAgent?: boolean },
): Anchor | null {
  const prep = preparedFor(turns);
  const candidates = [o.narrative, o.body].filter(
    (c): c is string => !!c && c.length >= MIN_ANCHOR_CHARS && c.length <= MAX_QUOTE_CHARS,
  );
  for (const candidate of candidates) {
    // The redactors emit "[redacted]" / "[REDACTED]"; such a candidate can only match by wildcard, never verbatim.
    if (REDACTION_MARKER.test(candidate)) continue;
    const q = normalizeQuote(candidate);
    const hits: GroundingTurn[] = [];
    for (let i = 0; i < prep.quotable.length; i++) {
      if ((prep.norm[i] as string).includes(q)) hits.push(prep.quotable[i] as GroundingTurn);
    }
    if (hits.length === 0) continue;
    const g = groundAgainstTurns(
      { kind: ctx.kind, text: ctx.text, quote: candidate, ref: null, turn_idx: ctx.citedIdx },
      hits,
    );
    if (!g.verified || !g.quote || g.quote.length > MAX_QUOTE_CHARS) continue;
    // The grounded quote is a slice of the transcript, which may hold a secret the observation did not.
    // A redacted quote would no longer match its turn, so such a record is imported un-quoted.
    if (cleanText(g.quote, g.quote.length) !== g.quote) continue;
    const role = g.turn_role === "user" && !ctx.subAgent ? "user" : "assistant";
    return { quote: g.quote, idx: g.turn_idx, role };
  }
  return null;
}

/** Coarse position: the idx of the Nth owner prose user turn for prompt_number N (1-based); 0 when unknown. */
export function coarseTurnIdx(promptNumber: number | null, turns: StoredTurn[]): number {
  if (promptNumber === null || promptNumber < 1) return 0;
  const users = turns.filter((t) => t.role === "user" && isQuotableTurn(t)).sort((a, b) => a.idx - b.idx);
  return users[promptNumber - 1]?.idx ?? 0;
}

export interface SessionRef {
  id: string;
  code_project_id: string;
  source_session_id: string;
  short_title: string | null;
  title: string | null;
  parent_source_session_id?: string | null;
}

export interface MappedRow {
  user_id: string;
  code_session_id: string;
  code_project_id: string;
  source: typeof CLAUDE_MEM_SOURCE;
  kind: MemoryKind;
  text: string;
  quote: string | null;
  turn_idx: number;
  turn_role: "user" | "assistant";
  verified: boolean;
  content_hash: string;
  session_title: string | null;
  created_at: string;
}

export function mapObservation(
  userId: string,
  session: SessionRef,
  turns: StoredTurn[] | PreparedTurns,
  o: ClaudeMemObservationInput,
  now: Date = new Date(),
): MappedRow | null {
  const text = recordText(o);
  if (!text) return null;
  const kind = kindForType(o.type);
  const prep = preparedFor(turns);
  // Prompt N counts from the session start; once older turns were dropped it points at the wrong turn.
  const coarse = prep.truncated ? 0 : coarseTurnIdx(o.promptNumber, prep.all);
  const anchor = findAnchor(o, prep, {
    kind,
    text,
    citedIdx: coarse,
    subAgent: !!session.parent_source_session_id,
  });
  // Always set: postgrest-js builds upsert columns from every row's keys (defaultToNull), so a row without
  // created_at in a mixed batch would write NULL into a not-null column. Missing/unparseable -> request time.
  // Never in the future (a skewed clock would otherwise sort the row above genuinely recent memories).
  // A zoneless timestamp is read as UTC, not as the server's local time.
  const raw = o.createdAt?.trim() ?? "";
  const zoneless = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(raw);
  const parsedAt = raw ? Date.parse(zoneless ? `${raw.replace(" ", "T")}Z` : raw) : Number.NaN;
  const created = Number.isNaN(parsedAt)
    ? now
    : new Date(Math.min(Math.max(parsedAt, MIN_CREATED_AT_MS), now.getTime()));
  return {
    user_id: userId,
    code_session_id: session.id,
    code_project_id: session.code_project_id,
    source: CLAUDE_MEM_SOURCE,
    kind,
    text,
    quote: anchor?.quote ?? null,
    turn_idx: anchor?.idx ?? coarse,
    // Unquoted rows stay "assistant" even when the coarse turn is a user turn: rank.ts voiceReceiptRank ranks any
    // turn_role "user" first without checking `verified`, so an unverified row must not claim the owner's voice.
    turn_role: anchor?.role ?? "assistant",
    verified: anchor !== null,
    content_hash: contentHashFor(kind, text, o.rawHash),
    session_title: session.short_title ?? session.title,
    created_at: created.toISOString(),
  };
}
