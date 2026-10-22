-- ============================================================
-- 057_claims_facets_dedupe.sql
-- Round-2 re-verification of the Memory browser + Bridge context panel
-- (2026-08-26). Three fixes, all touching the two RPCs 055 rewrote — folded
-- into one migration for the same reason 055 folded three fixes into one.
-- Depends on: 039, 046, 051, 055 (claim_browse_grounding,
-- claims_browse_label_regex, claims_browse_entity_labels are all reused
-- UNCHANGED from 055 — not redefined here).
--
-- NEW-6 — the "1 corrected" chip has no visible card: the client fetches
-- LIMIT 200 ordered by said_at desc; a corrected claim buried at rank
-- 425/426 never makes the page. Fix: the grounded/inferred/corrected/dropped
-- stat chips become real FILTERS via a new trailing `p_grounding` param on
-- kg_claims_browse (values: 'grounded' | 'inferred' | 'corrected' |
-- 'dropped' | NULL — NULL preserves 055's exact prior visibility rule,
-- byte-for-byte). 'dropped' surfaces the population kg_claims_browse has
-- ALWAYS silently excluded (grounding NULL — accepted-but-not-eligible,
-- rejected, or orphaned rows never had a browse route at all before this).
--
-- 'corrected' is the interesting case: the finding also asks that "the
-- correction and its superseded original show adjacent (group by
-- claim_key)". VERIFIED LIVE (2026-08-26, psql against a real corpus) that
-- this literal shorthand does not work: a live correction's own `claim_key`
-- (kg_user_claims) is ITS OWN identity, and `kg_user_claims.corrects` (039:
-- "claim_key of the claim being corrected") does NOT equal the superseded
-- extraction claim's `claim_key` either in practice — checking real rows
-- showed `corrects` values with no matching `kg_claims.claim_key` at all.
-- The actual blocking match (claim_not_blocked, 039) is on
-- `(kind, subject_key, target_key, block_discriminator)` — NOT claim_key,
-- NOT `corrects` — confirmed by re-deriving that exact tuple for a real
-- 'corrected' extraction row and finding it matched one live correction's
-- own (kind, subject_key, target_key, block_discriminator) exactly. So the
-- pairing key here is that same 4-column tuple, threaded through
-- `graded`/`corrections` (subject_key/target_key/block_discriminator were
-- not previously selected by either CTE) and combined into one `pair_key`
-- text inside `filtered` purely for ORDER BY grouping (the WHERE-clause
-- EXISTS match itself uses precise `is not distinct from` column
-- comparisons, not the concatenated text, to avoid any delimiter-collision
-- risk in the identity check itself). `p_grounding = 'corrected'` returns
-- BOTH the superseded original(s) (grounding = 'corrected') AND the
-- correction row(s) that superseded them (a correction's own grounding is
-- always 'grounded', `corrected: true` — see 055's own header) whose
-- (kind, subject_key, target_key, block_discriminator) tuple matches; both
-- the page-selecting ORDER BY and the final jsonb_agg's own ORDER BY sort by
-- `max(said_at) over (partition by pair_key)` first (most recently corrected
-- pair first), then `pair_key`, then `said_at desc` within the pair (the
-- newer correction naturally lands right above the older superseded
-- original) — so a pair is always adjacent in the returned array. Every
-- other `p_grounding` value (or NULL) leaves `pair_key`/the pairing CASE
-- branches inert (the CASE conditions all evaluate to the SQL constant NULL,
-- collapsing the ORDER BY back to plain `said_at desc, id` — 055's original
-- order, unchanged).
--
-- PAGINATION: a new trailing `p_offset` param (default 0, same
-- greatest(...,0) floor as 046's own p_offset) plus a `total_count` field —
-- `count(*) over()` computed over the full filtered set BEFORE limit/offset
-- clips the page, riding along on every returned row — same convention
-- 046's mcp_claims_browse already established (see that migration's own
-- header). Lets the client's "Load more" button know whether more rows
-- exist (`claims.length < total_count`) without a second round trip.
--
-- SIGNATURE NOTE (same gotcha 055's own header documents, and 046/051
-- before it): kg_claims_browse gains TWO new trailing params (p_grounding,
-- p_offset) here, so its 9-arg (055) signature is dropped first — a plain
-- create-or-replace with an added parameter would coexist as a SECOND
-- overload and make every existing 9-arg call ambiguous, not replace it.
-- kg_claims_facets' signature is UNCHANGED (still 2 args) — no drop needed.
--
-- NEW-10 — collapsed facet labels double-count claims ("rack (3)" vs 2
-- distinct claims): kg_claims_facets' people/projects CTEs join
-- `person_labels`/`project_labels` (one row per RAW label collapsed into a
-- canonical group) against `visible` (one row per claim) on an OR of two
-- match conditions (name-equality OR word-boundary text match) — a single
-- claim whose text happens to satisfy BOTH conditions against the SAME raw
-- label, or that matches TWO DIFFERENT raw labels collapsing into the SAME
-- canonical_label (e.g. a claim mentioning "Acme AIx Chrome extension"
-- word-boundary-matches both that raw label and the shorter "Acme AIx" it
-- canonicalizes to), produces more than one joined row for that one claim
-- under that one canonical_label group — `count(*)` then counts
-- label-match-instances, not distinct claims. Fix: `count(distinct v.id)`,
-- which requires a claim-identifying column threaded into `graded`
-- (`c.id`) and `corrections` (`u.correction_id as id`) that 055's version of
-- this function never selected at all (it only needed kind/name/
-- claim_text_best/grounding for counting, not row identity). `kinds` is
-- unaffected (grouped straight from `visible`, no label join, no fan-out).
-- ============================================================

-- ------------------------------------------------------------
-- 1. kg_claims_browse — rewritten (NEW-6 filter + pagination). Old 9-arg
-- signature (055) dropped first (see this file's header SIGNATURE NOTE).
-- ------------------------------------------------------------
drop function if exists public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text);

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
  p_offset int default 0
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
      coalesce(conv.updated_at, conv.created_at, c.created_at) as said_at,
      -- NEW-6: the (kind, subject_key, target_key, block_discriminator)
      -- tuple claim_not_blocked (039) actually blocks on — see this file's
      -- header for why claim_key/`corrects` don't work for pairing.
      c.subject_key, c.target_key, c.block_discriminator
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
      u.t_asserted as said_at,
      -- NEW-6: same tuple as graded, above — this is what claim_not_blocked
      -- actually joins a correction to the extraction claim(s) it blocks on.
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
        when 'project' then (
          select pl.canonical_label
            from project_labels pl
           where lower(btrim(coalesce(g.name, ''))) = lower(pl.raw_label)
              or g.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
           order by pl.canonical_label
           limit 1
        )
        else null
      end as group_label,
      -- NEW-6: the shared identity a correction and its superseded original
      -- pair on, for ORDER BY grouping only (the WHERE-clause EXISTS below
      -- uses precise column comparisons, not this concatenation) — inert
      -- outside p_grounding = 'corrected'. See this file's header for why
      -- (kind, subject_key, target_key, block_discriminator), not claim_key
      -- or `corrects`, is the real pairing tuple.
      g.kind || '::' || coalesce(g.subject_key, '') || '::' || coalesce(g.target_key, '') || '::' || coalesce(g.block_discriminator, '') as pair_key
    from combined g
    where (
      -- p_grounding NULL: 055's exact prior visibility rule, unchanged.
      (p_grounding is null and (g.grounding = 'grounded' or (p_include_inferred and g.grounding in ('inferred', 'corrected'))))
      -- 'dropped': the population every prior version of this RPC silently
      -- excluded entirely (grounding computed but never served) — grounding
      -- IS NULL is exactly G0/ineligible/orphaned/refuted (claim_browse_grounding's
      -- own fall-through).
      or (p_grounding = 'dropped' and g.grounding is null)
      -- 'corrected': the superseded original itself, PLUS the correction
      -- row that superseded it (own grounding 'grounded', corrected=true) —
      -- matched via the SAME (kind, subject_key, target_key,
      -- block_discriminator) tuple claim_not_blocked (039) itself blocks on
      -- (see this file's header — claim_key/`corrects` equality does not
      -- work for this).
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
      -- 'grounded' / 'inferred': a plain equality filter, deliberately
      -- IGNORING p_include_inferred — clicking the "N inferred" chip should
      -- show exactly that bucket even when the "show inferred" toggle is off.
      or (p_grounding in ('grounded', 'inferred') and g.grounding = p_grounding)
    )
      and (p_kind is null or g.kind = p_kind)
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
    -- NEW-6 pagination: total_count over the FULL filtered set, before
    -- limit/offset clips the page (046's mcp_claims_browse convention).
    -- pair_recency: only meaningful (and only consulted) when
    -- p_grounding = 'corrected' — see the ORDER BY below and in the final
    -- jsonb_agg.
    select f.*,
      count(*) over() as total_count,
      max(f.said_at) over (partition by f.pair_key) as pair_recency
    from filtered f
  ),
  ordered as (
    select *
    from counted
    -- MAINTAINER FOLLOW-UP 1 (055): recent-by-said_at, no grounded-first
    -- tie-break — UNCHANGED for every p_grounding value except 'corrected',
    -- where the pair (see header) sorts together: most-recently-corrected
    -- pair first, then said_at desc within the pair (correction usually
    -- lands just above its superseded original). The two `case` columns
    -- evaluate to a constant NULL for every other p_grounding value, so the
    -- ORDER BY collapses back to exactly `said_at desc nulls last, id`.
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
          when o.grounding in ('grounded', 'corrected') and not o.corrected then jsonb_build_object(
            'quote', o.evidence_quote,
            'conversation_id', o.conversation_id,
            'conversation_title', o.conversation_title,
            'source', o.conversation_source,
            'message_turn', o.turn
          )
          else null
        end,
        'corrected', o.corrected,
        'group_label', o.group_label,
        'person', case when o.kind = 'person' then o.name else null end,
        'project', case when o.kind = 'project' then o.name else null end,
        'created_at', o.created_at,
        'sensitive', o.sensitive,
        -- NEW-6: rides along on every row (046 convention) — the client
        -- reads it off claims[0] to know whether "Load more" has anything left.
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

comment on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int) is
  'Dashboard Memory browser (migration 057, rewriting 055): one row per kg_claims occurrence PLUS one row per live, eligible correction. NEW in 057: p_grounding (''grounded''|''inferred''|''corrected''|''dropped''|NULL) turns the grounded/inferred/corrected/dropped stat chips into real filters — NULL preserves 055''s exact prior visibility rule; ''corrected'' returns a superseded original AND its correction, paired via the (kind, subject_key, target_key, block_discriminator) tuple claim_not_blocked (039) actually blocks on — NOT claim_key or kg_user_claims.corrects, see this migration''s header — sorted so a pair is always adjacent. ''dropped'' surfaces the grounding-NULL population every prior version silently excluded. p_offset + a per-row total_count (count(*) over() before the page cutoff) support client-side "Load more" (046 convention). Session-bound: security invoker + explicit auth.uid()=p_user_id loud-fail. EXECUTE: authenticated only.';

revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int) from public;
revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int) from anon;
grant execute on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int) to authenticated;

-- ------------------------------------------------------------
-- 2. kg_claims_facets — rewritten (NEW-10 dedupe). SAME 2-arg signature as
-- 051/055 — no drop needed, a plain create-or-replace is safe.
-- ------------------------------------------------------------
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
      -- NEW-10: c.id threaded through so people/projects below can dedupe
      -- by claim identity instead of counting label-match rows.
      c.id, c.kind, c.name,
      coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
      public.claim_browse_grounding(c, l) as grounding
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
      'grounded'::text as grounding
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
    -- Unaffected by NEW-10: grouped straight from `visible`, no label join,
    -- so there is no row fan-out to dedupe here.
    select kind, count(*) as n from visible where kind is not null group by kind
  ),
  people as (
    -- NEW-10: count(distinct v.id), not count(*) — a claim that matches
    -- more than one raw label collapsing into the same canonical_label (or
    -- matches the same raw label by both name-equality AND text-mention)
    -- used to be counted once per match, not once per claim.
    select pl.canonical_label as label, count(distinct v.id) as n
      from person_labels pl
      join visible v
        on lower(btrim(coalesce(v.name, ''))) = lower(pl.raw_label)
        or v.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
     group by pl.canonical_label
  ),
  projects as (
    -- NEW-10: same count(distinct v.id) fix as people, above.
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
    'corrected', (select count(*) from combined where grounding = 'corrected'),
    'dropped', (select count(*) from graded where grounding is null)
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.kg_claims_facets(uuid, boolean) is
  'Filter-rail facet counts for the Memory browser (migration 057, rewriting 055). NEW-10 fix: people/projects now count(distinct claim id) instead of count(*) — a claim matching more than one raw label collapsed into the same canonical_label (or matching one raw label by both name-equality and text-mention) was being counted once per match instead of once per claim. kinds is unaffected (no label join, no fan-out). grounded/inferred/corrected/dropped are always computed over the full population (kg_claims graded rows plus live corrections for grounded). Session-bound, same auth.uid()=p_user_id loud-fail as kg_claims_browse. EXECUTE: authenticated only.';
