// G2 step 2.4d: the pure supersede planner behind write/io.ts's supersedeRecords.
// It decides, per kind, which new record links to which live row and which
// live rows are exact duplicates to retire; the per-kind read, the link
// updates, the retire update and the warn line stay in write/io.ts, in the
// order they ran before.
import { vectorThreshold } from "@/lib/llm/embedding-family";
import { parseVector } from "@/lib/llm/vector";
import { cosineSimilarity } from "../embed";
import { normalizeForDedup } from "../merge";

/** A newly-inserted record as supersedeRecords receives it. */
export interface SupersedeInsertedRecord {
  id: string;
  kind: string;
  text: string;
  embedding: number[] | null;
}

/** A new record of one kind; an empty embedding is normalized to null. */
export interface SupersedeNewRecord {
  id: string;
  text: string;
  embedding: number[] | null;
}

/** A row of the per-kind live read (`id, text, embedding`). */
export interface SupersedeLiveRow {
  id: string;
  text: string;
  embedding: unknown;
}

/** The writes for one kind: each `links` entry sets `supersedes` on `id`, in order; `retireIds` are retired as duplicates. */
export interface SupersedePlan {
  links: Array<{ id: string; supersedes: string }>;
  retireIds: string[];
}

/** The inserted records grouped by kind, in first-seen order. */
export function groupSupersedeByKind(inserted: SupersedeInsertedRecord[]): Map<string, SupersedeNewRecord[]> {
  const byKind = new Map<string, SupersedeNewRecord[]>();
  for (const r of inserted) {
    const list = byKind.get(r.kind) ?? [];
    list.push({ id: r.id, text: r.text, embedding: r.embedding && r.embedding.length > 0 ? r.embedding : null });
    byKind.set(r.kind, list);
  }
  return byKind;
}

/**
 * One kind's supersede decisions. Live rows that are themselves among the new
 * records are ignored. An exact normalized-text duplicate wins (link + retire
 * the older); otherwise the best cosine >= SUPERSEDE_COSINE_THRESHOLD match
 * over rows with an embedding is linked (not retired).
 */
export function planSupersede(newRecords: SupersedeNewRecord[], liveRows: SupersedeLiveRow[]): SupersedePlan {
  const newIds = new Set(newRecords.map((r) => r.id));
  const liveCandidates = liveRows
    .filter((row) => !newIds.has(row.id))
    .map((row) => ({ id: row.id, text: row.text, embedding: parseVector(row.embedding) }));

  const supersedeCut = vectorThreshold("supersede");
  const links: Array<{ id: string; supersedes: string }> = [];
  const toRetire = new Set<string>();
  for (const rec of newRecords) {
    let best: { id: string; sim: number } | null = null;

    const normalizedText = normalizeForDedup(rec.text);
    const textDuplicate = liveCandidates.find((c) => normalizeForDedup(c.text) === normalizedText);
    if (textDuplicate) {
      best = { id: textDuplicate.id, sim: 1 };
      toRetire.add(textDuplicate.id);
    } else if (rec.embedding && supersedeCut !== null) {
      // L8: the cut is calibrated per embedding family; an uncalibrated model links on text only.
      for (const candidate of liveCandidates) {
        if (candidate.embedding.length === 0) continue;
        const sim = cosineSimilarity(rec.embedding, candidate.embedding);
        if (sim >= supersedeCut && (!best || sim > best.sim)) best = { id: candidate.id, sim };
      }
    }
    if (best) links.push({ id: rec.id, supersedes: best.id });
  }
  return { links, retireIds: [...toRetire] };
}
