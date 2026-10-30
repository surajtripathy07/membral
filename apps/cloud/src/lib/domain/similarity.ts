/**
 * Similarity thresholds and the cosine helpers (G2 step 2.2e). The two
 * cosine bodies below are kept verbatim from their old owners and NOT
 * unified (G2 divergence rule): they differ only in the parameter types
 * (`readonly number[]` vs `number[]`) and in an extra `b.length === 0`
 * guard that is unreachable as a distinct outcome (any empty `b` with a
 * non-empty `a` already fails the length-equality check).
 */

import { BUNDLED_EMBEDDING_MODEL } from "./embedding-model-ids";
import { CROSS_SESSION_DUP_COSINE_THRESHOLD, RECURRENCE_COSINE_THRESHOLD } from "./recurrence";

/** Supersede rule (`write.ts`): a new record this close to a live one supersedes it. */
export const SUPERSEDE_COSINE_THRESHOLD = 0.9;

/**
 * Default cosine floor for semantic dedup (maintainer decision 2026-09-25:
 * 0.80, no LLM judge). `MEMBRAL_MEMORY_DEDUP_MIN_SIM` overrides.
 */
export const DEFAULT_SEMANTIC_DEDUP_MIN_SIM = 0.8;

/** Default in-batch collapse threshold for `dedupeByCosine` (`merge.ts`). */
export const IN_BATCH_DEDUP_COSINE_THRESHOLD = 0.93;

/**
 * Every cosine cut that is calibrated per embedding family (L8, D-072). `vectorThreshold(step, family)` in
 * `lib/llm/embedding-family.ts` is the only reader.
 *
 * - `in_batch_dedupe`, `cross_session_dedup`: silent drops (no merge log).
 * - `semantic_dedup`, `supersede`: retire the older record.
 * - `recurrence`, `blocker_dismiss`: count a recurrence of a blocker / carry a user dismissal onto it.
 * - `content_match`: an on/off gate only; the caller owns the number (cross-links.ts EMBED_SIM_THRESHOLD).
 * - `sem_floor`, `mixed_sem_floor`, `sql_cut`: the search relevance floor and the SQL candidate cut.
 */
export type VectorStep =
  | "in_batch_dedupe"
  | "cross_session_dedup"
  | "semantic_dedup"
  | "supersede"
  | "recurrence"
  | "blocker_dismiss"
  | "content_match"
  | "sem_floor"
  | "mixed_sem_floor"
  | "sql_cut";

/** text-embedding-3-small (the hosted default): the values every step has always used. Pinned by a test. */
export const DEFAULT_FAMILY_THRESHOLDS: Readonly<Record<VectorStep, number>> = {
  in_batch_dedupe: IN_BATCH_DEDUP_COSINE_THRESHOLD,
  cross_session_dedup: CROSS_SESSION_DUP_COSINE_THRESHOLD,
  semantic_dedup: DEFAULT_SEMANTIC_DEDUP_MIN_SIM,
  supersede: SUPERSEDE_COSINE_THRESHOLD,
  recurrence: RECURRENCE_COSINE_THRESHOLD,
  blocker_dismiss: RECURRENCE_COSINE_THRESHOLD,
  content_match: 0.42,
  sem_floor: 0.5,
  mixed_sem_floor: 0.4,
  sql_cut: 0.3,
};

/**
 * Calibrated families, keyed by canonical model id. `null` = this step was not calibrated and stays skipped.
 * nomic-embed-text: `scripts/eval/recall-precision/calibration/` (thresholds.json, REPORT.md), tuning split only;
 * a test pins this table to thresholds.json. Cosines on nomic run lower and wider than on text-embedding-3-small:
 * unrelated records sit at a median of 0.55, restatements at 0.77, so the default-family 0.80 cut would merge
 * mostly distinct facts. `content_match` has no labelled pairs and stays null.
 */
export const CALIBRATED_FAMILY_THRESHOLDS: Readonly<Record<string, Readonly<Record<VectorStep, number | null>>>> = {
  "nomic-embed-text": {
    in_batch_dedupe: 0.93,
    cross_session_dedup: 0.94,
    semantic_dedup: 0.86,
    supersede: 0.91,
    recurrence: 0.86,
    blocker_dismiss: 0.86,
    content_match: null,
    sem_floor: 0.66,
    mixed_sem_floor: 0.61,
    sql_cut: 0.51,
  },
  // The Docker-free store's bundled ONNX q8 nomic. Not an alias of the Ollama row: per-pair cosines differ (sd 0.016-0.020,
  // up to 0.087). supersede, sem_floor, mixed_sem_floor and sql_cut were replayed on the bundled model's own scores
  // (tuning split, not written by the script). The four dedupe/recurrence values (in_batch 0.93, cross_session 0.94,
  // semantic 0.86, recurrence/blocker_dismiss 0.86) keep Ollama's adjudicated cosines: re-scored on ONNX they would be
  // 0.90/0.91/0.82/0.82, so the kept values are stricter and safe. These write-path steps go from skipped to active on
  // Docker-free stores. content_match stays null (no labelled pairs).
  // `scripts/eval/recall-precision/calibration/2026-10-25-onnx-q8.md`, replay: `onnx-thresholds-replay.mjs`.
  [BUNDLED_EMBEDDING_MODEL]: {
    in_batch_dedupe: 0.93,
    cross_session_dedup: 0.94,
    semantic_dedup: 0.86,
    supersede: 0.88,
    recurrence: 0.86,
    blocker_dismiss: 0.86,
    content_match: null,
    sem_floor: 0.68,
    mixed_sem_floor: 0.63,
    sql_cut: 0.53,
  },
};

/**
 * Chat search (`mcp_search_unified`, `search_conversations`; migration 139): the floors of the families whose vectors
 * may meet a chat query. Separate from CALIBRATED_FAMILY_THRESHOLDS because chat has its own labelled set and a
 * family can be calibrated for memories and not for chats: the bundled ONNX family is deliberately absent, so chat
 * search stays keyword-only on it. The default family is not listed; it keeps the RPCs' own 0.3 cut.
 * nomic-embed-text: 310 labelled chat hits (0.68 / 0.63 / 0.55 gives precision 0.66, recall 0.90, 0 of 6 negative
 * queries served). Chat search reads `sem_floor` as the RPC cut; `mixed_sem_floor` and `sql_cut` are recorded with the
 * measurement but unread (see `chatVectorPlan`).
 */
export const CHAT_FAMILY_THRESHOLDS: Readonly<
  Record<string, Readonly<{ sem_floor: number; mixed_sem_floor: number; sql_cut: number }>>
> = {
  "nomic-embed-text": { sem_floor: 0.68, mixed_sem_floor: 0.63, sql_cut: 0.55 },
};

/**
 * L5 abstention floor: the fewest query lexemes a record must contain to be served on lexical evidence alone (the
 * floor's coverage rules (b) and (c); the cosine rule (a) is unaffected). A short query matched on two or three of its
 * words is the commonest way an off-topic query still serves ("decide ... queue" for a question about a tool the
 * store never mentions), and a coverage ratio cannot see it: 3 of 5 passes. An absolute count can, with no word list.
 * The default family keeps 0 (rule off, its historical behaviour); a family not listed gets 0 too (its floor is
 * off or uncalibrated anyway). nomic-embed-text: `scripts/eval/recall-precision/calibration/abstain.mjs` (tuning
 * split only; REPORT.md "L5"); a test pins this table to that script's output.
 */
export const LEXICAL_MIN_HITS: Readonly<Record<string, number>> = {
  "nomic-embed-text": 4,
  // Lexical legs do not read the embedding model, so the Ollama row's count carries over (same results file as above).
  [BUNDLED_EMBEDDING_MODEL]: 4,
};

/** Cosine similarity over readonly arrays (was `code-sessions/content-match.ts`). Returns 0 when either is empty, lengths differ, or either norm is 0. */
export function cosineSimilarityReadonly(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Cosine similarity of two equal-length vectors (was `memory/embed.ts`). Returns 0 for a length mismatch or an all-zero vector, rather than NaN/throwing. */
export function cosineSimilarityMutable(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
