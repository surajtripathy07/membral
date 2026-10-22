-- ============================================================
-- 059_claims_browse_receipts.sql
--
-- SUPERSEDED (fresh adversarial review, H1) — this migration's own gate
-- whitelist below (bare `reject_reason is not null`, folding in G3/G1/G2)
-- is WRONG and was fixed by 061_claims_lane.sql, which rewrites this same
-- function and narrows the whitelist to `reject_reason in ('gate:G4',
-- 'gate:G5','gate:G6','gate:G7','gate:G8','gate:G9')`. G3 IS the quote-
-- containment check itself (lib/kg/claims.ts's gate order: G0->G1->G2->
-- G3->G4->G6->G7->G8->G9->G5) — a `reject_reason = 'gate:G3'` row's quote
-- was NOT found, verbatim-or-normalized, in the cited turn; G1/G2 reject
-- BEFORE containment is even attempted. So the "quote is still real" claim
-- this file's own header makes a few lines down is only true for G4-G9,
-- not G3/G4/G5/G6/G7/G9 as originally written here. Left unedited below
-- (migrations are an append-only history of what was actually applied) —
-- 061 is the corrected, currently-live version; read that one, not this
-- comment block, for the real contract.
--
-- Goal 2026-08-26 e2e demo, W1 (D4) — "receipts on inferred claims". Today
-- an extraction claim that carries a verbatim `evidence_quote`/`turn` but
-- was rejected at a gate (e.g. `reject_reason = 'gate:G5'`, the "quote is
-- real, subject just isn't the owner" case) renders "No transcript backing"
-- in the Memory browser — the quote/turn/conversation the extractor actually
-- found is silently thrown away because kg_claims_browse's `receipt` object
-- was only ever populated for `grounding in ('grounded', 'corrected')` rows.
--
-- Fix: `receipt` is now populated for ANY non-correction row carrying
-- `evidence_quote is not null or turn is not null`, regardless of
-- `grounding` — so an 'inferred' or even 'dropped' (grounding NULL) row that
-- has a real, quoted, turn-cited span still shows it. A live user correction
-- row (`corrected = true`, from kg_user_claims) is UNCHANGED — its own
-- "receipt" is the correction utterance itself, not a transcript link, and
-- the client already renders that case separately ("From your own
-- correction, not a synced conversation"); this migration does not touch
-- that path.
--
-- New column `receipt_status text` distinguishes WHY a receipt is (or
-- isn't) present, independent of the existing `grounding` verdict (which
-- folds in orphaning/blocking/verification-policy/promotion — a different,
-- broader question than "did we find a real quote"):
--   'grounded'              — c.accepted (equivalently, reject_reason is
--                              null) — the claim was never gated at all.
--   'verified_quote_gated'  — evidence_quote is not null AND reject_reason
--                              is not null — the extractor found and quoted
--                              a real span, but a later gate (G3/G4/G5/G6/
--                              G7/G9 — see 051's claim_grounding header)
--                              rejected the claim itself. The quote is still
--                              real; only acceptance was refused.
--   'none'                  — everything else (no quote/turn at all, or a
--                              live correction row).
-- The raw gate code also rides along as a new `reject_reason` field (e.g.
-- 'gate:G5') so the client can derive a human label ("quote found · failed
-- gate G5") without a second lookup — see lib/memory/claims-browse.ts's
-- receiptStatusLabel.
-- A correction row (`corrected = true`) always reports 'none' here — it has
-- no `reject_reason` column to begin with (kg_user_claims, unlike kg_claims,
-- carries no gate machinery: G5 is enforced at WRITE time by membral_correct,
-- 041) and its own receipt semantics are handled entirely client-side via
-- the `corrected` flag, unchanged by this migration.
--
-- Depends on: 039 (kg_claims.reject_reason/accepted, kg_user_claims.accepted),
-- 051/055/057/058 (kg_claims_browse/kg_claims_facets lineage — this migration
-- rewrites kg_claims_browse only; kg_claims_facets is untouched).
--
-- SIGNATURE: kg_claims_browse's 11-arg signature (057) is UNCHANGED — no new
-- parameters, so a plain create-or-replace is safe (no drop needed, unlike
-- 055/057's own header notes for when a parameter is ADDED).
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
      -- NEW-6 (057): the (kind, subject_key, target_key, block_discriminator)
      -- tuple claim_not_blocked (039) actually blocks on — see 057's header
      -- for why claim_key/`corrects` don't work for pairing.
      c.subject_key, c.target_key, c.block_discriminator,
      -- 059 (W1/D4): threaded through so the receipt/receipt_status columns
      -- below can be computed independent of `grounding` — see this file's
      -- header for why (a claim can be gate-rejected yet still carry a real,
      -- verified quote worth showing).
      c.accepted, c.reject_reason
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
      -- NEW-6 (057): same tuple as graded, above — this is what
      -- claim_not_blocked actually joins a correction to the extraction
      -- claim(s) it blocks on.
      u.subject_key, u.target_key, u.block_discriminator,
      -- 059: kg_user_claims has no gate machinery (G5 is enforced at WRITE
      -- time by membral_correct, 041) — a correction row is always
      -- "accepted", with no reject_reason to speak of. receipt_status below
      -- deliberately reports 'none' for every correction row regardless
      -- (see this file's header), so these two values are never actually
      -- read for a corrections-origin row, but are threaded through so the
      -- `combined` union below type-matches `graded`.
      u.accepted, null::text as reject_reason
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
      -- NEW-6 (057): the shared identity a correction and its superseded
      -- original pair on, for ORDER BY grouping only (the WHERE-clause
      -- EXISTS below uses precise column comparisons, not this
      -- concatenation) — inert outside p_grounding = 'corrected'. See 057's
      -- header for why (kind, subject_key, target_key, block_discriminator),
      -- not claim_key or `corrects`, is the real pairing tuple.
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
      -- (see 057's header — claim_key/`corrects` equality does not work for
      -- this).
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
        -- 059 (W1/D4): populated for ANY non-correction row carrying a
        -- verbatim quote or turn, regardless of `grounding` — previously
        -- restricted to `grounding in ('grounded', 'corrected')`, which
        -- silently dropped the quote/turn/conversation for every 'inferred'
        -- (and 'dropped') row even when the extractor had genuinely found
        -- and cited one. A live correction (`corrected = true`) is
        -- unaffected — it never gets a transcript receipt here, unchanged.
        'receipt', case
          when not o.corrected and (o.evidence_quote is not null or o.turn is not null) then jsonb_build_object(
            'quote', o.evidence_quote,
            'conversation_id', o.conversation_id,
            'conversation_title', o.conversation_title,
            'source', o.conversation_source,
            'message_turn', o.turn
          )
          else null
        end,
        -- 059 (W1/D4): see this file's header for the three-value contract.
        'receipt_status', case
          when o.corrected then 'none'
          when o.accepted or o.reject_reason is null then 'grounded'
          when o.evidence_quote is not null and o.reject_reason is not null then 'verified_quote_gated'
          else 'none'
        end,
        -- 059 (W1/D4): the raw gate code (e.g. 'gate:G5'), so the client can
        -- derive a human label ("quote found · failed gate G5") without a
        -- second lookup — see lib/memory/claims-browse.ts's
        -- receiptStatusLabel. Null for a correction row (no reject_reason
        -- column on kg_user_claims) and for any row that was never gated.
        'reject_reason', case when o.corrected then null else o.reject_reason end,
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
  'Dashboard Memory browser (migration 059, rewriting 058''s dependency 057): one row per kg_claims occurrence PLUS one row per live, eligible correction. 059 (W1/D4): `receipt` is populated for ANY non-correction row carrying evidence_quote/turn, regardless of `grounding` (previously restricted to grounded/corrected — silently dropping the quote for gate-rejected-but-quoted ''inferred'' rows); new `receipt_status` (''grounded''|''verified_quote_gated''|''none'') reports WHY, independent of `grounding`. p_grounding (''grounded''|''inferred''|''corrected''|''dropped''|NULL, migration 057) still turns the stat chips into real filters; ''corrected'' pairs a superseded original with its correction via (kind, subject_key, target_key, block_discriminator) (057). p_offset + total_count support client-side "Load more" (046 convention). Session-bound: security invoker + explicit auth.uid()=p_user_id loud-fail. EXECUTE: authenticated only.';

revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int) from public;
revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int) from anon;
grant execute on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text, text, int) to authenticated;
