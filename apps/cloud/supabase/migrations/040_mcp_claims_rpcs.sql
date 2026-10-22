-- ============================================================
-- 040_mcp_claims_rpcs.sql
-- ADR 0030 D4/D5 — the claims-serving MCP RPCs (goal step 13).
-- Depends on: 039 (kg_claims, kg_user_claims, kg_claim_lifecycle,
-- serve_candidates, claim_serve_eligible, claim_effective_class).
-- ============================================================
--
-- Migration-016 shaped, deliberately: SECURITY INVOKER functions taking an
-- explicit `p_user_id uuid`, `where c.user_id = p_user_id` on every
-- subquery, EXECUTE revoked from public/anon/authenticated and granted ONLY
-- to service_role. /api/mcp connects with the service role (no Supabase
-- session -- auth.uid() is NULL there), so RLS is not the belt on this path
-- -- the explicit p_user_id predicate is (see 016's own header for the full
-- argument, and D5's "Serving surface: service-role RPCs, not a view"
-- section, which names 016's shape as the one to copy for exactly this
-- reason: a security_invoker VIEW with no predicate would return every
-- user's claims to a service-role caller, since RLS is bypassed and
-- auth.uid() is NULL under that role).
--
-- SENSITIVITY: `and c.sensitive is not true` inline in BOTH functions --
-- 0025 Q9's exact three-valued-logic predicate (`not sensitive` would drop
-- every legacy NULL row and return nothing). This is the MCP audience; the
-- owner-dashboard view (kg_claims_servable, migration 039) carries no such
-- filter, by design (D5: "Sensitivity is inlined per surface ... which
-- audience you are is decided by which function you call").
--
-- These functions replace the INTERNALS of who_is_this_user / get_context_for
-- (apps/cloud/src/lib/mcp/graph-tools.ts) -- goal step 13's own explicit
-- instruction that the OUTER MCP tool names/params must not change. See that
-- file for the claims-first-with-legacy-graph-fallback wiring.
-- ============================================================

-- ------------------------------------------------------------
-- FTS indexes over claim_text (ADR 0030 D5: "mcp_claims_context's v1
-- retrieval is FTS over claim_text, with a declared index" -- 039 deferred
-- this to step 13, exactly as its own header states: "the mcp_claims_* RPCs
-- ... are goal step 13 and are NOT created here"). 'simple' config, not a
-- language-specific stemmer -- the corpus is not monolingual (D5's own
-- stated reason, matching every other FTS index in this repo, e.g. 003's
-- `conversations.fts`... actually that one is 'english'; claims deliberately
-- deviates per the ADR's explicit instruction, not an oversight).
--
-- claim_text is expected to be largely/entirely NULL until goal step 12a's
-- re-extraction ships Delta 7 -- "Zero rows on the pre-12a corpus is
-- expected and fine" (this task's own explicit instruction). A GIN index
-- over an all-NULL expression costs almost nothing to maintain and is ready
-- the moment claim_text starts populating.
-- ------------------------------------------------------------
create index if not exists idx_kg_claims_claim_text_fts
  on public.kg_claims using gin (to_tsvector('simple', claim_text));

create index if not exists idx_kg_user_claims_claim_text_fts
  on public.kg_user_claims using gin (to_tsvector('simple', claim_text));

-- ------------------------------------------------------------
-- mcp_claims_identity(p_user_id): "who is this user, from claims" -- the
-- claims-first replacement for mcp_who_is_this_user's identity_line.
--
-- SCOPE, FLAGGED (the ADR names the function but not its exact query --
-- this implementer's fill-in): identity is drawn from `self` (the owner's
-- own attributes: name/role/employer/location/language/life_stage) and
-- `person` (the owner's relationships) claims -- the two kinds that answer
-- "who is this user" the way mcp_who_is_this_user's identity_line +
-- top_people did. Other kinds (place/project/event/...) are NOT identity in
-- this sense and are left to mcp_claims_context instead.
--
-- Every row is joined to its lifecycle row (INNER -- D5: "the row is written
-- at insert ... so the join is INNER and always finds a row") and passed
-- through the ONE shared eligibility predicate (claim_serve_eligible) plus
-- the sensitivity inline-filter. The redundant pre-filter
-- (`l.orphaned_at is null`) is sargable and cuts the candidate set before
-- claim_serve_eligible's function calls run, per D5's own stated
-- optimization -- claim_serve_eligible re-asserts it, so this changes
-- nothing about correctness, only cost.
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
      c.kind, c.target_key, c.name, c.relation_class, c.former, c.event_status,
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
  from eligible e;
$$;

-- ------------------------------------------------------------
-- mcp_claims_context(p_user_id, p_query, p_limit): "context for X, from
-- claims" -- the claims-first replacement for mcp_context_for.
--
-- v1 RETRIEVAL (D5, explicit): FTS over claim_text via the GIN 'simple'
-- index above, with an ILIKE fallback when plainto_tsquery('simple', ...)
-- produces an EMPTY tsquery (its ::text cast is '' -- 'simple' has no
-- stopword dictionary, so this only fires for a query that is empty or pure
-- punctuation/whitespace after tokenization). The fallback still filters on
-- the same eligibility/sensitivity conjuncts -- it changes only the MATCH
-- predicate, not who may be served. Embedding-based retrieval over claims is
-- explicitly deferred to goal step 11 (D5) -- not implemented here.
-- ------------------------------------------------------------
create or replace function public.mcp_claims_context(
  p_user_id uuid,
  p_query text,
  p_limit int default 20
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with q as (
    select plainto_tsquery('simple', coalesce(p_query, '')) as tsq
  ),
  eligible as (
    select
      c.kind, c.target_key, c.name, c.relation_class, c.former, c.event_status,
      c.claim_text, c.claim_origin, c.sensitive, c.provider, c.conversation_id,
      c.message_id, c.char_start, c.char_end, c.quote_verbatim, c.t_asserted,
      public.claim_effective_class(c, l) as effective_class
      from public.serve_candidates c
      join public.kg_claim_lifecycle l
        on l.user_id = c.user_id
       and l.claim_key_version = c.claim_key_version
       and l.claim_key = c.claim_key
      cross join q
     where c.user_id = p_user_id
       and l.orphaned_at is null
       and c.sensitive is not true
       and public.claim_serve_eligible(c, l)
       and (
         (q.tsq::text <> '' and to_tsvector('simple', c.claim_text) @@ q.tsq)
         or
         (q.tsq::text = '' and c.claim_text ilike '%' || p_query || '%')
       )
  ),
  limited as (
    select * from eligible
    order by t_asserted desc nulls last
    limit greatest(p_limit, 1)
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
    ) order by e.t_asserted desc nulls last),
    '[]'::jsonb
  )
  from limited e;
$$;

-- ------------------------------------------------------------
-- Lock down execution: service_role ONLY (migration 016's shape).
-- ------------------------------------------------------------
revoke all on function public.mcp_claims_identity(uuid) from public;
revoke all on function public.mcp_claims_identity(uuid) from anon;
revoke all on function public.mcp_claims_identity(uuid) from authenticated;
grant execute on function public.mcp_claims_identity(uuid) to service_role;

revoke all on function public.mcp_claims_context(uuid, text, int) from public;
revoke all on function public.mcp_claims_context(uuid, text, int) from anon;
revoke all on function public.mcp_claims_context(uuid, text, int) from authenticated;
grant execute on function public.mcp_claims_context(uuid, text, int) to service_role;
