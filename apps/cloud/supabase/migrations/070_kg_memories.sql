-- Migration 070 — ADR 0041 "a memory is one thing": memory_key, kg_memories
-- serving layer, and the memory-grain MCP/bridge RPCs.
--
-- ADDITIVE ONLY (D6, §5.15): this migration creates new objects and modifies
-- NONE of kg_claims, kg_user_claims, kg_claim_lifecycle, serve_candidates,
-- claim_not_blocked, claim_grounding, claim_browse_grounding,
-- kg_claims_browse, mcp_claims_browse, mcp_claims_context,
-- mcp_claims_identity, kg_claims_facets or kg_claims_by_code_project.
--
-- Objects (ADR 0041 D6 table):
--   1. memory_norm(text), memory_key(kind, subject_key, target_key,
--      relation_class, payload, claim_key) — D1/D1a/D1b. `claim_key` is an
--      ADDITIVE trailing default-null parameter beyond the ADR's own
--      abbreviated 5-arg listing: D1's own worked formula for the ∅
--      carve-out ("memory_key := 'instance:' || claim_key") is not
--      computable without it, so every call site here passes it explicitly;
--      any caller using the documented 5-arg form still works unchanged.
--   2. kg_memory_instances — convenience view, NOT on the hot path (D6.3
--      rule 4).
--   3. kg_memories_for — the single aggregation SRF; kg_memories — the
--      security_invoker owner view over it.
--   4. kg_memory_instances_page — instance expansion beyond the inline 5.
--   5. kg_memories_browse — jsonb projection of kg_memories_for + pagination.
--   6. kg_memories_facets — memory-grain facet counts, own materialized CTE
--      (D6.3 rule 1), delegates 'corrected'/'dropped' to kg_claims_facets
--      unchanged (D6b).
--   7. mcp_memories_context — service-role, FTS via kg_memories_for's p_q.
--   8. mcp_memories_browse — service-role, no embedded instances.
--   9. kg_memory_keys_for_claims — the one bridge-facing object (D7).
--  10. mcp_memories_identity — service-role, per-kind quotas (D6c).
--
-- KNOWN SCOPED-DOWN GAP (flagged, not silently improvised): objects 7/8/10
-- project the MCP receipt shape {provider, conversation_id, message_id,
-- char_start, char_end, quote_verbatim, t_asserted} from kg_memories_for's
-- already-aggregated BrowseClaim-shaped receipt (D6.4), which does not carry
-- per-instance message_id/char_start/char_end at memory grain — those three
-- are emitted as NULL (matching mcp_claims_browse's own precedent: its
-- header states message_id "is hardcoded NULL everywhere today"). quote_verbatim
-- is always non-null when a receipt exists (D2's eligibility filter already
-- requires evidence_quote is not null), so the no-quote guard in
-- claims-tools.ts still behaves correctly; only char-level citation
-- precision is reduced relative to the un-migrated RPCs.

-- =============================================================================
-- Round 3 fix (finding 4, NIT) — idempotency preamble.
--
-- Four objects in this migration changed SIGNATURE across earlier fix
-- rounds (`create or replace function` cannot change a function's argument
-- list or return type in place — Postgres identifies a function by name +
-- argument types, and a same-name/different-arity call becomes a NEW
-- overload rather than a replacement; a same-arity/different-return-type
-- call raises outright). On a database where an earlier revision of 070 had
-- already been applied, re-running this file top to bottom would either
-- create an ambiguous duplicate overload (the two arity changes below) or
-- fail with "cannot change return type of existing function" (the one
-- return-type change below). The live demo DB has never had any revision of
-- 070 applied (verified: `select count(*) from pg_proc where proname like
-- 'kg_memor%' or proname like 'mcp_memor%'` = 0), so none of this fires
-- today — it makes the migration safe to re-apply across its OWN future
-- edits, not a fix for an observed failure.
--
--   * kg_memories_for: gained a 10th parameter, p_memory_keys text[]
--     default null (fix round 2, R12) — the pre-R12 9-arg signature is
--     dropped so a database still on that revision doesn't end up with two
--     overloads and an ambiguous 9-arg call site (objects 5/7/8/10 all call
--     it with 9 positional args).
--   * mcp_memories_browse: gained a 4th parameter, p_exclude_kinds text[]
--     default null (fix round 2, R2) — same reasoning, the pre-R2 3-arg
--     signature is dropped.
--   * kg_memory_instances_page: gained six trailing parameters beyond the
--     original 4 (fix round 1, F11) — the pre-F11 4-arg signature is
--     dropped.
--   * kg_memory_keys_for_claims: changed RETURN TYPE from `returns table
--     (...)` to `returns jsonb` (fix round 1, F1 — the ACL-denied-SRF
--     segfault fix) with its argument list unchanged (uuid, uuid[]) — a
--     same-arity `create or replace function` cannot change this, so the
--     pre-F1 `returns table` version must be dropped, not replaced.
--
-- `if exists` makes every drop a no-op on a database (like this one) that
-- has never had any prior revision of 070 applied.
drop function if exists public.kg_memories_for(uuid, boolean, text, text, text, text, text, text, text);
drop function if exists public.mcp_memories_browse(uuid, integer, integer);
drop function if exists public.kg_memory_instances_page(uuid, text, integer, integer);
drop function if exists public.kg_memory_keys_for_claims(uuid, uuid[]);

-- =============================================================================
-- Object 1 — memory_norm, memory_key (D1, D1a, D1b)
-- =============================================================================

create or replace function public.memory_norm(p_text text)
returns text
language sql
immutable
security invoker
set search_path to 'public', 'pg_temp'
as $$
  select btrim(
    regexp_replace(
      lower(
        translate(
          translate(
            replace(replace(normalize(p_text, NFC), U&'\2026', '...'), U&'\E000', ' '),
            U&'\2018\2019\201B\2032\201C\201D\201F\2033\2010\2011\2012\2013\2014\2015\2212\00A0\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000',
            repeat('''', 4) || repeat('"', 4) || repeat('-', 7) || repeat(' ', 15)
          ),
          U&'\200B\FEFF\001F',
          ''
        )
      ),
      '\s+', ' ', 'g'
    )
  )
$$;

comment on function public.memory_norm(text) is
  'ADR 0041 D1a — NFC normalize, ellipsis/continuation-marker fold, punctuation/dash/space-separator fold (30 chars -> 30 chars translate), ZWSP/BOM/U+001F delete, lower, whitespace collapse, trim. Deliberately NOT equal to normalizeForContainment (claims.ts) — no TS second implementation exists to drift from.';

create or replace function public.memory_key(
  p_kind text,
  p_subject_key text,
  p_target_key text,
  p_relation_class text,
  p_payload jsonb,
  -- Fix round 1 (F14): NO default. Every call site in this migration already
  -- passes claim_key explicitly (verified by grep); a hypothetical 5-arg
  -- caller defaulting this to NULL would silently collapse every ∅-target
  -- person/place/project instance into ONE key instead of one-per-instance —
  -- exactly the "23 unnamed-person instances collapse into 7 groups" bug the
  -- carve-out (D1) exists to prevent. Dropping the default makes that caller
  -- a hard compile-time/call-time error instead of a silent data bug.
  p_claim_key text
)
returns text
language sql
immutable
security invoker
set search_path to 'public', 'pg_temp'
as $$
  select 'v1:' || md5(
    case
      when p_kind in ('person', 'place', 'project') and p_target_key = '∅' then
        coalesce(public.memory_norm('instance'), '') || U&'\001F' || coalesce(public.memory_norm(p_claim_key), '')
      when p_kind = 'person' then
        coalesce(public.memory_norm(p_kind), '') || U&'\001F' || coalesce(public.memory_norm(p_subject_key), '') || U&'\001F'
          || coalesce(public.memory_norm(p_target_key), '') || U&'\001F' || coalesce(public.memory_norm(p_relation_class), '')
      when p_kind = 'place' then
        coalesce(public.memory_norm(p_kind), '') || U&'\001F' || coalesce(public.memory_norm(p_subject_key), '') || U&'\001F'
          || coalesce(public.memory_norm(p_target_key), '') || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'role'), '')
      when p_kind = 'project' then
        coalesce(public.memory_norm(p_kind), '') || U&'\001F' || coalesce(public.memory_norm(p_subject_key), '') || U&'\001F'
          || coalesce(public.memory_norm(p_target_key), '')
      when p_kind = 'self' then
        coalesce(public.memory_norm(p_kind), '') || U&'\001F' || coalesce(public.memory_norm(p_subject_key), '') || U&'\001F'
          || coalesce(public.memory_norm(p_payload ->> 'attribute'), '') || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'value'), '')
      when p_kind = 'preference' then
        coalesce(public.memory_norm(p_kind), '') || U&'\001F' || coalesce(public.memory_norm(p_subject_key), '') || U&'\001F'
          || coalesce(public.memory_norm(p_target_key), '') || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'polarity'), '')
          || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'text'), '')
      when p_kind = 'decision' then
        coalesce(public.memory_norm(p_kind), '') || U&'\001F' || coalesce(public.memory_norm(p_subject_key), '') || U&'\001F'
          || coalesce(public.memory_norm(p_target_key), '') || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'text'), '')
      when p_kind = 'insight' then
        coalesce(public.memory_norm(p_kind), '') || U&'\001F' || coalesce(public.memory_norm(p_subject_key), '') || U&'\001F'
          || coalesce(public.memory_norm(p_target_key), '') || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'text'), '')
      when p_kind = 'event' then
        coalesce(public.memory_norm(p_kind), '') || U&'\001F' || coalesce(public.memory_norm(p_subject_key), '') || U&'\001F'
          || coalesce(public.memory_norm(p_target_key), '') || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'statement'), '')
          || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'when'), '')
      when p_kind = 'commitment' then
        coalesce(public.memory_norm(p_kind), '') || U&'\001F' || coalesce(public.memory_norm(p_subject_key), '') || U&'\001F'
          || coalesce(public.memory_norm(p_target_key), '') || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'text'), '')
          || U&'\001F' || coalesce(public.memory_norm(p_payload ->> 'due'), '')
      else
        coalesce(public.memory_norm('instance'), '') || U&'\001F' || coalesce(public.memory_norm(p_claim_key), '')
    end
  )
$$;

comment on function public.memory_key(text, text, text, text, jsonb, text) is
  'ADR 0041 D1 — per-kind conversation-independent fact identity. former/event_status/status excluded (state, not identity, D4.3). ∅ target (unnamed person/place/project) keys on the instance''s own claim_key (no cross-instance merge, D1 carve-out).';

-- =============================================================================
-- Object 2 — kg_memory_instances (convenience view, NOT on the hot path)
-- =============================================================================

create or replace view public.kg_memory_instances
with (security_invoker = true)
as
with graded as (
  select
    c.user_id, c.id, c.claim_key, c.kind, c.subject_key, c.target_key, c.relation_class, c.block_discriminator,
    c.about_key, c.name, c.former, c.event_status, c.accepted, c.reject_reason, c.sensitive,
    c.confidence, c.conversation_id, c.conv_order_key, c.created_at, c.evidence_quote,
    coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
    public.claim_browse_grounding(c, l) as grounding,
    false as is_correction,
    public.memory_key(c.kind, c.subject_key, c.target_key, c.relation_class, c.payload, c.claim_key) as memory_key
  from public.kg_claims c
  join public.kg_claim_lifecycle l
    on l.user_id = c.user_id and l.claim_key_version = c.claim_key_version and l.claim_key = c.claim_key
  where c.claim_key is not null
),
corrections as (
  select
    u.user_id, u.correction_id as id, u.claim_key, u.kind, u.subject_key, u.target_key, u.relation_class,
    u.block_discriminator, u.about_key, u.name, u.former, u.payload ->> 'event_status' as event_status,
    u.accepted, null::text as reject_reason, u.sensitive, 0.99::real as confidence,
    null::uuid as conversation_id, u.t_asserted as conv_order_key, u.created_at, u.evidence_quote,
    coalesce(u.claim_text, u.name, u.target_key) as claim_text_best,
    'grounded'::text as grounding,
    true as is_correction,
    coalesce(
      (select public.memory_key(cc.kind, cc.subject_key, cc.target_key, cc.relation_class, cc.payload, cc.claim_key)
         from public.kg_claims cc where cc.user_id = u.user_id and cc.claim_key = u.corrects limit 1),
      public.memory_key(u.kind, u.subject_key, u.target_key, u.relation_class, u.payload, u.claim_key)
    ) as memory_key
  from public.kg_user_claims u
  join public.kg_claim_lifecycle l
    on l.user_id = u.user_id and l.claim_key_version = u.claim_key_version and l.claim_key = u.claim_key
  where u.corrects is not null and u.retires is null
    and not exists (select 1 from public.kg_user_claims r where r.user_id = u.user_id and r.retires = u.correction_id)
    and public.claim_serve_eligible(
      (row('user_correction', u.claim_key_version, u.claim_key, u.user_id, u.kind, u.subject_key, u.target_key,
           u.block_discriminator, u.relation_class, u.former, u.name, u.payload ->> 'event_status', u.t_asserted,
           u.assertion_class, u.accepted, u.sensitive, u.claim_text, null::text[], u.correction_id, null::text,
           null::uuid, u.evidence_quote, null::int, null::int))::public.serve_candidates,
      l
    )
),
combined as (
  select * from graded
  union all
  select * from corrections
)
select * from combined
where grounding in ('grounded', 'inferred', 'corrected');

comment on view public.kg_memory_instances is
  'ADR 0041 D6.2/D6.3 rule 4 — convenience view for ad-hoc SQL and verification only. The universe is kg_claims_browse''s own (grounded+inferred+corrected extraction rows, plus live corrections). NOT on any serving path: a view cannot filter on its own computed grounding column without evaluating it twice.';

-- Fix round 1 (F13) — a small SCALAR (not set-returning) plpgsql helper,
-- same shape and pattern as the pre-existing `public.require_auth_uid()`
-- (used inside the `kg_memories` view below) and `project_alias_seed`'s own
-- inline guard (migrations 063/064): `auth.uid() = p_user_id` OR a real
-- service-role caller (`auth.role() = 'service_role'`, the genuine claim a
-- service-role-key request carries — tested live in 063). Deliberately
-- SCALAR: an earlier draft of this fix converted kg_memories_for itself to
-- `language plpgsql` with `returns table (...)` so it could `raise`
-- directly — reverted after live testing crashed the Postgres backend
-- (SIGNAL 11, reproduced twice) whenever an ACL-denied caller (authenticated
-- calling a service-role object like mcp_memories_context) triggered a
-- query plan containing a Function Scan over that RETURNS-TABLE plpgsql
-- function, EVEN THOUGH kg_memories_for's own ACL was never denied to the
-- caller — a distinct, broader trigger of the same crash class F1 diagnoses
-- for object 9. A scalar plpgsql function (this one) embedded in a
-- `language sql` `RETURNS TABLE` function's query plan does not crash —
-- `require_auth_uid()` has done exactly this, safely, since before this ADR.
-- Fix round 2 (R3, BLOCKER): was `stable` — a `guard` CTE cross-joined into
-- `graded` with its `ok` column never referenced anywhere (SELECT or WHERE)
-- was fully prunable, so this never actually ran (adv round2 finding 3,
-- decisive proof: as service_role with a spoofed authenticated JWT and
-- BYPASSRLS, kg_memories_for('<other-user>', true) returned 13 rows and did
-- not raise). `volatile` here is belt-and-suspenders alongside the WHERE-
-- clause fix below (kg_memories_for): it stops the planner from treating
-- repeated/unreferenced calls as foldable/skippable.
create or replace function public.require_session_or_service_role(p_user_id uuid, p_fn_name text)
returns boolean
language plpgsql
volatile
security invoker
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Round 3 fix (finding 3, MINOR): `auth.role()` only resolves when a
  -- `request.jwt.claims`/`request.jwt.claim.role` setting is present on the
  -- session (the shape a PostgREST/Supabase client request carries). A
  -- direct-`psql`/pooled/pgbouncer service-role session with NO jwt claim
  -- config set has none of that, so it used to raise even though it is a
  -- genuine service-role Postgres role. `current_user in ('service_role',
  -- 'postgres')` is a second, independent way to recognize that same
  -- genuine-service-role case, from the ROLE itself rather than a claim
  -- setting — belt-and-suspenders alongside auth.role(), not a replacement
  -- (a PostgREST-fronted service-role call still goes through auth.role();
  -- this only widens the OR for callers that bypass PostgREST entirely).
  if not (
    coalesce(auth.uid() = p_user_id, false)
    or coalesce(auth.role() = 'service_role', false)
    or current_user in ('service_role', 'postgres')
  ) then
    raise exception '% requires an end-user session matching p_user_id', p_fn_name;
  end if;
  return true;
end;
$function$;

comment on function public.require_session_or_service_role(uuid, text) is
  'ADR 0041 fix round 1 (F13), fixed round 2 (R3) — loud-fail tenancy guard usable from a language sql function body: auth.uid() = p_user_id, or a real service-role caller. Called from kg_memories_for as an UNCORRELATED scalar subquery in the WHERE clause (not a cross join with an unreferenced column) so it executes as a Postgres InitPlan — once, unconditionally, regardless of how many (or how few) kg_claims rows the rest of the query touches. See kg_memories_for''s own comment for why this is a scalar function, not a returns-table one.';

-- =============================================================================
-- Object 3 — kg_memories_for (the single aggregation) + kg_memories (owner view)
-- =============================================================================

create or replace function public.kg_memories_for(
  p_user_id uuid,
  p_include_inferred boolean default false,
  p_kind text default null,
  p_person text default null,
  p_project text default null,
  p_q text default null,
  p_group_by text default null,
  p_grounding text default null,
  p_lane text default 'all',
  -- Fix round 2 (R12, MINOR, perf) — every turn-zero bridge request
  -- (object 9) used to pay the FULL corpus aggregation just to attach four
  -- scalars to <=60 fetched claim ids (measured 446ms/440ms warm, adv
  -- round2 finding 12). When set, narrows `graded` to only the claims whose
  -- OWN memory_key is in this set, BEFORE the person/project-label tagging,
  -- jsonb-per-instance building, and array_agg grouping steps — object 9
  -- computes the target memory_keys for its own <=60 ids first, then passes
  -- them here so the aggregation only ever touches the instances that share
  -- one of those keys (still the memory's FULL instance set, D7's own
  -- contract — not just the 60 requested ids). Null (every other caller)
  -- means "no filter", byte-identical to pre-R12 behavior.
  p_memory_keys text[] default null
)
returns table (
  user_id uuid,
  memory_key text,
  memory_key_version int,
  kind text,
  subject_key text,
  target_key text,
  entity_key text,
  relation_class text,
  block_discriminator text,
  about_key text,
  former boolean,
  event_status text,
  id uuid,
  claim_key text,
  name text,
  text text,
  receipt jsonb,
  receipt_status text,
  reject_reason text,
  said_at timestamptz,
  created_at timestamptz,
  person text,
  project text,
  corrected boolean,
  sensitive boolean,
  grounding text,
  group_label text,
  accepted boolean,
  has_corrected_instance boolean,
  instance_count int,
  conversation_count int,
  grounded_instance_count int,
  grounded_conversation_count int,
  inferred_instance_count int,
  lanes jsonb,
  chat_instance_count int,
  code_instance_count int,
  projects jsonb,
  first_seen timestamptz,
  last_seen timestamptz,
  latest_text text,
  memory_confidence double precision,
  strongest_receipt jsonb,
  instances jsonb,
  instances_truncated boolean,
  -- Fix round 2 (R1, BLOCKER): D5 amended in writing (docs/adr/0041) — a
  -- memory's `sensitive` (bool_or over ALL instances) stays as-is above, for
  -- the browser UI. These three additionally expose the memory's
  -- NON-SENSITIVE FACE: objects 7/8/10 (MCP + the context card) serve THESE,
  -- not `strongest_receipt`/`latest_text`/`said_at` above, because a memory
  -- with even one sensitive instance out of many (e.g. Kabir: 2 of 53) used
  -- to be dropped from get_context_for/who_is_this_user ENTIRELY — a
  -- regression vs. the pre-070 instance-grain RPCs, and worse than the thing
  -- #107's sensitivity gate is meant to prevent (adv round2 finding 1).
  has_nonsensitive_instance boolean,
  strongest_receipt_nonsensitive jsonb,
  latest_text_nonsensitive text,
  said_at_nonsensitive timestamptz
)
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $$
  -- Fix round 1 (F13), fixed round 2 (R3, BLOCKER): the only session-group
  -- object with no loud-fail of its own — one non-RLS join away from a
  -- cross-tenant read, and RLS is the only thing that was stopping it.
  -- Round 1's `cross join guard` never referenced `guard.ok` anywhere (SELECT
  -- or WHERE), so the planner pruned the entire join — the guard never ran
  -- (adv round2 finding 3). `guard` is now referenced as an UNCORRELATED
  -- scalar subquery directly in `graded`'s WHERE clause: since it does not
  -- depend on any column of `kg_claims`/`kg_claim_lifecycle`/`conversations`,
  -- Postgres hoists it into an InitPlan — evaluated exactly once,
  -- unconditionally, BEFORE the rest of the query runs, regardless of
  -- whether `kg_claims` has zero or many matching rows for this tenant. A
  -- plain `cross join` (even referenced) would still risk a nested-loop plan
  -- that never probes the guard side when the driving relation returns zero
  -- rows; an uncorrelated WHERE subquery does not have that failure mode.
  -- Object 9 (kg_memory_keys_for_claims) calls this AS service_role with an
  -- explicit p_user_id — verified this bypass still lets that call through
  -- (§5 re-verification, fix-round-2 report).
  with guard as (
    select public.require_session_or_service_role(p_user_id, 'kg_memories_for') as ok
  ),
  graded as materialized (
    select
      p_user_id as user_id,
      c.id, c.claim_key, c.kind, c.name, c.sensitive, c.created_at, c.conv_order_key, c.turn,
      c.conversation_id, c.evidence_quote, c.accepted, c.reject_reason, c.confidence,
      c.subject_key, c.target_key, c.block_discriminator, c.relation_class, c.former, c.event_status, c.about_key,
      coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
      public.claim_browse_grounding(c, l) as grounding,
      false as is_correction,
      conv.title as conversation_title,
      conv.source as conversation_source,
      conv.metadata ->> 'code_project_id' as code_project_id,
      (conv.source = 'claude-code') as is_code_lane,
      public.memory_key(c.kind, c.subject_key, c.target_key, c.relation_class, c.payload, c.claim_key) as memory_key
    from public.kg_claims c
    join public.kg_claim_lifecycle l
      on l.user_id = c.user_id and l.claim_key_version = c.claim_key_version and l.claim_key = c.claim_key
    left join public.conversations conv on conv.id = c.conversation_id and conv.user_id = p_user_id
    where c.user_id = p_user_id and c.claim_key is not null
      and (select g.ok from guard g)
      -- Fix round 2 (R12) — narrows the scan early, before tagged/filtered/
      -- inst/grouped run over every claim in the corpus. Recomputes the
      -- same memory_key() expression the SELECT list above already builds
      -- (a SELECT-list alias can't be referenced in its own WHERE) — cheap
      -- (pure string ops), and the win is downstream, not here.
      and (
        p_memory_keys is null
        or public.memory_key(c.kind, c.subject_key, c.target_key, c.relation_class, c.payload, c.claim_key) = any(p_memory_keys)
      )
  ),
  -- Fix round 2 (R12) — deliberately NOT filtered by p_memory_keys: a
  -- correction's own memory_key is a correlated-subquery coalesce (looks up
  -- the ORIGINAL claim it corrects), duplicating that predicate here would
  -- cost more than it saves given how small this population is (single-digit
  -- rows on the founder corpus today, 0 live). `graded` above (the ~1,186-row
  -- population) is where the win actually is.
  corrections as materialized (
    select
      p_user_id as user_id,
      u.correction_id as id, u.claim_key, u.kind, u.name, u.sensitive, u.created_at, u.t_asserted as conv_order_key,
      null::int as turn, null::uuid as conversation_id, u.evidence_quote, u.accepted, null::text as reject_reason,
      0.99::real as confidence,
      u.subject_key, u.target_key, u.block_discriminator, u.relation_class, u.former,
      u.payload ->> 'event_status' as event_status, u.about_key,
      coalesce(u.claim_text, u.name, u.target_key) as claim_text_best,
      'grounded'::text as grounding,
      true as is_correction,
      null::text as conversation_title, null::text as conversation_source, null::text as code_project_id,
      false as is_code_lane,
      coalesce(
        (select public.memory_key(cc.kind, cc.subject_key, cc.target_key, cc.relation_class, cc.payload, cc.claim_key)
           from public.kg_claims cc where cc.user_id = u.user_id and cc.claim_key = u.corrects limit 1),
        public.memory_key(u.kind, u.subject_key, u.target_key, u.relation_class, u.payload, u.claim_key)
      ) as memory_key
    from public.kg_user_claims u
    join public.kg_claim_lifecycle l
      on l.user_id = u.user_id and l.claim_key_version = u.claim_key_version and l.claim_key = u.claim_key
    where u.user_id = p_user_id and u.corrects is not null and u.retires is null
      and not exists (select 1 from public.kg_user_claims r where r.user_id = u.user_id and r.retires = u.correction_id)
      and public.claim_serve_eligible(
        (row('user_correction', u.claim_key_version, u.claim_key, u.user_id, u.kind, u.subject_key, u.target_key,
             u.block_discriminator, u.relation_class, u.former, u.name, u.payload ->> 'event_status', u.t_asserted,
             u.assertion_class, u.accepted, u.sensitive, u.claim_text, null::text[], u.correction_id, null::text,
             null::uuid, u.evidence_quote, null::int, null::int))::public.serve_candidates,
        l
      )
  ),
  combined as materialized (
    select * from graded
    union all
    select * from corrections
  ),
  -- D6.3 rule 3: the person-label CTE is built (and, when p_person is set,
  -- narrowed to that one label) ONLY when a caller actually needs it.
  person_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false) pl
    where (p_person is not null or p_group_by = 'person')
      and (p_person is null or pl.canonical_label = p_person)
  ),
  -- Fix round 1 (F3): gated exactly like the person CTE above, NOT
  -- unconditional as originally documented (D6.3 rule 3 amended in the ADR
  -- — see the addendum in docs/adr/0041). The unconditional version paid a
  -- full 17-label regex join over every row on EVERY kg_memories_browse
  -- call regardless of p_project/p_group_by, which was measured as the
  -- entire cause of perf gate (b)'s failure (1.643x -> 1.268x once gated,
  -- fix-round-1 report §B). Cost: a memory's `projects[]` chip loses a
  -- text-derived (non-code-lane) project label when neither p_project nor
  -- p_group_by='project' is set — measured at <=14 founder claims total.
  project_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true) pl
    where (p_project is not null or p_group_by = 'project')
      and (p_project is null or pl.canonical_label = p_project)
  ),
  tagged as materialized (
    select
      g.*,
      case when p_group_by = 'person' then (
        select pl.canonical_label from person_labels pl
         where lower(btrim(coalesce(g.name, ''))) = lower(pl.raw_label)
            or g.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
         order by pl.canonical_label limit 1
      ) end as person_group_label,
      coalesce(
        (
          select pl.canonical_label from project_labels pl
           where lower(btrim(coalesce(g.name, ''))) = lower(pl.raw_label)
              or g.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
           order by pl.canonical_label limit 1
        ),
        case
          when g.conversation_source = 'claude-code' and g.code_project_id is not null then (
            select public.project_alias_resolve(p_user_id, cp.display_name)
              from public.code_projects cp
             where cp.id = g.code_project_id::uuid and cp.user_id = p_user_id
          )
          else null
        end
      ) as inst_project_label
    from combined g
  ),
  filtered as materialized (
    select t.*,
      case when p_group_by = 'project' then t.inst_project_label else t.person_group_label end as group_label
    from tagged t
    where (
        (p_grounding is null and (t.grounding = 'grounded' or (p_include_inferred and t.grounding in ('inferred', 'corrected'))))
        or (p_grounding = 'grounded' and t.grounding = 'grounded')
        or (p_grounding = 'inferred' and t.grounding = 'inferred')
      )
      and (p_kind is null or t.kind = p_kind)
      and (
        p_lane = 'all'
        or (p_lane = 'chat' and not t.is_code_lane)
        or (p_lane = 'code' and t.is_code_lane)
      )
      and (
        p_person is null
        or exists (
          select 1 from person_labels pl
           where pl.canonical_label = p_person
             and (lower(btrim(coalesce(t.name, ''))) = lower(pl.raw_label)
                  or t.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label))
        )
      )
      and (
        -- Fix round 1 (F15): mirrors kg_claims_browse's p_project predicate
        -- (migration 068 D4) exactly — an `exists` over ALL matching project
        -- labels, PLUS the code-lane fallback (a code-lane claim's own
        -- code_project_id, alias-resolved), not just `t.inst_project_label`
        -- (the single BEST label, picked by `order by canonical_label limit
        -- 1` — 070's own display-only computation). Latent on today's corpus
        -- (0 claims match >=2 project labels, 0 code-lane claims shadowed —
        -- fix-round-1 report), but this is the same class of bug 068 fixed
        -- for kg_claims_browse: a claim whose ONLY project match is via the
        -- code_project_id join could never satisfy p_project by text alone.
        p_project is null
        or exists (
          select 1 from project_labels pl
           where pl.canonical_label = p_project
             and (
               lower(btrim(coalesce(t.name, ''))) = lower(pl.raw_label)
               or t.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
             )
        )
        or (
          t.conversation_source = 'claude-code'
          and t.code_project_id is not null
          and exists (
            select 1
              from public.code_projects cp
             where cp.id::text = t.code_project_id
               and cp.user_id = p_user_id
               and public.project_alias_resolve(p_user_id, cp.display_name) = p_project
          )
        )
      )
      and (
        p_q is null or btrim(p_q) = ''
        or (
          case when nullif(plainto_tsquery('simple', coalesce(p_q, ''))::text, '') is not null
            then to_tsvector('simple', coalesce(t.claim_text_best, '')) @@ plainto_tsquery('simple', coalesce(p_q, ''))
            else coalesce(t.claim_text_best, '') ilike '%' || p_q || '%'
          end
        )
      )
  ),
  inst as materialized (
    select
      f.*,
      coalesce(f.conv_order_key, f.created_at) as said_at_key,
      (f.evidence_quote is not null and not f.is_correction
        and (f.reject_reason is null or f.reject_reason in ('gate:G4', 'gate:G5', 'gate:G6', 'gate:G7', 'gate:G8', 'gate:G9'))
      ) as eligible_receipt,
      jsonb_build_object(
        'id', f.id, 'claim_key', f.claim_key, 'kind', f.kind, 'subject_key', f.subject_key,
        'target_key', f.target_key, 'about_key', f.about_key, 'relation_class', f.relation_class,
        'block_discriminator', f.block_discriminator, 'former', f.former, 'event_status', f.event_status,
        'name', f.name, 'text', f.claim_text_best, 'grounding', f.grounding,
        'said_at', coalesce(f.conv_order_key, f.created_at), 'created_at', f.created_at,
        'corrected', f.is_correction, 'sensitive', f.sensitive, 'confidence', f.confidence,
        'person', case when f.kind = 'person' then f.name else null end,
        'project', case when f.kind = 'project' then f.name else null end,
        'lane', case when f.conversation_id is null then null when f.is_code_lane then 'code' else 'chat' end,
        'receipt', case
          when not f.is_correction
           and (f.reject_reason is null or f.reject_reason in ('gate:G4', 'gate:G5', 'gate:G6', 'gate:G7', 'gate:G8', 'gate:G9'))
           and (f.evidence_quote is not null or f.turn is not null)
          then jsonb_build_object(
            'quote', f.evidence_quote, 'conversation_id', f.conversation_id,
            'conversation_title', f.conversation_title, 'source', f.conversation_source, 'message_turn', f.turn
          )
          else null
        end,
        'receipt_status', case
          when f.is_correction then 'none'
          when f.accepted or f.reject_reason is null then 'grounded'
          when f.evidence_quote is not null and f.reject_reason in ('gate:G4', 'gate:G5', 'gate:G6', 'gate:G7', 'gate:G8', 'gate:G9')
            then 'verified_quote_gated'
          else 'none'
        end,
        'reject_reason', case when f.is_correction then null else f.reject_reason end
      ) as inst_json
    from filtered f
  ),
  grouped as materialized (
    select
      f.user_id,
      f.memory_key,
      count(*)::int as instance_count,
      count(distinct f.conversation_id)::int as conversation_count,
      count(*) filter (where f.grounding = 'grounded')::int as grounded_instance_count,
      count(distinct f.conversation_id) filter (where f.grounding = 'grounded')::int as grounded_conversation_count,
      count(*) filter (where f.grounding = 'inferred')::int as inferred_instance_count,
      bool_or(f.is_correction or f.grounding = 'corrected') as has_corrected_instance,
      bool_or(f.sensitive) as sensitive,
      -- Fix round 2 (R1, BLOCKER) — see the has_nonsensitive_instance column
      -- comment on kg_memories_for's `returns table` above.
      bool_or(not coalesce(f.sensitive, false)) as has_nonsensitive_instance,
      bool_or(f.accepted) as accepted,
      case
        when bool_or(f.grounding = 'grounded' or f.is_correction) then 'grounded'
        when bool_or(f.grounding = 'inferred') then 'inferred'
        else 'corrected'
      end as mem_grounding,
      coalesce(
        jsonb_agg(distinct (case when f.conversation_id is not null and f.is_code_lane then 'code'
                                  when f.conversation_id is not null and not f.is_code_lane then 'chat' end))
          filter (where f.conversation_id is not null),
        '[]'::jsonb
      ) as lanes,
      count(*) filter (where f.conversation_id is not null and not f.is_code_lane)::int as chat_instance_count,
      count(*) filter (where f.conversation_id is not null and f.is_code_lane)::int as code_instance_count,
      coalesce(jsonb_agg(distinct f.inst_project_label) filter (where f.inst_project_label is not null), '[]'::jsonb) as projects,
      min(f.said_at_key) as first_seen,
      max(f.said_at_key) as last_seen,
      -- Fix round 1 (F5a): a correction is not a receipt (D2/OQ4) — it must
      -- not inflate memory_confidence on its own. Corrections no longer
      -- contribute to max_instance_confidence UNLESS the memory has no
      -- non-correction instance at all (a dangling correction with nothing
      -- to correct), in which case its own confidence is the only basis
      -- there is. Previously every correction unconditionally contributed
      -- 0.99, so a single correction could make memory_confidence jump to
      -- 0.99 and outrank every other memory in D7.1/mcp_memories_context/
      -- mcp_memories_identity regardless of how corroborated it actually was
      -- (measured: 0.9705 -> 0.9900 on one synthetic correction, fix-round-1
      -- report).
      coalesce(
        max(f.confidence) filter (where not f.is_correction),
        max(f.confidence) filter (where f.is_correction)
      ) as max_instance_confidence,
      (array_agg(f.group_label order by f.group_label) filter (where f.group_label is not null))[1] as group_label,
      (
        array_agg(f.inst_json order by
          (f.grounding = 'grounded') desc, f.accepted desc, f.confidence desc nulls last,
          f.said_at_key desc nulls last, f.id
        ) filter (where f.eligible_receipt)
      )[1] as receipt_pick,
      coalesce(
        (
          array_agg(f.inst_json order by f.said_at_key desc nulls last, f.is_correction desc, f.id)
            filter (where f.grounding = 'grounded' or f.is_correction)
        )[1],
        (array_agg(f.inst_json order by f.said_at_key desc nulls last, f.is_correction desc, f.id))[1]
      ) as latest_pick,
      -- Fix round 2 (R1, BLOCKER) — the same two picks, but the `filter`
      -- ALSO excludes any instance flagged sensitive: the memory's
      -- non-sensitive face, for objects 7/8/10 only (session-group objects
      -- 4/5/6 keep reading receipt_pick/latest_pick above, unchanged).
      (
        array_agg(f.inst_json order by
          (f.grounding = 'grounded') desc, f.accepted desc, f.confidence desc nulls last,
          f.said_at_key desc nulls last, f.id
        ) filter (where f.eligible_receipt and not coalesce(f.sensitive, false))
      )[1] as receipt_pick_nonsensitive,
      coalesce(
        (
          array_agg(f.inst_json order by f.said_at_key desc nulls last, f.is_correction desc, f.id)
            filter (where (f.grounding = 'grounded' or f.is_correction) and not coalesce(f.sensitive, false))
        )[1],
        (
          array_agg(f.inst_json order by f.said_at_key desc nulls last, f.is_correction desc, f.id)
            filter (where not coalesce(f.sensitive, false))
        )[1]
      ) as latest_pick_nonsensitive,
      array_agg(f.inst_json order by
        (not f.eligible_receipt), (f.grounding = 'grounded') desc, f.accepted desc, f.confidence desc nulls last,
        f.said_at_key desc nulls last, f.id
      ) as instances_all
    from inst f
    group by f.user_id, f.memory_key
  )
  select
    g.user_id,
    g.memory_key,
    1 as memory_key_version,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'kind') as kind,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'subject_key') as subject_key,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'target_key') as target_key,
    coalesce(coalesce(g.receipt_pick, g.latest_pick) ->> 'name', coalesce(g.receipt_pick, g.latest_pick) ->> 'target_key') as entity_key,
    (g.latest_pick ->> 'relation_class') as relation_class,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'block_discriminator') as block_discriminator,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'about_key') as about_key,
    (g.latest_pick ->> 'former')::boolean as former,
    (g.latest_pick ->> 'event_status') as event_status,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'id')::uuid as id,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'claim_key') as claim_key,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'name') as name,
    (g.latest_pick ->> 'text') as text,
    (g.receipt_pick -> 'receipt') as receipt,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'receipt_status') as receipt_status,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'reject_reason') as reject_reason,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'said_at')::timestamptz as said_at,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'created_at')::timestamptz as created_at,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'person') as person,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'project') as project,
    (coalesce(g.receipt_pick, g.latest_pick) ->> 'corrected')::boolean as corrected,
    g.sensitive,
    g.mem_grounding as grounding,
    g.group_label,
    g.accepted,
    g.has_corrected_instance,
    g.instance_count,
    g.conversation_count,
    g.grounded_instance_count,
    g.grounded_conversation_count,
    g.inferred_instance_count,
    g.lanes,
    g.chat_instance_count,
    g.code_instance_count,
    g.projects,
    g.first_seen,
    g.last_seen,
    (g.latest_pick ->> 'text') as latest_text,
    least(
      0.99::double precision,
      0.99::double precision - (0.99::double precision - g.max_instance_confidence::double precision)
        / (1 + ln(1 + greatest(g.grounded_conversation_count - 1, 0)))
    ) as memory_confidence,
    (g.receipt_pick -> 'receipt') as strongest_receipt,
    coalesce((select jsonb_agg(x) from unnest(g.instances_all[1:5]) x), '[]'::jsonb) as instances,
    (coalesce(array_length(g.instances_all, 1), 0) > 5) as instances_truncated,
    -- Fix round 2 (R1, BLOCKER)
    g.has_nonsensitive_instance,
    (g.receipt_pick_nonsensitive -> 'receipt') as strongest_receipt_nonsensitive,
    (g.latest_pick_nonsensitive ->> 'text') as latest_text_nonsensitive,
    (coalesce(g.receipt_pick_nonsensitive, g.latest_pick_nonsensitive) ->> 'said_at')::timestamptz as said_at_nonsensitive
  from grouped g
  order by g.memory_key
$$;

comment on function public.kg_memories_for(uuid, boolean, text, text, text, text, text, text, text, text[]) is
  'ADR 0041 D2-D6.4 — one row per (user_id, memory_key), D6.2 universe, single materialized-CTE pass (D6.3). Fix round 1 (F13), fixed round 2 (R3): gains its own loud-fail auth.uid()=p_user_id guard (service-role bypass via auth.role()=''service_role'', same pattern as project_alias_seed 063/064) via require_session_or_service_role() referenced as an uncorrelated scalar subquery (InitPlan) in graded''s WHERE clause — no longer relying on RLS alone, and no longer a cross join whose result column went unreferenced (round 1''s version never actually ran, adv round2 finding 3). Deliberately stays `language sql` (not plpgsql) — see require_session_or_service_role''s own comment for the backend crash a plpgsql RETURNS TABLE version of this guard caused. Fix round 2 (R12): gains trailing p_memory_keys text[] default null — object 9''s own perf fix, narrows `graded` early when set; every other caller passes null (no behavior change).';

create or replace view public.kg_memories
with (security_invoker = true)
as
select * from public.kg_memories_for(public.require_auth_uid());

comment on view public.kg_memories is
  'ADR 0041 D6 object 3 — owner view; require_auth_uid() makes the user_id unspoofable (raises for a service-role/unauthenticated caller).';

-- =============================================================================
-- Object 4 — kg_memory_instances_page (instance expansion beyond the inline 5)
-- =============================================================================

create or replace function public.kg_memory_instances_page(
  p_user_id uuid,
  p_memory_key text,
  p_limit integer default 25,
  p_offset integer default 0,
  -- Fix round 1 (F11): the same instance-level filter params kg_memories_for
  -- takes, so "Load more" pages the SAME filtered universe the top-5 inline
  -- preview was drawn from, instead of the unfiltered memory_key set at an
  -- offset computed against the filtered one (which duplicated/leaked rows
  -- whenever any filter was active — fix-round-1 report finding 11).
  p_include_inferred boolean default false,
  p_person text default null,
  p_project text default null,
  p_q text default null,
  p_lane text default 'all',
  p_grounding text default null
)
returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'kg_memory_instances_page requires an end-user session matching p_user_id';
  end if;
  -- Fix round 2 (R9, MINOR) — copied from objects 5/6's own whitelist
  -- (F17/R8): this function is granted directly to `authenticated`
  -- (reachable via PostgREST regardless of the memories route's own
  -- whitelist), and used to silently return `{"instances": [], "total_count":
  -- 0}` for an unknown p_lane, an unknown p_grounding, or p_grounding in
  -- ('corrected','dropped') — which objects 5/6 raise on (adv round2 finding
  -- 9).
  if p_grounding is not null and p_grounding not in ('grounded', 'inferred', 'corrected', 'dropped') then
    raise exception 'kg_memory_instances_page: unknown p_grounding %, expected one of grounded, inferred, corrected, dropped', p_grounding;
  end if;
  if p_lane is null or p_lane not in ('all', 'chat', 'code') then
    raise exception 'kg_memory_instances_page: unknown p_lane %, expected one of all, chat, code', p_lane;
  end if;
  if p_grounding in ('corrected', 'dropped') then
    raise exception 'kg_memory_instances_page: p_grounding % is instances-mode only (use kg_claims_browse)', p_grounding;
  end if;

  with graded as materialized (
    select
      c.id, c.claim_key, c.kind, c.name, c.sensitive, c.created_at, c.conv_order_key, c.accepted, c.reject_reason,
      c.evidence_quote, c.confidence, c.turn, c.conversation_id,
      coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
      public.claim_browse_grounding(c, l) as grounding,
      false as is_correction,
      conv.title as conversation_title, conv.source as conversation_source,
      conv.metadata ->> 'code_project_id' as code_project_id,
      (conv.source = 'claude-code') as is_code_lane,
      public.memory_key(c.kind, c.subject_key, c.target_key, c.relation_class, c.payload, c.claim_key) as memory_key
    from public.kg_claims c
    join public.kg_claim_lifecycle l
      on l.user_id = c.user_id and l.claim_key_version = c.claim_key_version and l.claim_key = c.claim_key
    left join public.conversations conv on conv.id = c.conversation_id and conv.user_id = p_user_id
    where c.user_id = p_user_id and c.claim_key is not null
  ),
  corrections as materialized (
    select
      u.correction_id as id, u.claim_key, u.kind, u.name, u.sensitive, u.created_at, u.t_asserted as conv_order_key,
      u.accepted, null::text as reject_reason, u.evidence_quote, 0.99::real as confidence, null::int as turn,
      null::uuid as conversation_id,
      coalesce(u.claim_text, u.name, u.target_key) as claim_text_best,
      'grounded'::text as grounding,
      true as is_correction,
      null::text as conversation_title, null::text as conversation_source,
      null::text as code_project_id, false as is_code_lane,
      coalesce(
        (select public.memory_key(cc.kind, cc.subject_key, cc.target_key, cc.relation_class, cc.payload, cc.claim_key)
           from public.kg_claims cc where cc.user_id = u.user_id and cc.claim_key = u.corrects limit 1),
        public.memory_key(u.kind, u.subject_key, u.target_key, u.relation_class, u.payload, u.claim_key)
      ) as memory_key
    from public.kg_user_claims u
    join public.kg_claim_lifecycle l
      on l.user_id = u.user_id and l.claim_key_version = u.claim_key_version and l.claim_key = u.claim_key
    where u.user_id = p_user_id and u.corrects is not null and u.retires is null
      and not exists (select 1 from public.kg_user_claims r where r.user_id = u.user_id and r.retires = u.correction_id)
      and public.claim_serve_eligible(
        (row('user_correction', u.claim_key_version, u.claim_key, u.user_id, u.kind, u.subject_key, u.target_key,
             u.block_discriminator, u.relation_class, u.former, u.name, u.payload ->> 'event_status', u.t_asserted,
             u.assertion_class, u.accepted, u.sensitive, u.claim_text, null::text[], u.correction_id, null::text,
             null::uuid, u.evidence_quote, null::int, null::int))::public.serve_candidates,
        l
      )
  ),
  combined as materialized (
    select * from graded
    union all
    select * from corrections
  ),
  -- Same gating as kg_memories_for's own person_labels/project_labels (F3):
  -- only built when the corresponding filter is actually active.
  person_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false) pl
    where p_person is not null and pl.canonical_label = p_person
  ),
  project_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true) pl
    where p_project is not null and pl.canonical_label = p_project
  ),
  filtered as (
    select * from combined c
    where c.memory_key = p_memory_key
      -- Same three-branch grounding predicate as kg_memories_for's own
      -- `filtered` CTE (070) — p_grounding is expected to be null/'grounded'/
      -- 'inferred' here (corrected/dropped force the whole page into
      -- instances mode server-side, D6b, so a consolidated card's "Load
      -- more" never reaches this function with one of those two values).
      and (
        (p_grounding is null and (c.grounding = 'grounded' or (p_include_inferred and c.grounding in ('inferred', 'corrected'))))
        or (p_grounding = 'grounded' and c.grounding = 'grounded')
        or (p_grounding = 'inferred' and c.grounding = 'inferred')
      )
      and (
        p_lane = 'all'
        or (p_lane = 'chat' and not c.is_code_lane)
        or (p_lane = 'code' and c.is_code_lane)
      )
      and (
        p_person is null
        or exists (
          select 1 from person_labels pl
           where pl.canonical_label = p_person
             and (lower(btrim(coalesce(c.name, ''))) = lower(pl.raw_label)
                  or c.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label))
        )
      )
      and (
        p_project is null
        or exists (
          select 1 from project_labels pl
           where pl.canonical_label = p_project
             and (lower(btrim(coalesce(c.name, ''))) = lower(pl.raw_label)
                  or c.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label))
        )
        or (
          c.is_code_lane
          and c.code_project_id is not null
          and exists (
            select 1
              from public.code_projects cp
             where cp.id::text = c.code_project_id
               and cp.user_id = p_user_id
               and public.project_alias_resolve(p_user_id, cp.display_name) = p_project
          )
        )
      )
      and (
        p_q is null or btrim(p_q) = ''
        or (
          case when nullif(plainto_tsquery('simple', coalesce(p_q, ''))::text, '') is not null
            then to_tsvector('simple', coalesce(c.claim_text_best, '')) @@ plainto_tsquery('simple', coalesce(p_q, ''))
            else coalesce(c.claim_text_best, '') ilike '%' || p_q || '%'
          end
        )
      )
  ),
  eligible_tagged as (
    select f.*,
      coalesce(f.conv_order_key, f.created_at) as said_at_key,
      (f.evidence_quote is not null and not f.is_correction
        and (f.reject_reason is null or f.reject_reason in ('gate:G4', 'gate:G5', 'gate:G6', 'gate:G7', 'gate:G8', 'gate:G9'))
      ) as eligible_receipt
    from filtered f
  ),
  counted as (
    select *, count(*) over () as total_count from eligible_tagged
  ),
  ordered as (
    select * from counted
    order by
      (not eligible_receipt), (grounding = 'grounded') desc, accepted desc, confidence desc nulls last,
      said_at_key desc nulls last, id
    limit least(greatest(coalesce(p_limit, 25), 1), 200)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'instances', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', o.id, 'claim_key', o.claim_key, 'text', o.claim_text_best, 'grounding', o.grounding,
          'said_at', o.said_at_key,
          'receipt', case when not o.is_correction
                           and (o.reject_reason is null or o.reject_reason in ('gate:G4', 'gate:G5', 'gate:G6', 'gate:G7', 'gate:G8', 'gate:G9'))
                           and (o.evidence_quote is not null or o.turn is not null)
                      then jsonb_build_object('quote', o.evidence_quote, 'conversation_id', o.conversation_id,
                           'conversation_title', o.conversation_title, 'source', o.conversation_source, 'message_turn', o.turn)
                      else null end,
          'receipt_status', case when o.is_correction then 'none'
                                  when o.accepted or o.reject_reason is null then 'grounded'
                                  when o.evidence_quote is not null and o.reject_reason in ('gate:G4', 'gate:G5', 'gate:G6', 'gate:G7', 'gate:G8', 'gate:G9') then 'verified_quote_gated'
                                  else 'none' end,
          'reject_reason', case when o.is_correction then null else o.reject_reason end,
          'corrected', o.is_correction, 'sensitive', o.sensitive, 'created_at', o.created_at,
          'person', case when o.kind = 'person' then o.name else null end,
          'project', case when o.kind = 'project' then o.name else null end,
          'lane', case when o.conversation_id is null then null when o.conversation_source = 'claude-code' then 'code' else 'chat' end,
          'confidence', o.confidence
        )
        order by (not o.eligible_receipt), (o.grounding = 'grounded') desc, o.accepted desc, o.confidence desc nulls last,
                  o.said_at_key desc nulls last, o.id
      ),
      '[]'::jsonb
    ),
    -- Fix round 1 (F16): read from `counted` (computed BEFORE the
    -- limit/offset), not `ordered` (the post-LIMIT/OFFSET page) — paging
    -- past the end of the result used to return total_count=0 instead of
    -- the true total, breaking the client's "Load N more" arithmetic.
    'total_count', coalesce((select max(total_count) from counted), 0)
  )
  into v_result
  from ordered o;

  return v_result;
end;
$function$;

comment on function public.kg_memory_instances_page(uuid, text, integer, integer, boolean, text, text, text, text, text) is
  'ADR 0041 D6 object 4 — instance expansion beyond the top-5 inlined by kg_memories_for, same ordering (strongest-receipt-first, then said_at desc, id). Fix round 1 (F11): widened to take the same instance-level filters as kg_memories_for (p_include_inferred/p_person/p_project/p_q/p_lane/p_grounding) so "Load more" pages the same filtered universe the inline top-5 came from; F16: total_count now read from the pre-LIMIT `counted` CTE, not the post-LIMIT `ordered` one. Fix round 2 (R9, MINOR): same p_grounding/p_lane whitelist + corrected/dropped raise as objects 5/6, copied in (was silently returning an empty page for a bad value).';

-- =============================================================================
-- Object 5 — kg_memories_browse
-- =============================================================================

create or replace function public.kg_memories_browse(
  p_user_id uuid,
  p_include_inferred boolean default false,
  p_kind text default null,
  p_person text default null,
  p_project text default null,
  p_q text default null,
  p_limit integer default 100,
  p_order text default 'recent',
  p_group_by text default null,
  p_grounding text default null,
  p_offset integer default 0,
  p_lane text default 'all'
)
returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'kg_memories_browse requires an end-user session matching p_user_id';
  end if;
  -- Fix round 1 (F17): an unrecognized p_grounding/p_lane used to silently
  -- return 0 rows (fell through every OR-branch in kg_memories_for's
  -- `filtered` CTE) rather than raise — a client typo read as an empty
  -- memory browser with no error. Whitelisted here, same loud-fail style as
  -- the pre-existing corrected/dropped raise below.
  if p_grounding is not null and p_grounding not in ('grounded', 'inferred', 'corrected', 'dropped') then
    raise exception 'kg_memories_browse: unknown p_grounding %, expected one of grounded, inferred, corrected, dropped', p_grounding;
  end if;
  -- Fix round 2 (R8, MINOR): was `p_lane not in (...)`, which is NULL (not
  -- true) for an explicit p_lane => null, so the check silently never fired
  -- and kg_memories_for's own `filtered` CTE fell through every OR-branch
  -- (0 rows, no raise) — the exact failure mode F17 was written to close
  -- (adv round2 finding 8). Unreachable from TS today (both call sites use
  -- `opts.lane ?? "all"`), so this is defense-in-depth against a future
  -- direct-RPC caller (this function is granted to `authenticated`).
  if p_lane is null or p_lane not in ('all', 'chat', 'code') then
    raise exception 'kg_memories_browse: unknown p_lane %, expected one of all, chat, code', p_lane;
  end if;
  if p_grounding in ('corrected', 'dropped') then
    raise exception 'kg_memories_browse: p_grounding % is instances-mode only (use kg_claims_browse)', p_grounding;
  end if;

  with base as (
    select * from public.kg_memories_for(p_user_id, p_include_inferred, p_kind, p_person, p_project, p_q, p_group_by, p_grounding, p_lane)
  ),
  counted as (
    select b.*, count(*) over () as total_count from base b
  ),
  ordered as (
    select * from counted
    order by
      case when p_order = 'corroborated' then conversation_count end desc nulls last,
      last_seen desc nulls last,
      memory_key
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', o.id, 'claim_key', o.claim_key, 'kind', o.kind, 'text', o.text, 'grounding', o.grounding,
        'said_at', o.said_at, 'receipt', o.receipt, 'receipt_status', o.receipt_status, 'reject_reason', o.reject_reason,
        'corrected', o.corrected, 'group_label', o.group_label, 'person', o.person, 'project', o.project,
        'created_at', o.created_at, 'sensitive', o.sensitive, 'total_count', o.total_count,
        'block_discriminator', o.block_discriminator, 'memory_key', o.memory_key, 'memory_key_version', o.memory_key_version,
        'subject_key', o.subject_key, 'target_key', o.target_key, 'entity_key', o.entity_key,
        'relation_class', o.relation_class, 'about_key', o.about_key, 'former', o.former, 'event_status', o.event_status,
        'accepted', o.accepted, 'has_corrected_instance', o.has_corrected_instance, 'instance_count', o.instance_count,
        'conversation_count', o.conversation_count, 'grounded_instance_count', o.grounded_instance_count,
        'grounded_conversation_count', o.grounded_conversation_count, 'inferred_instance_count', o.inferred_instance_count,
        'lanes', o.lanes, 'chat_instance_count', o.chat_instance_count, 'code_instance_count', o.code_instance_count,
        'projects', o.projects, 'first_seen', o.first_seen, 'last_seen', o.last_seen, 'latest_text', o.latest_text,
        'memory_confidence', o.memory_confidence, 'strongest_receipt', o.strongest_receipt,
        'instances', o.instances, 'instances_truncated', o.instances_truncated
      )
      order by
        case when p_order = 'corroborated' then o.conversation_count end desc nulls last,
        o.last_seen desc nulls last,
        o.memory_key
    ),
    '[]'::jsonb
  )
  into v_result
  from ordered o;

  return v_result;
end;
$function$;

comment on function public.kg_memories_browse(uuid, boolean, text, text, text, text, integer, text, text, text, integer, text) is
  'ADR 0041 D6 object 5 — jsonb projection of kg_memories_for, memory-grain pagination/total_count (D6b), same loud-fail as kg_claims_browse. Raises on p_grounding in (corrected, dropped) — those chips are instances-mode only.';

-- =============================================================================
-- Object 6 — kg_memories_facets
-- =============================================================================

create or replace function public.kg_memories_facets(
  p_user_id uuid,
  p_include_inferred boolean default false,
  p_lane text default 'all'
)
returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'kg_memories_facets requires an end-user session matching p_user_id';
  end if;
  -- Fix round 1 (F17, extended to this object for the same reason): an
  -- unrecognized p_lane silently returned an all-zero facets response.
  -- Fix round 2 (R8, MINOR): null-safe — see kg_memories_browse's identical
  -- comment (adv round2 finding 8).
  if p_lane is null or p_lane not in ('all', 'chat', 'code') then
    raise exception 'kg_memories_facets: unknown p_lane %, expected one of all, chat, code', p_lane;
  end if;

  with graded as materialized (
    select
      c.id, c.kind, c.name, c.subject_key, c.target_key, c.block_discriminator,
      coalesce(c.claim_text, c.text, c.name, c.target_key) as claim_text_best,
      public.claim_browse_grounding(c, l) as grounding,
      false as is_correction,
      public.memory_key(c.kind, c.subject_key, c.target_key, c.relation_class, c.payload, c.claim_key) as memory_key,
      conv.source as conversation_source,
      conv.metadata ->> 'code_project_id' as code_project_id
    from public.kg_claims c
    join public.kg_claim_lifecycle l
      on l.user_id = c.user_id and l.claim_key_version = c.claim_key_version and l.claim_key = c.claim_key
    left join public.conversations conv on conv.id = c.conversation_id and conv.user_id = p_user_id
    where c.user_id = p_user_id and c.claim_key is not null
  ),
  corrections as materialized (
    select
      u.correction_id as id, u.kind, u.name, u.subject_key, u.target_key, u.block_discriminator,
      coalesce(u.claim_text, u.name, u.target_key) as claim_text_best,
      'grounded'::text as grounding,
      true as is_correction,
      coalesce(
        (select public.memory_key(cc.kind, cc.subject_key, cc.target_key, cc.relation_class, cc.payload, cc.claim_key)
           from public.kg_claims cc where cc.user_id = u.user_id and cc.claim_key = u.corrects limit 1),
        public.memory_key(u.kind, u.subject_key, u.target_key, u.relation_class, u.payload, u.claim_key)
      ) as memory_key,
      null::text as conversation_source,
      null::text as code_project_id
    from public.kg_user_claims u
    join public.kg_claim_lifecycle l
      on l.user_id = u.user_id and l.claim_key_version = u.claim_key_version and l.claim_key = u.claim_key
    where u.user_id = p_user_id and u.corrects is not null and u.retires is null
      and not exists (select 1 from public.kg_user_claims r where r.user_id = u.user_id and r.retires = u.correction_id)
      and public.claim_serve_eligible(
        (row('user_correction', u.claim_key_version, u.claim_key, u.user_id, u.kind, u.subject_key, u.target_key,
             u.block_discriminator, u.relation_class, u.former, u.name, u.payload ->> 'event_status', u.t_asserted,
             u.assertion_class, u.accepted, u.sensitive, u.claim_text, null::text[], u.correction_id, null::text,
             null::uuid, u.evidence_quote, null::int, null::int))::public.serve_candidates,
        l
      )
  ),
  combined as materialized (
    select * from graded
    union all
    select * from corrections
  ),
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
    select * from combined_laned
    where grounding = 'grounded' or (p_include_inferred and grounding in ('inferred', 'corrected'))
  ),
  person_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false)
  ),
  project_labels as (
    select * from public.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true)
  ),
  kinds as (
    select kind, count(distinct memory_key) as n from visible where kind is not null group by kind
  ),
  people as (
    select pl.canonical_label as label, count(distinct v.memory_key) as n
      from person_labels pl
      join visible v
        on lower(btrim(coalesce(v.name, ''))) = lower(pl.raw_label)
        or v.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
     group by pl.canonical_label
  ),
  projects_text as (
    select pl.canonical_label as label, v.memory_key
      from project_labels pl
      join visible v
        on lower(btrim(coalesce(v.name, ''))) = lower(pl.raw_label)
        or v.claim_text_best ~* public.claims_browse_label_regex(pl.raw_label)
  ),
  projects_code as (
    select public.project_alias_resolve(p_user_id, cp.display_name) as label, v.memory_key
      from visible v
      join public.code_projects cp
        on cp.id = v.code_project_id::uuid and cp.user_id = p_user_id
     where v.code_project_id is not null and cp.display_name is not null
  ),
  -- D6b: UNION (not UNION ALL) on (label, memory_key) before counting — this
  -- is what makes memory-grain facet parity exact for a claim that both
  -- text-matches a label AND carries a resolving code_project_id.
  projects_union as (
    select label, memory_key from projects_text
    union
    select label, memory_key from projects_code
  ),
  projects as (
    select label, count(distinct memory_key) as n
      from projects_union
     where label is not null and label <> ''
     group by label
  )
  select jsonb_build_object(
    'kinds', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'count', n) order by n desc, kind) from kinds), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'count', n) order by n desc, label) from people), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'count', n) order by n desc, label) from projects), '[]'::jsonb),
    'grounded', (select count(distinct memory_key) from combined_laned where grounding = 'grounded'),
    'inferred', (select count(distinct memory_key) from combined_laned where grounding = 'inferred'),
    -- D6b: 'corrected'/'dropped' are kg_claims_facets' OWN counts, unchanged
    -- (INSTANCE grain, not memory grain — those two chips force instances
    -- mode). Replicated directly against this function's own already-scanned
    -- graded/combined_laned CTEs rather than calling kg_claims_facets, which
    -- would pay its whole claim_browse_grounding + label-join cost a second
    -- time (measured: 2.6s vs 1.24s baseline before this fix).
    'corrected', (
      select count(*)
        from combined_laned c
       where c.grounding = 'corrected'
          or (c.is_correction and exists (
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
$function$;

comment on function public.kg_memories_facets(uuid, boolean, text) is
  'ADR 0041 D6 object 6 / D6b — memory-grain facet counts (count(distinct memory_key)); corrected/dropped delegate unchanged to kg_claims_facets (those chips are instances-mode only).';

-- =============================================================================
-- Object 7 — mcp_memories_context (service-role)
-- =============================================================================

create or replace function public.mcp_memories_context(
  p_user_id uuid,
  p_query text,
  p_limit integer default 20,
  p_include_inferred boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $function$
  with base as (
    select * from public.kg_memories_for(p_user_id, p_include_inferred, null, null, null, p_query, null, null, 'all')
  ),
  eligible as (
    -- Fix round 1 (F8): a memory with no eligible receipt (D2 — e.g. a
    -- correction-only memory, ~177/686 by design) used to reach `ranked`/
    -- `p_limit`/be counted, then get silently dropped by mapClaimRow's
    -- no-quote guard downstream — so p_limit and total_count described a
    -- population bigger than what the caller actually saw. Filtered here so
    -- both describe servable rows.
    -- Fix round 2 (R1, BLOCKER, amends D5): a memory is not dropped just
    -- because SOME of its instances are sensitive (e.g. Kabir: 2 sensitive
    -- of 53 — dropping the whole memory lost the demo's own headline person
    -- entirely, adv round2 finding 1). Eligible iff it has >= 1
    -- NON-sensitive instance with a receipt; the memory's non-sensitive face
    -- (strongest_receipt_nonsensitive/latest_text_nonsensitive) is what gets
    -- served below, never a sensitive instance's content.
    select * from base where has_nonsensitive_instance and strongest_receipt_nonsensitive is not null
  ),
  ranked as (
    select * from eligible
    order by memory_confidence desc, conversation_count desc, last_seen desc nulls last, memory_key
    -- Fix round 1 (F6): clamped upward too (D6d: "the same way kg_claims_browse
    -- does"), not just downward — an unbounded p_limit had no FTS safety
    -- valve at all.
    limit least(greatest(coalesce(p_limit, 20), 1), 500)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', r.kind, 'target_key', r.target_key, 'block_discriminator', r.block_discriminator,
        'name', r.name, 'relation_class', r.relation_class, 'former', r.former, 'event_status', r.event_status,
        'claim_text', r.latest_text_nonsensitive,
        'effective_class', case when r.grounding = 'grounded' then 'stated' else 'inferred' end,
        'claim_origin', case when r.corrected then 'user_correction' else 'extraction' end,
        -- Round 3 fix (finding 1, BLOCKER): D5 amended again — objects 7/8/10
        -- now emit a hardcoded `false` here, not bool_or(sensitive) over all
        -- instances. mapClaimRow (claims-tools.ts) drops ANY row with
        -- `sensitive === true` as defense-in-depth against a served-sensitive
        -- regression; eligibility above (has_nonsensitive_instance and
        -- strongest_receipt_nonsensitive is not null) already GUARANTEES the
        -- face actually served here (latest_text_nonsensitive /
        -- strongest_receipt_nonsensitive) is non-sensitive — so the aggregate
        -- bool_or was defeating the mapping-layer's own defense and dropping
        -- the Kabir memory a second time, downstream of the SQL fix (round 2
        -- verified only in psql, never through mapClaimRow). `sensitive:
        -- false` here is not a lie: it describes the served face, which the
        -- eligibility filter has already proven non-sensitive.
        'sensitive', false,
        -- The bool_or(all instances) fact is preserved under a new name so no
        -- information is lost — a caller that wants to know "does this
        -- memory have ANY sensitive instance at all" (distinct from "is the
        -- served face sensitive") can still ask.
        'has_sensitive_instance', r.sensitive,
        'memory_key', r.memory_key, 'memory_confidence', r.memory_confidence,
        -- Fix round 1 (F7): instance_count now emitted (was never emitted by
        -- any of objects 7/8/10 — the demo's own headline evidence,
        -- "get_context_for('Kabir') ... with its instance_count", could not
        -- be produced without it). instance_count/conversation_count are the
        -- memory's FULL counts (R1 — unchanged, not narrowed to the
        -- non-sensitive slice).
        'instance_count', r.instance_count,
        'conversation_count', r.conversation_count, 'last_seen', r.last_seen,
        -- Round 3 fix (finding 2, MAJOR, payload trim): message_id/char_start/
        -- char_end dropped from this literal — they were always hardcoded
        -- null here (this RPC has no per-instance char-offset data at memory
        -- grain, see this migration's own header comment), and
        -- claims-tools.ts's mapClaimRow already defaults an ABSENT key to
        -- null (`row.receipt?.message_id ?? null`) exactly as it did an
        -- explicit null value — so the served ServedClaim.receipt shape is
        -- byte-identical either way; only the RPC wire payload shrinks.
        'receipt', jsonb_build_object(
          'provider', r.strongest_receipt_nonsensitive ->> 'source', 'conversation_id', r.strongest_receipt_nonsensitive ->> 'conversation_id',
          'quote_verbatim', r.strongest_receipt_nonsensitive ->> 'quote', 't_asserted', r.said_at_nonsensitive
        )
      )
      order by r.memory_confidence desc, r.conversation_count desc, r.last_seen desc nulls last, r.memory_key
    ),
    '[]'::jsonb
  )
  from ranked r;
$function$;

comment on function public.mcp_memories_context(uuid, text, integer, boolean) is
  'ADR 0041 D6 object 7 — service-role, memory-grain get_context_for backing. p_limit applies to MEMORIES over the full matched instance set (not instances pre-aggregation). Fix round 1: F6 (p_limit clamped to [1,500]), F7 (instance_count emitted), F8 (strongest_receipt is not null required for eligibility, matching mapClaimRow''s own no-quote drop). Fix round 2 (R1, BLOCKER): eligibility and claim_text/receipt now read the memory''s NON-SENSITIVE face (has_nonsensitive_instance/strongest_receipt_nonsensitive/latest_text_nonsensitive/said_at_nonsensitive) — a memory with >=1 non-sensitive instance is served even if bool_or(sensitive) is true; top-level `sensitive` is emitted FALSE (the served face is non-sensitive by eligibility); has_sensitive_instance carries bool_or over ALL instances (fix round 3, finding 1). The UI objects 5/6 keep bool_or in `sensitive`.';

-- =============================================================================
-- Object 8 — mcp_memories_browse (service-role)
-- =============================================================================

create or replace function public.mcp_memories_browse(
  p_user_id uuid,
  p_limit integer default 200,
  p_offset integer default 0,
  -- Fix round 2 (R2, BLOCKER) — the context card excludes 'self'/'person'
  -- kinds (it serves those from mcp_memories_identity instead), but did so
  -- client-side, AFTER this RPC's own 200-row cap and count(*) over() had
  -- already spent the budget on rows the card discards — self+person
  -- dominate this RPC's own conversation_count-first ordering, so the card
  -- collapsed from 192 usable rows to 49 (adv round2 finding 2/6). Applied
  -- in `eligible`, BEFORE `counted`'s count(*) over() and the limit/offset,
  -- so the cap and total_count both describe the card's real population.
  p_exclude_kinds text[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $function$
  with base as (
    select * from public.kg_memories_for(p_user_id, false, null, null, null, null, null, null, 'all')
  ),
  eligible as (
    -- Fix round 1 (F8): see mcp_memories_context's identical comment above.
    -- Fix round 2 (R1, BLOCKER): see mcp_memories_context's identical
    -- non-sensitive-face comment above.
    select * from base
    where has_nonsensitive_instance
      and strongest_receipt_nonsensitive is not null
      and (p_exclude_kinds is null or kind is null or kind <> all(p_exclude_kinds))
  ),
  counted as (
    select *, count(*) over () as total_count from eligible
  ),
  ordered as (
    select * from counted
    order by conversation_count desc, memory_confidence desc, last_seen desc nulls last, memory_key
    -- Fix round 1 (F6): clamp lowered from 1000 to 500, matching D6d's
    -- stated contract (kg_claims_browse's own clamp) and claims-tools.ts's
    -- getMemoriesBrowse, which already clamped at 500 independently of what
    -- this RPC actually enforced.
    limit least(greatest(coalesce(p_limit, 200), 1), 500)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', o.kind, 'target_key', o.target_key, 'block_discriminator', o.block_discriminator,
        'name', o.name, 'relation_class', o.relation_class, 'former', o.former, 'event_status', o.event_status,
        'claim_text', o.latest_text_nonsensitive,
        'effective_class', case when o.grounding = 'grounded' then 'stated' else 'inferred' end,
        'claim_origin', case when o.corrected then 'user_correction' else 'extraction' end,
        -- Round 3 fix (finding 1, BLOCKER) — see mcp_memories_context's
        -- identical comment above.
        'sensitive', false,
        'has_sensitive_instance', o.sensitive,
        'memory_key', o.memory_key, 'memory_confidence', o.memory_confidence,
        -- Fix round 1 (F7): instance_count now emitted.
        'instance_count', o.instance_count,
        'conversation_count', o.conversation_count, 'last_seen', o.last_seen,
        -- Round 3 fix (finding 2, MAJOR, payload trim) — see
        -- mcp_memories_context's identical comment above.
        'receipt', jsonb_build_object(
          'provider', o.strongest_receipt_nonsensitive ->> 'source', 'conversation_id', o.strongest_receipt_nonsensitive ->> 'conversation_id',
          'quote_verbatim', o.strongest_receipt_nonsensitive ->> 'quote', 't_asserted', o.said_at_nonsensitive
        ),
        'total_count', o.total_count
      )
      order by o.conversation_count desc, o.memory_confidence desc, o.last_seen desc nulls last, o.memory_key
    ),
    '[]'::jsonb
  )
  from ordered o;
$function$;

comment on function public.mcp_memories_browse(uuid, integer, integer, text[]) is
  'ADR 0041 D6 object 8 — service-role, the context card''s memory-grain read. No embedded instances, counts only. Fix round 1: F6 (p_limit clamp lowered 1000 -> 500), F7 (instance_count emitted), F8 (strongest_receipt is not null required for eligibility). Fix round 2: R1 (BLOCKER, non-sensitive face), R2 (BLOCKER, p_exclude_kinds applied server-side before the 200-row cap/count(*) over() so the card''s own kind exclusion no longer collapses the servable rows by ~74%).';

-- =============================================================================
-- Object 9 — kg_memory_keys_for_claims (the one bridge-facing object, D7)
-- =============================================================================

-- Fix round 1 (F1, BLOCKER): `returns table` made this the only
-- set-returning function in this migration granted only to service_role —
-- in this Postgres build, an ACL-DENIED SRF invoked under a role that lacks
-- EXECUTE crashes the backend with SIGNAL 11 (reproduced 3x during the
-- fix-round-1 adversarial review; a plain `select * from f()`, not just a
-- plpgsql wrapper, triggers it, and PostgREST reaches it via
-- POST /rest/v1/rpc/kg_memory_keys_for_claims — any signed-in user, incl.
-- tusk-demo, could crash the whole cluster). `returns jsonb` — the same
-- shape objects 7/8/10 already use — sidesteps the crash entirely (objects
-- 7/8/10, all `returns jsonb`, fail CLEANLY with "permission denied for
-- function" under an unauthorized role) while leaving the wire shape
-- unchanged for every caller: PostgREST already serialized a `returns
-- table` result as a JSON array of rows, so route.ts's
-- `supabase.rpc("kg_memory_keys_for_claims", ...)` needs no changes.
create or replace function public.kg_memory_keys_for_claims(
  p_user_id uuid,
  p_claim_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $$
  with fetched as (
    select c.id as claim_id, c.claim_key, c.kind, c.subject_key, c.target_key, c.relation_class, c.payload
    from public.kg_claims c
    join public.kg_claim_lifecycle l
      on l.user_id = c.user_id and l.claim_key_version = c.claim_key_version and l.claim_key = c.claim_key
    where c.user_id = p_user_id and c.id = any (p_claim_ids) and c.claim_key is not null
  ),
  keyed as (
    select f.claim_id, public.memory_key(f.kind, f.subject_key, f.target_key, f.relation_class, f.payload, f.claim_key) as memory_key
    from fetched f
  ),
  mem as (
    -- Fix round 1 (F2, BLOCKER): was `kg_memories_for(p_user_id)` — every
    -- default, including `p_include_inferred => false`. D6 object 9's own
    -- contract is "aggregates computed over kg_memories_for's full D6.2
    -- universe" (the memory's full instance set, not the grounded-only
    -- slice) — measured: 281 of 896 keyed founder claims (31%) had
    -- memory_confidence/conversation_count silently NULL under the old
    -- default, which lib/bridge/context.ts's D7.1 rank reads as confidence
    -- 0, collapsing D7.1's rank to plain recency for every inferred-only
    -- memory in the turn-zero proposal.
    --
    -- Fix round 2 (R12, MINOR, perf): was `kg_memories_for(p_user_id, true)`
    -- — the WHOLE corpus (773 memories) aggregated just to attach four
    -- scalars to the <=60 requested claim ids' own memory_keys (measured
    -- 446ms/440ms warm, adv round2 finding 12, essentially the full cost of
    -- an unfiltered kg_memories_browse). `keyed`'s own memory_keys (already
    -- computed above, cheaply — one memory_key() call per fetched claim, not
    -- per corpus row) are now pushed into kg_memories_for's own
    -- p_memory_keys, so the aggregation only touches instances sharing one
    -- of those keys (still each memory's FULL instance set — D7's contract
    -- is unchanged, just no longer paid for the other ~700+ memories nobody
    -- asked about).
    select m.memory_key, m.memory_confidence, m.conversation_count, m.last_seen, m.instance_count
    from public.kg_memories_for(
      p_user_id, true, null, null, null, null, null, null, 'all',
      (select array_agg(distinct k.memory_key) from keyed k where k.memory_key is not null)
    ) m
  ),
  joined as (
    select req.claim_id, k.memory_key, mm.memory_confidence, mm.conversation_count, mm.last_seen, mm.instance_count
    from unnest(p_claim_ids) as req(claim_id)
    left join keyed k on k.claim_id = req.claim_id
    left join mem mm on mm.memory_key = k.memory_key
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'claim_id', j.claim_id, 'memory_key', j.memory_key, 'memory_confidence', j.memory_confidence,
        'conversation_count', j.conversation_count, 'last_seen', j.last_seen, 'instance_count', j.instance_count
      )
    ),
    '[]'::jsonb
  )
  from joined j
$$;

comment on function public.kg_memory_keys_for_claims(uuid, uuid[]) is
  'ADR 0041 D6 object 9 / D7 — the one bridge-facing object. Service-role shape: explicit p_user_id, tenancy by the where-predicate only, no auth.uid() guard (getBridgeServiceClient() runs with auth.uid() = NULL). A claim without a claim_key/lifecycle row returns memory_key = NULL (D7.3 — not a group, never deduped). Aggregates computed over kg_memories_for''s full D6.2 universe (p_include_inferred => true, fix round 1 F2), not the fetched subset. Fix round 1 (F1): returns jsonb, not `returns table` — see this object''s own header comment for the ACL-denied-SRF segfault this avoids; wire shape (a JSON array of rows) is unchanged for every caller. Fix round 2 (R12): pushes the fetched claims'' own memory_keys into kg_memories_for''s p_memory_keys, so the aggregation runs only over instances sharing one of those keys instead of the whole corpus — see the `mem` CTE''s own comment for the measured cost this closes.';

-- =============================================================================
-- Object 10 — mcp_memories_identity (service-role, D6c)
-- =============================================================================

create or replace function public.mcp_memories_identity(
  p_user_id uuid,
  p_include_inferred boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $function$
  with base as (
    select * from public.kg_memories_for(p_user_id, p_include_inferred, null, null, null, null, null, null, 'all')
  ),
  eligible as (
    -- Fix round 1 (F8): see mcp_memories_context's identical comment.
    -- Fix round 2 (R1, BLOCKER): see mcp_memories_context's identical
    -- non-sensitive-face comment. `mcp_memories_identity` includes Kabir
    -- again once this is applied (34 rows -> the kabir child memory present,
    -- adv round2 finding 1).
    select * from base
    where has_nonsensitive_instance
      and strongest_receipt_nonsensitive is not null
      and kind in ('self', 'person')
      and (kind <> 'self' or subject_key = 'owner')
  ),
  ranked_person as (
    select *, row_number() over (order by conversation_count desc, memory_confidence desc, last_seen desc nulls last, memory_key) as rn
    from eligible where kind = 'person'
  ),
  ranked_self as (
    select *, row_number() over (order by conversation_count desc, memory_confidence desc, last_seen desc nulls last, memory_key) as rn
    from eligible where kind = 'self'
  ),
  capped as (
    select * from ranked_person where rn <= 40
    union all
    select * from ranked_self where rn <= 10
  ),
  final as (
    select * from capped
    order by (kind <> 'self'), kind, conversation_count desc, memory_confidence desc, last_seen desc nulls last, memory_key
    limit 100
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', f.kind, 'target_key', f.target_key, 'block_discriminator', f.block_discriminator,
        'name', f.name, 'relation_class', f.relation_class, 'former', f.former, 'event_status', f.event_status,
        'claim_text', f.latest_text_nonsensitive,
        'effective_class', case when f.grounding = 'grounded' then 'stated' else 'inferred' end,
        'claim_origin', case when f.corrected then 'user_correction' else 'extraction' end,
        -- Round 3 fix (finding 1, BLOCKER) — see mcp_memories_context's
        -- identical comment above. This is the object whose regression the
        -- round-3 review demonstrated end-to-end (getMemoriesIdentity's
        -- Kabir row dropped by mapClaimRow); it is the one that most needed
        -- the fix.
        'sensitive', false,
        'has_sensitive_instance', f.sensitive,
        'memory_key', f.memory_key, 'memory_confidence', f.memory_confidence,
        -- Fix round 1 (F7): instance_count now emitted.
        'instance_count', f.instance_count,
        'conversation_count', f.conversation_count, 'last_seen', f.last_seen,
        -- Round 3 fix (finding 2, MAJOR, payload trim) — see
        -- mcp_memories_context's identical comment above.
        'receipt', jsonb_build_object(
          'provider', f.strongest_receipt_nonsensitive ->> 'source', 'conversation_id', f.strongest_receipt_nonsensitive ->> 'conversation_id',
          'quote_verbatim', f.strongest_receipt_nonsensitive ->> 'quote', 't_asserted', f.said_at_nonsensitive
        )
      )
      order by (f.kind <> 'self'), f.kind, f.conversation_count desc, f.memory_confidence desc, f.last_seen desc nulls last, f.memory_key
    ),
    '[]'::jsonb
  )
  from final f;
$function$;

comment on function public.mcp_memories_identity(uuid, boolean) is
  'ADR 0041 D6 object 10 / D6c — service-role, parallel to mcp_claims_identity (untouched). Per-kind quotas: person 40, self 10, overall cap 100; self additionally filtered to subject_key=owner (OQ2). Fix round 1: F7 (instance_count emitted), F8 (strongest_receipt is not null required for eligibility). Fix round 2 (R1, BLOCKER): eligibility/claim_text/receipt read the memory''s non-sensitive face — see mcp_memories_context''s identical comment.';

-- =============================================================================
-- GRANTs — two shapes (D6 GRANT row)
-- =============================================================================

-- Fix round 1 (F4): `revoke ... from public` does NOT remove an EXPLICIT
-- grant Supabase's `ALTER DEFAULT PRIVILEGES` makes to `anon` on every new
-- `public` function/view — measured live after applying 070 unfixed:
-- kg_memories_for/kg_memories_browse/kg_memories_facets/kg_memory_instances_page
-- all still carried `anon=X/postgres`; memory_key/memory_norm (which had NO
-- revoke/grant statements at all) still carried the PUBLIC default; the
-- views kg_memories/kg_memory_instances carried `anon=arwdDxtm` (SELECT AND
-- INSERT/UPDATE/DELETE). No live data leak either way (every object's own
-- loud-fail/RLS still holds under anon), but D6's own GRANT row is explicit
-- that these must be revoked from public/anon — every revoke below now
-- names `anon` explicitly, and the two helper functions get their own
-- explicit revoke+grant (they had none before: memory_key/memory_norm are
-- called from the body of every SECURITY INVOKER session/service-role
-- object above, so authenticated/service_role need direct EXECUTE on them
-- too, not just on the objects that call them).
revoke all on function public.memory_norm(text) from public, anon;
grant execute on function public.memory_norm(text) to authenticated, service_role;

revoke all on function public.memory_key(text, text, text, text, jsonb, text) from public, anon;
grant execute on function public.memory_key(text, text, text, text, jsonb, text) to authenticated, service_role;

-- Fix round 1 (F13): kg_memories_for's guard helper — same reasoning as
-- memory_key/memory_norm above (called from a SECURITY INVOKER body, so the
-- calling role needs direct EXECUTE too).
revoke all on function public.require_session_or_service_role(uuid, text) from public, anon;
grant execute on function public.require_session_or_service_role(uuid, text) to authenticated, service_role;

-- Session objects (2, 3's view, 4, 5, 6): authenticated, loud-fail tenancy.
revoke all on function public.kg_memories_for(uuid, boolean, text, text, text, text, text, text, text, text[]) from public, anon;
grant execute on function public.kg_memories_for(uuid, boolean, text, text, text, text, text, text, text, text[]) to authenticated, service_role;

-- Fix round 2 (R11, MINOR): F4 removed `anon`'s ACL on these views but left
-- Supabase's default `authenticated=arwdDxtm` (SELECT AND INSERT/UPDATE/
-- DELETE) in place underneath the `grant select` — a no-op on top of an
-- existing ALL grant (adv round2 finding 11). No real exposure either way
-- (neither view is auto-updatable — an SRF/CTE+UNION view — so a write
-- already raises), but D6's own GRANT row is explicit that these should be
-- SELECT-only for `authenticated`.
revoke all on public.kg_memory_instances from public, anon, authenticated;
grant select on public.kg_memory_instances to authenticated;

revoke all on public.kg_memories from public, anon, authenticated;
grant select on public.kg_memories to authenticated;

revoke all on function public.kg_memory_instances_page(uuid, text, integer, integer, boolean, text, text, text, text, text) from public, anon;
grant execute on function public.kg_memory_instances_page(uuid, text, integer, integer, boolean, text, text, text, text, text) to authenticated;

revoke all on function public.kg_memories_browse(uuid, boolean, text, text, text, text, integer, text, text, text, integer, text) from public, anon;
grant execute on function public.kg_memories_browse(uuid, boolean, text, text, text, text, integer, text, text, text, integer, text) to authenticated;

revoke all on function public.kg_memories_facets(uuid, boolean, text) from public, anon;
grant execute on function public.kg_memories_facets(uuid, boolean, text) to authenticated;

-- Service-role objects (7, 8, 9, 10): no auth.uid() guard, tenancy by the where-predicate only.
revoke all on function public.mcp_memories_context(uuid, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.mcp_memories_context(uuid, text, integer, boolean) to service_role;

revoke all on function public.mcp_memories_browse(uuid, integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.mcp_memories_browse(uuid, integer, integer, text[]) to service_role;

-- F1: kept service_role-only (returns jsonb now, not returns table — see
-- object 9's own header comment for why).
revoke all on function public.kg_memory_keys_for_claims(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.kg_memory_keys_for_claims(uuid, uuid[]) to service_role;

revoke all on function public.mcp_memories_identity(uuid, boolean) from public, anon, authenticated;
grant execute on function public.mcp_memories_identity(uuid, boolean) to service_role;

notify pgrst, 'reload schema';
