-- ============================================================
-- 074_claims_browse_returns_jsonb.sql
-- Issue #115: mcp_claims_browse (migration 046, grain-fixed 047) is a
-- `returns table` set-returning function granted EXECUTE only to
-- service_role. In this Postgres build, calling an ACL-denied SRF under a
-- role that lacks EXECUTE (PostgREST reaches it via
-- POST /rest/v1/rpc/mcp_claims_browse under `authenticated`) segfaults the
-- backend — the same crash migration 070's own header (object 9,
-- kg_memory_keys_for_claims) documented and fixed by switching to `returns
-- jsonb`; every memory-grain RPC in that migration (kg_memory_instances_page,
-- kg_memories_browse, kg_memories_facets, mcp_memories_context,
-- mcp_memories_browse, mcp_memories_identity, kg_memory_keys_for_claims) is
-- `returns jsonb` for exactly this reason. mcp_claims_browse predates that
-- migration and was never converted. This migration brings it into the same
-- shape.
--
-- `returns jsonb` fails CLEANLY with "permission denied for function" under
-- an unauthorized role instead of crashing the cluster. Postgres refuses
-- create-or-replace across a return-type change, so this is a drop + create.
--
-- Query body — eligibility conjuncts (serve_candidates join kg_claim_
-- lifecycle, orphaned_at is null, sensitive is not true,
-- claim_serve_eligible, no kind restriction), the DISTINCT ON grain
-- (kind, target_key, coalesce(block_discriminator, claim_key)) and its
-- intra-group tie-break (t_asserted desc nulls last, claim_key, message_id
-- nulls last, char_start nulls last, char_end nulls last, quote_verbatim —
-- 047 fix round 3, HIGH finding 1), the count(*) over() total_count window,
-- the page order (t_asserted desc nulls last, claim_key — T1) and the
-- limit/offset clamp — all BYTE-IDENTICAL to 047's. Only the final
-- projection changed: a bare SELECT of table columns became
-- jsonb_agg(jsonb_build_object(...)) over the same fields, matching how
-- migration 070's mcp_memories_browse (its closest sibling — a browse
-- surface returning many rows, not a single-object dispatcher like
-- kg_memories_browse) shapes its own array. Wire shape is unchanged for
-- every caller: PostgREST already serialized a `returns table` result as a
-- JSON array of rows, and supabase-js parses a `returns jsonb` array result
-- the same way — getClaimsBrowse in apps/cloud/src/lib/mcp/claims-tools.ts
-- needs no changes, the same precedent migration 070's own header states for
-- its objects (route.ts's supabase.rpc(...) call sites needed none either).
--
-- ACLs, language/stable/security invoker/search_path attributes: preserved
-- byte-identical to 047's mcp_claims_browse — revoke public/anon/
-- authenticated, grant service_role only; `language sql stable security
-- invoker set search_path = public, pg_temp`.
-- ============================================================

drop function if exists public.mcp_claims_browse(uuid, int, int);

create function public.mcp_claims_browse(
  p_user_id uuid,
  p_limit int default 200,
  p_offset int default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with eligible as (
    select
      c.kind, c.target_key, c.block_discriminator, c.claim_key, c.name, c.relation_class, c.former,
      c.event_status, c.claim_text, c.claim_origin, c.sensitive, c.provider, c.conversation_id,
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
       and public.claim_serve_eligible(c, l)
       -- NO kind restriction, NO query predicate: this is the browse
       -- surface — every eligible kind, unconditionally.
  ),
  deduped as (
    -- Grain + tie-break BYTE-IDENTICAL to 047's mcp_claims_browse — see that
    -- migration's own comment for the full history (F5, fix rounds 2/3).
    select distinct on (kind, target_key, coalesce(block_discriminator, claim_key))
      kind, target_key, block_discriminator, claim_key, name, relation_class, former, event_status,
      claim_text, claim_origin, sensitive, provider, conversation_id, message_id, char_start,
      char_end, quote_verbatim, t_asserted, effective_class
      from eligible
     order by kind, target_key, coalesce(block_discriminator, claim_key), t_asserted desc nulls last, claim_key,
              message_id nulls last, char_start nulls last, char_end nulls last, quote_verbatim
  ),
  counted as (
    -- Total eligible fact count, computed over every deduped row BEFORE
    -- limit/offset clips the page — every row on a page carries the same
    -- total_count.
    select *, count(*) over() as total_count
      from deduped
  ),
  ordered as (
    -- T1 (046, unchanged): deterministic total order — recency first, then
    -- claim_key as the unique tie-break. Same clamp as 047's bare SELECT.
    select
      kind, target_key, block_discriminator, name, relation_class, former, event_status, claim_text,
      effective_class, claim_origin, sensitive,
      jsonb_build_object(
        'provider', provider,
        'conversation_id', conversation_id,
        'message_id', message_id,
        'char_start', char_start,
        'char_end', char_end,
        'quote_verbatim', quote_verbatim,
        't_asserted', t_asserted
      ) as receipt,
      total_count, t_asserted, claim_key
      from counted
     order by t_asserted desc nulls last, claim_key
     limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', o.kind, 'target_key', o.target_key, 'block_discriminator', o.block_discriminator,
        'name', o.name, 'relation_class', o.relation_class, 'former', o.former, 'event_status', o.event_status,
        'claim_text', o.claim_text, 'effective_class', o.effective_class, 'claim_origin', o.claim_origin,
        'sensitive', o.sensitive, 'receipt', o.receipt, 'total_count', o.total_count
      )
      order by o.t_asserted desc nulls last, o.claim_key
    ),
    '[]'::jsonb
  )
  from ordered o;
$$;

comment on function public.mcp_claims_browse(uuid, int, int) is
  'Claims-first browse surface for the context-card generator (ADR 0030 D7, goal step 16, migration 046; grain fix + tie-break fix migration 047; issue #115, migration 074: returns jsonb instead of returns table — an ACL-denied set-returning function segfaults the backend under an unauthorized PostgREST role, the same crash migration 070 documented and fixed for its own memory-grain RPCs; query body and wire shape otherwise unchanged). One claim per fact identity (kind, target_key, coalesce(block_discriminator, claim_key)) across ALL kinds — deduped exactly like mcp_claims_identity (latest t_asserted wins) for kinds whose block_discriminator is non-null; kinds whose discriminator is NULL (project/decision/insight) dedupe on claim_key instead of collapsing to one-per-target (047 fix, #98). total_count is a count(*) over() window over the full deduped set, riding along on every row. Deterministic order: t_asserted desc nulls last, then claim_key (T1); the DISTINCT ON''s own intra-group tie-break is t_asserted desc nulls last, claim_key, THEN message_id nulls last, char_start nulls last, char_end nulls last, quote_verbatim (N1). Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

revoke all on function public.mcp_claims_browse(uuid, int, int) from public;
revoke all on function public.mcp_claims_browse(uuid, int, int) from anon;
revoke all on function public.mcp_claims_browse(uuid, int, int) from authenticated;
grant execute on function public.mcp_claims_browse(uuid, int, int) to service_role;
