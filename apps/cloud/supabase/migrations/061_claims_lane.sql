-- ============================================================
-- 061_claims_lane.sql
-- ADR 0039 / goal 2026-08-26 e2e demo, W6 (D7) — code sessions enter the
-- claims pipeline as `conversations` rows with source='claude-code' (see
-- lib/code-sessions/mirror-conversations.ts). Every memory surface treats
-- `source` as a LANE and never mixes lanes in one ranked list (ADR 0039 §1).
--
-- This migration:
--   (A) kg_claims_browse (rewriting 059's 11-arg version): adds a 12th,
--       trailing, DEFAULTED parameter `p_lane text default 'all'`
--       ('all'|'chat'|'code') that filters rows by their conversation's
--       `source` — 'chat' excludes source='claude-code' (and any row with no
--       conversation at all, e.g. a live correction, still counts as
--       'chat'-visible, matching the "corrections aren't code" intuition);
--       'code' keeps only source='claude-code'. Same trailing-default-param
--       convention every prior kg_claims_browse revision (051/055/057/059)
--       has used — no DROP needed, existing named-arg RPC callers (PostgREST
--       always calls by name) are unaffected.
--   (B) kg_claims_facets (rewriting 058's 2-arg version): adds a 3rd,
--       trailing, defaulted `p_lane text default 'all'`, same semantics,
--       applied to kinds/people/grounded/inferred/corrected/dropped.
--       Additionally, the `projects` facet now ALSO lists code projects by
--       CANONICAL label (via project_alias_resolve, migration 060) with the
--       count of code-lane claims whose conversation's
--       metadata->>'code_project_id' resolves to that project — this is the
--       join `kg_claims_facets`'s prior text-match-only `projects` CTE never
--       had (see the W7 report's finding 1: 'dev/membral' never appeared in
--       this facet because no chat claim ever mentions "membral" by name).
--       A project appearing under both a chat-text mention AND code claims
--       shows ONE row with the summed count.
--   (C) NEW kg_claims_by_code_project(p_user_id, p_code_project_ids[],
--       p_include_inferred, p_limit): the code-project page's own Memory
--       section read (project-memory.tsx) — claims whose conversation is in
--       the code lane for ANY of the given code_project_ids (a caller passes
--       every code_projects.id sharing the current project's canonical alias
--       group, migration 060), each with its quote and the session's branch,
--       ordered decisions-first.
--
-- Depends on: 039 (kg_claims.reject_reason/accepted), 046/051/055/057/058/059
-- (kg_claims_browse/kg_claims_facets lineage), 060 (project_aliases /
-- project_alias_resolve / claims_browse_entity_labels).
--
-- No new unique index: conversations already has `unique (user_id, source,
-- source_id)` (migration 001) — exactly the dedupe key ADR 0039 specifies for
-- the mirror (source='claude-code', source_id=code_session.id).
--
-- MIGRATION-NUMBER COLLISION WITH 062 (discovered mid-write, live DB already
-- broken by it — see below): 062_claims_browse_receipts_gate_fix.sql landed
-- concurrently (its own header: "061 is reserved by a concurrently-running
-- agent, hence 062") and rewrites kg_claims_browse's SAME 11-arg signature
-- with two real fixes — H1 (receipt/receipt_status must whitelist
-- reject_reason in gate:G4-G9, not any non-null reject_reason — G1/G2/G3
-- reject before or at quote-containment, so their "quote" is unverified) and
-- H2 (new `edit_field`/`edit_value` columns so Edit prefills the real
-- editable column, not the rendered sentence). Applying both files as
-- written creates TWO CO-EXISTING OVERLOADS (11-arg and this file's 12-arg)
-- — verified live: `kg_claims_browse(p_user_id => ..., p_include_inferred =>
-- true, p_limit => 1)` throws "function ... is not unique" the moment both
-- exist, because every caller that omits the newly-added trailing param (the
-- overwhelming majority — nothing else in this codebase passes p_lane yet)
-- matches BOTH overloads. This is not hypothetical: it broke the LIVE
-- founder-1k DB the moment this file's original (pre-fix) version was
-- applied on top of 062's already-applied one. Same problem, same fix, for
-- kg_claims_facets (058's 2-arg vs. this file's 3-arg — no competing content
-- there, purely an arity collision from this file's own p_lane addition).
--
-- FIX (this revision of 061): (1) H1+H2's exact logic is folded into this
-- file's OWN kg_claims_browse body below, so nothing from 062 is lost. (2)
-- Both old-arity overloads are explicitly DROPPED right before their
-- replacements are created, so exactly ONE kg_claims_browse and ONE
-- kg_claims_facets exist afterward — no ambiguity for any caller, old or
-- new. (3) FLAGGED FOR THE DRIVER: 062's file is now fully redundant with
-- what's below (its H1/H2 content lives here instead) — replaying migrations
-- 061 then 062 on a FRESH database would re-create the ambiguous 11-arg
-- overload all over again. 062 should be deleted or turned into a no-op
-- before this branch ships; not done here since editing/deleting another
-- concurrent agent's migration file is outside this task's scope — see the
-- W6 report.
-- ============================================================

-- ------------------------------------------------------------
-- (A) kg_claims_browse — DROP the stale 11-arg overload (see this file's
-- collision note above) before creating the merged, single 12-arg version.
-- ------------------------------------------------------------
drop function if exists public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int);

-- ------------------------------------------------------------
-- kg_claims_browse body — same as 059, plus 062's H1 (gate-whitelisted
-- receipt/receipt_status) and H2 (edit_field/edit_value) fixes, plus:
--   - graded/corrections both carry conversation_source (already did) and a
--     NEW raw code_project_id (text, from conv.metadata->>'code_project_id')
--     so the lane filter and the project group_label fallback below can use
--     it without a second join.
--   - `filtered`'s WHERE clause gains the p_lane predicate.
--   - the `project` branch of the group_label CASE falls back to the code
--     project's alias-resolved canonical label when no chat-side text match
--     was found — this is what makes "code-lane claims grouped under their
--     project" (ADR 0039 §1) work when p_group_by='project'.
-- ------------------------------------------------------------
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
      -- 061 (W6/D7): raw code_project_id off the mirrored conversation's
      -- metadata (lib/code-sessions/mirror-conversations.ts) — text here,
      -- cast to uuid only where actually consulted (the group_label
      -- fallback below), so a non-code conversation's NULL never risks a
      -- cast error.
      conv.metadata->>'code_project_id' as code_project_id,
      coalesce(conv.updated_at, conv.created_at, c.created_at) as said_at,
      c.subject_key, c.target_key, c.block_discriminator,
      c.accepted, c.reject_reason,
      -- 062 (H2), folded in here (see this file's collision note): the raw
      -- per-kind payload, so edit_value below can read the real editable
      -- field instead of the rendered sentence.
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
      -- 062 (H2), folded in here: a correction row is never editable
      -- (edit_field is null for every corrected=true row regardless) —
      -- threaded through only so `combined`'s union type-matches `graded`.
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
          -- 061 (W6/D7): code-lane fallback — a code claim's `name`/text
          -- rarely mentions the project by name (it's a decision/fact ABOUT
          -- the project, not a claim describing the project entity itself),
          -- so it would never match project_labels above. Group it by the
          -- alias-resolved canonical label of the code_project_id its own
          -- conversation carries instead.
          case
            when g.conversation_source = 'claude-code' and g.code_project_id is not null then (
              select public.project_alias_resolve(p_user_id, cp.display_name)
                from public.code_projects cp
               where cp.id = g.code_project_id::uuid
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
        -- 061 (W6/D7): the lane rule (ADR 0039 §1) — 'chat' keeps every row
        -- whose conversation isn't source='claude-code', INCLUDING rows with
        -- no conversation at all (a live correction: conversation_source is
        -- NULL, coalesced to '' <> 'claude-code' so it stays visible in the
        -- default 'chat' view, matching pre-061 behavior byte-for-byte when
        -- p_lane is left at its default).
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
        -- 062 (H1), folded in here (see this file's collision note): only
        -- gate:G4-G9 clear quote-containment (G3) — G0/G1/G2/G3 never proved
        -- the quote is really in the cited turn, so they must NOT render a
        -- receipt at all.
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
        -- 062 (H2), folded in here: the real editable field name/value per
        -- kind, so the client can prefill Edit correctly instead of posting
        -- the rendered sentence into an identity column. Both null for a
        -- correction row (not editable, only retirable).
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
  'Dashboard Memory browser (migration 061, rewriting 059/062''s dependency — see this file''s collision note for why 062''s H1/H2 content is folded in here rather than living in a separate 11-arg overload). 061 (ADR 0039 W6/D7): new trailing p_lane (''all''|''chat''|''code'', default ''all'') filters rows by the claim''s conversation source (a live correction, with no conversation, always counts as chat-visible); the p_group_by=''project'' branch falls back to the alias-resolved code_projects label (via project_alias_resolve) for a code-lane claim with no chat-side text match, so code claims group under their project. 062 H1 (folded in): receipt/receipt_status whitelist reject_reason in (gate:G4..G9) only — G0-G3 never proved the quote is in the cited turn. 062 H2 (folded in): new edit_field/edit_value expose the real editable column per kind for correct Edit prefill. Session-bound: security invoker + explicit auth.uid()=p_user_id loud-fail. EXECUTE: authenticated only.';

revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int, text) from public;
revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int, text) from anon;
grant execute on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int, text) to authenticated;

-- ------------------------------------------------------------
-- (B) kg_claims_facets — DROP the stale 2-arg overload (see this file's
-- collision note above — pure arity collision from this file's own p_lane
-- addition, no competing content from another migration here), same body as
-- 058, plus a p_lane filter and a code-project projects enrichment.
-- ------------------------------------------------------------
drop function if exists public.kg_claims_facets(uuid, boolean);

create or replace function public.kg_claims_facets(p_user_id uuid, p_include_inferred boolean default false, p_lane text default 'all')
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
      c.id, c.kind, c.name,
      coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
      public.claim_browse_grounding(c, l) as grounding,
      false as corrected,
      c.subject_key, c.target_key, c.block_discriminator,
      -- 061 (W6/D7): threaded through so the lane filter (below) and the
      -- code-project facet enrichment can use it without a second join.
      conv.source as conversation_source,
      conv.metadata->>'code_project_id' as code_project_id
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
      u.correction_id as id, u.kind, u.name,
      coalesce(u.claim_text, u.name, u.target_key) as claim_text_best,
      'grounded'::text as grounding,
      true as corrected,
      u.subject_key, u.target_key, u.block_discriminator,
      null::text as conversation_source,
      null::text as code_project_id
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
  -- 061 (W6/D7): the lane predicate, applied once and reused by every count
  -- below (kinds/people/projects/grounded/inferred/corrected/dropped all
  -- derive from this, not the raw `combined`/`graded`) — the same rule
  -- kg_claims_browse's `filtered` CTE applies (see that function's comment).
  combined_laned as (
    select * from combined
    where p_lane = 'all'
       or (p_lane = 'chat' and coalesce(conversation_source, '') <> 'claude-code')
       or (p_lane = 'code' and conversation_source = 'claude-code')
  ),
  graded_laned as (
    select * from graded
    where p_lane = 'all'
       or (p_lane = 'chat' and coalesce(conversation_source, '') <> 'claude-code')
       or (p_lane = 'code' and conversation_source = 'claude-code')
  ),
  visible as (
    select *
    from combined_laned
    where grounding = 'grounded' or (p_include_inferred and grounding in ('inferred', 'corrected'))
  ),
  person_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false)
  ),
  project_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true)
  ),
  kinds as (
    select kind, count(*) as n from visible where kind is not null group by kind
  ),
  people as (
    select pl.canonical_label as label, count(distinct v.id) as n
      from person_labels pl
      join visible v
        on lower(btrim(coalesce(v.name, ''))) = lower(pl.raw_label)
        or v.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
     group by pl.canonical_label
  ),
  projects_text as (
    -- Unchanged from 057/058's own `projects` CTE — chat-side text match.
    select pl.canonical_label as label, count(distinct v.id) as n
      from project_labels pl
      join visible v
        on lower(btrim(coalesce(v.name, ''))) = lower(pl.raw_label)
        or v.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
     group by pl.canonical_label
  ),
  projects_code as (
    -- 061 (W6/D7): a code-lane claim counted by ITS OWN conversation's
    -- code_project_id, alias-resolved to a canonical label — independent of
    -- whether the claim's own text happens to mention the project by name
    -- (it usually doesn't; see this file's header). This is what makes
    -- 'dev/membral' (or any code project) show up in this facet at all once
    -- code sessions are mirrored, closing the W7 report's finding 1.
    select public.project_alias_resolve(p_user_id, cp.display_name) as label, count(distinct v.id) as n
      from visible v
      join public.code_projects cp
        on cp.id = v.code_project_id::uuid
       and cp.user_id = p_user_id
     where v.code_project_id is not null
       and cp.display_name is not null
     group by public.project_alias_resolve(p_user_id, cp.display_name)
  ),
  projects as (
    -- A project mentioned in chat AND coded on shows ONE row, count summed.
    select label, sum(n) as n
      from (select * from projects_text union all select * from projects_code) u
     where label is not null and label <> ''
     group by label
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
    'grounded', (select count(*) from combined_laned where grounding = 'grounded'),
    'inferred', (select count(*) from combined_laned where grounding = 'inferred'),
    'corrected', (
      select count(*)
        from combined_laned c
       where c.grounding = 'corrected'
          or (c.corrected and exists (
                select 1 from combined_laned c2
                 where c2.grounding = 'corrected'
                   and c2.kind = c.kind
                   and c2.subject_key is not distinct from c.subject_key
                   and c2.target_key is not distinct from c.target_key
                   and c2.block_discriminator is not distinct from c.block_discriminator
              ))
    ),
    'dropped', (select count(*) from graded_laned where grounding is null)
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.kg_claims_facets(uuid, boolean, text) is
  'Filter-rail facet counts for the Memory browser (migration 061, rewriting 058). 061 (ADR 0039 W6/D7): new trailing p_lane (''all''|''chat''|''code'', default ''all'') applied to every count via combined_laned/graded_laned; the `projects` facet is now a union of the pre-existing chat-side text match (projects_text) with code-lane claims grouped by their conversation''s code_project_id, alias-resolved via project_alias_resolve (projects_code) — a project appearing in both shows one summed row. kinds/people/grounded/inferred/corrected/dropped otherwise unchanged from 058. Session-bound, same auth.uid()=p_user_id loud-fail as kg_claims_browse. EXECUTE: authenticated only.';

revoke all on function public.kg_claims_facets(uuid, boolean, text) from public;
revoke all on function public.kg_claims_facets(uuid, boolean, text) from anon;
grant execute on function public.kg_claims_facets(uuid, boolean, text) to authenticated;

-- ------------------------------------------------------------
-- (C) kg_claims_by_code_project — the code-project page's own Memory read
-- (project-memory.tsx, ADR 0039 §1 "Code-project page" row). Claims whose
-- conversation is source='claude-code' AND whose
-- metadata->>'code_project_id' is one of `p_code_project_ids` (a caller
-- passes every code_projects.id sharing the current project's canonical
-- alias group, migration 060, so three renamed-remote rows for "the same"
-- project all contribute). Returns quote + branch (from the session's own
-- conversation metadata) alongside each claim, ordered decisions-first then
-- most-recent.
-- ------------------------------------------------------------
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
    select
      c.id, c.kind, c.evidence_quote, c.conversation_id,
      coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
      public.claim_browse_grounding(c, l) as grounding,
      conv.title as conversation_title,
      conv.metadata->>'branch' as branch,
      coalesce(conv.updated_at, conv.created_at, c.created_at) as said_at
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
      and (conv.metadata->>'code_project_id')::uuid = any(p_code_project_ids)
  ),
  visible as (
    select *
    from graded
    where grounding = 'grounded' or (p_include_inferred and grounding in ('inferred', 'corrected'))
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
        'said_at', o.said_at
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
  'Code-project page Memory section (migration 061, ADR 0039 W6/D7, project-memory.tsx): claims whose conversation is source=''claude-code'' and whose metadata->>''code_project_id'' is one of the given code_projects.id array (callers pass a whole alias group, migration 060, so renamed-remote siblings all contribute). Returns quote + the session''s branch, ordered decisions-first then most-recent. Session-bound: security invoker + explicit auth.uid()=p_user_id loud-fail. EXECUTE: authenticated only.';

revoke all on function public.kg_claims_by_code_project(uuid, uuid[], boolean, int) from public;
revoke all on function public.kg_claims_by_code_project(uuid, uuid[], boolean, int) from anon;
grant execute on function public.kg_claims_by_code_project(uuid, uuid[], boolean, int) to authenticated;
