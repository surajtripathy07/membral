-- ============================================================
-- 012_search_conversations_secfix.sql
-- Security hardening for search_conversations (membral-ort.1)
--
-- Two vulnerabilities in the 003 version:
--   1. Missing SET search_path on a SECURITY DEFINER function
--      allows a search-path injection attack.
--   2. Accepts search_user_id as a caller-supplied parameter;
--      a malicious authenticated caller can pass any uuid and
--      read another user's conversations despite RLS on the
--      underlying table being bypassed by SECURITY DEFINER.
--
-- Fix: remove the parameter, call auth.uid() directly, and
-- pin the search path.
-- ============================================================

create or replace function public.search_conversations(
  query_text     text,
  query_embedding vector(1536),
  match_count    int default 10
)
returns table (
  id         uuid,
  source     text,
  title      text,
  updated_at timestamptz,
  summary    text,
  similarity float
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select
    c.id,
    c.source,
    c.title,
    c.updated_at,
    em.summary,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.conversations c
  left join public.extracted_metadata em on em.conversation_id = c.id
  where c.user_id = auth.uid()
    and (
      c.fts @@ plainto_tsquery('english', query_text)
      or 1 - (c.embedding <=> query_embedding) > 0.3
    )
  order by similarity desc nulls last
  limit match_count;
end;
$$;
