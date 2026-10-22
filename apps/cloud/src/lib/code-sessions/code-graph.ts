// Stage-1 deterministic extractor for the code-session knowledge graph
// (ADR 0023 Q1/Q2/Q4, corrected by ADR 0026 — P2a scope).
//
// ZERO LLM CALLS. Everything here is a fold over columns already in
// code_projects/code_sessions/code_session_turns — see
// __tests__/code-graph.test.ts's "makes zero LLM calls" assertion (this
// module doesn't even import an LLM client type).
//
// ISOLATION (ADR 0023 Q3): writes ONLY to code_kg_nodes/code_kg_edges. Never
// imports GraphWriter, never references kg_edges, never writes kg_nodes —
// see code-isolation.test.ts's static gate (this file lives under
// lib/code-sessions/, which the gate scans automatically) and its
// byte-identical proof (extended to run a full code-graph build).
//
// IDEMPOTENT + CONTENT-ADDRESSED (ADR 0023 Q4 "Idempotency + dirty regen",
// corrected by the P2a adversarial verify's F2/F3/F9 findings): every call to
// `buildCodeGraphForProject` recomputes that project's nodes/edges from
// current source rows and UPSERTS them keyed on each table's own unique
// constraint (code_project_id, node_type, key) / (code_project_id,
// src_node_id, dst_node_id, rel_type) — never a blind delete-then-insert.
// This buys three things at once:
//   - stable node/edge ids across rebuilds (F9) — a node's id is preserved
//     whenever its (node_type, key) is unchanged, which anything wanting to
//     reference a code_kg_nodes.id (P2b's locked_fields, node-level
//     cross-links, P2d's embedding cache) needs.
//   - partial-failure safety (F2) — rows are only ever deleted AFTER the new
//     set has been safely upserted, and only the ones this rebuild didn't
//     reproduce ("stale"). A failure mid-upsert leaves the OLD rows exactly
//     as they were; it can never leave the project's graph empty.
//   - upsert-on-conflict is race-safe under Postgres's own row-level
//     conflict resolution, so two overlapping rebuilds of the same project
//     (e.g. an import-triggered synthesize racing the launchd sweep, F3)
//     converge on one row per key instead of colliding on the unique
//     constraint. `buildCodeGraphForProject` additionally single-flights
//     concurrent calls for the same (userId, codeProjectId) within this
//     process (see `inFlightBuilds` below) so a race within one server
//     process does the work once, not twice.
// Zero LLM cost makes "always rebuild" cheap; there's no dirty-flag gate to
// get wrong. Mirrors the same "replace on re-import" semantics `import.ts`'s
// `replaceTurns` already uses for turns (turns have no downstream id
// dependents, so a plain delete+insert is still fine there).
import { randomUUID } from "node:crypto";
import type { RawSubAgent, RawUsage } from "@membral/core";
import type { Db } from "@/lib/db/types";
import { log } from "../log";
import { selectAllRows } from "../util/pagination";
import { computeCost } from "./price-table";

export type CodeKgNodeType = "project" | "session" | "file" | "tool" | "subagent";
export type CodeKgRelType = "contains" | "touched" | "used" | "spawned";

export interface CodeKgNodeRow {
  id: string;
  user_id: string;
  code_project_id: string;
  node_type: CodeKgNodeType;
  key: string;
  label: string;
  ref_id: string | null;
  props: Record<string, unknown>;
  session_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface CodeKgEdgeRow {
  id: string;
  user_id: string;
  code_project_id: string;
  src_node_id: string;
  dst_node_id: string;
  rel_type: CodeKgRelType;
  weight: number;
  props: Record<string, unknown>;
}

export interface BuildCodeGraphResult {
  codeProjectId: string;
  nodesWritten: number;
  edgesWritten: number;
  nodeCountsByType: Partial<Record<CodeKgNodeType, number>>;
  edgeCountsByType: Partial<Record<CodeKgRelType, number>>;
  /**
   * Set when this project's rebuild failed (F2) — `buildCodeGraphForUser`
   * catches per-project so one failure never aborts the rest of the run.
   * nodesWritten/edgesWritten are 0 for a failed entry, but that describes
   * only THIS run's write count, not the project's current graph state: the
   * upsert-then-delete-stale ordering in `replaceProjectGraph` means a
   * mid-failure leaves the previous graph mostly or entirely intact rather
   * than empty.
   */
  error?: string;
}

const NODE_INSERT_CHUNK = 500;
const EDGE_INSERT_CHUNK = 500;
const DELETE_CHUNK = 500;
const SESSION_ID_CHUNK = 200;

// Edit-type tools count toward a File's edit_count; Read-only touches still
// produce a TOUCHED edge (recurrence signal) but don't bump edit_count.
// MultiEdit/NotebookEdit kept defensively (ADR 0026 D1 — 0 occurrences in
// the validated corpus, but the rule must not silently break if they show up).
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

interface ProjectRow {
  id: string;
  display_name: string | null;
  repo_identity: string;
}

interface SessionRow {
  id: string;
  cwd: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
  props: Record<string, unknown> | null;
  // ADR 0023 Q1/Q4 D13 fallback File-node source (F6): a source/version that
  // reports which files a session touched at the session level, but never
  // populates per-turn file_path, must still yield File nodes — "a valid,
  // smaller graph", not zero.
  files_touched: string[] | null;
}

interface ToolUseTurnRow {
  session_id: string;
  tool_name: string | null;
  file_path: string | null;
  props: Record<string, unknown> | null;
}

function canonicalFilePath(filePath: string, cwd: string | null): string {
  if (cwd && filePath.startsWith(cwd)) {
    const rel = filePath.slice(cwd.length).replace(/^[/\\]+/, "");
    if (rel) return rel;
  }
  return filePath;
}

function toolKey(
  toolName: string,
  mcpServer?: string,
  mcpTool?: string,
): { key: string; label: string; rawName?: string } {
  if (mcpServer && mcpTool) {
    return { key: `${mcpServer}:${mcpTool}`, label: `${mcpServer}/${mcpTool}`, rawName: toolName };
  }
  return { key: toolName, label: toolName };
}

function minTs(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

function maxTs(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Single-flight guard (F3): two overlapping rebuilds of the SAME project
// within this process (e.g. an import's fire-and-forget synthesize racing
// the launchd sweep hitting the same server) join the one already in
// flight instead of duplicating the work. This is a best-effort, in-process
// complement to `replaceProjectGraph`'s upsert-based concurrency safety
// below — it does not (and, over plain HTTP-to-PostgREST supabase-js calls,
// cannot cheaply) protect against a race between two SEPARATE processes; the
// upsert-on-conflict design is what makes that case safe rather than
// crashing on the unique constraint.
const inFlightBuilds = new Map<string, Promise<BuildCodeGraphResult>>();

/**
 * Build (or rebuild) the deterministic Tier-1 graph for one CodeProject:
 * project/session mirrors, File+TOUCHED, Tool+USED, SubAgent+SPAWNED. Reads
 * only code_projects/code_sessions/code_session_turns; writes only
 * code_kg_nodes/code_kg_edges, scoped to this codeProjectId.
 */
export async function buildCodeGraphForProject(
  supabase: Db,
  userId: string,
  codeProjectId: string,
): Promise<BuildCodeGraphResult> {
  const key = `${userId}:${codeProjectId}`;
  const inFlight = inFlightBuilds.get(key);
  if (inFlight) return inFlight;

  const promise = buildCodeGraphForProjectInner(supabase, userId, codeProjectId).finally(() => {
    inFlightBuilds.delete(key);
  });
  inFlightBuilds.set(key, promise);
  return promise;
}

async function buildCodeGraphForProjectInner(
  supabase: Db,
  userId: string,
  codeProjectId: string,
): Promise<BuildCodeGraphResult> {
  const empty: BuildCodeGraphResult = {
    codeProjectId,
    nodesWritten: 0,
    edgesWritten: 0,
    nodeCountsByType: {},
    edgeCountsByType: {},
  };

  const projectRes = await supabase
    .from("code_projects")
    .select("id, display_name, repo_identity")
    .eq("user_id", userId)
    .eq("id", codeProjectId)
    .maybeSingle();
  if (projectRes.error) throw new Error(`buildCodeGraphForProject(project) failed: ${projectRes.error.message}`);
  const project = projectRes.data as ProjectRow | null;
  if (!project) return empty;

  // PostgREST caps a single response at ~1000 rows — selectAllRows pages
  // past that. Sessions per project are small today, but turns are NOT
  // (a busy project's tool_use rows routinely exceed 1000): an unpaginated
  // select here silently truncates and under-counts recurrence, exactly the
  // kind of bug the isolation/golden tests can't catch on a small fixture.
  const sessions = await selectAllRows<SessionRow>((from, to) =>
    supabase
      .from("code_sessions")
      .select("id, cwd, model, started_at, ended_at, title, props, files_touched")
      .eq("user_id", userId)
      .eq("code_project_id", codeProjectId)
      // Sub-agents already reach the graph through the parent's props.subAgents.
      .is("parent_source_session_id", null)
      .order("id")
      .range(from, to),
  );

  const sessionIds = sessions.map((s) => s.id);
  // F12: chunk the .in("session_id", ...) id list — one project with ~1000+
  // sessions would otherwise build a multi-KB PostgREST URL and 414 before
  // any turns come back (throwing before any write, so the graph just goes
  // stale rather than empty — but still worth avoiding).
  const turns: ToolUseTurnRow[] = [];
  for (let i = 0; i < sessionIds.length; i += SESSION_ID_CHUNK) {
    const idChunk = sessionIds.slice(i, i + SESSION_ID_CHUNK);
    if (idChunk.length === 0) continue;
    const chunkTurns = await selectAllRows<ToolUseTurnRow>((from, to) =>
      supabase
        .from("code_session_turns")
        .select("session_id, tool_name, file_path, props")
        .eq("user_id", userId)
        .eq("kind", "tool_use")
        .in("session_id", idChunk)
        .order("id")
        .range(from, to),
    );
    turns.push(...chunkTurns);
  }

  const nodes: CodeKgNodeRow[] = [];
  const edges: CodeKgEdgeRow[] = [];

  const newNode = (
    node_type: CodeKgNodeType,
    key: string,
    label: string,
    ref_id: string | null,
    props: Record<string, unknown>,
    session_count: number,
    first_seen_at: string | null,
    last_seen_at: string | null,
  ): CodeKgNodeRow => ({
    id: randomUUID(),
    user_id: userId,
    code_project_id: codeProjectId,
    node_type,
    key,
    label,
    ref_id,
    props,
    session_count,
    first_seen_at,
    last_seen_at,
  });

  const newEdge = (
    src_node_id: string,
    dst_node_id: string,
    rel_type: CodeKgRelType,
    weight: number,
    props: Record<string, unknown>,
  ): CodeKgEdgeRow => ({
    id: randomUUID(),
    user_id: userId,
    code_project_id: codeProjectId,
    src_node_id,
    dst_node_id,
    rel_type,
    weight,
    props,
  });

  // --- project mirror -------------------------------------------------
  let projectFirstSeen: string | null = null;
  let projectLastSeen: string | null = null;
  for (const s of sessions) {
    projectFirstSeen = minTs(projectFirstSeen, s.started_at);
    projectLastSeen = maxTs(projectLastSeen, s.ended_at);
  }
  const projectNode = newNode(
    "project",
    project.id,
    project.display_name ?? project.repo_identity,
    project.id,
    {},
    sessions.length,
    projectFirstSeen,
    projectLastSeen,
  );
  nodes.push(projectNode);

  // --- per-session state ------------------------------------------------
  const sessionNodeById = new Map<string, CodeKgNodeRow>();

  interface FileAgg {
    key: string;
    sessions: Set<string>;
    firstSeen: string | null;
    lastSeen: string | null;
    perSession: Map<string, { editCount: number; created?: boolean }>;
  }
  interface ToolAgg {
    key: string;
    label: string;
    rawName?: string;
    sessions: Set<string>;
    firstSeen: string | null;
    lastSeen: string | null;
    perSessionCount: Map<string, number>;
  }
  const fileAggs = new Map<string, FileAgg>();
  const toolAggs = new Map<string, ToolAgg>();

  for (const session of sessions) {
    const sessionUsage = (session.props?.usage as RawUsage | undefined) ?? undefined;
    const sessionModels =
      (session.props?.models as string[] | undefined) ?? (session.model ? [session.model] : undefined);
    const primaryModel = sessionModels?.[0] ?? session.model ?? undefined;
    const cost = computeCost(sessionUsage, primaryModel);

    const sessionProps = omitUndefined({
      models: sessionModels,
      usage: sessionUsage,
      est_cost_usd: cost,
    });

    const sessionNode = newNode(
      "session",
      session.id,
      session.title ?? `session ${session.id}`,
      session.id,
      sessionProps,
      1,
      session.started_at,
      session.ended_at,
    );
    nodes.push(sessionNode);
    sessionNodeById.set(session.id, sessionNode);

    // CONTAINS: project -> session (structural)
    edges.push(newEdge(projectNode.id, sessionNode.id, "contains", 1, {}));

    // SPAWNED: session -> subagent, from the parser-persisted sidecar join
    // (ADR 0026 D3). Sparse/absent on rows imported before this parser
    // extension shipped — code_sessions.props defaults to {} for those.
    const subAgents = (session.props?.subAgents as RawSubAgent[] | undefined) ?? [];
    subAgents.forEach((sub, i) => {
      if (sub.isFork === true) return; // forks inherit the parent's context — not a distinct node (D3)
      const key = sub.agentId ?? sub.toolUseId ?? `${session.id}:subagent:${i}`;
      const label = sub.description ?? sub.agentType ?? "sub-agent";
      const props = omitUndefined({
        agent_type: sub.agentType,
        description: sub.description,
        spawn_depth: sub.spawnDepth,
        model: sub.model,
        tokens: sub.usage,
        tool_use_id: sub.toolUseId,
        parent_agent_id: sub.parentAgentId,
      });
      const subAgentNode = newNode("subagent", key, label, null, props, 1, session.started_at, session.ended_at);
      nodes.push(subAgentNode);
      edges.push(
        newEdge(sessionNode.id, subAgentNode.id, "spawned", 1, omitUndefined({ model: sub.model, tokens: sub.usage })),
      );
    });

    // F6 / ADR 0023 Q1/Q4 D13 fallback: seed a File touch from
    // code_sessions.files_touched BEFORE folding turns below, so a source
    // that reports session-level files but no per-turn file_path (or an
    // already-imported session whose turns predate that parser extension)
    // still yields File nodes — "a valid, smaller graph", not zero. editCount
    // starts at 0 here; a matching tool_use turn below fills it in for free.
    for (const rawPath of session.files_touched ?? []) {
      const canonical = canonicalFilePath(rawPath, session.cwd);
      let fileAgg = fileAggs.get(canonical);
      if (!fileAgg) {
        fileAgg = { key: canonical, sessions: new Set(), firstSeen: null, lastSeen: null, perSession: new Map() };
        fileAggs.set(canonical, fileAgg);
      }
      fileAgg.sessions.add(session.id);
      fileAgg.firstSeen = minTs(fileAgg.firstSeen, session.started_at);
      fileAgg.lastSeen = maxTs(fileAgg.lastSeen, session.ended_at);
      if (!fileAgg.perSession.has(session.id)) {
        fileAgg.perSession.set(session.id, { editCount: 0, created: undefined });
      }
    }
  }

  // --- fold tool_use turns into File/Tool aggregates ---------------------
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  for (const turn of turns) {
    const session = sessionById.get(turn.session_id);
    if (!session) continue;
    const toolName = turn.tool_name ?? "unknown";
    const turnProps = turn.props ?? {};
    const mcpServer = typeof turnProps.mcpServer === "string" ? turnProps.mcpServer : undefined;
    const mcpTool = typeof turnProps.mcpTool === "string" ? turnProps.mcpTool : undefined;

    // Tool aggregation
    const { key: tKey, label: tLabel, rawName } = toolKey(toolName, mcpServer, mcpTool);
    let toolAgg = toolAggs.get(tKey);
    if (!toolAgg) {
      toolAgg = {
        key: tKey,
        label: tLabel,
        rawName,
        sessions: new Set(),
        firstSeen: null,
        lastSeen: null,
        perSessionCount: new Map(),
      };
      toolAggs.set(tKey, toolAgg);
    }
    toolAgg.sessions.add(session.id);
    toolAgg.firstSeen = minTs(toolAgg.firstSeen, session.started_at);
    toolAgg.lastSeen = maxTs(toolAgg.lastSeen, session.ended_at);
    toolAgg.perSessionCount.set(session.id, (toolAgg.perSessionCount.get(session.id) ?? 0) + 1);

    // File aggregation (file-touching tools only)
    if (turn.file_path) {
      const canonical = canonicalFilePath(turn.file_path, session.cwd);
      let fileAgg = fileAggs.get(canonical);
      if (!fileAgg) {
        fileAgg = { key: canonical, sessions: new Set(), firstSeen: null, lastSeen: null, perSession: new Map() };
        fileAggs.set(canonical, fileAgg);
      }
      fileAgg.sessions.add(session.id);
      fileAgg.firstSeen = minTs(fileAgg.firstSeen, session.started_at);
      fileAgg.lastSeen = maxTs(fileAgg.lastSeen, session.ended_at);

      const perSess = fileAgg.perSession.get(session.id) ?? { editCount: 0, created: undefined };
      if (EDIT_TOOLS.has(toolName)) {
        // ADR 0026 D1: edit_count from structuredPatch hunk count when
        // present, else 1 per edit call — never inferred from the tool name.
        const editHunks = typeof turnProps.editHunks === "number" ? turnProps.editHunks : 1;
        perSess.editCount += editHunks;
      }
      // ADR 0026 D1: created/updated comes ONLY from toolUseResult.type,
      // never `Write ⇒ created`. Absent on rows without that structured
      // field (backfill from before this parser extension) — `created`
      // stays undefined rather than guessed.
      const resultType = turnProps.resultType;
      if (resultType === "create") perSess.created = true;
      else if (resultType === "update" && perSess.created === undefined) perSess.created = false;
      fileAgg.perSession.set(session.id, perSess);
    }
  }

  // --- materialize File nodes + TOUCHED edges -----------------------------
  for (const fileAgg of fileAggs.values()) {
    const fileNode = newNode(
      "file",
      fileAgg.key,
      fileAgg.key,
      null,
      {},
      fileAgg.sessions.size,
      fileAgg.firstSeen,
      fileAgg.lastSeen,
    );
    nodes.push(fileNode);
    for (const [sessionId, perSess] of fileAgg.perSession) {
      const sessionNode = sessionNodeById.get(sessionId);
      if (!sessionNode) continue;
      edges.push(
        newEdge(
          sessionNode.id,
          fileNode.id,
          "touched",
          // F13: a read-only touch (or a files_touched-only touch with no
          // per-turn edit data) has editCount 0, but a touch still happened
          // — weight 0 both disagrees with the column's own default of 1 and
          // silently drops the recurrence signal for any retrieval that
          // sorts/multiplies by weight. edit_count (the raw count) still
          // lands in props, unclamped.
          Math.max(perSess.editCount, 1),
          omitUndefined({
            created: perSess.created,
            edit_count: perSess.editCount,
          }),
        ),
      );
    }
  }

  // --- materialize Tool nodes + USED edges --------------------------------
  for (const toolAgg of toolAggs.values()) {
    const toolNode = newNode(
      "tool",
      toolAgg.key,
      toolAgg.label,
      null,
      omitUndefined({ raw_name: toolAgg.rawName }),
      toolAgg.sessions.size,
      toolAgg.firstSeen,
      toolAgg.lastSeen,
    );
    nodes.push(toolNode);
    for (const [sessionId, count] of toolAgg.perSessionCount) {
      const sessionNode = sessionNodeById.get(sessionId);
      if (!sessionNode) continue;
      edges.push(newEdge(sessionNode.id, toolNode.id, "used", count, {}));
    }
  }

  const merged = mergeDuplicateGraphRows(nodes, edges);
  await replaceProjectGraph(supabase, codeProjectId, merged.nodes, merged.edges);

  const result: BuildCodeGraphResult = {
    codeProjectId,
    nodesWritten: merged.nodes.length,
    edgesWritten: merged.edges.length,
    nodeCountsByType: countBy(merged.nodes, (n) => n.node_type),
    edgeCountsByType: countBy(merged.edges, (e) => e.rel_type),
  };
  return result;
}

/**
 * Collapse rows that share an upsert conflict key before they reach
 * `replaceProjectGraph`: Postgres rejects a single `INSERT ... ON CONFLICT DO
 * UPDATE` that touches the same row twice ("cannot affect row a second
 * time"), failing the whole project's rebuild. The live case: two top-level
 * sessions of one resumed transcript both carry the same sub-agent in
 * `props.subAgents`, so the `subagent` node key appears twice. Nodes merge on
 * (node_type, key) — first row wins, session_count sums, seen-range widens;
 * edges are repointed at the surviving node, then merge on
 * (src, dst, rel_type) with weights summed.
 */
export function mergeDuplicateGraphRows(
  nodes: CodeKgNodeRow[],
  edges: CodeKgEdgeRow[],
): { nodes: CodeKgNodeRow[]; edges: CodeKgEdgeRow[] } {
  const nodeByKey = new Map<string, CodeKgNodeRow>();
  const survivorId = new Map<string, string>();
  for (const n of nodes) {
    const k = `${n.node_type}:${n.key}`;
    const kept = nodeByKey.get(k);
    if (!kept) {
      nodeByKey.set(k, { ...n });
      continue;
    }
    kept.session_count += n.session_count;
    kept.first_seen_at = minTs(kept.first_seen_at, n.first_seen_at);
    kept.last_seen_at = maxTs(kept.last_seen_at, n.last_seen_at);
    survivorId.set(n.id, kept.id);
  }
  const edgeByKey = new Map<string, CodeKgEdgeRow>();
  for (const e of edges) {
    const src = survivorId.get(e.src_node_id) ?? e.src_node_id;
    const dst = survivorId.get(e.dst_node_id) ?? e.dst_node_id;
    const k = `${src}:${dst}:${e.rel_type}`;
    const kept = edgeByKey.get(k);
    if (kept) kept.weight += e.weight;
    else edgeByKey.set(k, { ...e, src_node_id: src, dst_node_id: dst });
  }
  return { nodes: [...nodeByKey.values()], edges: [...edgeByKey.values()] };
}

/**
 * Rebuild every CodeProject's graph for a user. Runnable standalone
 * (backfill) and from the synthesize orchestrator. Zero LLM calls.
 *
 * F5: paginated past PostgREST's ~1000-row default cap — a user with more
 * than 1000 CodeProjects would otherwise silently truncate the list and
 * those projects' graphs would go stale forever.
 *
 * F2: each project's rebuild is contained in its own try/catch. One
 * project's failure is recorded on its own result entry (see
 * `BuildCodeGraphResult.error`) and does NOT abort the rest of the user's
 * projects — matching this module's and synthesize.ts's own documented
 * contract that the code-graph build "never blocks" the rest of the pass.
 */
export async function buildCodeGraphForUser(supabase: Db, userId: string): Promise<BuildCodeGraphResult[]> {
  const projects = await selectAllRows<{ id: string }>((from, to) =>
    supabase.from("code_projects").select("id").eq("user_id", userId).order("id").range(from, to),
  );

  const results: BuildCodeGraphResult[] = [];
  for (const project of projects) {
    try {
      results.push(await buildCodeGraphForProject(supabase, userId, project.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("code_graph build failed for one project — continuing with the rest", {
        user_id: userId,
        code_project_id: project.id,
        err: message,
      });
      results.push({
        codeProjectId: project.id,
        nodesWritten: 0,
        edgesWritten: 0,
        nodeCountsByType: {},
        edgeCountsByType: {},
        error: message,
      });
    }
  }
  return results;
}

function countBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Content-addressed replace (ADR 0023 Q4, corrected by the P2a adversarial
 * verify's F2/F3/F9 findings): upsert every node/edge this rebuild computed,
 * keyed on the table's own unique constraint, THEN delete only the rows from
 * a prior rebuild that this one didn't reproduce ("stale"). Never a blind
 * delete-then-insert. See this file's header comment for the full rationale.
 *
 * `nodes`/`edges` carry PROVISIONAL ids (assigned by `newNode`/`newEdge` so
 * the in-memory graph can be built in one pass) — those ids are never sent
 * to the database. Each upsert omits `id` from the payload entirely, so
 * Postgres either assigns a fresh one (new row) or leaves the existing one
 * untouched (conflicting row) — the UPDATE SET clause an upsert generates
 * only ever covers columns present in the payload.
 */
async function replaceProjectGraph(
  supabase: Db,
  codeProjectId: string,
  nodes: CodeKgNodeRow[],
  edges: CodeKgEdgeRow[],
): Promise<void> {
  // Snapshot which rows already exist for this project BEFORE writing
  // anything — used only to compute what's stale once the new set is safely
  // upserted below. Paginated: a long-lived busy project can exceed 1000
  // nodes/edges.
  const existingNodeIds = (
    await selectAllRows<{ id: string }>((from, to) =>
      supabase.from("code_kg_nodes").select("id").eq("code_project_id", codeProjectId).order("id").range(from, to),
    )
  ).map((r) => r.id);
  const existingEdgeIds = (
    await selectAllRows<{ id: string }>((from, to) =>
      supabase.from("code_kg_edges").select("id").eq("code_project_id", codeProjectId).order("id").range(from, to),
    )
  ).map((r) => r.id);

  // --- nodes: upsert by (code_project_id, node_type, key) — F9. ----------
  const nodeIdByKey = new Map<string, string>(); // `${node_type}:${key}` -> real db id
  for (let i = 0; i < nodes.length; i += NODE_INSERT_CHUNK) {
    const chunk = nodes.slice(i, i + NODE_INSERT_CHUNK);
    if (chunk.length === 0) continue;
    const rows = chunk.map(({ id: _id, ...rest }) => rest);
    const upsertRes = await supabase
      .from("code_kg_nodes")
      .upsert(rows, { onConflict: "code_project_id,node_type,key" })
      .select("id, node_type, key");
    if (upsertRes.error) throw new Error(`replaceProjectGraph(upsert nodes) failed: ${upsertRes.error.message}`);
    for (const row of (upsertRes.data ?? []) as { id: string; node_type: string; key: string }[]) {
      nodeIdByKey.set(`${row.node_type}:${row.key}`, row.id);
    }
  }

  // Resolve edges' provisional in-memory node ids to the real (possibly
  // pre-existing) database ids the upsert above just assigned/confirmed.
  const provisionalToReal = new Map<string, string>();
  for (const n of nodes) {
    const real = nodeIdByKey.get(`${n.node_type}:${n.key}`);
    if (real) provisionalToReal.set(n.id, real);
  }
  const resolvedEdges = edges.map((e) => ({
    ...e,
    src_node_id: provisionalToReal.get(e.src_node_id) ?? e.src_node_id,
    dst_node_id: provisionalToReal.get(e.dst_node_id) ?? e.dst_node_id,
  }));

  // --- edges: upsert by (code_project_id, src_node_id, dst_node_id, rel_type).
  const keptEdgeIds = new Set<string>();
  for (let i = 0; i < resolvedEdges.length; i += EDGE_INSERT_CHUNK) {
    const chunk = resolvedEdges.slice(i, i + EDGE_INSERT_CHUNK);
    if (chunk.length === 0) continue;
    const rows = chunk.map(({ id: _id, ...rest }) => rest);
    const upsertRes = await supabase
      .from("code_kg_edges")
      .upsert(rows, { onConflict: "code_project_id,src_node_id,dst_node_id,rel_type" })
      .select("id");
    if (upsertRes.error) throw new Error(`replaceProjectGraph(upsert edges) failed: ${upsertRes.error.message}`);
    for (const row of (upsertRes.data ?? []) as { id: string }[]) keptEdgeIds.add(row.id);
  }

  // --- delete stale rows LAST (F2): a failure anywhere above throws before
  // reaching here, so it leaves the OLD graph as-is — never emptied.
  // Edges before nodes: code_kg_edges' FKs cascade off code_kg_nodes, so a
  // stale node is never deleted while a live (just-upserted) edge still
  // depends on a DIFFERENT stale node — edges are already fully settled by
  // the time node cleanup runs.
  await chunkedDeleteByIds(
    supabase,
    "code_kg_edges",
    existingEdgeIds.filter((id) => !keptEdgeIds.has(id)),
  );
  const keptNodeIds = new Set(nodeIdByKey.values());
  await chunkedDeleteByIds(
    supabase,
    "code_kg_nodes",
    existingNodeIds.filter((id) => !keptNodeIds.has(id)),
  );
}

async function chunkedDeleteByIds(
  supabase: Db,
  table: "code_kg_nodes" | "code_kg_edges",
  ids: string[],
): Promise<void> {
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    if (chunk.length === 0) continue;
    const res = await supabase.from(table).delete().in("id", chunk);
    if (res.error) throw new Error(`replaceProjectGraph(delete stale ${table}) failed: ${res.error.message}`);
  }
}
