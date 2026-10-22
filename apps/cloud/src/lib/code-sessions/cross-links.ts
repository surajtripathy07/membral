// Cross-links from a CodeProject to a chat conversation, for chat
// pre-context (memory v1, docs/design/memory-v1.md §5). Best-effort,
// deterministic modulo one LLM-adjacent call (an embedding, not a chat
// completion — no free-text generation). Writes code_cross_links rows
// (rel_type 'relates_to', confidence 0-1) pointing at conversations.id.
//
// CONTENT MATCH (the one signal that survives v1): does a chat conversation
// actually DISCUSS the project, regardless of what either side is named?
// The CodeProject's rollup prose (what was built / decided / left open, plus
// recurring file/tool basenames — see content-match.ts) is embedded ONE time
// per project and compared via cosine similarity against
// conversations.embedding, populated independently by
// lib/conversation-embeddings.ts. A conversation whose content clears the
// similarity floor becomes a cross-link candidate directly through its own
// conversations.id — no chat-graph indirection.
//
// HISTORY (migration 084 retarget): before memory v1 this matcher also ran a
// NAME/ALIAS-overlap signal (a CodeProject's repo/display name and its
// rollup's `people` field, token-overlap against kg_nodes LABELS of type
// Item/LifeArea/Person) and resolved the content signal through a
// kg_nodes-type='Conversation' indirection + kg_conv_embeddings, both owned
// by the chat-extraction pipeline being deleted (docs/design/memory-v1.md
// §5, D-045). Migration 084 dropped code_cross_links.kg_node_id (its only
// target column) in favor of conversation_id, and its backfill deleted every
// row that could not resolve to a conversation — locally all 3 rows, all
// name-match links to Person nodes, none to a Conversation. There is no
// column left to store a name-match's target, so that signal is gone with
// it: post-v1 code_cross_links exists solely for chat pre-context (§5's
// table: "Chat pre-context and chat_precontext in the tools"), which only
// the content signal ever served.
//
// Every embedding call is wrapped and DEGRADES GRACEFULLY: no OPENAI_API_KEY
// (or any embedding failure) skips content-matching for that project and
// logs a warning — every other project is unaffected. This mirrors
// lib/kg/search.ts's graceful degradation for the same reason: an offline
// embedding provider must never take down synthesis.
//
// AUTO-CREATE + DISMISSABLE (ADR open question 2, resolved): links are
// created automatically; the user can dismiss one later (dismissed_at). ANY
// existing row for a (code_project_id, conversation_id) pair — active or
// dismissed — blocks re-creating it: an active link is never duplicated, and
// a dismissed link is never resurrected by a later run (undismissing is a
// separate, explicit user action outside this matcher). The per-user
// fallback bucket (`code-project:unassigned`) never gets cross-links (ADR
// Q4 — no cwd/remote means nothing to anchor a match to). Every project is
// capped at MAX_LINKS_PER_PROJECT links and every match below
// MIN_CONFIDENCE_FLOOR is dropped — the anti-flooding guarantee the
// maintainer asked for.
//
// ISOLATION (ADR Q2): this file no longer reads kg_nodes/kg_edges/
// kg_conv_embeddings at all (see HISTORY above) — `conversations` is an
// ordinary code-sessions-adjacent table, not part of the chat KG, so this
// file carries no isolation-gate exception in code-isolation.test.ts.
import type { Db } from "@/lib/db/types";
import { EmbeddingCeilingExceededError, generateEmbedding } from "@/lib/embeddings";
import { parseVector } from "../llm/vector";
import { log } from "../log";
import { selectAllRows } from "../util/pagination";
import { buildProjectContentSignal, type ConversationCandidate, scoreConversationCandidates } from "./content-match";
import { UNASSIGNED_REPO_IDENTITY } from "./repo-identity";
import { parseCodeProjectRollup } from "./view";

// Content-match tuning. EMBED_SIM_THRESHOLD was set empirically against
// founder-1k (real embeddings, real corpus): cosine similarity between
// unrelated text in this corpus centers ~0.26-0.28, genuinely on-topic
// matches land ~0.42+ (e.g. the membral project's rollup vs. a chat
// conversation literally about "designing a synchronization tool for project
// management between AI platforms Claude and ChatGPT" scored 0.49), and 0.3
// (the threshold used elsewhere in this codebase for short-label anchors —
// migration 021, seed-attach.ts TAU_ABS) let in 100-300+ candidates per
// project here, which would flood.
export const EMBED_SIM_THRESHOLD = 0.42;
const CONTENT_MAX_CONFIDENCE = 0.7;

const MAX_LINKS_PER_PROJECT = 5;
const MIN_CONFIDENCE_FLOOR = 0.2; // defense-in-depth floor below the signal's own threshold

interface ProjectRow {
  id: string;
  display_name: string | null;
  repo_identity: string;
  summary: string | null;
  props: Record<string, unknown> | null;
}
interface CrossLinkRow {
  code_project_id: string;
  conversation_id: string;
  dismissed_at: string | null;
}
interface ConversationRow {
  id: string;
  title: string | null;
  embedding: unknown;
}

export interface CrossLinkMatch {
  codeProjectId: string;
  conversationId: string;
  conversationTitle: string | null;
  confidence: number;
}

export interface MatchCrossLinksResult {
  evaluated: number;
  created: number;
  matches: CrossLinkMatch[];
}

export interface MatchCrossLinksDeps {
  supabase: Db;
  userId: string;
  /** Injectable for tests; defaults to the real OpenAI embedding call. */
  embed?: (text: string) => Promise<number[]>;
}

// Chat sources only (review-084.md finding 2, BLOCKER): `conversations` is
// not a chat-only table — mirrorCodeSessionsToConversations (still live,
// called from api/code-sessions/route.ts) writes each code_sessions row in
// as source='claude-code', and lib/conversation-embeddings.ts's
// embedMissingConversations embeds by `embedding is null` with no source
// filter (intentionally left as-is — see that file's own note — because
// search.ts's general conversation search depends on mirrored code sessions
// being embedded too). Without this allowlist, a project's own mirrored
// sessions would score ~1.0 against its own rollup prose and take every
// MAX_LINKS_PER_PROJECT slot, making chat pre-context self-referential.
// Explicit allowlist, not `.neq("source", "claude-code")`: a new non-chat
// source added later must opt IN to being a cross-link candidate, not
// silently qualify by default.
const CHAT_SOURCES = ["chatgpt", "claude", "claude-code-chat"] as const;

// Candidate conversations for the content signal: every one of the user's
// CHAT conversations (CHAT_SOURCES above) with a populated embedding
// (lib/conversation-embeddings.ts) — never a mirrored code session.
async function fetchConversationCandidates(supabase: Db, userId: string): Promise<ConversationCandidate[]> {
  // No `.not("embedding", "is", null)` filter at the query level: the
  // fetch-then-filter-in-JS shape below (parseVector + a length check)
  // already excludes null/empty embeddings, and this keeps the query shape
  // identical to every other selectAllRows call in this file for the shared
  // test double (fake-supabase.ts) to exercise consistently.
  const rows = await selectAllRows<ConversationRow>((from, to) =>
    supabase
      .from("conversations")
      .select("id, title, embedding")
      .eq("user_id", userId)
      .in("source", [...CHAT_SOURCES])
      .order("id")
      .range(from, to),
  );
  return rows
    .map((r) => ({ conversationId: r.id, title: r.title, embedding: parseVector(r.embedding) }))
    .filter((c) => c.embedding.length > 0);
}

async function fetchExistingLinkedPairs(supabase: Db, userId: string): Promise<Set<string>> {
  const rows = await selectAllRows<CrossLinkRow>((from, to) =>
    supabase
      .from("code_cross_links")
      .select("code_project_id, conversation_id, dismissed_at")
      .eq("user_id", userId)
      .order("id")
      .range(from, to),
  );
  // ANY existing row for a (project, conversation) pair blocks recreation —
  // active OR dismissed. An active link is simply not duplicated; a
  // DISMISSED link is a durable user signal that this pairing is unwanted,
  // and re-evaluating a match must never resurrect it as a fresh row.
  // (Undismissing is a separate, explicit user action outside this
  // matcher's scope.)
  return new Set(rows.map((r) => `${r.code_project_id}::${r.conversation_id}`));
}

async function fetchProjects(supabase: Db, userId: string): Promise<ProjectRow[]> {
  return selectAllRows<ProjectRow>((from, to) =>
    supabase
      .from("code_projects")
      .select("id, display_name, repo_identity, summary, props")
      .eq("user_id", userId)
      .order("id")
      .range(from, to),
  );
}

/** Embeds the project's rollup signal ONCE and scores it against every
 *  candidate conversation's cached embedding. Returns [] (never throws) on a
 *  missing/failing embedding provider — the caller proceeds with no matches
 *  for this project. */
async function contentMatchesForProject(
  project: ProjectRow,
  conversationCandidates: readonly ConversationCandidate[],
  embed: (text: string) => Promise<number[]>,
): Promise<CrossLinkMatch[]> {
  if (conversationCandidates.length === 0) return [];

  const rollup = parseCodeProjectRollup(project.props);
  const signal = buildProjectContentSignal({
    repoIdentity: project.repo_identity,
    displayName: project.display_name,
    summary: project.summary,
    whatBuilt: rollup.what_built || null,
    keyDecisions: rollup.key_decisions || null,
    openThreads: rollup.open_threads || null,
    recurringFilesTools: rollup.recurring_files_tools,
  });
  if (!signal.trim()) return [];

  let projectEmbedding: number[];
  try {
    projectEmbedding = await embed(signal);
  } catch (err) {
    // Ceiling errors are NOT swallowed here (issue #92 adversarial review
    // m2) — every remaining project would just re-hit the exact same ceiling
    // one preflight-and-throw at a time. Let the caller catch this ONE level
    // up and stop the whole run instead.
    if (err instanceof EmbeddingCeilingExceededError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("code cross-link content match: embedding failed, skipping content signal for this project", {
      code_project_id: project.id,
      err: msg,
    });
    return [];
  }

  const scored = scoreConversationCandidates(projectEmbedding, conversationCandidates, {
    threshold: EMBED_SIM_THRESHOLD,
    topK: MAX_LINKS_PER_PROJECT,
  });

  return scored.map((s) => ({
    codeProjectId: project.id,
    conversationId: s.conversationId,
    conversationTitle: s.title,
    confidence: Math.min(CONTENT_MAX_CONFIDENCE, s.sim),
  }));
}

/**
 * Dedupe by target conversation (keep the highest-confidence match), drop
 * anything under MIN_CONFIDENCE_FLOOR, cap per project. Exported for direct
 * unit testing of the cap/floor invariants.
 */
export function dedupeAndCap(matches: CrossLinkMatch[]): CrossLinkMatch[] {
  const byConversation = new Map<string, CrossLinkMatch>();
  for (const m of matches) {
    if (m.confidence < MIN_CONFIDENCE_FLOOR) continue;
    const existing = byConversation.get(m.conversationId);
    if (!existing || m.confidence > existing.confidence) byConversation.set(m.conversationId, m);
  }
  return [...byConversation.values()].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_LINKS_PER_PROJECT);
}

/**
 * Best-effort content matcher: for every CodeProject (except the unassigned
 * fallback bucket), find conversations whose cached embedding is similar to
 * the project's rollup prose, and write a code_cross_links row for each new
 * match. Never recreates a dismissed link or duplicates an existing
 * non-dismissed one.
 */
export async function matchCodeProjectCrossLinks(deps: MatchCrossLinksDeps): Promise<MatchCrossLinksResult> {
  // generateEmbedding now takes a cost-guard opts bag (issue #92) — wrap it so
  // the injectable `embed` dependency here keeps its original (text) => Promise<number[]>
  // shape for tests, while the real default routes through the ledger/ceiling.
  // Tagged "query_embedding" (not "conversation_embedding"): this is a
  // transient one-off embed of the project's rollup prose for comparison
  // against already-stored conversations.embedding, not a new row being
  // persisted.
  const embed =
    deps.embed ?? ((text: string) => generateEmbedding(text, { userId: deps.userId, pass: "query_embedding" }));

  const [projects, existingPairs, conversationCandidates] = await Promise.all([
    fetchProjects(deps.supabase, deps.userId),
    fetchExistingLinkedPairs(deps.supabase, deps.userId),
    fetchConversationCandidates(deps.supabase, deps.userId),
  ]);

  const matches: CrossLinkMatch[] = [];
  let evaluated = 0;
  // Issue #92 adversarial review m-cross-links: once the ceiling trips,
  // DISABLE content-matching for the rest of the run rather than letting
  // every remaining project independently preflight-and-throw against the
  // same ceiling.
  let contentDisabled = false;
  for (const project of projects) {
    if (project.repo_identity === UNASSIGNED_REPO_IDENTITY) continue; // ADR Q4: no cross-links for the fallback bucket
    evaluated++;
    if (contentDisabled) continue;
    try {
      const contentMatches = await contentMatchesForProject(project, conversationCandidates, embed);
      matches.push(...dedupeAndCap(contentMatches));
    } catch (err) {
      if (!(err instanceof EmbeddingCeilingExceededError)) throw err;
      // Monthly embedding ceiling hit: disable content-matching for every
      // remaining project (each would just independently preflight-and-
      // throw against the same ceiling otherwise) — this project and every
      // one after it stop getting new matches, but evaluated keeps counting.
      log.warn(
        "code cross-link content match: monthly embedding cost ceiling exceeded — disabling content-match for remaining projects this run",
        {
          code_project_id: project.id,
          spent_usd: err.spentUsd,
          ceiling_usd: err.ceilingUsd,
        },
      );
      contentDisabled = true;
    }
  }

  let created = 0;
  for (const m of matches) {
    const key = `${m.codeProjectId}::${m.conversationId}`;
    if (existingPairs.has(key)) continue; // equivalent non-dismissed link already exists — skip
    const insertRes = await deps.supabase.from("code_cross_links").insert({
      user_id: deps.userId,
      code_project_id: m.codeProjectId,
      conversation_id: m.conversationId,
      rel_type: "relates_to",
      confidence: m.confidence,
    });
    if (insertRes.error) {
      log.warn("failed to write code cross-link", {
        code_project_id: m.codeProjectId,
        conversation_id: m.conversationId,
        err: insertRes.error.message,
      });
      continue;
    }
    existingPairs.add(key); // guard against a duplicate within the same run
    created++;
  }

  log.info("code_cross_links complete", { user_id: deps.userId, evaluated, matched: matches.length, created });

  return { evaluated, created, matches };
}
