-- Enable pgvector extension
create extension if not exists vector with schema extensions;

-- Users profile (linked to auth.users)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  display_name text,
  tier text default 'free' check (tier in ('free', 'pro')),
  conversation_limit int default 100,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Conversations table
create table public.conversations (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  source text not null,
  source_id text not null,
  title text default 'Untitled',
  created_at timestamptz,
  updated_at timestamptz,
  model text,
  messages jsonb default '[]'::jsonb,
  metadata jsonb default '{}'::jsonb,
  synced_at timestamptz default now(),
  embedding vector(1536),
  unique (user_id, source, source_id)
);

-- Extracted metadata (from GPT-4o-mini extraction pipeline)
create table public.extracted_metadata (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references public.conversations(id) on delete cascade not null unique,
  summary text,
  topics text[] default '{}',
  entities text[] default '{}',
  questions text[] default '{}',
  decisions text[] default '{}',
  conversation_type text,
  extracted_at timestamptz default now()
);

-- Indexes
create index idx_conversations_user_id on public.conversations(user_id);
create index idx_conversations_source on public.conversations(source);
create index idx_conversations_updated_at on public.conversations(updated_at desc);
create index idx_conversations_embedding on public.conversations using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Full-text search
alter table public.conversations add column fts tsvector
  generated always as (to_tsvector('english', coalesce(title, ''))) stored;
create index idx_conversations_fts on public.conversations using gin(fts);
