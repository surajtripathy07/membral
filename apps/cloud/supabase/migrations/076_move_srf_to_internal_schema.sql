-- ============================================================
-- 076_move_srf_to_internal_schema.sql
-- Issue #115, final leg: kg_memories_for and claims_browse_entity_labels
-- are the two functions migration 075 deferred (its own header names them
-- and explains why: both are `returns table` set-returning functions
-- consumed internally, as `select * from public.<fn>(...)`, by OTHER
-- security-invoker functions that read named table columns off the result
-- -- a return-type change to `returns jsonb` (074/075's fix for every other
-- ACL-denied SRF) would break every one of those call sites, independent of
-- any grant).
--
-- A live test on the demo stack proved granting `anon` EXECUTE does NOT fix
-- the underlying crash class either: calling an ACL-denied `returns table`
-- SRF under a role that lacks EXECUTE segfaults the Postgres backend the
-- instant it starts reading the RLS-gated body -- a Postgres bug, not an ACL
-- gap. Granting anon just trades "segfault on denial" for "the function
-- actually executes under anon", which is worse, not better, for a
-- session-bound function whose only real guard is `auth.uid() = p_user_id`
-- (anon's auth.uid() is always NULL, so the guard raises cleanly today --
-- but a raise is not the same contract as "this route does not exist").
--
-- FIX: PostgREST only exposes RPC routes for functions in the schemas listed
-- in apps/cloud/supabase/config.toml's `api.schemas` (confirmed: `public`,
-- `graphql_public` only). Moving both functions to a new `internal` schema
-- removes the PostgREST route entirely -- POST /rest/v1/rpc/kg_memories_for
-- and POST /rest/v1/rpc/claims_browse_entity_labels 404 (no route), not
-- segfault and not execute -- while every SQL caller keeps working via an
-- explicit `internal.<fn>(...)` call, since Postgres schema-qualified calls
-- are untouched by what PostgREST exposes.
--
-- This is a pure relocation + reference-repoint: return types, bodies'
-- logic, and every caller's own ORDER BY/LIMIT/predicate are BYTE-IDENTICAL
-- to each function's authoritative (LAST create-or-replace, across every
-- migration) definition. Verified by grepping every migration for
-- `kg_memories_for(` and `claims_browse_entity_labels(` and confirming no
-- migration after each caller's own listed source redefines it.
--
-- LIVE CALL GRAPH (verified against every migration up to 075; caller ->
-- callee, with the caller's own live-definition migration):
--
--   kg_memories_for (live def: 070_kg_memories.sql:303) is called by:
--     - kg_memories                 (view,  070_kg_memories.sql:787)
--     - kg_memories_browse          (fn,    070_kg_memories.sql:1073)
--     - mcp_memories_context        (fn,    070_kg_memories.sql:1310)
--     - mcp_memories_browse         (fn,    070_kg_memories.sql:1420)
--     - kg_memory_keys_for_claims   (fn,    070_kg_memories.sql:1540)
--     - mcp_memories_identity       (fn,    070_kg_memories.sql:1581)
--   All six are `language sql|plpgsql`, SECURITY INVOKER (the Postgres
--   default -- no `security definer` keyword anywhere in this family), all
--   defined in migration 070 itself, none redefined by any later migration
--   (confirmed: 071/072/074/075 do not touch any of them).
--
--   claims_browse_entity_labels (live def: 069_people_facet_owner_org_
--   exclusion.sql:234, superseding 055/060/063/064/066 -- confirmed no
--   migration after 069 redefines it) is called by:
--     - kg_claims_browse    (fn, live def 068_code_lane_project_filter.sql:56,
--       SECURITY INVOKER, EXECUTE granted to `authenticated` only -- real
--       end-user sessions invoke this directly, so its grants are
--       load-bearing, not just theoretical PostgREST exposure)
--     - kg_claims_facets    (fn, live def 061_claims_lane.sql:427, SECURITY
--       INVOKER, EXECUTE granted to `authenticated` only)
--     - kg_memories_for itself   (070_kg_memories.sql:486, 500)
--     - kg_memory_instances_page (fn, 070_kg_memories.sql:796, calls it at
--       894, 898)
--     - kg_memories_facets       (fn, 070_kg_memories.sql:1126, calls it at
--       1213, 1216)
--   All SECURITY INVOKER, none redefined after their listed migration.
--
-- 12 call sites total (6 for kg_memories_for, 6 for claims_browse_entity_
-- labels — 2 of those 6 are kg_memories_for's own internal person/project
-- label lookups) across 9 distinct caller objects (the kg_memories view +
-- 8 functions). grep -rn 'kg_memories_for(' / 'claims_browse_entity_labels('
-- across apps/cloud/src turns up zero `.rpc(...)` call sites -- every
-- reference there is a code comment; nothing in the app calls either
-- function directly, so no serving-code change is needed.
--
-- MIGRATION STRUCTURE (order matters):
--   1. create schema internal; grant USAGE to authenticated + service_role
--      only (no anon, no public) -- see the authenticated-USAGE reasoning
--      below.
--   2. Create internal.kg_memories_for and internal.claims_browse_entity_
--      labels with their live bodies copied VERBATIM (language/stability/
--      security invoker/search_path attributes unchanged) from their
--      authoritative migrations above. The ONLY text changed inside either
--      body: kg_memories_for's own two internal calls to
--      `public.claims_browse_entity_labels(` become
--      `internal.claims_browse_entity_labels(` (it now calls its sibling in
--      the same new schema). Every other reference inside both bodies
--      (public.kg_claims, public.kg_claim_lifecycle, public.conversations,
--      public.kg_user_claims, public.code_projects, public.project_aliases,
--      public.claim_browse_grounding, public.claim_serve_eligible,
--      public.memory_key, public.require_session_or_service_role,
--      public.claims_browse_label_regex, public.project_alias_resolve,
--      public.kg__normalize_label, public.profiles, public.serve_candidates)
--      was ALREADY explicitly `public.`-qualified in the live source -- none
--      of that needed changing, and `set search_path = public, pg_temp` is
--      preserved unchanged on both so those bare-schema-qualified refs keep
--      resolving exactly as before.
--   3. Grant EXECUTE on both internal functions -- see the authenticated
--      reasoning below -- then REVOKE EXECUTE FROM PUBLIC explicitly (no
--      anon grant, ever).
--   4. Repoint every live caller with `create or replace` (same name, same
--      schema `public`, same signature -- privileges are preserved
--      automatically across a same-signature CREATE OR REPLACE, so none of
--      the callers' own ACLs needed re-granting): the `kg_memories` VIEW
--      first (it depends on public.kg_memories_for and must be repointed
--      BEFORE that function is dropped, or the drop fails), then all 8
--      caller functions. Only the exact call-site substring
--      `public.kg_memories_for(` -> `internal.kg_memories_for(` or
--      `public.claims_browse_entity_labels(` -> `internal.claims_browse_
--      entity_labels(` changes in each; every other line, including every
--      comment, is byte-identical to the caller's own live source.
--   5. Only THEN drop `public.kg_memories_for(uuid, boolean, text, text,
--      text, text, text, text, text, text[])` and `public.claims_browse_
--      entity_labels(uuid, text, boolean, boolean)` -- by this point nothing
--      in `public` still references either, so both drops succeed with no
--      CASCADE needed.
--
-- AUTHENTICATED-USAGE-ON-INTERNAL DECISION: every one of the 9 caller
-- objects is SECURITY INVOKER (never SECURITY DEFINER) -- a Postgres
-- SECURITY INVOKER function's body executes AS the role that invoked it.
-- Supabase/PostgREST does not open a distinct per-end-user Postgres role;
-- every authenticated request executes as the single Postgres role
-- `authenticated` (RLS/auth.uid() do the actual per-user scoping via the
-- JWT claim, not the executing role identity). So:
--   - kg_memories (view) and kg_memories_browse are granted EXECUTE to
--     `authenticated` (070) and are the REAL end-user path (the Memory
--     browser). When a signed-in user's session calls
--     `select * from kg_memories` or `kg_memories_browse(...)`, the
--     resulting call into (now) `internal.kg_memories_for` executes AS
--     `authenticated` -- which therefore needs USAGE on schema `internal`
--     and EXECUTE on `internal.kg_memories_for`.
--   - kg_memories_for's OWN body calls claims_browse_entity_labels, so that
--     same `authenticated`-role execution continues one level deeper into
--     `internal.claims_browse_entity_labels` -- `authenticated` needs
--     EXECUTE on that one too.
--   - kg_memory_instances_page, kg_memories_facets (070), kg_claims_browse
--     (068), kg_claims_facets (061) are ALSO granted EXECUTE to
--     `authenticated` only (no service_role grant on any of these four) and
--     call claims_browse_entity_labels directly -- same requirement.
--   - mcp_memories_context, mcp_memories_browse, kg_memory_keys_for_claims,
--     mcp_memories_identity are service-role-only (070's own "Service-role
--     objects" grant block: revoked from public/anon/authenticated, granted
--     to service_role only) and call kg_memories_for -- so `service_role`
--     needs the same USAGE + EXECUTE pair on both internal functions, for
--     the identical SECURITY INVOKER reason.
-- Net: BOTH `authenticated` and `service_role` need USAGE on schema
-- `internal` and EXECUTE on both internal functions -- neither role can be
-- dropped without breaking a real, live caller. `anon` needs, and gets,
-- nothing: no live caller anon can reach (directly or transitively) ever
-- calls into either function -- every session-bound caller loud-fails on
-- `auth.uid() is null` before it would, and PostgREST no longer even exposes
-- a route into `internal` for anon to hit directly.
-- ============================================================

create schema if not exists internal;

comment on schema internal is
  'Issue #115: functions that must never be reachable via PostgREST (POST /rest/v1/rpc/<fn>) -- apps/cloud/supabase/config.toml exposes only public + graphql_public, so a function defined here has no PostgREST route at all. Callers reach it only via an explicit schema-qualified SQL call from another function. See migration 076''s own header for why (`returns table` SRFs segfault the backend when called by a role lacking EXECUTE, independent of the role''s ACL state -- a Postgres bug, not fixable by granting anon).';

revoke all on schema internal from public;
grant usage on schema internal to authenticated, service_role;

-- =============================================================================
-- internal.claims_browse_entity_labels -- verbatim body from
-- 069_people_facet_owner_org_exclusion.sql:234-456 (the live, authoritative
-- definition). No internal cross-reference to repoint -- every reference
-- inside this body was already public.-qualified and stays that way.
-- =============================================================================

create or replace function internal.claims_browse_entity_labels(
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
  -- 069 (D8, #111): the owner's own structured aliases -- same sources
  -- resolveOwnerAliases (lib/kg/owner-aliases.ts) uses at write time, read
  -- directly here since this SQL function has no access to that TS module.
  -- Only consulted when p_kind = 'person' (below). F4: when
  -- profiles.display_name is NULL, owner_display_name/owner_first_token are
  -- both empty and contribute nothing -- only a live kg_user_claims
  -- self-name correction (source 3) can still exclude anything for that
  -- user; a user with neither excludes nothing (no-op, not an error).
  -- R2-3: every comparison below goes through public.kg__normalize_label
  -- (migration 026) -- documented byte-compatible with lib/kg/resolve.ts's
  -- normalizeLabel (NFKD, diacritic-strip, lowercase, non-alnum runs
  -- collapsed to one space, trim); IMMUTABLE, no extension needed.
  -- Structured-label normalization, not semantic regex over free text.
  owner_display_name as (
    select p.display_name
      from public.profiles p
     where p.id = p_user_id
       and p.display_name is not null
       and btrim(p.display_name) <> ''
  ),
  owner_first_token as (
    select split_part(public.kg__normalize_label(display_name), ' ', 1) as token
      from owner_display_name
     where split_part(public.kg__normalize_label(display_name), ' ', 1) <> ''
  ),
  -- R2-1: the owner's OWN unconditional aliases (full display_name, bare
  -- token), computed here so the collision test below can exclude them --
  -- "collision" must mean a DIFFERENT person shares the token, never the
  -- owner's own name recurring under a now-visible claim.
  owner_aliases_unconditional as (
    select public.kg__normalize_label(display_name) as alias
      from owner_display_name
    union
    select t.token as alias
      from owner_first_token t
  ),
  -- F1/R2-1/R2-2/R2-3, FINAL FORM (round 3, scratchpad W1b_adv_round3.md,
  -- "V2"): true when a claim is BOTH (i) currently VISIBLE under the exact
  -- same `claim_key is not null` + grounding predicate `named` uses (R2-2),
  -- and (ii) its FULL normalized name equals the owner's bare first token
  -- (R2-3: via kg__normalize_label) AND is NOT itself one of the owner's own
  -- unconditional aliases (R2-1: full display_name or that same bare
  -- token). (i)+(ii)'s second half are STRUCTURALLY MUTUALLY EXCLUSIVE: a
  -- claim whose full name equals the bare token IS, by construction, one of
  -- `owner_aliases_unconditional` (which contains that exact token) -- so
  -- this guard can never actually fire, by design, not by omission. Kept
  -- anyway (round 3 finding 1, corrected here): a kind='person' claim whose
  -- ONLY recorded name is byte-equal to the owner's bare first token is
  -- ALWAYS treated as the owner and DROPPED from the facet -- that IS
  -- #111's fix working as intended (this schema has no structural way to
  -- tell "the owner referred to by first name" apart from "a different
  -- person who happens to share that exact bare name", and #111 asks to
  -- suppress the former, so the latter is an accepted, documented
  -- trade-off, not a bug). A DIFFERENT, LONGER name that merely shares that
  -- first token (e.g. a two-word name starting with it) is never a
  -- candidate for the owner-alias exclusion at all -- exclusion (069(a)
  -- below) is FULL-STRING equality only, never prefix/token matching -- so
  -- it always keeps showing as its own separate facet label regardless of
  -- this guard, with no protection mechanism required. Earlier revisions
  -- (F1/R2-1/R2-2) used a first-TOKEN match here instead of full-name
  -- equality, which could fire on such a longer name and, combined with an
  -- explicit `reject_reason is null` conjunct, made the result depend on
  -- today's gate-rejection state (#98 is open to change it). V2 removes
  -- both the false "protects a longer name" appearance and that gate-state
  -- dependency: verified live (rolled back) behaviour-identical to the
  -- prior revision on today's corpus (44 People rows, owner absent, md5 of
  -- the facet JSON unchanged) while no longer depending on which claims
  -- happen to be gate-rejected today.
  owner_first_token_collision as (
    select exists (
      select 1
        from public.kg_claims c
        join public.kg_claim_lifecycle l2
          on l2.user_id = c.user_id
         and l2.claim_key_version = c.claim_key_version
         and l2.claim_key = c.claim_key
        cross join owner_first_token t
       where c.user_id = p_user_id
         and c.claim_key is not null
         and c.kind = 'person'
         and c.name is not null
         and (
           public.claim_browse_grounding(c, l2) = 'grounded'
           or (p_include_inferred and public.claim_browse_grounding(c, l2) in ('inferred', 'corrected'))
         )
         and public.kg__normalize_label(c.name) = t.token
         and public.kg__normalize_label(c.name) not in (select alias from owner_aliases_unconditional)
    ) as collided
  ),
  owner_aliases as (
    select public.kg__normalize_label(display_name) as alias
      from owner_display_name
    union
    select t.token as alias
      from owner_first_token t
     where not exists (select 1 from owner_first_token_collision where collided)
    union
    -- F3: same supersession check as kg_claims_browse's own corrections CTE
    -- (migration 068) -- a self-name correction later retired by another
    -- correction row must not still act as a live owner alias.
    select public.kg__normalize_label(u.payload->>'value') as alias
      from public.kg_user_claims u
     where u.user_id = p_user_id
       and u.kind = 'self'
       and u.subject_key = 'owner'
       and u.accepted = true
       and u.retires is null
       and u.payload->>'attribute' = 'name'
       and u.payload->>'value' is not null
       and btrim(u.payload->>'value') <> ''
       and not exists (
         select 1 from public.kg_user_claims r
          where r.user_id = u.user_id and r.retires = u.correction_id
       )
  ),
  labels as (
    select candidate as raw_label
      from named
     where candidate is not null and candidate <> ''
       -- 069(a): drop a raw person label that IS, exactly (R2-3:
       -- kg__normalize_label-equal), one of the owner's own structured
       -- aliases.
       and (
         p_kind <> 'person'
         or public.kg__normalize_label(candidate) not in (select alias from owner_aliases)
       )
       -- 069(b): drop a raw person label that the extractor ALSO
       -- independently tagged as kind='project' for this user, AND that
       -- project claim is itself currently visible (F2: same
       -- claim_key-is-not-null + grounding predicate `named` above uses --
       -- a rejected/dropped/ungrounded/retired project extraction must not
       -- silently suppress a real person label).
       and (
         p_kind <> 'person'
         or not exists (
           select 1
             from public.kg_claims cp
             join public.kg_claim_lifecycle l2
               on l2.user_id = cp.user_id
              and l2.claim_key_version = cp.claim_key_version
              and l2.claim_key = cp.claim_key
            where cp.user_id = p_user_id
              and cp.claim_key is not null
              and cp.kind = 'project'
              and cp.name is not null
              and lower(btrim(cp.name)) = lower(btrim(candidate))
              and (
                public.claim_browse_grounding(cp, l2) = 'grounded'
                or (p_include_inferred and public.claim_browse_grounding(cp, l2) in ('inferred', 'corrected'))
              )
         )
       )
  ),
  -- 055/060/063/064: the ORIGINAL prefix-collapse, unchanged -- runs over
  -- the RAW label pool (now pre-filtered by 069 above), before any alias
  -- resolution.
  prefix_collapsed as (
    select
      l.raw_label,
      (
        select m.raw_label
          from labels m
         where left(lower(l.raw_label), length(m.raw_label)) = lower(m.raw_label)
         order by length(m.raw_label), m.raw_label
         limit 1
      ) as prefix_canonical
    from labels l
  )
  -- migration 066 (RESIDUAL-1), unchanged: "does this label have its own
  -- alias row" is decided by ROW EXISTENCE in project_aliases, not by
  -- nullif-ing the resolved value against raw_label. 'person' is a
  -- pass-through (canonical_label = prefix_canonical), byte-identical to
  -- 055/060/063/064/066 except that the input pool is now 069-filtered.
  select
    pc.raw_label,
    case
      when p_kind = 'project' then
        case
          when exists (
            select 1 from public.project_aliases pa
             where pa.user_id = p_user_id and pa.alias = pc.raw_label
          )
            then public.project_alias_resolve(p_user_id, pc.raw_label)
          else public.project_alias_resolve(p_user_id, pc.prefix_canonical)
        end
      else pc.prefix_canonical
    end as canonical_label
  from prefix_collapsed pc
$$;

comment on function internal.claims_browse_entity_labels(uuid, text, boolean, boolean) is
  'Issue #115, migration 076: relocated from public.claims_browse_entity_labels (055, extended 060/063/064/066/069) into schema internal so PostgREST can never route to it -- same fix and reasoning as internal.kg_memories_for''s own comment. Body and every attribute are byte-identical to 069''s public.claims_browse_entity_labels (the live, authoritative definition) -- no internal cross-reference needed repointing. See 069''s own comment on public.claims_browse_entity_labels (now dropped) for the full label-curation/owner-alias-exclusion history this function implements.';

revoke all on function internal.claims_browse_entity_labels(uuid, text, boolean, boolean) from public;
grant execute on function internal.claims_browse_entity_labels(uuid, text, boolean, boolean) to authenticated, service_role;

-- =============================================================================
-- internal.kg_memories_for -- verbatim body from 070_kg_memories.sql:303-779
-- (the live, authoritative definition), except its own two internal calls to
-- claims_browse_entity_labels now target internal. instead of public..
-- =============================================================================

create or replace function internal.kg_memories_for(
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
    select * from internal.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false) pl
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
    select * from internal.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true) pl
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

comment on function internal.kg_memories_for(uuid, boolean, text, text, text, text, text, text, text, text[]) is
  'Issue #115, migration 076: relocated from public.kg_memories_for (070) into schema internal so PostgREST can never route to it (config.toml exposes only public/graphql_public) -- the fix for the ACL-denied-SRF backend segfault that a `returns jsonb` conversion could not apply here (this function is consumed as `select * from fn(...)` by other SECURITY INVOKER functions reading its named columns; see this migration''s own header). Body, return type, and every attribute (language sql, stable, security invoker, search_path) are byte-identical to 070''s public.kg_memories_for -- only its own two internal calls to claims_browse_entity_labels now read internal.claims_browse_entity_labels instead of public.claims_browse_entity_labels. See 070''s own comment on public.kg_memories_for (now dropped) for the full ADR 0041 D2-D6.4 history this function implements.';

revoke all on function internal.kg_memories_for(uuid, boolean, text, text, text, text, text, text, text, text[]) from public;
grant execute on function internal.kg_memories_for(uuid, boolean, text, text, text, text, text, text, text, text[]) to authenticated, service_role;

-- =============================================================================
-- Repoint every live caller to the internal schema, BEFORE dropping the
-- public originals. The `kg_memories` view depends on public.kg_memories_for
-- and must be repointed first, or the drop below fails. Every function below
-- is `create or replace` with its EXACT existing signature -- privileges
-- (ACLs) are preserved automatically across a same-signature
-- CREATE OR REPLACE, so none of these need their own grant statements
-- reissued; only the call-site substring changes, everything else
-- byte-identical to each function's own live source.
-- =============================================================================

-- kg_memories (view, live def 070_kg_memories.sql:784) -- repointed first.
create or replace view public.kg_memories
with (security_invoker = true)
as
select * from internal.kg_memories_for(public.require_auth_uid());

comment on view public.kg_memories is
  'ADR 0041 D6 object 3 — owner view; require_auth_uid() makes the user_id unspoofable (raises for a service-role/unauthenticated caller).';

-- kg_memory_instances_page (fn, live def 070_kg_memories.sql:796) -- 2 call
-- sites (person_labels/project_labels CTEs) repointed.
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
    select * from internal.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false) pl
    where p_person is not null and pl.canonical_label = p_person
  ),
  project_labels as (
    select * from internal.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true) pl
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


-- kg_memories_browse (fn, live def 070_kg_memories.sql:1025) -- 1 call site
-- repointed.
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
    select * from internal.kg_memories_for(p_user_id, p_include_inferred, p_kind, p_person, p_project, p_q, p_group_by, p_grounding, p_lane)
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


-- kg_memories_facets (fn, live def 070_kg_memories.sql:1126) -- 2 call sites
-- repointed.
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
    select * from internal.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false)
  ),
  project_labels as (
    select * from internal.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true)
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

-- mcp_memories_context (fn, live def 070_kg_memories.sql:1297) -- 1 call
-- site repointed.
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
    select * from internal.kg_memories_for(p_user_id, p_include_inferred, null, null, null, p_query, null, null, 'all')
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

-- mcp_memories_browse (fn, live def 070_kg_memories.sql:1399) -- 1 call site
-- repointed.
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
    select * from internal.kg_memories_for(p_user_id, false, null, null, null, null, null, null, 'all')
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


-- kg_memory_keys_for_claims (fn, live def 070_kg_memories.sql:1496) -- 1
-- call site repointed.
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
    from internal.kg_memories_for(
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


-- mcp_memories_identity (fn, live def 070_kg_memories.sql:1570) -- 1 call
-- site repointed.
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
    select * from internal.kg_memories_for(p_user_id, p_include_inferred, null, null, null, null, null, null, 'all')
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

-- kg_claims_browse (fn, live def 068_code_lane_project_filter.sql:56) -- 2
-- call sites repointed.
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
    select * from internal.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false)
  ),
  project_labels as (
    select * from internal.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true)
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

-- kg_claims_facets (fn, live def 061_claims_lane.sql:427) -- 2 call sites
-- repointed.
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
    select * from internal.claims_browse_entity_labels(p_user_id, 'person', p_include_inferred, false)
  ),
  project_labels as (
    select * from internal.claims_browse_entity_labels(p_user_id, 'project', p_include_inferred, true)
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

-- =============================================================================
-- Drop the public originals -- LAST, after every caller above has been
-- repointed to internal. No CASCADE: the kg_memories view was already
-- repointed above, so nothing in `public` still depends on either function.
-- =============================================================================

drop function if exists public.kg_memories_for(uuid, boolean, text, text, text, text, text, text, text, text[]);
drop function if exists public.claims_browse_entity_labels(uuid, text, boolean, boolean);
