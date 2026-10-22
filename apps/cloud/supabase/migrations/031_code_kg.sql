-- ============================================================
-- 031_code_kg.sql
-- Code-session knowledge graph — dedicated, isolated tables (ADR 0023 Q3,
-- corrected by ADR 0026 D9). P2a scope: deterministic (Tier-1) graph only.
-- Depends on: 029 (code_projects/code_sessions/code_session_turns).
-- ============================================================
--
-- WHY SEPARATE TABLES (ADR 0023 Q3, mirrors ADR 0021 Q2 exactly): the code
-- graph must never destabilise the existing chat graph (kg_nodes/kg_edges).
-- code_kg_nodes/code_kg_edges are NEW, DEDICATED tables — the chat pipeline
-- (pass1/embeddings/cluster/stage-a/promote/stage-b/portrait/resolve) only
-- ever selects kg_nodes/kg_edges, so it physically cannot see a row here.
-- Isolation is a structural invariant, proven in code-isolation.test.ts
-- (byte-identical kg_nodes/kg_edges snapshot before/after a full code-graph
-- build) — see lib/code-sessions/code-graph.ts.
--
-- OWNERSHIP NOTE (P2a adversarial verify, F11 — deferred to P2c, not this
-- migration's scope): RLS below is user_id-scoped exactly like 029/011, but
-- does not cross-check user_id against code_project_id ownership (the RLS
-- policies below still block cross-user reads/writes; the residual gap is
-- an attacker inserting a row they own that POINTS AT another user's
-- code_project_id). Any future project-scoped RPC (e.g. a P2c
-- `p_scope_code_project_id` reader) MUST filter on BOTH columns, not
-- code_project_id alone, or it becomes a graph-poisoning vector.
--
-- CodeProject/CodeSession are mirrored as node rows (ref_id back to their
-- source PK) so code_kg_edges stays a uniform node->node table — no
-- polymorphic (src_type, src_id) shape, exactly like the chat graph modeling
-- Conversation as a node type.
--
-- node_type / rel_type value sets (ADR 0023 Q1/Q1a/Q2, folded per ADR 0026
-- D9 — 'problem' node_type and 'resolved_by' rel_type are DROPPED; Problem
-- folds into Task as props.kind). P2a (this migration + the Stage-1
-- extractor) writes ONLY 'project'/'session'/'file'/'tool'/'subagent' nodes
-- and 'contains'/'touched'/'used'/'spawned' edges — the rest of the value
-- set is reserved for P2b's semantic (LLM) graph so this table doesn't need
-- another migration to add them.
-- ============================================================

create table public.code_kg_nodes (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  code_project_id  uuid not null references public.code_projects(id) on delete cascade,
  node_type        text not null check (node_type in (
                     'project', 'session', 'file', 'tool',
                     'decision', 'task', 'technology',
                     'subagent', 'directive', 'feedback', 'issue_ref'
                   )),
  key              text not null,  -- canonical dedup key within the project
  label            text not null,  -- display / retrieval text
  ref_id           uuid,           -- FK-by-convention to code_projects/code_sessions for the two mirror types; NULL for derived nodes
  props            jsonb not null default '{}'::jsonb,
  session_count    int not null default 0,
  first_seen_at    timestamptz,
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (code_project_id, node_type, key)
);

create table public.code_kg_edges (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  code_project_id  uuid not null references public.code_projects(id) on delete cascade,
  src_node_id      uuid not null references public.code_kg_nodes(id) on delete cascade,
  dst_node_id      uuid not null references public.code_kg_nodes(id) on delete cascade,
  rel_type         text not null check (rel_type in (
                     'contains', 'touched', 'used', 'made', 'spans', 'about', 'involves',
                     'spawned', 'gave', 'got', 'referenced'
                   )),
  weight           int not null default 1,
  props            jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique (code_project_id, src_node_id, dst_node_id, rel_type)
);

-- ------------------------------------------------------------
-- code_session_turns extras (ADR 0026 D1/D2/D10) — a single jsonb column,
-- consistent with code_projects.props / code_sessions.props / kg_nodes.props
-- convention, rather than five new scalar columns. Populated on tool_use
-- rows only, all keys optional:
--   result_type   text    'create'|'update'   (D1, from toolUseResult.type — NOT the tool name)
--   edit_hunks    int                          (D1, from toolUseResult.structuredPatch length)
--   mcp_server    text                          (D2, from attributionMcpServer)
--   mcp_tool      text                          (D2, from attributionMcpTool)
--   tool_use_id   text                          (join key for SubAgent correlation)
--   input_digest  text                          (D10, redacted + length-capped; allowlisted tools only)
-- Existing rows default to '{}' and remain valid (D13: source-optional).
-- ------------------------------------------------------------
alter table public.code_session_turns
  add column if not exists props jsonb not null default '{}'::jsonb;

-- ============================================================
-- indexes
-- ============================================================

create index idx_code_kg_nodes_user_id on public.code_kg_nodes (user_id);
create index idx_code_kg_nodes_code_project_id on public.code_kg_nodes (code_project_id);
create index idx_code_kg_nodes_node_type on public.code_kg_nodes (node_type);

create index idx_code_kg_edges_user_id on public.code_kg_edges (user_id);
create index idx_code_kg_edges_code_project_id on public.code_kg_edges (code_project_id);
create index idx_code_kg_edges_src_node_id on public.code_kg_edges (src_node_id);
create index idx_code_kg_edges_dst_node_id on public.code_kg_edges (dst_node_id);

-- ============================================================
-- row-level security — same four-policy shape as code_* (migration 029) and
-- kg_nodes (011): every table is user_id-scoped, owner-only, no cross-user
-- visibility.
-- ============================================================

alter table public.code_kg_nodes enable row level security;

create policy "code_kg_nodes: users see own rows" on public.code_kg_nodes
  for select using (auth.uid() = user_id);
create policy "code_kg_nodes: users insert own rows" on public.code_kg_nodes
  for insert with check (auth.uid() = user_id);
create policy "code_kg_nodes: users update own rows" on public.code_kg_nodes
  for update using (auth.uid() = user_id);
create policy "code_kg_nodes: users delete own rows" on public.code_kg_nodes
  for delete using (auth.uid() = user_id);

alter table public.code_kg_edges enable row level security;

create policy "code_kg_edges: users see own rows" on public.code_kg_edges
  for select using (auth.uid() = user_id);
create policy "code_kg_edges: users insert own rows" on public.code_kg_edges
  for insert with check (auth.uid() = user_id);
create policy "code_kg_edges: users update own rows" on public.code_kg_edges
  for update using (auth.uid() = user_id);
create policy "code_kg_edges: users delete own rows" on public.code_kg_edges
  for delete using (auth.uid() = user_id);
