-- ============================================================
-- 051_claims_inferred_lane.sql
-- "Inferred memory lane" + a real claims-backed Memory browser for the
-- dashboard (demo goal: "if we have data backing it, show the receipt; if
-- not, show it as inferred without any transcript backing"). Depends on:
-- 039 (kg_claims, kg_claim_lifecycle, serve_candidates, claim_serve_eligible,
-- claim_not_blocked, claim_is_latest_correction, verification_policy_ok,
-- assumption_policy_ok), 040/042/046 (mcp_claims_identity, mcp_claims_context).
--
-- SCOPE: DB predicates + serving RPCs only (deliverable 1). Deliverables 2-5
-- (lib/memory/claims-browse.ts, /api/memory/*, the /memories page rewrite,
-- and the /people/[personId] + /code/[projectId] Memory sections) are
-- implemented in TypeScript/TSX alongside this file and read ONLY the
-- surfaces this migration adds — see this task's own report for that file
-- list.
--
-- claim_serve_eligible / serve_candidates / claim_not_blocked /
-- claim_is_latest_correction / verification_policy_ok / assumption_policy_ok
-- are all left BYTE-IDENTICAL (untouched) — the HARD RULE this task was
-- given ("the grounded path must stay byte-identical for existing MCP
-- callers") is honored by construction: claim_grounding's 'grounded' branch
-- IS claim_serve_eligible, called unmodified, and mcp_claims_identity /
-- mcp_claims_context's default (p_include_inferred = false) path is proven
-- byte-identical below (see each function's own comment for the mechanism:
-- an empty-jsonb `||` no-op plus a sort key that is constant, hence
-- order-inert, whenever no inferred rows are unioned in).
-- ============================================================

-- ------------------------------------------------------------
-- 1. claim_grounding(c kg_claims, l kg_claim_lifecycle) — the three-valued
-- epistemic verdict for ONE kg_claims row (an extraction-claim OCCURRENCE,
-- not a fact identity — same grain as kg_claims itself).
--
-- 'grounded'  — claim_serve_eligible would serve it (has an accepted,
--               receipted, unblocked, non-orphaned, non-refuted, promoted-
--               if-person claim). Reuses claim_serve_eligible VERBATIM by
--               constructing the same serve_candidates-shaped row that
--               view's extraction branch (039/042) itself builds — see the
--               `sc` CTE below, a field-for-field copy of that branch's
--               SELECT list. `provider` is the one column serve_candidates
--               carries that kg_claims cannot supply without a join to
--               `conversations`; it is passed as NULL here because nothing
--               claim_serve_eligible/claim_not_blocked/
--               claim_is_latest_correction/verification_policy_ok/
--               assumption_policy_ok ever reads from it (confirmed by
--               reading each function's body) — a join-free NULL is
--               therefore observationally identical to the real value for
--               every predicate this function calls.
--
-- 'inferred'  — extracted, has a verbatim quote, but did not clear serving,
--               via exactly ONE of two routes (both still required to be
--               unblocked / not-orphaned / not-refuted / latest-correction /
--               policy-ok — the same conjuncts claim_serve_eligible uses
--               for everything BUT accepted/promoted, reused via the same
--               five function calls rather than re-derived):
--                 (a) NOT accepted, has evidence_quote, and reject_reason is
--                     one of the gates that still leaves a real,
--                     turn-verified quote behind — G3 (span not found
--                     verbatim — the extractor's paraphrase/mis-cite case),
--                     G4 (assistant/quoted voice, not the owner's), G5
--                     (subject isn't the owner), G6 (non-asserted modality),
--                     G7 (low-confidence/not-durable), G9 (census
--                     mismatch). G0 (no parsed claim — claim_key is NULL,
--                     short-circuited below), G1 (turn missing) and G2
--                     (non-owner turn) are DELIBERATELY EXCLUDED — this
--                     task's own FACTS classify them as "dropped": a claim
--                     G3-clean, its quote was actually verified inside the
--                     cited turn; G1/G2 never got that far, so there is no
--                     verified span to show as "inferred," only an
--                     unverifiable one.
--                 (b) accepted, kind = 'person', quote-verified (G3 passed,
--                     since accepted implies it), but NOT promoted — the
--                     one case where claim_serve_eligible's OWN accepted
--                     conjunct is true yet it still isn't eligible, purely
--                     because of the person-promotion gate. This has no
--                     reject_reason (rejectReason is NULL whenever
--                     accepted, per claims-write.ts's projectConversationClaims)
--                     so it is checked as its own arm, not folded into (a)'s
--                     reject_reason IN (...) test.
--
-- NULL ("dropped") — everything else: G0 (claim_key IS NULL — no fact
--               identity was ever computed, so there is nothing to look up
--               in kg_claim_lifecycle at all), G1/G2 (turn missing / non-
--               owner turn — see above), no verbatim quote, or a claim
--               that WOULD otherwise read 'inferred' but is blocked by a
--               correction / orphaned / refuted / not the latest correction.
--
-- SECURITY: security invoker, no grants revoked from PUBLIC on the five
-- helper functions it calls (039's own stated convention — "no EXECUTE
-- grants/revokes on any function here"); this function itself IS a new
-- directly-callable entry point (unlike those five), so it revokes from
-- public/anon and grants to BOTH `authenticated` (kg_claims_browse /
-- kg_claims_facets below run as the calling dashboard session) and
-- `service_role` (mcp_claims_identity / mcp_claims_context run under the
-- service-role connection /api/mcp uses, per 040's own header).
-- ------------------------------------------------------------
create or replace function public.claim_grounding(c public.kg_claims, l public.kg_claim_lifecycle)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with sc as (
    select (
      row(
        'extraction', c.claim_key_version, c.claim_key, c.user_id, c.kind,
        c.subject_key, c.target_key, c.block_discriminator, c.relation_class, c.former,
        c.name, c.event_status, c.conv_order_key,
        c.assertion_class, c.accepted, c.sensitive, c.claim_text, c.bridging_assumptions,
        c.conversation_id, null::text,
        c.message_id, c.evidence_quote, c.char_start, c.char_end
      )
    )::public.serve_candidates as row
  )
  select case
    when c.claim_key is null then null  -- G0: no fact identity at all.
    when public.claim_serve_eligible((select row from sc), l) then 'grounded'
    when (
        -- claim_serve_eligible's conjuncts MINUS accepted / promoted (the
        -- shared "not suppressed by anything else" gate both the 'inferred'
        -- branches below still have to pass).
        l.orphaned_at is null
        and coalesce(l.verification->>'status', 'unverified') <> 'refuted'
        and public.claim_not_blocked((select row from sc))
        and public.claim_is_latest_correction((select row from sc))
        and public.verification_policy_ok(l)
        and public.assumption_policy_ok((select row from sc))
      )
      and (
        (
          not c.accepted
          and c.evidence_quote is not null
          and c.reject_reason in ('gate:G3', 'gate:G4', 'gate:G5', 'gate:G6', 'gate:G7', 'gate:G9')
        )
        or (
          c.accepted
          and c.kind = 'person'
          and not coalesce(l.promoted, false)
          and c.evidence_quote is not null
        )
      )
    then 'inferred'
    else null
  end
$$;

comment on function public.claim_grounding(public.kg_claims, public.kg_claim_lifecycle) is
  'Three-valued epistemic verdict for one kg_claims row (ADR 0030 D5 lineage, this task''s own "inferred memory lane"): grounded (claim_serve_eligible, called unmodified via a synthetic serve_candidates row), inferred (a real, turn-verified quote that failed G3/G4/G5/G6/G7/G9, or an accepted-but-unpromoted person claim — never G0/G1/G2, which the task classifies as dropped), or NULL/dropped otherwise. Reuses claim_not_blocked/claim_is_latest_correction/verification_policy_ok/assumption_policy_ok for the "not suppressed" conjuncts shared by both branches. Migration 051.';

revoke all on function public.claim_grounding(public.kg_claims, public.kg_claim_lifecycle) from public;
revoke all on function public.claim_grounding(public.kg_claims, public.kg_claim_lifecycle) from anon;
grant execute on function public.claim_grounding(public.kg_claims, public.kg_claim_lifecycle) to authenticated;
grant execute on function public.claim_grounding(public.kg_claims, public.kg_claim_lifecycle) to service_role;

-- ------------------------------------------------------------
-- 2. Supporting index — kg_claims_browse filters by (user_id, kind, name)
-- for the p_person / p_project matches below; nothing in 039/040/042/046
-- indexes `name` at all.
-- ------------------------------------------------------------
create index if not exists idx_kg_claims_user_kind_name
  on public.kg_claims (user_id, kind, name)
  where name is not null;

-- ------------------------------------------------------------
-- 3. kg_claims_browse — the dashboard Memory browser's one read RPC.
--
-- Session-bound (015/025/034 family SHAPE, but with an explicit p_user_id
-- parameter per this task's own spec rather than reading auth.uid()
-- directly): SECURITY INVOKER, so RLS on kg_claims/kg_claim_lifecycle/
-- conversations (auth.uid() = user_id) is the belt; an explicit
-- `auth.uid() = p_user_id` check (034's loud-fail RAISE, adapted for a
-- caller-supplied id rather than 034's "no such argument exists") is the
-- suspenders — a spoofed p_user_id fails loudly rather than silently
-- returning someone else's rows (which RLS alone would already prevent,
-- since the underlying tables filter on the REAL auth.uid(), not on
-- p_user_id) or silently returning nothing (which would look like success).
-- `language plpgsql`, not `sql`, because RAISE requires it (034's own
-- stated reason).
--
-- GRAIN: one row per kg_claims OCCURRENCE (id), not per fact identity — the
-- Memory browser is meant to show every extracted sentence, not a
-- deduplicated one-per-fact projection like mcp_claims_identity/
-- mcp_claims_browse (046) do for their own (different) audiences.
--
-- FIELD PROVENANCE (documented per this task's own instruction to "pick
-- what exists" and document it):
--   text            := coalesce(claim_text, text, name, target_key) — the
--                       best available natural-language rendering. claim_text
--                       (Delta 7) is required going forward but NULL on any
--                       pre-12a row; `text` is the memory-kind payload field
--                       (decision/preference/insight/commitment); `name` is
--                       the person/place/project's own name; `target_key` is
--                       the last-resort normalized identity string.
--   person          := name, when kind = 'person' (claims-write.ts:
--                       claimName() returns the payload''s own `name` for
--                       exactly this kind).
--   project         := name, when kind = 'project' (same claimName() rule).
--   p_person/p_project match ON THAT SAME `name` COLUMN, case/whitespace-
--   insensitively — the only person/project-identifying string kg_claims
--   carries at all (subject_key is almost always ''owner''; about_key is
--   used by the THREE different, unrelated memory kinds). FLAGGED
--   LIMITATION: this is the raw extracted name, not the curated
--   kg_nodes.label a person may have been renamed/merged to on /people — a
--   renamed person''s older claims will not match their current label until
--   a future revision joins through kg_nodes/kg_claims entity linking
--   (resolved_entity_id, columns-only per 039). Acceptable for this STOPGAP
--   deliverable; called out per this task''s "deviations loudly" instruction.
--   receipt         := ONLY when grounding = 'grounded' (task''s own spec);
--                       NULL for inferred/anything else, so the web UI can
--                       never accidentally render a transcript link for a
--                       claim that has none.
--
-- p_q: FTS over the best-available text (`claim_text_best`), 'simple'
-- config, WITH an ILIKE fallback on a degenerate (empty-after-tokenization)
-- tsquery — unlike 042''s mcp_claims_context fix, which removed that
-- fallback because an EMPTY p_query made it degrade to "match everything."
-- Here the fallback only ever fires when p_q is itself non-empty (the
-- `p_q is null or btrim(p_q) = ''` branch above it handles "no query at
-- all" separately, by skipping the predicate entirely rather than falling
-- through to ILIKE), so a punctuation-only SEARCH TERM still narrows the
-- ILIKE pattern to that literal text rather than matching every row.
-- ------------------------------------------------------------
create or replace function public.kg_claims_browse(
  p_user_id uuid,
  p_include_inferred boolean default false,
  p_kind text default null,
  p_person text default null,
  p_project text default null,
  p_q text default null,
  p_limit int default 100
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
      public.claim_grounding(c, l) as grounding
    from public.kg_claims c
    join public.kg_claim_lifecycle l
      on l.user_id = c.user_id
     and l.claim_key_version = c.claim_key_version
     and l.claim_key = c.claim_key
    where c.user_id = p_user_id
      and c.claim_key is not null
  ),
  filtered as (
    select g.*, conv.title as conversation_title, conv.source as conversation_source
    from graded g
    left join public.conversations conv on conv.id = g.conversation_id and conv.user_id = p_user_id
    where (g.grounding = 'grounded' or (p_include_inferred and g.grounding = 'inferred'))
      and (p_kind is null or g.kind = p_kind)
      and (
        p_person is null
        or (g.kind = 'person' and g.name is not null and lower(btrim(g.name)) = lower(btrim(p_person)))
      )
      and (
        p_project is null
        or (g.kind = 'project' and g.name is not null and lower(btrim(g.name)) = lower(btrim(p_project)))
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
  ordered as (
    select *
    from filtered
    order by (grounding = 'grounded') desc, coalesce(conv_order_key, created_at) desc nulls last, id
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', o.id,
        'claim_key', o.claim_key,
        'kind', o.kind,
        'text', o.claim_text_best,
        'grounding', o.grounding,
        'receipt', case
          when o.grounding = 'grounded' then jsonb_build_object(
            'quote', o.evidence_quote,
            'conversation_id', o.conversation_id,
            'conversation_title', o.conversation_title,
            'source', o.conversation_source,
            'message_turn', o.turn
          )
          else null
        end,
        'person', case when o.kind = 'person' then o.name else null end,
        'project', case when o.kind = 'project' then o.name else null end,
        'created_at', o.created_at,
        'sensitive', o.sensitive
      )
      order by (o.grounding = 'grounded') desc, coalesce(o.conv_order_key, o.created_at) desc nulls last, o.id
    ),
    '[]'::jsonb
  )
  into v_result
  from ordered o;

  return v_result;
end;
$$;

comment on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int) is
  'Dashboard Memory browser (this task, migration 051): one row per kg_claims occurrence (not per fact identity), grounding-stamped via claim_grounding, receipt present ONLY when grounded. p_person/p_project match kg_claims.name (the only person/project-identifying string kg_claims carries — see this function''s own header for the flagged kg_nodes-rename limitation). p_q: FTS over the best-available text field with an ILIKE fallback for a non-empty degenerate query. Session-bound: security invoker + explicit auth.uid() = p_user_id loud-fail (034 family, adapted for the explicit-param shape this task specifies). EXECUTE: authenticated only.';

revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int) from public;
revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int) from anon;
grant execute on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int) to authenticated;

-- ------------------------------------------------------------
-- 4. kg_claims_facets — filter-rail counts for the Memory browser.
--
-- `kinds`/`people`/`projects` respect p_include_inferred (they describe what
-- is ACTUALLY visible at the current toggle state, so the filter rail''s own
-- counts never promise more rows than the browse call will return for the
-- same toggle); `grounded`/`inferred`/`dropped` are computed over the FULL
-- population regardless of the toggle — they are the stat chips that tell
-- the owner what the toggle is offering to reveal, so they must not change
-- when the toggle itself changes.
--
-- No sensitivity filter, matching kg_claims_servable (039)''s own explicit
-- choice: "No sensitive filter — the owner is the audience Q9 says may see
-- sensitive claims." `sensitive` rides along per-row in kg_claims_browse''s
-- own output for the UI to badge, exactly like kg_claims_servable does.
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
    select c.kind, c.name, public.claim_grounding(c, l) as grounding
    from public.kg_claims c
    join public.kg_claim_lifecycle l
      on l.user_id = c.user_id
     and l.claim_key_version = c.claim_key_version
     and l.claim_key = c.claim_key
    where c.user_id = p_user_id
      and c.claim_key is not null
  ),
  visible as (
    select *
    from graded
    where grounding = 'grounded' or (p_include_inferred and grounding = 'inferred')
  ),
  kinds as (
    select kind, count(*) as n from visible where kind is not null group by kind
  ),
  people as (
    select name as label, count(*) as n from visible where kind = 'person' and name is not null group by name
  ),
  projects as (
    select name as label, count(*) as n from visible where kind = 'project' and name is not null group by name
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
    'grounded', (select count(*) from graded where grounding = 'grounded'),
    'inferred', (select count(*) from graded where grounding = 'inferred'),
    'dropped', (select count(*) from graded where grounding is null)
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.kg_claims_facets(uuid, boolean) is
  'Filter-rail facet counts for the Memory browser (this task, migration 051). kinds/people/projects respect p_include_inferred; grounded/inferred/dropped are always computed over the full population (the stat chips describing what the toggle offers). Session-bound, same auth.uid()=p_user_id loud-fail as kg_claims_browse. EXECUTE: authenticated only.';

revoke all on function public.kg_claims_facets(uuid, boolean) from public;
revoke all on function public.kg_claims_facets(uuid, boolean) from anon;
grant execute on function public.kg_claims_facets(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 5. mcp_claims_identity — ADDITIVE p_include_inferred overload.
--
-- FLAGGED, EMPIRICALLY VERIFIED (read-only rollback-transaction check
-- against the local DB while writing this migration): a bare
-- `create or replace function mcp_claims_identity(p_user_id uuid,
-- p_include_inferred boolean default false)` does NOT replace the existing
-- one-argument function in place — Postgres''s replace rule requires the
-- SAME argument-type list; adding a trailing parameter (even a defaulted
-- one) is a DIFFERENT signature, so `create or replace` would instead
-- create a SECOND, coexisting function, and `mcp_claims_identity(p_user_id)`
-- (one positional arg — every existing caller''s call shape) becomes
-- AMBIGUOUS between the old (uuid) function and the new (uuid, boolean)
-- one resolved via its default — a hard 42725 "function ... is not unique"
-- error, the opposite of "call-compatible." The fix is an explicit
-- `drop function` of the old one-argument signature immediately before the
-- `create function` below, so only ONE `mcp_claims_identity` exists
-- afterward and a one-argument call resolves to it unambiguously (a new
-- OID; nothing else in this schema references this function by OID —
-- confirmed by grepping every migration file for the name — only
-- application code calling `.rpc('mcp_claims_identity', {...})` by name,
-- which is OID-agnostic).
--
-- BYTE-IDENTICAL MECHANISM (the HARD RULE this task was given): when
-- p_include_inferred is false, `inferred_raw` filters on `where
-- p_include_inferred` first and returns zero rows, so `combined` is exactly
-- `capped` (046''s own CTE, copied verbatim) with a constant `is_grounded =
-- true` tag. The trailing `|| case when p_include_inferred then
-- jsonb_build_object(...) else '{}'::jsonb end` is a no-op merge in that
-- case (appends nothing), and the extra `e.is_grounded desc` ORDER BY term
-- is a constant across every row when only `capped` contributes, so it
-- changes no relative ordering versus 046''s original
-- `order by e.kind, e.target_key, e.t_asserted desc nulls last`. jsonb''s
-- ::text serialization is canonical regardless of how the value was
-- constructed, so the OUTPUT jsonb (and its text form) is byte-identical to
-- 046''s function for this call shape.
--
-- When p_include_inferred is true: unions in kg_claims rows (kind in
-- ('self','person'), same scope as the base `eligible` CTE) whose
-- claim_grounding = 'inferred', EXCLUDING any (kind, target_key,
-- block_discriminator) fact identity already present in `capped` (a
-- grounded winner takes precedence over surfacing its own rejected
-- sibling), then stamps every item — both the grounded ones and the newly
-- unioned inferred ones — with a `grounding` key.
-- ------------------------------------------------------------
drop function if exists public.mcp_claims_identity(uuid);

create or replace function public.mcp_claims_identity(p_user_id uuid, p_include_inferred boolean default false)
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
    select distinct on (kind, target_key, block_discriminator)
      kind, target_key, block_discriminator, name, relation_class, former, event_status, claim_text,
      claim_origin, sensitive, provider, conversation_id, message_id, char_start,
      char_end, quote_verbatim, t_asserted, effective_class
      from eligible
     order by kind, target_key, block_discriminator, t_asserted desc nulls last
  ),
  capped as (
    select * from deduped
     order by (kind <> 'self'), kind, target_key, t_asserted desc nulls last
     limit 100
  ),
  inferred_raw as (
    select
      c.kind, c.target_key, c.block_discriminator, c.name, c.relation_class, c.former, c.event_status,
      c.claim_text, 'extraction'::text as claim_origin, c.sensitive, conv.source as provider,
      c.conversation_id, c.message_id, c.char_start, c.char_end, c.evidence_quote as quote_verbatim,
      c.conv_order_key as t_asserted, c.assertion_class as effective_class
      from public.kg_claims c
      join public.kg_claim_lifecycle l
        on l.user_id = c.user_id
       and l.claim_key_version = c.claim_key_version
       and l.claim_key = c.claim_key
      join public.conversations conv on conv.id = c.conversation_id and conv.user_id = c.user_id
     where p_include_inferred
       and c.user_id = p_user_id
       and c.sensitive is not true
       and c.kind in ('self', 'person')
       and public.claim_grounding(c, l) = 'inferred'
  ),
  inferred_deduped as (
    select distinct on (i.kind, i.target_key, i.block_discriminator)
      i.kind, i.target_key, i.block_discriminator, i.name, i.relation_class, i.former, i.event_status,
      i.claim_text, i.claim_origin, i.sensitive, i.provider, i.conversation_id, i.message_id,
      i.char_start, i.char_end, i.quote_verbatim, i.t_asserted, i.effective_class
      from inferred_raw i
     where not exists (
       select 1 from capped d
        where d.kind = i.kind
          and d.target_key = i.target_key
          and d.block_discriminator is not distinct from i.block_discriminator
     )
     order by i.kind, i.target_key, i.block_discriminator, i.t_asserted desc nulls last
  ),
  combined as (
    select *, true as is_grounded from capped
    union all
    select *, false as is_grounded from inferred_deduped
  )
  select coalesce(
    jsonb_agg(
      (
        jsonb_build_object(
          'kind', e.kind,
          'target_key', e.target_key,
          'block_discriminator', e.block_discriminator,
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
        )
        || case
             when p_include_inferred
               then jsonb_build_object('grounding', case when e.is_grounded then 'grounded' else 'inferred' end)
             else '{}'::jsonb
           end
      )
      order by e.kind, e.target_key, e.t_asserted desc nulls last, e.is_grounded desc
    ),
    '[]'::jsonb
  )
  from combined e;
$$;

comment on function public.mcp_claims_identity(uuid, boolean) is
  'Claims-first identity surface for who_is_this_user (ADR 0030 D5, goal step 13). Migration 051 ADDITIVE change: new trailing p_include_inferred parameter (default false, byte-identical to migration 046''s output for that default — see this function''s own header for the exact no-op mechanism); when true, unions kind in (self,person) rows whose claim_grounding = ''inferred'' (excluding fact identities already covered by a grounded row) and stamps a ''grounding'' key on every item. Every other field and rule is unchanged from 046. Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

revoke all on function public.mcp_claims_identity(uuid, boolean) from public;
revoke all on function public.mcp_claims_identity(uuid, boolean) from anon;
revoke all on function public.mcp_claims_identity(uuid, boolean) from authenticated;
grant execute on function public.mcp_claims_identity(uuid, boolean) to service_role;

-- ------------------------------------------------------------
-- 6. mcp_claims_context — same ADDITIVE p_include_inferred treatment as
-- mcp_claims_identity above (new trailing defaulted parameter; SAME
-- explicit-drop-first fix — see section 5''s header for why a bare
-- `create or replace` with an added parameter does NOT replace in place
-- and instead makes the original 3-argument call shape ambiguous; verified
-- empirically the same way). Byte-identical default path via the same
-- no-op-merge + constant-sort-key mechanism. Unlike identity, context has
-- NO kind restriction and no DISTINCT ON dedup (042''s own version doesn't
-- dedupe by fact identity — v1 is "every matching claim occurrence"), so
-- the inferred union here is simpler: the same FTS match, independently
-- capped at p_limit, with no exclusion against the grounded set (context
-- already tolerates multiple rows per fact identity, so an inferred
-- sibling next to a grounded one is consistent with its existing v1
-- behavior, not a new kind of duplication).
-- ------------------------------------------------------------
drop function if exists public.mcp_claims_context(uuid, text, int);

create or replace function public.mcp_claims_context(
  p_user_id uuid,
  p_query text,
  p_limit int default 20,
  p_include_inferred boolean default false
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
       and q.tsq::text <> ''
       and to_tsvector('simple', c.claim_text) @@ q.tsq
  ),
  limited as (
    select * from eligible
    order by t_asserted desc nulls last
    limit greatest(p_limit, 1)
  ),
  inferred_raw as (
    select
      c.kind, c.target_key, c.name, c.relation_class, c.former, c.event_status,
      c.claim_text, 'extraction'::text as claim_origin, c.sensitive, conv.source as provider,
      c.conversation_id, c.message_id, c.char_start, c.char_end, c.evidence_quote as quote_verbatim,
      c.conv_order_key as t_asserted, c.assertion_class as effective_class
      from public.kg_claims c
      join public.kg_claim_lifecycle l
        on l.user_id = c.user_id
       and l.claim_key_version = c.claim_key_version
       and l.claim_key = c.claim_key
      join public.conversations conv on conv.id = c.conversation_id and conv.user_id = c.user_id
      cross join q
     where p_include_inferred
       and c.user_id = p_user_id
       and c.sensitive is not true
       and public.claim_grounding(c, l) = 'inferred'
       and q.tsq::text <> ''
       and to_tsvector('simple', coalesce(c.claim_text, '')) @@ q.tsq
  ),
  inferred_limited as (
    select * from inferred_raw
    order by t_asserted desc nulls last
    limit greatest(p_limit, 1)
  ),
  combined as (
    select *, true as is_grounded from limited
    union all
    select *, false as is_grounded from inferred_limited
  )
  select coalesce(
    jsonb_agg(
      (
        jsonb_build_object(
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
        )
        || case
             when p_include_inferred
               then jsonb_build_object('grounding', case when e.is_grounded then 'grounded' else 'inferred' end)
             else '{}'::jsonb
           end
      )
      order by e.t_asserted desc nulls last, e.is_grounded desc
    ),
    '[]'::jsonb
  )
  from combined e;
$$;

comment on function public.mcp_claims_context(uuid, text, int, boolean) is
  'Claims-first context surface for get_context_for (ADR 0030 D5, goal step 13). Migration 051 ADDITIVE change: new trailing p_include_inferred parameter (default false, byte-identical to migration 042''s output for that default); when true, unions FTS-matching kg_claims rows whose claim_grounding = ''inferred'' (own p_limit-sized slice) and stamps a ''grounding'' key on every item. v1 retrieval unchanged: FTS over claim_text (GIN ''simple''), no ILIKE fallback (042''s own fix). Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

revoke all on function public.mcp_claims_context(uuid, text, int, boolean) from public;
revoke all on function public.mcp_claims_context(uuid, text, int, boolean) from anon;
revoke all on function public.mcp_claims_context(uuid, text, int, boolean) from authenticated;
grant execute on function public.mcp_claims_context(uuid, text, int, boolean) to service_role;
