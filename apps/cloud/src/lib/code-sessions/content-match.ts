// Pure, DB-free content-matching helpers for the cross-link matcher
// (cross-links.ts). Kept in a separate file so the scoring math is
// independently unit-testable with plain vectors/strings — mirrors
// lib/kg/seed-attach.ts's scoreSeededAssignments shape. Nothing here touches
// Supabase at all, so this file needs no isolation-gate allowance (see
// code-isolation.test.ts).
//
// WHY CONTENT MATCHING: comparing a CodeProject's repo/display NAME against
// a chat entity's LABEL never asks whether a chat conversation actually
// DISCUSSES the project. A project named after its repo
// ("surajtripathy07/membral") and a conversation titled generically
// ("Synchronization tool for AI project management") share no tokens at all,
// so a name-overlap heuristic can never link them even though the
// conversation plainly is about the project. This module embeds the
// CodeProject's own rollup prose (what was built/decided/open, plus
// recurring files/tools) and compares it, via cached cosine similarity,
// against conversations.embedding (populated independently by
// lib/conversation-embeddings.ts). A conversation whose content clears the
// bar becomes a cross-link candidate through its own conversations.id — see
// cross-links.ts's HISTORY note for the migration-084 retarget off
// kg_nodes/kg_conv_embeddings.

import { cosineSimilarityReadonly as cosineSimilarity } from "@/lib/domain/similarity";
import { vectorThreshold } from "@/lib/llm/embedding-family";

export interface ProjectContentSource {
  repoIdentity: string;
  displayName: string | null;
  /** Top-level code_projects.summary column — included alongside the
   *  structured rollup fields below as a cheap redundancy (harmless for an
   *  embedding if it overlaps; a safety net if the rollup hasn't run yet but
   *  a fallback summary has). */
  summary: string | null;
  whatBuilt: string | null;
  keyDecisions: string | null;
  openThreads: string | null;
  recurringFilesTools: readonly string[];
}

/**
 * repo name + display name + rollup prose + recurring file/tool basenames —
 * the text embedded to find chat conversations actually ABOUT this project.
 * Basenames only (not full paths) for recurring files: a path like
 * `apps/cloud/src/lib/kg/cluster.ts` mostly contributes generic directory
 * noise ("apps", "src", "lib") to an embedding; `cluster.ts` is the
 * distinctive part.
 */
export function buildProjectContentSignal(project: ProjectContentSource): string {
  const parts: string[] = [];
  const repoSeg = project.repoIdentity.split("/").pop();
  if (repoSeg) parts.push(repoSeg);
  if (project.displayName) parts.push(project.displayName);
  if (project.summary) parts.push(project.summary);
  for (const text of [project.whatBuilt, project.keyDecisions, project.openThreads]) {
    if (text) parts.push(text);
  }
  if (project.recurringFilesTools.length > 0) {
    parts.push(project.recurringFilesTools.map((f) => f.split("/").pop() || f).join(" "));
  }
  return parts.join("\n");
}

export { cosineSimilarity };

/** One conversation available as a content-match target: its id (the
 *  cross-link FK target) + its cached embedding. */
export interface ConversationCandidate {
  conversationId: string;
  title: string | null;
  embedding: readonly number[];
}

export interface ConversationMatch {
  conversationId: string;
  title: string | null;
  sim: number;
}

export interface ScoreConversationsOptions {
  /** Absolute cosine floor a candidate must clear to be considered at all. */
  threshold: number;
  /** Cap on how many candidates this function returns (strongest first). */
  topK: number;
}

/**
 * Score `candidates` against the embedded project signal; keep those
 * clearing `threshold`, strongest first, capped at `topK`. Deterministic
 * (ties broken by conversationId) — mirrors seed-attach.ts's
 * scoreSeededAssignments shape/contract.
 */
export function scoreConversationCandidates(
  projectEmbedding: readonly number[],
  candidates: readonly ConversationCandidate[],
  opts: ScoreConversationsOptions,
): ConversationMatch[] {
  if (projectEmbedding.length === 0) return [];
  // L8: `opts.threshold` is the default model's number; a family with no calibrated content_match links nothing by content.
  if (vectorThreshold("content_match") === null) return [];
  const scored: ConversationMatch[] = [];
  for (const c of candidates) {
    if (c.embedding.length === 0) continue;
    const sim = cosineSimilarity(projectEmbedding, c.embedding);
    if (sim >= opts.threshold) scored.push({ conversationId: c.conversationId, title: c.title, sim });
  }
  scored.sort((a, b) => b.sim - a.sim || (a.conversationId < b.conversationId ? -1 : 1));
  return scored.slice(0, Math.max(0, opts.topK));
}
