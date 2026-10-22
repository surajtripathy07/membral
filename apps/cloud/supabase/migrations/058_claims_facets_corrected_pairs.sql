-- ============================================================
-- 058_claims_facets_corrected_pairs.sql
-- Round-3 re-verification of the Memory browser (2026-08-26). Item 5: the
-- "corrected" filter-rail chip (kg_claims_facets) undercounts relative to
-- what clicking that chip actually shows (kg_claims_browse with
-- p_grounding = 'corrected').
--
-- 057 (NEW-6) made kg_claims_browse's 'corrected' filter return BOTH sides
-- of a correction pair — the superseded original (grounding = 'corrected')
-- AND the correction row that superseded it (grounding = 'grounded',
-- corrected = true) — matched via the (kind, subject_key, target_key,
-- block_discriminator) tuple claim_not_blocked (039) actually blocks on
-- (see 057's own header for why claim_key/kg_user_claims.corrects don't
-- work for this pairing). kg_claims_facets' 'corrected' chip was never
-- updated to match: it still does a plain
-- `count(*) from combined where grounding = 'corrected'` — counting only
-- the superseded originals, never their correction partners — so the chip
-- undercounts by (roughly) half of what the browse view returns for the
-- same filter. Depends on: 039, 046, 051, 055, 057 (same lineage as 057).
--
-- Fix: kg_claims_facets' graded/corrections CTEs thread the SAME
-- subject_key/target_key/block_discriminator/corrected columns 057 already
-- threads through kg_claims_browse's graded/corrections, and the
-- 'corrected' count uses the IDENTICAL pairing predicate 057's WHERE clause
-- uses for p_grounding = 'corrected' — so the chip count equals
-- kg_claims_browse(..., p_grounding => 'corrected')'s total_count, by
-- construction. kinds/people/projects/grounded/inferred/dropped are
-- untouched. Same 2-arg signature as 051/055/057 — no drop needed, a plain
-- create-or-replace is safe.
-- ============================================================

create or replace function public.kg_claims_facets(p_user_id uuid, p_include_inferred boolean default false)
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
    raise exception 'kg_claims_facets requires an end-user session matching p_user_id';
  end if;

  with graded as (
    select
      -- NEW-10 (057): c.id threaded through so people/projects below can
      -- dedupe by claim identity instead of counting label-match rows.
      -- item 5 (058): subject_key/target_key/block_discriminator/corrected
      -- threaded through too — the SAME pairing tuple kg_claims_browse's
      -- 'corrected' filter (057, NEW-6) matches on, so the 'corrected' chip
      -- below counts exactly what that filter returns.
      c.id, c.kind, c.name,
      coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
      public.claim_browse_grounding(c, l) as grounding,
      false as corrected,
      c.subject_key, c.target_key, c.block_discriminator
    from public.kg_claims c
    join public.kg_claim_lifecycle l
      on l.user_id = c.user_id
     and l.claim_key_version = c.claim_key_version
     and l.claim_key = c.claim_key
    where c.user_id = p_user_id
      and c.claim_key is not null
  ),
  corrections as (
    select
      u.correction_id as id, u.kind, u.name,
      coalesce(u.claim_text, u.name, u.target_key) as claim_text_best,
      'grounded'::text as grounding,
      true as corrected,
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
  combined as (
    select * from graded
    union all
    select * from corrections
  ),
  visible as (
    select *
    from combined
    where grounding = 'grounded' or (p_include_inferred and grounding in ('inferred', 'corrected'))
  ),
  person_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false)
  ),
  project_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true)
  ),
  kinds as (
    -- Unaffected by NEW-10/item 5: grouped straight from `visible`, no
    -- label join and no pairing, so there is no row fan-out to dedupe here.
    select kind, count(*) as n from visible where kind is not null group by kind
  ),
  people as (
    -- NEW-10 (057): count(distinct v.id), not count(*) — a claim that
    -- matches more than one raw label collapsing into the same
    -- canonical_label (or matches the same raw label by both
    -- name-equality AND text-mention) used to be counted once per match,
    -- not once per claim.
    select pl.canonical_label as label, count(distinct v.id) as n
      from person_labels pl
      join visible v
        on lower(btrim(coalesce(v.name, ''))) = lower(pl.raw_label)
        or v.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
     group by pl.canonical_label
  ),
  projects as (
    -- NEW-10 (057): same count(distinct v.id) fix as people, above.
    select pl.canonical_label as label, count(distinct v.id) as n
      from project_labels pl
      join visible v
        on lower(btrim(coalesce(v.name, ''))) = lower(pl.raw_label)
        or v.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
     group by pl.canonical_label
  )
  select jsonb_build_object(
    'kinds', coalesce(
      (select jsonb_agg(jsonb_build_object('kind', kind, 'count', n) order by n desc, kind) from kinds), '[]'::jsonb
    ),
    'people', coalesce(
      (select jsonb_agg(jsonb_build_object('label', label, 'count', n) order by n desc, label) from people), '[]'::jsonb
    ),
    'projects', coalesce(
      (select jsonb_agg(jsonb_build_object('label', label, 'count', n) order by n desc, label) from projects), '[]'::jsonb
    ),
    'grounded', (select count(*) from combined where grounding = 'grounded'),
    'inferred', (select count(*) from combined where grounding = 'inferred'),
    -- item 5 (058): the SAME pairing predicate kg_claims_browse's
    -- p_grounding = 'corrected' WHERE-clause branch uses (057, NEW-6) — a
    -- row counts if its OWN grounding is 'corrected' (the superseded
    -- original), OR it's a correction row (corrected = true) whose
    -- (kind, subject_key, target_key, block_discriminator) tuple matches
    -- a 'corrected' row's tuple (the correction that superseded it). This
    -- makes the chip count equal kg_claims_browse(..., p_grounding =>
    -- 'corrected')'s total_count by construction, instead of only ever
    -- counting the superseded-original half of each pair.
    'corrected', (
      select count(*)
        from combined c
       where c.grounding = 'corrected'
          or (c.corrected and exists (
                select 1 from combined c2
                 where c2.grounding = 'corrected'
                   and c2.kind = c.kind
                   and c2.subject_key is not distinct from c.subject_key
                   and c2.target_key is not distinct from c.target_key
                   and c2.block_discriminator is not distinct from c.block_discriminator
              ))
    ),
    'dropped', (select count(*) from graded where grounding is null)
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.kg_claims_facets(uuid, boolean) is
  'Filter-rail facet counts for the Memory browser (migration 058, rewriting 057). item 5 fix: the ''corrected'' chip now counts BOTH sides of a correction pair via the SAME (kind, subject_key, target_key, block_discriminator) pairing predicate kg_claims_browse''s p_grounding = ''corrected'' filter (057, NEW-6) uses — previously it only counted the superseded-original half (plain grounding = ''corrected''), undercounting relative to what clicking the chip actually shows. kinds/people/projects/grounded/inferred/dropped unchanged from 057. Session-bound, same auth.uid()=p_user_id loud-fail as kg_claims_browse. EXECUTE: authenticated only.';
