-- ============================================================
-- 069_people_facet_owner_org_exclusion.sql
-- People facet: exclude the owner and the owner's organisation.
--
-- The People facet (`kg_claims_facets(...)->'people'` and
-- `claims_browse_entity_labels(p_kind='person')`, which `kg_claims_browse`'s
-- p_person filter and the facet share) must not list the owner's own
-- name/aliases, or the owner's organisation, as if they were people.
--
-- RULE
--   - The owner's own full display name, and any live, non-superseded,
--     accepted `kg_user_claims` self-name correction (`kind='self'`,
--     `subject_key='owner'`, `payload->>'attribute'='name'`), are excluded
--     from the person label pool. Matching is exact on the normalized label
--     (`public.kg__normalize_label`), applied BEFORE the prefix-collapse, so
--     a longer or different name that merely shares the owner's first name
--     is never touched.
--   - The owner's bare first-name token is excluded only when no other
--     currently visible person claim carries the same first token. A
--     relative who shares the owner's first name must not collide with the
--     owner: the collision test uses the same visibility predicate as the
--     facet's own pool (`claim_key is not null` plus grounding via
--     `kg_claim_lifecycle`), and claims that are themselves the owner's own
--     aliases do not count as collisions.
--   - A kind='person' label is also dropped when the same string (case-
--     insensitive, trimmed) is independently visible as a kind='project'
--     claim name for the user, which catches an organisation mis-extracted
--     as a person. The lifecycle/grounding predicate matches the one the
--     person pool uses.
--   - When `profiles.display_name` is NULL the full-name and first-token
--     exclusions are no-ops; only a live self-name correction can still
--     exclude a label.
--
-- No word lists and no regex over free text: only structured sources. An
-- organisation label with no kind='project' counterpart is not caught;
-- filtering on `relation_class='unknown'` was rejected because genuine
-- under-documented acquaintances default to the same values.
--
-- SCOPE: only `claims_browse_entity_labels` changes, gated to `p_kind =
-- 'person'` (the `p_kind = 'project'` call this same function serves is
-- byte-identical to 066). `kg_claims_facets`'s `people` CTE and
-- `kg_claims_browse`'s `person_labels`/p_person filter both consume this
-- function's output already. Signature unchanged (pure CREATE OR REPLACE,
-- no DROP needed).
-- ============================================================

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
  -- dependency: behaviour-identical to the
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

comment on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) is
  'Curated, alias-resolved, case-insensitive-prefix-collapsed label set for the Memory browser''s People/Projects facets (migration 055, extended by 060, fixed by 063 finding #6, 064 NEW-2, 066 RESIDUAL-1, 069 D8/#111, adversarially reviewed rounds 1-3 -- F1-F4, R2-1..R2-3, R3-1/R3-2 fixed). 069, p_kind=''person'' only: the raw label pool is pre-filtered BEFORE prefix-collapse to drop (a) any label EXACT-STRING-equal (R2-3: via public.kg__normalize_label) to the owner''s own full display_name, its bare first-name token, or any live, non-superseded (F3), accepted kg_user_claims self-name correction -- exact full-string equality only, never a prefix/token match, so a longer/different name merely sharing the owner''s first token (e.g. a two-word name starting with it) is never touched and always keeps showing as its own facet label. A kind=''person'' claim whose ONLY recorded name is byte-equal to the owner''s bare first token is therefore always treated as the owner and dropped -- #111''s fix working as intended (this schema has no structural signal to tell that apart from "a different person who happens to share that exact bare name"; round 3 finding R3-1). (b) drops any label the extractor ALSO independently tagged as kind=''project'' for this user, where that project claim is itself currently visible (F2: same claim_key-is-not-null + grounding predicate as this function''s own person pool). F4: a NULL profiles.display_name makes the full-name/first-token exclusion sources a no-op for that user -- only a live self-name correction can still exclude anything. p_kind=''project'' behaviour is byte-identical to 066. For p_kind=''project'': whether a label has its OWN alias is decided by ROW EXISTENCE in project_aliases (066), not by whether resolving changed the string (064''s bug); a label with its own row resolves via project_alias_resolve on its raw_label; a label with no row of its own falls back to resolving the group''s shared prefix_canonical (063 finding #6, preserved).';

-- Grants unchanged from 055/060/063/064/066 (same signature -- CREATE OR
-- REPLACE keeps existing privileges; no re-grant needed).
