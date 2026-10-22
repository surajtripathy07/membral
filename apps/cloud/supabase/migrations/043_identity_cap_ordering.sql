-- ============================================================
-- 043_identity_cap_ordering.sql
-- ADR 0030 D5 — MAJOR fix from round-2 verification of the goal-step-13/14
-- fresh adversarial review (2026-07-26): mcp_claims_identity's LIMIT 100
-- cap (migration 042, M2) ordered candidates `kind, target_key, t_asserted
-- desc nulls last` before capping. 'person' sorts alphabetically BEFORE
-- 'self', so once a user has more than 100 distinct person facts, the cap
-- consumes all 100 slots on person rows and drops EVERY self fact —
-- who_is_this_user degenerates into a contact list with nothing about the
-- user themselves, while still returning a non-empty claims result that
-- DISPLACES the working legacy identity_line (whoIsThisUser's `source:
-- "claims"` branch fires on ANY non-empty renderable line, so a
-- person-only line still wins over the legacy fallback).
--
-- FIX: order the cap by `(kind <> 'self'), kind, target_key, t_asserted
-- desc nulls last` instead — `kind <> 'self'` is `false` (sorts first) for
-- every self row and `true` for everything else, so ALL self facts survive
-- the cap regardless of how many distinct person facts exist, and the
-- remaining slots fill with person facts ordered exactly as before.
-- Everything else (security shape, grants, the DISTINCT ON dedup grain) is
-- IDENTICAL to migration 042's version — only the capped CTE's ORDER BY
-- changes.
-- ============================================================

create or replace function public.mcp_claims_identity(p_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with eligible as (
    select
      c.kind, c.target_key, c.block_discriminator, c.name, c.relation_class, c.former, c.event_status,
      c.claim_text, c.claim_origin, c.sensitive, c.provider, c.conversation_id,
      c.message_id, c.char_start, c.char_end, c.quote_verbatim, c.t_asserted,
      public.claim_effective_class(c, l) as effective_class
      from public.serve_candidates c
      join public.kg_claim_lifecycle l
        on l.user_id = c.user_id
       and l.claim_key_version = c.claim_key_version
       and l.claim_key = c.claim_key
     where c.user_id = p_user_id
       and l.orphaned_at is null
       and c.sensitive is not true
       and c.kind in ('self', 'person')
       and public.claim_serve_eligible(c, l)
  ),
  deduped as (
    -- M2 (unchanged): one row per (kind, target_key, block_discriminator)
    -- fact identity — the latest t_asserted wins within a group.
    select distinct on (kind, target_key, block_discriminator)
      kind, target_key, name, relation_class, former, event_status, claim_text,
      claim_origin, sensitive, provider, conversation_id, message_id, char_start,
      char_end, quote_verbatim, t_asserted, effective_class
      from eligible
     order by kind, target_key, block_discriminator, t_asserted desc nulls last
  ),
  capped as (
    -- FIX (round-2 verification, 2026-07-26): `kind <> 'self'` sorts FALSE
    -- (i.e. every self row) FIRST, so the LIMIT below can never drop a self
    -- fact in favour of a person fact — the cap now protects identity
    -- content about the user, not just whichever kind happens to sort first
    -- alphabetically. `self` claims are also inherently few (one per
    -- attribute, at most SELF_ATTRIBUTES.length ~ 7), so this costs the
    -- person side nothing in the common case and only trims person facts
    -- when a corpus genuinely has more than ~100 distinct people.
    select * from deduped
     order by (kind <> 'self'), kind, target_key, t_asserted desc nulls last
     limit 100
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'kind', e.kind,
      'target_key', e.target_key,
      'name', e.name,
      'relation_class', e.relation_class,
      'former', e.former,
      'event_status', e.event_status,
      'claim_text', e.claim_text,
      'effective_class', e.effective_class,
      'claim_origin', e.claim_origin,
      'sensitive', e.sensitive,
      'receipt', jsonb_build_object(
        'provider', e.provider,
        'conversation_id', e.conversation_id,
        'message_id', e.message_id,
        'char_start', e.char_start,
        'char_end', e.char_end,
        'quote_verbatim', e.quote_verbatim,
        't_asserted', e.t_asserted
      )
    ) order by e.kind, e.target_key, e.t_asserted desc nulls last),
    '[]'::jsonb
  )
  from capped e;
$$;

comment on function public.mcp_claims_identity(uuid) is
  'Claims-first identity surface for who_is_this_user (ADR 0030 D5, goal step 13). DISTINCT ON (kind, target_key, block_discriminator), latest t_asserted wins (M2). Cap-ordering fix (round-2 verification, 2026-07-26): self facts are ordered before person facts in the LIMIT 100 cap (`order by (kind <> ''self''), kind, target_key, t_asserted desc nulls last`) so identity content about the user always survives the cap regardless of how many distinct person facts exist. Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

-- Grants: unchanged from 040/042 (create or replace preserves existing
-- grants, but re-asserted here for the same belt-and-suspenders reason
-- 042 states explicitly).
revoke all on function public.mcp_claims_identity(uuid) from public;
revoke all on function public.mcp_claims_identity(uuid) from anon;
revoke all on function public.mcp_claims_identity(uuid) from authenticated;
grant execute on function public.mcp_claims_identity(uuid) to service_role;
