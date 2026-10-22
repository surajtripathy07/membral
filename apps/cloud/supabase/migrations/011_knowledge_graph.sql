-- ============================================================
-- 011_knowledge_graph.sql
-- Production knowledge-graph schema (membral-ort.1 bead)
-- Depends on: 001 (profiles, conversations, pgvector), 002 (RLS)
-- ============================================================

-- ------------------------------------------------------------
-- enums
-- ------------------------------------------------------------

create type public.kg_node_type as enum (
  'User',
  'LifeArea',
  'Item',
  'Conversation',
  'Person',
  'Organization',
  'Tool',
  'Artifact',
  'PendingExtraction'
);

create type public.kg_edge_type as enum (
  'contains',
  'contributes_to',
  'discusses',
  'mentions_person',
  'collaborates_with',
  'uses_tool',
  'is_about',
  'modifies',
  'depends_on',
  'reviews',
  'decides',
  'holds_stance',
  'relates_to'
);

create type public.kg_actor_type as enum ('llm', 'user', 'system');

-- ------------------------------------------------------------
-- kg_nodes: core graph vertices
-- ------------------------------------------------------------

create table public.kg_nodes (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  type                   kg_node_type not null,
  kind                   text,
  label                  text not null,
  aliases                text[] not null default '{}',
  props                  jsonb not null default '{}',
  status                 text,
  confidence             real,
  embedding              vector(1536),
  created_by_actor       kg_actor_type not null default 'llm',
  created_by_model       text,
  last_modified_by       kg_actor_type not null default 'llm',
  locked_fields          text[] not null default '{}',
  source_conversation_id uuid references public.conversations(id) on delete set null,
  deleted_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ------------------------------------------------------------
-- kg_edges: directed graph edges
-- ------------------------------------------------------------

create table public.kg_edges (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  src_id                 uuid not null references public.kg_nodes(id) on delete cascade,
  dst_id                 uuid not null references public.kg_nodes(id) on delete cascade,
  rel_type               kg_edge_type not null,
  predicate              text,
  props                  jsonb not null default '{}',
  valid_at               timestamptz,
  invalid_at             timestamptz,
  expired_at             timestamptz,
  source_conversation_id uuid references public.conversations(id) on delete set null,
  source_turn_idx        integer,
  confidence             real,
  created_by_actor       kg_actor_type not null default 'llm',
  created_by_model       text,
  last_modified_by       kg_actor_type not null default 'llm',
  deleted_at             timestamptz,
  created_at             timestamptz not null default now()
);

-- ------------------------------------------------------------
-- kg_node_history: immutable audit log for node mutations
-- ------------------------------------------------------------

create table public.kg_node_history (
  id              uuid primary key default gen_random_uuid(),
  node_id         uuid not null references public.kg_nodes(id) on delete cascade,
  user_id         uuid not null,  -- denormalized for RLS
  sequence_number bigint generated always as identity,
  snapshot        jsonb not null,
  actor_type      kg_actor_type not null,
  actor_id        text,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- kg_edge_history: immutable audit log for edge mutations
-- ------------------------------------------------------------

create table public.kg_edge_history (
  id              uuid primary key default gen_random_uuid(),
  edge_id         uuid not null references public.kg_edges(id) on delete cascade,
  user_id         uuid not null,  -- denormalized for RLS
  sequence_number bigint generated always as identity,
  snapshot        jsonb not null,
  actor_type      kg_actor_type not null,
  actor_id        text,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- kg_user_portraits: one row per user, regenerated on demand
-- ------------------------------------------------------------

create table public.kg_user_portraits (
  user_id          uuid primary key references public.profiles(id) on delete cascade,
  version          int not null default 1,
  generated_at     timestamptz not null default now(),
  markdown_full    text,
  markdown_compact text,
  json_full        jsonb,
  portrait_dirty   boolean not null default false
);

-- ------------------------------------------------------------
-- kg_extraction_rejections: human/system feedback on proposals
-- ------------------------------------------------------------

create table public.kg_extraction_rejections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  rejected_at       timestamptz not null default now(),
  original_proposal jsonb not null,
  reason            text,
  user_reason       text,
  category          text
);

-- ============================================================
-- indexes
-- ============================================================

-- kg_nodes: composite lookup by user + type
create index idx_kg_nodes_user_type
  on public.kg_nodes (user_id, type);

-- kg_nodes: case-insensitive label lookup
create index idx_kg_nodes_user_label
  on public.kg_nodes (user_id, lower(label));

-- kg_nodes: partial — only rows with a status value
create index idx_kg_nodes_user_status
  on public.kg_nodes (user_id, status)
  where status is not null;

-- kg_nodes: HNSW vector index — only rows that have an embedding
create index idx_kg_nodes_embedding
  on public.kg_nodes using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

-- kg_nodes: enforce at most one type='User' node per user (singleton)
create unique index idx_kg_nodes_user_singleton
  on public.kg_nodes (user_id)
  where type = 'User';

-- kg_edges: outbound traversal (src) with rel_type filter
create index idx_kg_edges_user_src_rel
  on public.kg_edges (user_id, src_id, rel_type);

-- kg_edges: inbound traversal (dst) with rel_type filter
create index idx_kg_edges_user_dst_rel
  on public.kg_edges (user_id, dst_id, rel_type);

-- kg_edges: lookup by edge kind across a user's graph
create index idx_kg_edges_user_rel
  on public.kg_edges (user_id, rel_type);

-- kg_edges: partial — trace edges back to the source conversation
create index idx_kg_edges_source_conv
  on public.kg_edges (source_conversation_id)
  where source_conversation_id is not null;

-- kg_node_history: lookup history records for a node
create index idx_kg_node_history_lookup
  on public.kg_node_history (user_id, node_id, sequence_number);

-- kg_edge_history: lookup history records for an edge
create index idx_kg_edge_history_lookup
  on public.kg_edge_history (user_id, edge_id, sequence_number);

-- ============================================================
-- row-level security
-- ============================================================

-- kg_nodes
alter table public.kg_nodes enable row level security;

create policy "kg_nodes: users see own rows" on public.kg_nodes
  for select using (auth.uid() = user_id);
create policy "kg_nodes: users insert own rows" on public.kg_nodes
  for insert with check (auth.uid() = user_id);
create policy "kg_nodes: users update own rows" on public.kg_nodes
  for update using (auth.uid() = user_id);
create policy "kg_nodes: users delete own rows" on public.kg_nodes
  for delete using (auth.uid() = user_id);

-- kg_edges
alter table public.kg_edges enable row level security;

create policy "kg_edges: users see own rows" on public.kg_edges
  for select using (auth.uid() = user_id);
create policy "kg_edges: users insert own rows" on public.kg_edges
  for insert with check (auth.uid() = user_id);
create policy "kg_edges: users update own rows" on public.kg_edges
  for update using (auth.uid() = user_id);
create policy "kg_edges: users delete own rows" on public.kg_edges
  for delete using (auth.uid() = user_id);

-- kg_node_history (user_id is denormalized — still works for RLS)
alter table public.kg_node_history enable row level security;

create policy "kg_node_history: users see own rows" on public.kg_node_history
  for select using (auth.uid() = user_id);
create policy "kg_node_history: users insert own rows" on public.kg_node_history
  for insert with check (auth.uid() = user_id);
create policy "kg_node_history: users update own rows" on public.kg_node_history
  for update using (auth.uid() = user_id);
create policy "kg_node_history: users delete own rows" on public.kg_node_history
  for delete using (auth.uid() = user_id);

-- kg_edge_history (user_id is denormalized — still works for RLS)
alter table public.kg_edge_history enable row level security;

create policy "kg_edge_history: users see own rows" on public.kg_edge_history
  for select using (auth.uid() = user_id);
create policy "kg_edge_history: users insert own rows" on public.kg_edge_history
  for insert with check (auth.uid() = user_id);
create policy "kg_edge_history: users update own rows" on public.kg_edge_history
  for update using (auth.uid() = user_id);
create policy "kg_edge_history: users delete own rows" on public.kg_edge_history
  for delete using (auth.uid() = user_id);

-- kg_user_portraits (user_id is the PK)
alter table public.kg_user_portraits enable row level security;

create policy "kg_user_portraits: users see own row" on public.kg_user_portraits
  for select using (auth.uid() = user_id);
create policy "kg_user_portraits: users insert own row" on public.kg_user_portraits
  for insert with check (auth.uid() = user_id);
create policy "kg_user_portraits: users update own row" on public.kg_user_portraits
  for update using (auth.uid() = user_id);
create policy "kg_user_portraits: users delete own row" on public.kg_user_portraits
  for delete using (auth.uid() = user_id);

-- kg_extraction_rejections
alter table public.kg_extraction_rejections enable row level security;

create policy "kg_extraction_rejections: users see own rows" on public.kg_extraction_rejections
  for select using (auth.uid() = user_id);
create policy "kg_extraction_rejections: users insert own rows" on public.kg_extraction_rejections
  for insert with check (auth.uid() = user_id);
create policy "kg_extraction_rejections: users update own rows" on public.kg_extraction_rejections
  for update using (auth.uid() = user_id);
create policy "kg_extraction_rejections: users delete own rows" on public.kg_extraction_rejections
  for delete using (auth.uid() = user_id);
