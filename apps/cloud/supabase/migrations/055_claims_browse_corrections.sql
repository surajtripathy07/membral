-- ============================================================
-- 055_claims_browse_corrections.sql
-- Fresh adversarial review of the Bridge Context + Memory Lane surface
-- (2026-08-26). H5 + two live-maintainer follow-ups folded into one
-- migration since all three touch the same two RPCs. Depends on: 039
-- (kg_claims, kg_user_claims, kg_claim_lifecycle, serve_candidates,
-- claim_serve_eligible, claim_not_blocked), 046 (mcp_claims_browse), 051
-- (claim_grounding, kg_claims_browse, kg_claims_facets). 049-054 already
-- applied — nothing in them is touched here.
--
-- H5 — corrected memories vanish: kg_claims_browse/kg_claims_facets (051)
-- scan ONLY public.kg_claims. A live correction (kg_user_claims, migration
-- 041) is never itself a browse row, AND its blocking anti-join
-- (claim_not_blocked, 039) makes the extraction row it suppresses fail
-- EVERY grounding branch (claim_grounding's 'grounded' branch requires
-- claim_not_blocked; both 'inferred' branches require it too) — so a
-- corrected memory returns grounding NULL and disappears from the browser
-- entirely, with no trace that anything was ever said. Fix: (a)
-- claim_browse_grounding, a browse-only extension of 051's claim_grounding
-- that reports 'corrected' for an extraction claim that would otherwise be
-- 'grounded' EXCEPT for failing claim_not_blocked specifically (i.e. it was
-- accepted, receipted, promoted-if-person, not orphaned/refuted — and the
-- ONLY reason it doesn't serve is a live correction) — everything else that
-- fails to be 'grounded'/'inferred' still falls through to NULL/dropped,
-- unchanged; (b) the live correction itself is unioned into both RPCs'
-- source rows as grounding='grounded', receipt=null (it has no real
-- conversation_id to link to — see kg_user_claims' own "the correction IS
-- its own source document" comment in 039), corrected=true.
--
-- MAINTAINER FOLLOW-UP 1 — order by when it was SAID, not claim-row
-- created_at (bootstrap-stamped every row 2026-07-28) and not grounded-first.
-- Fix: `said_at` := coalesce(conversation.updated_at, conversation.created_at,
-- claim.created_at) for an extraction row, correction.t_asserted for a
-- correction row (its receipt IS the correction utterance, dated at
-- assertion time) — returned on every item, sole sort key (desc).
--
-- MAINTAINER FOLLOW-UP 2/3 — People/Projects facets, CLAIMS-FIRST ONLY (the
-- maintainer explicitly overrode an earlier graph-based draft: "do NOT use
-- the graph at all — no kg_nodes, no kg_people_list, no kg_edges"):
--   People   := distinct kg_claims.name where kind='person' (visible set —
--               grounded, plus inferred/corrected when p_include_inferred;
--               the inferred lane holds most person claims, #98's G3 dead
--               end), normalized lower(btrim()).
--   Projects := distinct kg_claims.name where kind='project' (same rule)
--               UNION code_projects.display_name for the user (code
--               sessions aren't the graph either — kept).
-- Both label sets are then COLLAPSED by case-insensitive prefix ("Genius
-- AIx" / "Acme AIX" / "Acme AIx Chrome extension" -> one group, shortest
-- label wins as the display/canonical label) via
-- claims_browse_entity_labels() below. A claim belongs to a label's group
-- when claim.name matches it (case-insensitively) OR claim_text
-- word-boundary-matches it (claims_browse_label_regex()) — so a claim never
-- explicitly tagged kind='person'/'project' but mentioning the name/project
-- in its own text still counts. p_person/p_project filter and the new
-- p_group_by row-level `group_label` (a "Group by: person | project" UI
-- control) both reuse the exact same matching predicate.
--
-- SIGNATURE NOTE (same empirically-verified gotcha 051's own header
-- documents): `create or replace function` with an ADDED parameter is a
-- DIFFERENT signature, not a replacement — it would create a second,
-- coexisting overload and make every existing 7-arg kg_claims_browse call
-- ambiguous. kg_claims_browse gains two new trailing params (p_order,
-- p_group_by) here, so its old 7-arg signature is dropped first.
-- kg_claims_facets' signature is UNCHANGED (still 2 args) — no drop needed,
-- a plain create-or-replace is safe there.
-- ============================================================

-- ------------------------------------------------------------
-- 1. claim_browse_grounding(c kg_claims, l kg_claim_lifecycle) — see H5
-- above. Delegates to 051's claim_grounding for the grounded/inferred/NULL
-- verdict; only adds the 'corrected' outcome on top, for the specific case
-- claim_grounding has no way to express (it does not distinguish "blocked"
-- from any other non-serving reason).
-- ------------------------------------------------------------
create or replace function public.claim_browse_grounding(c public.kg_claims, l public.kg_claim_lifecycle)
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
  ),
  base as (
    select public.claim_grounding(c, l) as g
  )
  select case
    when (select g from base) is not null then (select g from base)
    when c.claim_key is null then null  -- G0, same short-circuit as claim_grounding.
    when (
      -- Everything claim_serve_eligible checks EXCEPT claim_not_blocked
      -- (and claim_is_latest_correction, which is a no-op for an
      -- extraction-origin row — see that function's own first conjunct):
      -- this would have been 'grounded' were it not suppressed.
      c.accepted
      and c.evidence_quote is not null
      and (c.kind <> 'person' or l.promoted)
      and l.orphaned_at is null
      and coalesce(l.verification->>'status', 'unverified') <> 'refuted'
      and public.verification_policy_ok(l)
      and public.assumption_policy_ok((select row from sc))
      and not public.claim_not_blocked((select row from sc))
    )
    then 'corrected'
    else null
  end
$$;

comment on function public.claim_browse_grounding(public.kg_claims, public.kg_claim_lifecycle) is
  'Browse-only extension of claim_grounding (051): adds a fourth outcome, ''corrected'', for an extraction claim that would be ''grounded'' except that claim_not_blocked (039) says a live correction suppresses it — so the Memory browser can show it as a badge instead of silently dropping it (migration 055, H5). Every other case (accepted/inferred/dropped) is delegated to claim_grounding unchanged.';

revoke all on function public.claim_browse_grounding(public.kg_claims, public.kg_claim_lifecycle) from public;
revoke all on function public.claim_browse_grounding(public.kg_claims, public.kg_claim_lifecycle) from anon;
grant execute on function public.claim_browse_grounding(public.kg_claims, public.kg_claim_lifecycle) to authenticated;
grant execute on function public.claim_browse_grounding(public.kg_claims, public.kg_claim_lifecycle) to service_role;

-- ------------------------------------------------------------
-- 2. claims_browse_label_regex(text) — builds a safe, word-boundary POSIX
-- ARE pattern from a raw label: every regex metacharacter is backslash-
-- escaped (so a label containing e.g. '.' or '(' is matched LITERALLY, not
-- as regex syntax), then wrapped in Postgres's `\m`/`\M` word-boundary
-- anchors so "AI" doesn't match inside "SAIL". `immutable` — pure string
-- transform, safe to use inline in a WHERE/JOIN predicate.
--
-- CONDITIONAL ANCHORING (caught in this migration's own psql verification —
-- 'C++ (Project)' silently matched NOTHING before this fix): `\m`/`\M` are
-- zero-width word/non-word TRANSITION assertions — anchoring one next to a
-- literal that is ITSELF non-word (a label starting/ending in punctuation,
-- e.g. the trailing ')' in 'C++ (Project)') makes the assertion
-- unsatisfiable at that position, so the whole pattern can never match,
-- ANYWHERE, including the label's own literal text. Each anchor is only
-- emitted when that edge of the label is actually a word character
-- ([[:alnum:]_]); a punctuation-edged label still matches literally, just
-- without a boundary requirement on that one side.
-- ------------------------------------------------------------
create or replace function public.claims_browse_label_regex(p_label text)
returns text
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select
    (case when coalesce(p_label, '') ~ '^[[:alnum:]_]' then '\m' else '' end)
    || regexp_replace(coalesce(p_label, ''), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g')
    || (case when coalesce(p_label, '') ~ '[[:alnum:]_]$' then '\M' else '' end)
$$;

comment on function public.claims_browse_label_regex(text) is
  'Word-boundary POSIX ARE pattern from a raw label, every regex metachar escaped so the label matches literally. Migration 055 (Memory browser people/project grouping).';

revoke all on function public.claims_browse_label_regex(text) from public;
revoke all on function public.claims_browse_label_regex(text) from anon;
grant execute on function public.claims_browse_label_regex(text) to authenticated;
grant execute on function public.claims_browse_label_regex(text) to service_role;

-- ------------------------------------------------------------
-- 3. claims_browse_entity_labels(p_user_id, p_kind, p_include_inferred,
-- p_include_code_projects) — the curated, collapsed label set behind the
-- People/Projects facets and the p_person/p_project/p_group_by matching in
-- kg_claims_browse/kg_claims_facets below. CLAIMS-FIRST ONLY (maintainer
-- correction, 2026-08-26): source is exclusively kg_claims.name (p_kind
-- restricts to 'person' or 'project') from the VISIBLE population (grounded,
-- plus inferred/corrected when p_include_inferred — via
-- claim_browse_grounding), UNION code_projects.display_name when
-- p_include_code_projects (the Projects caller only — code sessions are not
-- the graph, kept per the maintainer's own instruction). NO kg_nodes,
-- kg_edges, or kg_people_list involvement anywhere in this function.
--
-- COLLAPSE ALGORITHM: for each raw label, its canonical_label is the
-- SHORTEST label in the same candidate set (ties broken alphabetically) that
-- is a case-insensitive PREFIX of it — a plain `left()`/`lower()` compare,
-- not a LIKE pattern, so label content can never be interpreted as a LIKE
-- wildcard. A label with no shorter prefix among its peers is its own
-- canonical label. This is a simple, cheap-at-demo-scale correlated
-- subquery (STOPGAP quality, matching 051's own "v1 grain" convention) —
-- fine for the tens-to-low-hundreds of distinct labels a real corpus has.
-- ------------------------------------------------------------
create or replace function public.claims_browse_entity_labels(
  p_user_id uuid,
  p_kind text,
  p_include_inferred boolean default false,
  p_include_code_projects boolean default false
)
returns table (raw_label text, canonical_label text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with named as (
    select distinct btrim(c.name) as candidate
      from public.kg_claims c
      join public.kg_claim_lifecycle l
        on l.user_id = c.user_id
       and l.claim_key_version = c.claim_key_version
       and l.claim_key = c.claim_key
     where c.user_id = p_user_id
       and c.claim_key is not null
       and c.kind = p_kind
       and c.name is not null
       and (
         public.claim_browse_grounding(c, l) = 'grounded'
         or (p_include_inferred and public.claim_browse_grounding(c, l) in ('inferred', 'corrected'))
       )
    union
    select distinct btrim(cp.display_name) as candidate
      from public.code_projects cp
     where p_include_code_projects
       and cp.user_id = p_user_id
       and cp.display_name is not null
  ),
  labels as (
    select candidate as raw_label from named where candidate is not null and candidate <> ''
  )
  select
    l.raw_label,
    (
      select m.raw_label
        from labels m
       where left(lower(l.raw_label), length(m.raw_label)) = lower(m.raw_label)
       order by length(m.raw_label), m.raw_label
       limit 1
    ) as canonical_label
    from labels l
$$;

comment on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) is
  'Curated, case-insensitive-prefix-collapsed label set for the Memory browser''s People/Projects facets (migration 055). CLAIMS-FIRST ONLY: distinct kg_claims.name for p_kind (person|project) from the visible population (claim_browse_grounding), optionally unioned with code_projects.display_name (p_include_code_projects, projects only) — no kg_nodes/kg_edges/kg_people_list involvement. canonical_label is the shortest same-population label that is a case-insensitive prefix of raw_label.';

revoke all on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) from public;
revoke all on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) from anon;
grant execute on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) to authenticated;
grant execute on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) to service_role;

-- ------------------------------------------------------------
-- 4. bridge_related_by_conversation — GET /api/bridge/context's related-
-- conversations FALLBACK (verified live, 2026-08-26): mcp_related_conversations
-- (migration 016) only matches conversations with a kg_conv_embeddings row,
-- a bootstrap-only cache — a conversation synced after the last bootstrap
-- has conversations.embedding set but no kg_conv_embeddings row and is
-- invisible to it (1,190/1,191 conversations in one real corpus). This RPC
-- is the same cosine-similarity-over-conversations.embedding query
-- migrations 044/045 already use for search (`1 - (embedding <=> query) >
-- 0.3` floor), scoped to one exclude-id instead of unified search's fuller
-- shape — used only when the cache-backed lookup returns zero rows.
-- ------------------------------------------------------------
create or replace function public.bridge_related_by_conversation(
  p_user_id uuid,
  p_query_embedding vector(1536),
  p_exclude_conversation_id uuid default null,
  p_limit int default 8
)
returns table (
  conversation_id uuid,
  title text,
  conv_date timestamptz,
  similarity real
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select c.id, c.title, c.created_at, (1 - (c.embedding <=> p_query_embedding))::real as similarity
    from public.conversations c
   where c.user_id = p_user_id
     and c.embedding is not null
     and (p_exclude_conversation_id is null or c.id <> p_exclude_conversation_id)
     and 1 - (c.embedding <=> p_query_embedding) > 0.3
   order by c.embedding <=> p_query_embedding
   limit greatest(coalesce(p_limit, 8), 1)
$$;

comment on function public.bridge_related_by_conversation(uuid, vector, uuid, int) is
  'GET /api/bridge/context''s related-conversations fallback (migration 055) — direct cosine similarity over conversations.embedding, used when mcp_related_conversations (kg_conv_embeddings-cache-backed, bootstrap-only) returns zero rows. Same >0.3 similarity floor as migrations 044/045''s search RPCs. Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

revoke all on function public.bridge_related_by_conversation(uuid, vector, uuid, int) from public;
revoke all on function public.bridge_related_by_conversation(uuid, vector, uuid, int) from anon;
revoke all on function public.bridge_related_by_conversation(uuid, vector, uuid, int) from authenticated;
grant execute on function public.bridge_related_by_conversation(uuid, vector, uuid, int) to service_role;

-- ------------------------------------------------------------
-- 5. kg_claims_browse — rewritten (H5 + both maintainer follow-ups). Old
-- 7-arg signature dropped first (see this file's header SIGNATURE NOTE).
-- ------------------------------------------------------------
drop function if exists public.kg_claims_browse(uuid, boolean, text, text, text, text, int);

create or replace function public.kg_claims_browse(
  p_user_id uuid,
  p_include_inferred boolean default false,
  p_kind text default null,
  p_person text default null,
  p_project text default null,
  p_q text default null,
  p_limit int default 100,
  p_order text default 'recent',
  p_group_by text default null
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
      coalesce(conv.updated_at, conv.created_at, c.created_at) as said_at
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
      u.t_asserted as said_at
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
      end as group_label
    from combined g
    where (g.grounding = 'grounded' or (p_include_inferred and g.grounding in ('inferred', 'corrected')))
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
  ordered as (
    select *
    from filtered
    -- MAINTAINER FOLLOW-UP 1: recent-by-said_at only — no more
    -- grounded-first tie-break (051's original ordering).  p_order is a
    -- forward-looking knob (046/049-style) — 'recent' is the only
    -- implemented value today; anything else also falls back to it.
    order by said_at desc nulls last, id
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
        'said_at', o.said_at,
        'receipt', case
          -- A correction row (corrected=true) has no real conversation to
          -- link to (kg_user_claims: "the correction IS its own source
          -- document") — receipt stays null even though it's grounded. A
          -- 'corrected' (superseded) ORIGINAL still carries its real,
          -- once-grounded receipt (useful context for the badge) — an
          -- enhancement beyond the letter of H5's ask, not required by it.
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
        'sensitive', o.sensitive
      )
      order by o.said_at desc nulls last, o.id
    ),
    '[]'::jsonb
  )
  into v_result
  from ordered o;

  return v_result;
end;
$$;

comment on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text) is
  'Dashboard Memory browser (migration 055, rewriting 051): one row per kg_claims occurrence PLUS one row per live, eligible correction (kg_user_claims) — grounding-stamped via claim_browse_grounding (grounded/inferred/corrected/dropped), receipt present for grounded/corrected extraction rows only (never for a correction row itself, which has no real conversation). said_at (conversation.updated_at/created_at, or the correction''s own t_asserted) is the sole sort key, recent first. p_person/p_project/p_group_by(''person''|''project'') all key off claims_browse_entity_labels'' curated, prefix-collapsed, claims-first label set. Session-bound: security invoker + explicit auth.uid()=p_user_id loud-fail (034 family). EXECUTE: authenticated only.';

revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text) from public;
revoke all on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text) from anon;
grant execute on function public.kg_claims_browse(uuid, boolean, text, text, text, text, int, text, text) to authenticated;

-- ------------------------------------------------------------
-- 6. kg_claims_facets — rewritten (H5 + People/Projects follow-up). SAME
-- 2-arg signature as 051 — no drop needed, a plain create-or-replace is
-- safe (no new parameters, so no ambiguous-overload risk).
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
      c.kind, c.name,
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
      u.kind, u.name,
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
    select kind, count(*) as n from visible where kind is not null group by kind
  ),
  people as (
    select pl.canonical_label as label, count(*) as n
      from person_labels pl
      join visible v
        on lower(btrim(coalesce(v.name, ''))) = lower(pl.raw_label)
        or v.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
     group by pl.canonical_label
  ),
  projects as (
    select pl.canonical_label as label, count(*) as n
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
  'Filter-rail facet counts for the Memory browser (migration 055, rewriting 051). kinds respect p_include_inferred; people/projects are claims_browse_entity_labels'' curated, prefix-collapsed, CLAIMS-FIRST label sets (no graph involvement), counted by matched claim (name match or word-boundary text match), respecting p_include_inferred. grounded/inferred/corrected/dropped are always computed over the full population (kg_claims graded rows plus live corrections for grounded) — the stat chips describing what the toggle offers. Session-bound, same auth.uid()=p_user_id loud-fail as kg_claims_browse. EXECUTE: authenticated only.';

revoke all on function public.kg_claims_facets(uuid, boolean) from public;
revoke all on function public.kg_claims_facets(uuid, boolean) from anon;
grant execute on function public.kg_claims_facets(uuid, boolean) to authenticated;
