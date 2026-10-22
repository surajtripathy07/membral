-- ============================================================
-- 078_conversation_limit_trigger.sql
-- Issue #127 round-2 adversarial review, HIGH 3/4/6: `profiles.
-- conversation_limit` was only enforced in application code
-- (getConversationQuota/partitionByConversationQuota in lib/billing.ts,
-- called from /api/sync and /api/import). Three ways around that:
--
--   HIGH 3 - /api/import/upload (the bulk ChatGPT/Claude export path) never
--   called ingestConversations with `enforceQuota: true`, so a dragged-in
--   export could write unlimited rows regardless of conversation_limit.
--
--   HIGH 4 - getConversationQuota's count query excluded
--   `source = 'claude-code'` (ADR 0039 M3 said a mirrored code session
--   shouldn't consume chat quota) so /api/code-sessions' mirror path wrote
--   unbounded `conversations` rows nothing ever counted against any ceiling.
--   Per the round-2 finding, mirrored code sessions now count against the
--   SAME conversation_limit as chat conversations - a deliberate narrowing
--   of ADR 0039 M3, flagged in the fix report.
--
--   HIGH 6 - even where enforcement existed, the check (SELECT count(*))
--   and the write (the eventual upsert) were two separate round-trips with
--   no lock between them - concurrent requests could each observe stale
--   headroom and all pass, multiplying the effective limit.
--
-- FIX: move the check into a BEFORE INSERT row trigger on
-- public.conversations so every insert path (the app's own upserts, a
-- future RPC, a manual `insert`, ...) is covered by ONE atomic
-- count-and-check, and no app-level round-trip gap can be raced.
--
-- The trigger is a BACKSTOP, not a replacement for the existing app-level
-- pre-partition (lib/billing.ts's partitionByConversationQuota, still used
-- by /api/sync and /api/import for a friendly partial-batch response
-- BEFORE ever attempting the write) - callers still get the nice
-- skipped/atLimit shape in the common case; this trigger only fires when
-- that pre-check was skipped (the /api/import/upload path, until its own
-- fix lands) or raced (HIGH 6's TOCTOU window).
-- ============================================================

-- Already created by migration 001 (idx_conversations_user_id) - confirmed
-- present; this is a defensive if-not-exists so the migration is safe to
-- replay against a DB where it was somehow dropped.
create index if not exists idx_conversations_user_id on public.conversations (user_id);

create or replace function public.enforce_conversation_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  -- An upsert of an EXISTING (user_id, source, source_id) row is an UPDATE,
  -- not new usage - always allowed regardless of quota. This mirrors
  -- partitionByConversationQuota's own "existing rows always accepted"
  -- rule, and is what lets `insert ... on conflict (...) do update` keep
  -- working for every already-synced conversation once a user is at their
  -- limit.
  if exists (
    select 1
      from public.conversations
     where user_id = new.user_id
       and source = new.source
       and source_id = new.source_id
  ) then
    return new;
  end if;

  -- HIGH 6: serialize concurrent quota checks for THIS user so two racing
  -- inserts can't both observe stale headroom. Transaction-scoped -
  -- released automatically when the enclosing statement/transaction ends.
  -- Same pattern as migration 028's rate_limit_check.
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));

  select coalesce(conversation_limit, 100)
    into v_limit
    from public.profiles
   where id = new.user_id;

  -- No profiles row at all (should not happen - migration 004's
  -- handle_new_user trigger creates one on every auth.users insert) falls
  -- back to the same free-tier default getConversationQuota() uses.
  if v_limit is null then
    v_limit := 100;
  end if;

  -- HIGH 4: counts ALL sources, including `claude-code` - no exclusion.
  select count(*)
    into v_count
    from public.conversations
   where user_id = new.user_id;

  if v_count >= v_limit then
    raise exception 'conversation_limit'
      using errcode = 'P0001',
            detail = json_build_object('limit', v_limit, 'count', v_count)::text;
  end if;

  return new;
end;
$$;

comment on function public.enforce_conversation_limit() is
  'Issue #127 round-2 HIGH 3/4/6: atomic before-insert quota check for public.conversations. Raises errcode P0001, message ''conversation_limit'', detail {"limit":N,"count":N} when a brand-new (user_id,source,source_id) row would exceed profiles.conversation_limit. Existing rows (updates) always pass. See lib/billing.ts''s parseConversationLimitError for the app-side translation.';

drop trigger if exists conversations_enforce_limit on public.conversations;
create trigger conversations_enforce_limit
  before insert on public.conversations
  for each row
  execute function public.enforce_conversation_limit();
