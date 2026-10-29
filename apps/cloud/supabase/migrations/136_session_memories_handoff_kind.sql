-- ============================================================
-- 136_session_memories_handoff_kind.sql
-- Agent-authored handoff (goal 2026-10-25 box 2.3a, design
-- docs/design/2026-10-25_agent-authored-handoff.md). A closed session's
-- extraction pass may write ONE synthesized note per session as a
-- session_memories row with kind = 'handoff' (quote null, source 'extractor').
--
-- 1. kind check: widened from (outcome, decision, learning, blocker,
--    preference) to add 'handoff'. Added NOT VALID, then validated; the file
--    runs in one transaction, so the split saves no lock time (table is small).
-- 2. source_record_ids: the live record ids the note was built from (for the
--    gap diff of box 2.4). Nullable.
-- 3. covered_by_handoff: nullable flag for box 2.4; nothing writes it yet.
-- 4. Partial unique index: at most one LIVE handoff per session. The writer
--    retires the old note before inserting, so a second live note means two
--    writers raced and the insert fails with 23505.
-- Additive: the old app never writes 'handoff' and reads kind as text.
-- ============================================================
alter table public.session_memories
  drop constraint if exists session_memories_kind_check;
alter table public.session_memories
  add constraint session_memories_kind_check
  check (kind in ('outcome', 'decision', 'learning', 'blocker', 'preference', 'handoff')) not valid;
alter table public.session_memories
  validate constraint session_memories_kind_check;

alter table public.session_memories
  add column if not exists source_record_ids uuid[],
  add column if not exists covered_by_handoff boolean;

create unique index if not exists session_memories_one_live_handoff
  on public.session_memories (code_session_id)
  where kind = 'handoff' and retired_at is null;

-- 5. replace_session_handoff: retire the session's live note and insert its replacement in ONE transaction, so a
--    failure between the two can never leave the session with no note, and two writers cannot both pass a
--    read-then-write gap (the partial unique index above still rejects a second live note). Security as 112/121/130:
--    SECURITY INVOKER (service role bypasses RLS; any other caller is held to its own policies), search_path pinned,
--    revoked from public/anon/authenticated, service_role only. The session must belong to p_user_id.
create or replace function public.replace_session_handoff(
  p_user_id uuid,
  p_code_session_id uuid,
  p_text text,
  p_turn_idx integer,
  p_content_hash text,
  p_source_record_ids uuid[],
  p_extraction_pass text,
  p_retired_at timestamptz,
  p_retire_reason text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_project uuid;
  v_id uuid;
begin
  select cs.code_project_id into v_project
    from public.code_sessions cs
   where cs.id = p_code_session_id
     and cs.user_id = p_user_id;
  if not found then
    raise exception 'replace_session_handoff: session % not found for user %', p_code_session_id, p_user_id;
  end if;

  update public.session_memories
     set retired_at = p_retired_at,
         retire_reason = p_retire_reason
   where user_id = p_user_id
     and code_session_id = p_code_session_id
     and kind = 'handoff'
     and retired_at is null;

  insert into public.session_memories (
    user_id, code_session_id, code_project_id, source, kind, text, quote, turn_idx, turn_role,
    verified, durable, content_hash, extraction_pass, source_record_ids
  ) values (
    p_user_id, p_code_session_id, v_project, 'extractor', 'handoff', p_text, null, p_turn_idx, 'assistant',
    false, false, p_content_hash, p_extraction_pass, p_source_record_ids
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.replace_session_handoff(uuid, uuid, text, integer, text, uuid[], text, timestamptz, text) from public;
revoke all on function public.replace_session_handoff(uuid, uuid, text, integer, text, uuid[], text, timestamptz, text) from anon;
revoke all on function public.replace_session_handoff(uuid, uuid, text, integer, text, uuid[], text, timestamptz, text) from authenticated;
grant execute on function public.replace_session_handoff(uuid, uuid, text, integer, text, uuid[], text, timestamptz, text) to service_role;
