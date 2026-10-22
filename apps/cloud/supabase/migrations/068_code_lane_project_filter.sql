-- ============================================================
-- 068_code_lane_project_filter.sql
-- Goal 2026-08-27 W1 (D4): with lane=Code, `kg_claims_facets(..., 'code')
-- ->'projects'` reports code-project labels (canonical, alias-resolved via
-- project_alias_resolve, migration 060) with real counts, but
-- `kg_claims_browse(..., p_project=<label>, ..., p_lane='code')` returns 0
-- rows for every one of those labels. Kind and person filters already
-- resolve correctly in the code lane (verified live: p_kind='self' returns
-- the same 95 the facet reports; p_person=<owner alias> returns the same 74)
-- — this migration touches ONLY the project predicate.
--
-- DIAGNOSIS: `kg_claims_browse`'s `filtered` CTE (migration 061) matches
-- p_project against `project_labels` (claims_browse_entity_labels) via TEXT
-- MATCH ONLY — `g.name`/`g.claim_text_best` compared against a project's
-- raw chat-mention label. A code-lane claim (a decision/fact ABOUT the
-- project) essentially never mentions the project by name in its own text —
-- migration 061's own header already says so, and is exactly why that
-- migration added a SEPARATE code-project fallback to `group_label` (via
-- `code_project_id` -> `code_projects.display_name` ->
-- `project_alias_resolve`) for p_group_by='project' display. The p_project
-- WHERE-filter never got the matching fallback, so it silently excludes
-- every code-lane claim whose project match can only be established via
-- that join (the code_project_id path) rather than by text.
--
-- `kg_claims_facets`'s `projects_code` CTE (061) already computes exactly
-- this join (`project_alias_resolve(p_user_id, cp.display_name)` off each
-- claim's own `code_project_id`) to produce the facet count. Meaning the
-- facet's own basis for a project's label was NEVER reachable from browse's
-- filter — this migration makes the filter use the SAME join, mirroring the
-- group_label CASE's own code-lane fallback (061) verbatim.
--
-- FIX: `filtered`'s p_project predicate gains one more OR-branch, structurally
-- identical to the `group_label` CASE's own code-lane fallback: a code-lane
-- claim (`g.conversation_source = 'claude-code'` and `g.code_project_id is
-- not null`) matches p_project when its own code_projects row's
-- alias-resolved canonical label equals p_project — no text match, no regex,
-- the same structured join the facet already uses. Everything else in this
-- function (12-arg signature, every other predicate, ordering, JSON shape)
-- is byte-identical to 061 — this is a pure CREATE OR REPLACE, no DROP
-- needed (signature unchanged).
--
-- FRESH ADVERSARIAL REVIEW (round 1, scratchpad W1b_adv_round1.md): verdict
-- SOLID, no correctness findings. One NIT (#8) addressed here, no behaviour
-- change: both `cp.id = g.code_project_id::uuid` comparisons (the
-- group_label fallback and this migration's own p_project OR-branch) are
-- rewritten as `cp.id::text = g.code_project_id` — the WHERE-clause cast now
-- evaluates for every row whenever p_project is set (not just under
-- p_group_by='project' as before), and a malformed `code_project_id` string
-- would raise on the ::uuid cast with no guaranteed short-circuit. Comparing
-- as text instead never raises on a malformed value (it just doesn't match);
-- verified live that all 96 code-lane rows carry a well-formed
-- `code_project_id`, so this is a pure hardening, byte-identical result on
-- today's data (re-verified: same 72/33/20 equality after the change).
-- ============================================================

create or replace function public.kg_claims_browse(
  p_user_id uuid,
  p_include_inferred boolean default false,
  p_kind text default null,
  p_person text default null,
  p_project text default null,
  p_q text default null,
  p_limit int default 100,
  p_order text default 'recent',
  p_group_by text default null,
  p_grounding text default null,
  p_offset int default 0,
  p_lane text default 'all'
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
    raise exception 'kg_claims_browse requires an end-user session matching p_user_id';
  end if;

  with graded as (
    select
      c.id, c.claim_key, c.kind, c.name, c.sensitive, c.created_at, c.conv_order_key,
      c.turn, c.conversation_id, c.evidence_quote,
      coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
      public.claim_browse_grounding(c, l) as grounding,
      false as corrected,
      conv.title as conversation_title,
      conv.source as conversation_source,
      conv.metadata->>'code_project_id' as code_project_id,
      coalesce(conv.updated_at, conv.created_at, c.created_at) as said_at,
      c.subject_key, c.target_key, c.block_discriminator,
      c.accepted, c.reject_reason,
      c.payload
    from public.kg_claims c
    join public.kg_claim_lifecycle l
      on l.user_id = c.user_id
     and l.claim_key_version = c.claim_key_version
     and l.claim_key = c.claim_key
    left join public.conversations conv on conv.id = c.conversation_id and conv.user_id = p_user_id
    where c.user_id = p_user_id
      and c.claim_key is not null
  ),
  corrections as (
    select
      u.correction_id as id, u.claim_key, u.kind, u.name, u.sensitive, u.created_at,
      u.t_asserted as conv_order_key,
      null::int as turn,
      null::uuid as conversation_id,
      u.evidence_quote,
      coalesce(u.claim_text, u.name, u.target_key) as claim_text_best,
      'grounded'::text as grounding,
      true as corrected,
      null::text as conversation_title,
      null::text as conversation_source,
      null::text as code_project_id,
      u.t_asserted as said_at,
      u.subject_key, u.target_key, u.block_discriminator,
      u.accepted, null::text as reject_reason,
      u.payload
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
  person_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false)
  ),
  project_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true)
  ),
  filtered as (
    select
      g.*,
      case p_group_by
        when 'person' then (
          select pl.canonical_label
            from person_labels pl
           where lower(btrim(coalesce(g.name, ''))) = lower(pl.raw_label)
              or g.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
           order by pl.canonical_label
           limit 1
        )
        when 'project' then coalesce(
          (
            select pl.canonical_label
              from project_labels pl
             where lower(btrim(coalesce(g.name, ''))) = lower(pl.raw_label)
                or g.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
             order by pl.canonical_label
             limit 1
          ),
          case
            when g.conversation_source = 'claude-code' and g.code_project_id is not null then (
              select public.project_alias_resolve(p_user_id, cp.display_name)
                from public.code_projects cp
               where cp.id::text = g.code_project_id
                 and cp.user_id = p_user_id
            )
            else null
          end
        )
        else null
      end as group_label,
      g.kind || '::' || coalesce(g.subject_key, '') || '::' || coalesce(g.target_key, '') || '::' || coalesce(g.block_discriminator, '') as pair_key
    from combined g
    where (
      (p_grounding is null and (g.grounding = 'grounded' or (p_include_inferred and g.grounding in ('inferred', 'corrected'))))
      or (p_grounding = 'dropped' and g.grounding is null)
      or (p_grounding = 'corrected' and (
            g.grounding = 'corrected'
            or (g.corrected and exists (
                  select 1 from combined g2
                   where g2.grounding = 'corrected'
                     and g2.kind = g.kind
                     and g2.subject_key is not distinct from g.subject_key
                     and g2.target_key is not distinct from g.target_key
                     and g2.block_discriminator is not distinct from g.block_discriminator
                ))
          ))
      or (p_grounding in ('grounded', 'inferred') and g.grounding = p_grounding)
    )
      and (p_kind is null or g.kind = p_kind)
      and (
        p_lane = 'all'
        or (p_lane = 'chat' and coalesce(g.conversation_source, '') <> 'claude-code')
        or (p_lane = 'code' and g.conversation_source = 'claude-code')
      )
      and (
        p_person is null
        or exists (
          select 1 from person_labels pl
           where pl.canonical_label = p_person
             and (
               lower(btrim(coalesce(g.name, ''))) = lower(pl.raw_label)
               or g.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
             )
        )
      )
      and (
        p_project is null
        or exists (
          select 1 from project_labels pl
           where pl.canonical_label = p_project
             and (
               lower(btrim(coalesce(g.name, ''))) = lower(pl.raw_label)
               or g.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
             )
        )
        -- 068 (D4): the code-lane fallback the group_label CASE above already
        -- uses for DISPLAY — a code-lane claim's own code_project_id, joined
        -- to code_projects and alias-resolved, is the facet's own basis for
        -- this label (kg_claims_facets' projects_code CTE, migration 061).
        -- Without this branch a code-lane claim can never satisfy p_project
        -- by text match (061's own header: a code claim's text rarely
        -- mentions the project by name), so every p_project filter in the
        -- code lane returned 0 rows regardless of the label chosen.
        or (
          g.conversation_source = 'claude-code'
          and g.code_project_id is not null
          and exists (
            select 1
              from public.code_projects cp
             where cp.id::text = g.code_project_id
               and cp.user_id = p_user_id
               and public.project_alias_resolve(p_user_id, cp.display_name) = p_project
          )
        )
      )
      and (
        p_q is null or btrim(p_q) = ''
        or (
          case
            when nullif(plainto_tsquery('simple', coalesce(p_q, ''))::text, '') is not null
              then to_tsvector('simple', coalesce(g.claim_text_best, '')) @@ plainto_tsquery('simple', coalesce(p_q, ''))
            else coalesce(g.claim_text_best, '') ilike '%' || p_q || '%'
          end
        )
      )
  ),
  counted as (
    select f.*,
      count(*) over() as total_count,
      max(f.said_at) over (partition by f.pair_key) as pair_recency
    from filtered f
  ),
  ordered as (
    select *
    from counted
    order by
      case when p_grounding = 'corrected' then pair_recency end desc nulls last,
      case when p_grounding = 'corrected' then pair_key end,
      said_at desc nulls last,
      id
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', o.id,
        'claim_key', o.claim_key,
        'kind', o.kind,
        'text', o.claim_text_best,
        'grounding', o.grounding,
        'said_at', o.said_at,
        'receipt', case
          when not o.corrected
           and (o.reject_reason is null or o.reject_reason in ('gate:G4', 'gate:G5', 'gate:G6', 'gate:G7', 'gate:G8', 'gate:G9'))
           and (o.evidence_quote is not null or o.turn is not null)
          then jsonb_build_object(
            'quote', o.evidence_quote,
            'conversation_id', o.conversation_id,
            'conversation_title', o.conversation_title,
            'source', o.conversation_source,
            'message_turn', o.turn
          )
          else null
        end,
        'receipt_status', case
          when o.corrected then 'none'
          when o.accepted or o.reject_reason is null then 'grounded'
          when o.evidence_quote is not null and o.reject_reason in ('gate:G4', 'gate:G5', 'gate:G6', 'gate:G7', 'gate:G8', 'gate:G9')
            then 'verified_quote_gated'
          else 'none'
        end,
        'reject_reason', case when o.corrected then null else o.reject_reason end,
        'edit_field', case
          when o.corrected then null
          when o.kind = 'person' then 'name'
          when o.kind = 'self' then 'value'
          when o.kind = 'place' then 'name'
          when o.kind = 'project' then 'name'
          when o.kind = 'event' then 'statement'
          when o.kind in ('decision', 'preference', 'insight', 'commitment') then 'text'
          else null
        end,
        'edit_value', case
          when o.corrected then null
          when o.kind in ('person', 'place', 'project') then o.name
          when o.kind = 'self' then o.payload->>'value'
          when o.kind = 'event' then o.payload->>'statement'
          when o.kind in ('decision', 'preference', 'insight', 'commitment') then o.payload->>'text'
          else null
        end,
        'corrected', o.corrected,
        'group_label', o.group_label,
        'person', case when o.kind = 'person' then o.name else null end,
        'project', case when o.kind = 'project' then o.name else null end,
        'created_at', o.created_at,
        'sensitive', o.sensitive,
        'total_count', o.total_count
      )
      order by
        case when p_grounding = 'corrected' then o.pair_recency end desc nulls last,
        case when p_grounding = 'corrected' then o.pair_key end,
        o.said_at desc nulls last,
        o.id
    ),
    '[]'::jsonb
  )
  into v_result
  from ordered o;

  return v_result;
end;
$$;

comment on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int, text) is
  'Dashboard Memory browser (migration 061, fixed by 068 D4, adversarially reviewed round 1 SOLID). 068: the p_project predicate gained a code-lane fallback branch (a code-lane claim''s own code_project_id, joined to code_projects and alias-resolved via project_alias_resolve) mirroring the group_label CASE''s existing code-lane fallback and kg_claims_facets'' projects_code CTE, so p_project now resolves for code-lane labels exactly as the facet reports them (previously always 0 rows, since a code claim''s own text rarely mentions its project by name). Both code_project_id joins compare cp.id::text = g.code_project_id rather than casting the metadata string to ::uuid (round-1 NIT 8: avoids a WHERE-clause cast raising on a malformed value; byte-identical result on today''s data). 061 (ADR 0039 W6/D7): p_lane (''all''|''chat''|''code'', default ''all'') filters rows by the claim''s conversation source. 062 H1 (folded in 061): receipt/receipt_status whitelist reject_reason in (gate:G4..G9) only. 062 H2 (folded in 061): edit_field/edit_value expose the real editable column per kind. Session-bound: security invoker + explicit auth.uid()=p_user_id loud-fail. EXECUTE: authenticated only.';

revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int, text) from public;
revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int, text) from anon;
grant execute on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int, text) to authenticated;
