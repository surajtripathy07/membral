-- ============================================================
-- 046_claims_browse.sql
-- ADR 0030 D7, goal step 16 — fixes from the context-card generator's fresh
-- adversarial review (2026-07-26, NOT SOLID: 2 BLOCKER / 3 MAJOR / 5 MINOR).
-- Driver decisions this migration implements:
--
-- B1 (probe fan-out defeated identity dedup — the context-card route fanned
-- mcp_claims_context out over ten guessed English function words to fake an
-- "everything eligible" fetch, which re-introduced duplicate self/person
-- rows mcp_claims_identity's own dedup already solved): this migration adds
-- mcp_claims_browse, a real browse surface — no kind restriction (unlike
-- identity's `kind in ('self', 'person')`) and no query predicate (unlike
-- context's FTS match), the thing the ten-probe hack was trying to fake.
-- N2 (grain, corrected — round-2 re-verification): this RPC serves one
-- claim per fact identity — (kind, target_key, block_discriminator); kinds
-- whose discriminator is NULL collapse to one-per-target (latest wins), a
-- driver-ratified v1 grain; revisit if null-discriminator kinds accumulate
-- multiple distinct facts per target. Same 016 shape as 040/042/043:
-- SECURITY INVOKER, explicit p_user_id, EXECUTE revoked from
-- public/anon/authenticated and granted only to service_role, search_path
-- pinned. Same inline eligibility conjuncts as every other claims-serving
-- surface (claim_serve_eligible via the shared eligible CTE, `c.sensitive
-- is not true`) — copied from mcp_claims_identity/mcp_claims_context's live
-- (045-era) function text, not written from scratch.
--
-- Dedup grain is IDENTICAL to mcp_claims_identity's own
-- (`distinct on (kind, target_key, block_discriminator) ... order by
-- t_asserted desc nulls last` — latest version of each fact wins), applied
-- across ALL kinds instead of just self/person. The route is what excludes
-- self/person from the BROWSE portion of its merge (identity stays the
-- canonical source for those two kinds) — nothing in this RPC itself
-- special-cases them.
--
-- T1 (tie-break, round-2 re-verification fix, N1): DISTINCT ON's own ORDER
-- BY did NOT already give a deterministic winner per fact-identity group —
-- `t_asserted desc nulls last` alone is neither unique nor non-null, so two
-- candidate rows in the same (kind, target_key, block_discriminator) group
-- with equal (or both-NULL) t_asserted left Postgres free to pick either one
-- as the DISTINCT ON winner. This migration's intra-group ORDER BY now
-- APPENDS `claim_key` as the final tie-break (`kind, target_key,
-- block_discriminator, t_asserted desc nulls last, claim_key`), so the
-- winner itself is deterministic, not just the final row order. This RPC's
-- FINAL row order (its actual response order, after dedup) separately
-- tie-breaks on `claim_key` too — giving a fully deterministic total order:
-- `t_asserted desc nulls last, claim_key`.
-- mcp_claims_identity's own DISTINCT ON tie-break (no claim_key term there,
-- same gap this note used to wrongly claim didn't exist) is PRE-EXISTING,
-- UPSTREAM behavior and is deliberately left as-is by this migration (see
-- the M2 note below for the one field it DOES add to that function's
-- output).
--
-- PAGINATION + TOTAL COUNT: `p_limit` (default 200, clamped to [1, 1000])
-- and `p_offset` (default 0, clamped to >= 0) slice the deduped, ordered
-- set. `total_count` — a `count(*) over()` window computed over every
-- deduped row BEFORE the limit/offset clips the page — rides along on every
-- returned row, so a caller learns "N of M eligible" from one round trip
-- without a second query. (A page with zero rows, e.g. an out-of-range
-- offset, carries no total_count at all — today's actual caller,
-- api/context-card/route.ts, only ever fetches page one, so this is a
-- forward-looking knob, not a gap being papered over for a real caller.)
--
-- M2 SIDE EFFECT, FLAGGED FOR DRIVER/MAINTAINER RATIFICATION (a scope
-- extension beyond "add mcp_claims_browse", taken because the alternative —
-- M2 simply staying unfixed — seemed worse): the context-card's work
-- variant needs to tell a `self` claim's ATTRIBUTE (name/role/employer/...
-- — kg/claims.ts's SELF_ATTRIBUTES) apart from its kind, which is exactly
-- what `block_discriminator` already IS for `self` rows (D5's own table:
-- self -> attribute; see aggregate-claims.ts:332-334). But
-- mcp_claims_identity (040/042/043) is the ONLY source of `self`/`person`
-- claims the context-card route uses — the route deliberately excludes
-- browse's self/person rows from its merge, to avoid a second, redundant
-- copy of identity's own canonical dedup (B1's fix) — so unless IDENTITY's
-- own output ALSO carries `block_discriminator`, the work variant has no
-- way to tell a work-appropriate self attribute from a personal one, and
-- the M2 fix is not implementable at all. This migration therefore ALSO
-- `create or replace`s `mcp_claims_identity`, adding `block_discriminator`
-- to its jsonb output — a byte-for-byte-else-unchanged, PURELY ADDITIVE
-- field. Every eligibility/dedup/cap-ordering rule, and every other output
-- field, is IDENTICAL to migration 043's version. Existing callers that
-- don't read the new key are unaffected (jsonb is structurally typed at the
-- call site, not positionally).
-- ============================================================

-- ------------------------------------------------------------
-- mcp_claims_browse(p_user_id, p_limit, p_offset) — see header.
-- ------------------------------------------------------------
create or replace function public.mcp_claims_browse(
  p_user_id uuid,
  p_limit int default 200,
  p_offset int default 0
)
returns table (
  kind                text,
  target_key          text,
  block_discriminator text,
  name                text,
  relation_class      text,
  former              boolean,
  event_status        text,
  claim_text          text,
  effective_class     text,
  claim_origin        text,
  sensitive           boolean,
  receipt             jsonb,
  total_count         bigint
)
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
    -- Same fact-identity grain as mcp_claims_identity's own DISTINCT ON
    -- (migration 042/043), applied across ALL kinds: one row per (kind,
    -- target_key, block_discriminator), latest t_asserted wins. N1 fix
    -- (round-2 re-verification): `claim_key` appended as the intra-group
    -- tie-break — `t_asserted` alone is neither unique nor non-null, so
    -- without this the DISTINCT ON winner within a tied group was
    -- unspecified (Postgres picks whichever physical row it scans first).
    -- mcp_claims_identity's own DISTINCT ON below has the identical gap and
    -- is deliberately left alone (ratified as pre-existing/upstream).
    select distinct on (kind, target_key, block_discriminator)
      kind, target_key, block_discriminator, claim_key, name, relation_class, former, event_status,
      claim_text, claim_origin, sensitive, provider, conversation_id, message_id, char_start,
      char_end, quote_verbatim, t_asserted, effective_class
      from eligible
     order by kind, target_key, block_discriminator, t_asserted desc nulls last, claim_key
  ),
  counted as (
    -- Total eligible fact count, computed over every deduped row BEFORE
    -- limit/offset clips the page — every row on a page carries the same
    -- total_count.
    select *, count(*) over() as total_count
      from deduped
  )
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
    total_count
    from counted
   -- T1: deterministic total order — recency first, then claim_key as the
   -- unique tie-break (t_asserted alone is neither unique nor non-null).
   order by t_asserted desc nulls last, claim_key
   limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.mcp_claims_browse(uuid, int, int) is
  'Claims-first browse surface for the context-card generator (ADR 0030 D7, goal step 16, migration 046) — one claim per fact identity (kind, target_key, block_discriminator) across ALL kinds, deduped exactly like mcp_claims_identity; kinds whose discriminator is NULL collapse to one-per-target, latest wins (N2, a driver-ratified v1 grain — revisit if null-discriminator kinds accumulate multiple distinct facts per target). No kind restriction and no query predicate (unlike mcp_claims_context, which has both). total_count is a count(*) over() window over the full deduped set, riding along on every row, so the caller learns "N of M eligible" from one call. Deterministic order: t_asserted desc nulls last, then claim_key (T1); the DISTINCT ON''s own intra-group tie-break also ends in claim_key (N1), so the winner per group is deterministic too. Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

revoke all on function public.mcp_claims_browse(uuid, int, int) from public;
revoke all on function public.mcp_claims_browse(uuid, int, int) from anon;
revoke all on function public.mcp_claims_browse(uuid, int, int) from authenticated;
grant execute on function public.mcp_claims_browse(uuid, int, int) to service_role;

-- ------------------------------------------------------------
-- mcp_claims_identity — ADDITIVE ONLY (see the M2 header note above):
-- block_discriminator added to the jsonb output. Everything else —
-- eligibility, the (kind, target_key, block_discriminator) DISTINCT ON
-- dedup, the self-protected LIMIT 100 cap ordering (043) — is BYTE-IDENTICAL
-- to migration 043's version.
-- ------------------------------------------------------------
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
    -- Unchanged (042/043): one row per (kind, target_key,
    -- block_discriminator) fact identity — the latest t_asserted wins.
    select distinct on (kind, target_key, block_discriminator)
      kind, target_key, block_discriminator, name, relation_class, former, event_status, claim_text,
      claim_origin, sensitive, provider, conversation_id, message_id, char_start,
      char_end, quote_verbatim, t_asserted, effective_class
      from eligible
     order by kind, target_key, block_discriminator, t_asserted desc nulls last
  ),
  capped as (
    -- Unchanged (043): self facts always survive the LIMIT 100 cap.
    select * from deduped
     order by (kind <> 'self'), kind, target_key, t_asserted desc nulls last
     limit 100
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'kind', e.kind,
      'target_key', e.target_key,
      'block_discriminator', e.block_discriminator, -- 046 ADDITIVE (M2)
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
  'Claims-first identity surface for who_is_this_user (ADR 0030 D5, goal step 13). DISTINCT ON (kind, target_key, block_discriminator), latest t_asserted wins (M2), self-protected LIMIT 100 cap (043). Migration 046 ADDITIVE change: block_discriminator now included in the jsonb output (needed by the goal-step-16 context-card''s work-variant self-attribute restriction) — every other field, and all eligibility/dedup/cap logic, unchanged from 043. Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

revoke all on function public.mcp_claims_identity(uuid) from public;
revoke all on function public.mcp_claims_identity(uuid) from anon;
revoke all on function public.mcp_claims_identity(uuid) from authenticated;
grant execute on function public.mcp_claims_identity(uuid) to service_role;
