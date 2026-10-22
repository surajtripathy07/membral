-- ============================================================
-- 042_claims_serving_fixes.sql
-- ADR 0030 D4/D5 — fixes from the goal-step-13/14 mandatory adversarial
-- review (fresh review, 2026-07-26): 1 BLOCKER (server.ts, not SQL — see
-- lib/mcp/server.ts's own B1 comment) + M2, M3, and two MINORs land here.
-- Migrations 040/041 are ALREADY APPLIED, so every fix below is a NEW
-- object (`create or replace`) or an additive `alter table` — nothing in
-- 040/041's own files is rewritten to require re-application.
-- ============================================================

-- ------------------------------------------------------------
-- M3 — retired corrections must STOP SERVING their own content.
--
-- FINDING: serve_candidates' correction branch filtered `where u.retires is
-- null` (excluding retirement rows THEMSELVES from being claims — correct
-- and unchanged) but never checked whether the CORRECTION ROW ITSELF had
-- since been retired by a LATER row. A retired correction therefore kept
-- appearing as `claim_origin = 'user_correction'` content forever — the
-- serving surface's own "I take that back" receipt kept being served after
-- the user had explicitly withdrawn it, which contradicts membral_correct's
-- own tool description ("withdraw a previous correction") and the
-- retirement UX example.
--
-- FIX: add the same "not retired" anti-join the blocking functions
-- (claim_not_blocked, claim_is_latest_correction, kg_active_blocks) already
-- carry on THEIR OWN correction-row lookups — this view just needed the
-- identical guard on the row it emits as a claim.
--
-- SCOPE, CONFIRMED UNCHANGED: claim_not_blocked / claim_is_latest_correction
-- / kg_active_blocks read `kg_user_claims` directly (never through
-- serve_candidates), and each ALREADY excludes retired corrections from
-- their own anti-join subqueries — this fix touches none of that
-- suppression machinery. What changes is narrower and exactly what the
-- finding names: a retired correction stops being SERVABLE CONTENT (an
-- entry in mcp_claims_identity/mcp_claims_context/kg_claims_servable), while
-- the FACT that it once suppressed a claim, and the suppression's own
-- retirement, continue to be governed entirely by fact identity as before.
--
-- CHAIN SEMANTICS, CONFIRMED UNCHANGED (retiring C1 with a live C2 present):
-- C2's own row is untouched by this WHERE clause (nothing retires C2), so C2
-- keeps serving. This is the same "retiring an objection un-suppresses the
-- OLDER evidence underneath it, C2 still serves and still wins the fold on
-- recency" behaviour ADR 0030 D5 already documents for the blocking side —
-- this fix makes the SERVING side of a single retired correction agree with
-- it, nothing more.
--
-- DRIVER ARBITRATION (M3, recorded per the fresh review's instruction): this
-- is a serving-predicate clarification of D5's text, not a re-litigation of
-- the retirement/suppression design — taken at driver level as reversible,
-- for maintainer ratification. See docs/adr/0030-recentering-verified-record.md's
-- chain-semantics section and 2026-07-26 implementation addendum for the
-- corresponding one-line ADR note.
--
-- `security_invoker = on` preserved — required on every view in this chain
-- (039's own comment: the flag does not chain; an inner view created
-- without it runs as `postgres`, which carries BYPASSRLS). Column list is
-- BYTE-IDENTICAL to 039's version (same 24 columns, same order/types) — only
-- the correction branch's WHERE clause changes, which is why `create or
-- replace view` is safe here (it is not legal to `create or replace` a view
-- with a different column list, and the fix does not need one).
-- ------------------------------------------------------------
create or replace view public.serve_candidates with (security_invoker = on) as
  select 'extraction'::text as claim_origin, c.claim_key_version, c.claim_key, c.user_id, c.kind,
         c.subject_key, c.target_key, c.block_discriminator, c.relation_class, c.former,
         c.name, c.event_status, c.conv_order_key as t_asserted,
         c.assertion_class, c.accepted, c.sensitive, c.claim_text, c.bridging_assumptions,
         c.conversation_id, conv.source as provider,
         c.message_id, c.evidence_quote as quote_verbatim, c.char_start, c.char_end
    from public.kg_claims c
    join public.conversations conv on conv.id = c.conversation_id and conv.user_id = c.user_id
  union all
  select 'user_correction'::text, u.claim_key_version, u.claim_key, u.user_id, u.kind,
         u.subject_key, u.target_key, u.block_discriminator, u.relation_class, u.former,
         u.name, u.payload->>'event_status', u.t_asserted,
         u.assertion_class, u.accepted, u.sensitive, u.claim_text, null::text[],
         u.correction_id,        -- conversation_id: the correction IS its own source document
         null::text,             -- provider null: it came from Membral, not from a provider
         null::uuid, u.evidence_quote,  -- message_id null; the receipt is the whole utterance
         null::int, null::int    -- offsets null: there is no enclosing message to offset into
    from public.kg_user_claims u
   where u.retires is null       -- retirement rows are CONTROL RECORDS, not claims:
                                  --   no lifecycle row, never folded, never served
     and not exists (            -- M3: a correction that has ITSELF been retired stops
       select 1                  --   being servable content — "I take that back" actually
         from public.kg_user_claims r  --   stops the withdrawn statement from being served,
        where r.user_id = u.user_id   --   not just from blocking. A live C2 on the same fact
          and r.retires  = u.correction_id  -- identity is untouched (nothing retires C2).
     );

comment on view public.serve_candidates is
  'Union of extraction claims (kg_claims) and live, NON-RETIRED corrections (kg_user_claims), 24 columns, ADR 0030 D5. M3 fix (fresh adversarial review 2026-07-26): a correction row that has itself been retired by a later kg_user_claims row is excluded from the union entirely, matching membral_correct''s own "withdraw a previous correction" contract. security_invoker=on so RLS on the base tables actually scopes callers — this view carries no auth predicate of its own (shared substrate for the goal-step-13 service-role RPCs, where auth.uid() is NULL by design).';

-- ------------------------------------------------------------
-- M2 — mcp_claims_identity must DEDUPE and CAP.
--
-- FINDING: the 040 version emitted one row per SERVE-ELIGIBLE kg_claims
-- occurrence — every conversation that repeated "I'm a staff engineer"
-- contributed its own row, so a corpus with many repeated self-facts (or
-- many extraction rows sharing one relationship) returned a long, heavily
-- duplicated list instead of one line per distinct fact, and carried no
-- upper bound at all.
--
-- FIX: DISTINCT ON (kind, target_key, block_discriminator) — the same
-- fact-identity grain claim_not_blocked/claim_is_latest_correction/
-- kg_active_blocks already group on — picking the row with the latest
-- t_asserted per group (Postgres DISTINCT ON requires ORDER BY to lead with
-- the same expressions it distincts on), plus a hard LIMIT 100 on the
-- deduped set as a response-size backstop. `block_discriminator` is part of
-- the DISTINCT ON grain (not just kind+target_key) because two DIFFERENT
-- facts about the SAME target can share (kind, target_key) — e.g. `self`
-- claims always share target_key='∅' but differ by attribute
-- (role/employer/location/...), which IS the block_discriminator for that
-- kind; distincting on (kind, target_key) alone would silently collapse a
-- role fact and an employer fact into one.
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
    -- M2: one row per (kind, target_key, block_discriminator) fact identity —
    -- the latest t_asserted wins within a group.
    select distinct on (kind, target_key, block_discriminator)
      kind, target_key, name, relation_class, former, event_status, claim_text,
      claim_origin, sensitive, provider, conversation_id, message_id, char_start,
      char_end, quote_verbatim, t_asserted, effective_class
      from eligible
     order by kind, target_key, block_discriminator, t_asserted desc nulls last
  ),
  capped as (
    -- M2: hard cap, applied AFTER dedup so the 100 slots are 100 distinct facts.
    select * from deduped
     order by kind, target_key, t_asserted desc nulls last
     limit 100
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
  from capped e;
$$;

comment on function public.mcp_claims_identity(uuid) is
  'Claims-first identity surface for who_is_this_user (ADR 0030 D5, goal step 13). M2 fix (fresh adversarial review 2026-07-26): DISTINCT ON (kind, target_key, block_discriminator), latest t_asserted wins, hard-capped at 100 facts. Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

-- ------------------------------------------------------------
-- MINOR — mcp_claims_context's empty/punctuation-only-query fallback
-- matched EVERYTHING instead of NOTHING.
--
-- FINDING: the 040 version fell back to `c.claim_text ilike '%' || p_query
-- || '%'` whenever plainto_tsquery('simple', ...) produced an empty
-- tsquery. Under the 'simple' config (no stopword list), that happens ONLY
-- for degenerate input — an empty string, whitespace, or pure punctuation —
-- and in every one of those cases the ilike pattern degrades to '%<mostly
-- nothing>%', which matches EVERY non-null claim_text rather than the
-- documented "fallback when the tsquery is empty" behaviour. A one-character
-- punctuation query returned the user's entire claim set.
--
-- FIX: no ilike fallback at all. Since an empty tsquery under 'simple' is
-- categorically a degenerate-input signal (there is no non-degenerate input
-- that produces one), the correct, CONSISTENT behaviour for every such query
-- is zero rows, not "sometimes everything, depending on trailing
-- punctuation". This is a narrower v1 than the original "FTS + ilike
-- fallback" design the ADR sketched — the fallback's only reachable case
-- was the one it handled wrong, so removing it is a strict improvement.
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
       -- MINOR fix: an empty tsquery (degenerate input under 'simple') now
       -- matches NOTHING, consistently — no ilike fallback.
       and q.tsq::text <> ''
       and to_tsvector('simple', c.claim_text) @@ q.tsq
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

comment on function public.mcp_claims_context(uuid, text, int) is
  'Claims-first context surface for get_context_for (ADR 0030 D5, goal step 13). v1 retrieval: FTS over claim_text (GIN ''simple''). MINOR fix (fresh adversarial review 2026-07-26): an empty/punctuation-only query (empty tsquery) now returns zero rows deterministically — the earlier ilike fallback matched EVERY claim on this input, which is the opposite of "fallback". Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

-- Grants: unchanged from 040 (create or replace preserves existing grants in
-- Postgres, but re-asserted here for the same "belt and suspenders" reason
-- 016/039 state explicitly — a migration that silently depended on grants
-- surviving a `create or replace` would be exactly the kind of implicit
-- assumption this repo's own conventions reject).
revoke all on function public.mcp_claims_identity(uuid) from public;
revoke all on function public.mcp_claims_identity(uuid) from anon;
revoke all on function public.mcp_claims_identity(uuid) from authenticated;
grant execute on function public.mcp_claims_identity(uuid) to service_role;

revoke all on function public.mcp_claims_context(uuid, text, int) from public;
revoke all on function public.mcp_claims_context(uuid, text, int) from anon;
revoke all on function public.mcp_claims_context(uuid, text, int) from authenticated;
grant execute on function public.mcp_claims_context(uuid, text, int) to service_role;

-- ------------------------------------------------------------
-- MINOR — claim_key_version's DB DEFAULT must track CURRENT_CLAIM_KEY_VERSION.
--
-- claim-key.ts's CURRENT_CLAIM_KEY_VERSION bumped 1 -> 2 (goal step 12a,
-- landed after 039 shipped its `default 1`). The application always sets
-- claim_key_version EXPLICITLY on every insert (claims-write.ts,
-- claims-correct.ts), so this default is a pure safety net — but a stale
-- default is exactly the kind of thing that silently produces a v1-labelled
-- row from a future code path that forgets to pass the column, so it tracks
-- the app constant here rather than being left to drift a second time.
-- ------------------------------------------------------------
alter table public.kg_claims alter column claim_key_version set default 2;
alter table public.kg_user_claims alter column claim_key_version set default 2;

-- ------------------------------------------------------------
-- MINOR — a structural CHECK backstop for G5 on kg_user_claims.
--
-- G5 ("membral_correct rejects, it does not store-then-filter") is enforced
-- entirely in TypeScript today (lib/kg/claims-correct.ts, BEFORE
-- membral_correct_write is ever called — see 041's own header, restated:
-- "there is deliberately no redundant check [in the RPC]"). This CHECK is
-- the cheap structural backstop the fresh review asked for: a defense-in-
-- depth guard against a FUTURE regression in that TS gate, not a
-- replacement for it. It cannot express "the CORRECTED claim's subject was
-- the owner" (that identity lives on the row being corrected, not on this
-- one) — only the narrower, still-useful invariant that every row THIS
-- correction writes about itself claims subject_key = 'owner'. Retirement
-- rows (`corrects is null`) are exempt: they carry whatever subject_key was
-- denormalized from the correction they retire, which G5 already validated
-- when THAT correction was written.
-- ------------------------------------------------------------
alter table public.kg_user_claims
  add constraint kg_user_claims_g5_owner_only
  check (corrects is null or subject_key = 'owner');
