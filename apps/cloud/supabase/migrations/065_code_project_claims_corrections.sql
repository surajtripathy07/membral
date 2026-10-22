-- ============================================================
-- 065_code_project_claims_corrections.sql
-- W6/D7 fresh adversarial review, finding M9 — kg_claims_by_code_project
-- (migration 061) never unioned kg_user_claims, so a claim the user
-- explicitly corrected still rendered on the code-project page as an
-- ordinary amber "inferred" card, with the correction itself nowhere to be
-- found — exactly the failure ADR 0025's correction machinery exists to
-- prevent. It also never returned `sensitive`, so masking was impossible.
--
-- Fix (same 4-arg signature, CREATE OR REPLACE — no drop needed):
--   - Superseded originals (`grounding = 'corrected'`) are now EXCLUDED
--     entirely from this RPC's output (unlike kg_claims_browse's default
--     view, which shows both sides of a correction pair for transparency —
--     the code-project page has no correction UI of its own, so showing the
--     stale original serves no purpose here).
--   - The live correction that superseded it is INCLUDED instead
--     (`corrected: true` in the output), resolved to this project via the
--     SAME (kind, subject_key, target_key, block_discriminator) pairing
--     tuple kg_claims_browse's own 'corrected' filter uses (061/059) — a
--     kg_user_claims row carries no conversation/project of its own, so its
--     project is "whichever project the claim it corrected belongs to".
--   - `sensitive` is now returned so a future UI can mask it (not built
--     here — out of this migration's scope, see the review's own M9 note).
--
-- Depends on: 039 (kg_claims.sensitive), 041 (kg_user_claims, membral_correct),
-- 046 (claim_serve_eligible/serve_candidates), 061 (this function's origin).
-- ============================================================

create or replace function public.kg_claims_by_code_project(
  p_user_id uuid,
  p_code_project_ids uuid[],
  p_include_inferred boolean default true,
  p_limit int default 200
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'kg_claims_by_code_project requires an end-user session matching p_user_id';
  end if;

  if p_code_project_ids is null or array_length(p_code_project_ids, 1) is null then
    return '[]'::jsonb;
  end if;

  with graded as (
    -- Every code-lane claim for this user, INTENTIONALLY not yet filtered
    -- to p_code_project_ids — `corrections_resolved` below needs to look up
    -- a correction's paired original regardless of which project it landed
    -- in, then the final `visible` union applies the real project filter to
    -- both halves.
    select
      c.id, c.kind, c.evidence_quote, c.conversation_id, c.sensitive,
      coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
      public.claim_browse_grounding(c, l) as grounding,
      false as corrected,
      conv.title as conversation_title,
      conv.metadata->>'branch' as branch,
      coalesce(conv.updated_at, conv.created_at, c.created_at) as said_at,
      c.subject_key, c.target_key, c.block_discriminator,
      (conv.metadata->>'code_project_id')::uuid as code_project_id
    from public.kg_claims c
    join public.kg_claim_lifecycle l
      on l.user_id = c.user_id
     and l.claim_key_version = c.claim_key_version
     and l.claim_key = c.claim_key
    join public.conversations conv on conv.id = c.conversation_id and conv.user_id = p_user_id
    where c.user_id = p_user_id
      and c.claim_key is not null
      and conv.source = 'claude-code'
      and conv.metadata->>'code_project_id' is not null
  ),
  corrections as (
    -- Mirrors kg_claims_browse's own `corrections` CTE (059/061) — identical
    -- eligibility (claim_serve_eligible over a live, non-retired correction).
    select
      u.correction_id as id, u.kind, u.evidence_quote, null::uuid as conversation_id, u.sensitive,
      coalesce(u.claim_text, u.name, u.target_key) as claim_text_best,
      'grounded'::text as grounding,
      true as corrected,
      null::text as conversation_title,
      null::text as branch,
      u.t_asserted as said_at,
      u.subject_key, u.target_key, u.block_discriminator
    from public.kg_user_claims u
    join public.kg_claim_lifecycle l
      on l.user_id = u.user_id
     and l.claim_key_version = u.claim_key_version
     and l.claim_key = u.claim_key
    where u.user_id = p_user_id
      and u.corrects is not null
      and u.retires is null
      and not exists (
        select 1 from public.kg_user_claims r
         where r.user_id = u.user_id and r.retires = u.correction_id
      )
      and public.claim_serve_eligible(
        (
          row(
            'user_correction', u.claim_key_version, u.claim_key, u.user_id, u.kind,
            u.subject_key, u.target_key, u.block_discriminator, u.relation_class, u.former,
            u.name, u.payload->>'event_status', u.t_asserted,
            u.assertion_class, u.accepted, u.sensitive, u.claim_text, null::text[],
            u.correction_id, null::text, null::uuid, u.evidence_quote, null::int, null::int
          )
        )::public.serve_candidates,
        l
      )
  ),
  corrections_resolved as (
    -- A correction carries no conversation/project of its own — resolve one
    -- via ANY graded row (any grounding — the superseded original is always
    -- 'corrected', but the lookup is grounding-agnostic on purpose) sharing
    -- the SAME (kind, subject_key, target_key, block_discriminator) tuple
    -- claim_not_blocked (039) itself pairs a correction to what it blocks.
    select
      cor.id, cor.kind, cor.evidence_quote, cor.conversation_id, cor.sensitive,
      cor.claim_text_best, cor.grounding, cor.corrected,
      cor.conversation_title, cor.branch, cor.said_at,
      (
        select g.code_project_id
          from graded g
         where g.kind = cor.kind
           and g.subject_key is not distinct from cor.subject_key
           and g.target_key is not distinct from cor.target_key
           and g.block_discriminator is not distinct from cor.block_discriminator
         limit 1
      ) as code_project_id
    from corrections cor
  ),
  visible as (
    -- M9: 'corrected' (the superseded original) is excluded outright — the
    -- live correction (below) stands in for it. 'grounded' always passes;
    -- 'inferred' only when p_include_inferred.
    select id, kind, claim_text_best, grounding, evidence_quote, conversation_id,
           conversation_title, branch, said_at, sensitive, corrected, code_project_id
      from graded
     where grounding in ('grounded', 'inferred')
       and (grounding = 'grounded' or p_include_inferred)
       and code_project_id = any(p_code_project_ids)
    union all
    select id, kind, claim_text_best, grounding, evidence_quote, conversation_id,
           conversation_title, branch, said_at, sensitive, corrected, code_project_id
      from corrections_resolved
     where code_project_id = any(p_code_project_ids)
  ),
  limited as (
    select * from visible
    order by said_at desc nulls last, id
    limit least(greatest(coalesce(p_limit, 200), 1), 500)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', o.id,
        'kind', o.kind,
        'text', o.claim_text_best,
        'grounding', o.grounding,
        'quote', o.evidence_quote,
        'branch', o.branch,
        'conversation_id', o.conversation_id,
        'conversation_title', o.conversation_title,
        'said_at', o.said_at,
        'sensitive', o.sensitive,
        'corrected', o.corrected
      )
      -- decisions first, then most-recent within each kind bucket.
      order by case when o.kind = 'decision' then 0 else 1 end, o.said_at desc nulls last, o.id
    ),
    '[]'::jsonb
  )
  into v_result
  from limited o;

  return v_result;
end;
$$;

comment on function public.kg_claims_by_code_project(uuid, uuid[], boolean, int) is
  'Code-project page Memory section (migration 065, rewriting 061 — W6/D7 review M9). Claims whose conversation is source=''claude-code'' and whose metadata->>''code_project_id'' is one of the given code_projects.id array. A claim superseded by a correction (grounding=''corrected'') is EXCLUDED; the live correction that superseded it is INCLUDED instead (corrected=true), resolved to the same project via the (kind, subject_key, target_key, block_discriminator) pairing tuple kg_claims_browse itself uses. Now also returns `sensitive` (masking left to the caller — not built here). Ordered decisions-first then most-recent. Session-bound: security invoker + explicit auth.uid()=p_user_id loud-fail. EXECUTE: authenticated only.';

revoke all on function public.kg_claims_by_code_project(uuid, uuid[], boolean, int) from public;
revoke all on function public.kg_claims_by_code_project(uuid, uuid[], boolean, int) from anon;
grant execute on function public.kg_claims_by_code_project(uuid, uuid[], boolean, int) to authenticated;
