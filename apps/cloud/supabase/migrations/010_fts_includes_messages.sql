-- Extend full-text search to cover message bodies, not just titles.
--
-- Until now `conversations.fts` was generated from the title alone, which
-- meant the contents of synced conversations (and their artifacts) were
-- invisible to keyword search. We rebuild `fts` to also index a flattened
-- text projection of every message body.

-- Flatten the messages jsonb array into a single text blob for indexing.
create or replace function public.conversation_messages_text(messages jsonb)
returns text
language sql
immutable
as $$
  select coalesce(
    string_agg(
      coalesce(msg.value->>'content', ''),
      E'\n'
    ),
    ''
  )
  from jsonb_array_elements(coalesce(messages, '[]'::jsonb)) as msg(value)
$$;

-- Drop the old fts column + index and rebuild with messages included.
drop index if exists idx_conversations_fts;
alter table public.conversations drop column if exists fts;

alter table public.conversations
  add column fts tsvector
  generated always as (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || public.conversation_messages_text(messages)
    )
  ) stored;

create index idx_conversations_fts on public.conversations using gin(fts);
