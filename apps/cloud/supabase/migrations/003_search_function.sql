create or replace function search_conversations(
  query_text text,
  query_embedding vector(1536),
  match_count int default 10,
  search_user_id uuid default auth.uid()
)
returns table (
  id uuid,
  source text,
  title text,
  updated_at timestamptz,
  summary text,
  similarity float
)
language plpgsql
security definer
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
  where c.user_id = search_user_id
    and (
      c.fts @@ plainto_tsquery('english', query_text)
      or 1 - (c.embedding <=> query_embedding) > 0.3
    )
  order by similarity desc nulls last
  limit match_count;
end;
$$;
