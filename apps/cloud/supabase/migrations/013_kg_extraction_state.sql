-- ============================================================
-- 013_kg_extraction_state.sql
-- Resumability state for the graph extraction pipeline (membral-ort.2)
-- Depends on: 001 (conversations, profiles), 011 (kg_nodes)
-- ============================================================

-- Per-conversation extraction state: Pass 1 results + resumability
create table public.kg_conversations_processed (
  conversation_id  uuid primary key references public.conversations(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  status           text not null default 'pending',  -- pending | done | failed
  started_at       timestamptz,
  completed_at     timestamptz,
  pass1_result     jsonb,
  tokens_in        integer not null default 0,
  tokens_out       integer not null default 0,
  cost_usd         real not null default 0,
  error            text,
  created_at       timestamptz not null default now()
);

create index idx_kg_conv_proc_user_status
  on public.kg_conversations_processed (user_id, status);

-- Cached conversation embeddings for Stage A clustering
create table public.kg_conv_embeddings (
  conversation_id  uuid primary key references public.conversations(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  embed_text       text not null,
  embedding        vector(1536) not null,
  created_at       timestamptz not null default now()
);

create index idx_kg_conv_emb_user
  on public.kg_conv_embeddings (user_id);

-- Stage A: variable-depth tree (proposal space, not live nodes)
create table public.kg_stage_a_tree (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  parent_id        uuid references public.kg_stage_a_tree(id) on delete cascade,
  depth            integer not null default 0,
  node_role        text not null,  -- 'life_area' | 'block'
  label            text not null,
  kind             text,
  status           text,
  is_block         boolean not null default true,
  not_block_reason text,
  life_area        text,
  evidence         text,
  member_conv_ids  uuid[] not null default '{}',
  own_conv_ids     uuid[] not null default '{}',
  member_count     integer not null default 0,
  confidence       real,
  promoted_node_id uuid references public.kg_nodes(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index idx_kg_stage_a_tree_user_run
  on public.kg_stage_a_tree (user_id, run_id, depth);

-- ============================================================
-- RLS — service-role bypasses; users can read their own rows
-- ============================================================

alter table public.kg_conversations_processed enable row level security;

create policy "kg_conv_proc: users see own rows" on public.kg_conversations_processed
  for select using (auth.uid() = user_id);
create policy "kg_conv_proc: users insert own rows" on public.kg_conversations_processed
  for insert with check (auth.uid() = user_id);
create policy "kg_conv_proc: users update own rows" on public.kg_conversations_processed
  for update using (auth.uid() = user_id);

alter table public.kg_conv_embeddings enable row level security;

create policy "kg_conv_emb: users see own rows" on public.kg_conv_embeddings
  for select using (auth.uid() = user_id);
create policy "kg_conv_emb: users insert own rows" on public.kg_conv_embeddings
  for insert with check (auth.uid() = user_id);

alter table public.kg_stage_a_tree enable row level security;

create policy "kg_stage_a_tree: users see own rows" on public.kg_stage_a_tree
  for select using (auth.uid() = user_id);
create policy "kg_stage_a_tree: users insert own rows" on public.kg_stage_a_tree
  for insert with check (auth.uid() = user_id);
create policy "kg_stage_a_tree: users update own rows" on public.kg_stage_a_tree
  for update using (auth.uid() = user_id);
