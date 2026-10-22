-- ============================================================
-- 069_people_facet_owner_org_exclusion.sql
-- Goal 2026-08-27 W1 (D8, #111): the People facet
-- (`kg_claims_facets(...)->'people'` and
-- `claims_browse_entity_labels(p_kind='person')`, which both `kg_claims_
-- browse`'s p_person filter and the facet share) lists the owner's own
-- name/aliases and, at least one observed case, a company name, as if they
-- were people.
--
-- DIAGNOSIS (verified live, founder-1k): the People facet's label pool
-- (`claims_browse_entity_labels`, migration 055/060/063/064/066) is every
-- DISTINCT `kg_claims.name` for `kind = 'person'`, case-insensitive-prefix-
-- collapsed. Two live rows account for the reported symptoms:
--   - An "owner alias" row: several raw kind='person' names all sharing a
--     first-name prefix (one of them is the owner's own full display name,
--     verbatim) prefix-collapse to the SHORTEST of them — which is exactly
--     the owner's bare first name — and that merged label leads the facet
--     by a wide margin (the vast majority of "person" mentions in this
--     corpus are the owner referring to themselves). The owner-alias set
--     already exists for a DIFFERENT purpose (lib/kg/owner-aliases.ts,
--     resolveOwnerAliases, used by claims.ts's G5 subject-normalization gate
--     at WRITE time) but nothing at READ time ever consulted it — the
--     browse/facet surfaces have no access to that TypeScript module, and
--     no SQL equivalent existed until this migration.
--   - An "org label" row: one real kg_claims row with kind='person', a
--     company's name as `name`, `relation_class = 'unknown'`,
--     `relation_basis = 'none'`, `relation = ''` — an extractor
--     mis-classification (pass1.ts's own prompt says organizations/
--     companies belong under kind='project', not kind='person', but nothing
--     enforces that at extraction time).
--
-- FRESH ADVERSARIAL REVIEW (round 1, scratchpad W1b_adv_round1.md): verdict
-- SHIP-WITH-FIXES. Findings F1-F4 below are all fixed in THIS revision
-- (069 was not yet applied anywhere, so this is a straight rewrite, not a
-- follow-up migration):
--
--  F1 [MED] — the first draft excluded the owner's bare first-name token
--     unconditionally, on the (FALSE, now corrected) claim that an exact-
--     string match "can never touch a same-first-name-but-otherwise-distinct
--     label". Live counter-example: the ONLY kg_claims row whose name equals
--     the owner's bare first token is `kind='person'`,
--     `relation_class='family_other'`, `subject_key='owner'` — the
--     extractor recorded a RELATIVE referred to by first name only, not the
--     owner. Fixed: the full `display_name` is still excluded
--     UNCONDITIONALLY (an exact match to the owner's own full name is never
--     ambiguous), but the bare first-name token is now gated behind the
--     SAME collision check `resolveOwnerAliases` (lib/kg/owner-aliases.ts,
--     `firstNameCollides`) already applies at write time: if ANY
--     `kind='person'` claim with `reject_reason is null` (not the
--     grounded/inferred filter `named` below uses — this mirrors
--     `firstNameCollides`'s own query exactly) carries that same first
--     token, the bare-token alias is skipped entirely, corpus-wide, same
--     fail-closed direction as the TS module. On this corpus that collision
--     IS live (several other kind='person' rows share the owner's first
--     token), so the bare-token alias is NOT added here — the family_other
--     relative's row survives, and so, as a side effect, does the wider
--     prefix-collapsed group anchored on that bare token (see the evidence
--     file for the honest resulting numbers). The full-name exclusion alone
--     still fires.
--  F2 [MED] — the kind='project' corroboration subquery (069(b) below)
--     checked no lifecycle/grounding predicate at all, unlike `named`'s own
--     pool (`claim_key is not null` + `claim_browse_grounding(...)`
--     grounded/inferred). A rejected/dropped/retired/ungrounded project
--     extraction could have silently dropped a real person label from the
--     facet. Fixed: the corroboration subquery now joins
--     `kg_claim_lifecycle` and applies the exact same
--     `claim_key is not null` + grounding predicate `named` uses.
--  F3 [LOW-MED] — the self-name correction liveness check
--     (`kg_user_claims`, `kind='self'`, `subject_key='owner'`) used
--     `accepted and retires is null` only, unlike `kg_claims_browse`'s own
--     corrections CTE (migration 068), which additionally requires the
--     correction not be superseded by a LATER retirement row
--     (`not exists (select 1 from kg_user_claims r where r.retires =
--     u.correction_id)`). Fixed: the same supersession check is now applied
--     here, so a later-retired self-name correction no longer acts as a
--     live owner alias.
--  F4 [LOW] — undocumented precondition: when `profiles.display_name` is
--     NULL (tusk-demo's actual live state, verified), the owner-alias
--     exclusion is a no-op for the full-name and first-token sources — ONLY
--     a live `kg_user_claims` self-name correction (source 3) can still
--     exclude anything for that user. Documented here and in the function
--     comment; tusk-demo's People facet has no owner-alias pollution today
--     regardless (verified: 2 clean rows), so this is a documentation fix,
--     not a behaviour change.
--
--  Also noted, NOT fixed here (both correctly out of this migration's
--  scope per the review itself):
--   - The org-label row is NOT excluded (069(b) finds no kind='project'
--     corroboration for it in this corpus) — see the header note below,
--     unchanged from the first draft's own honest disclosure.
--   - 3 new low-count residual rows surface from the prefix-collapse side
--     effect of removing the full-name candidate (a possessive relation
--     phrase among them) — flagged as a possible structural follow-up
--     (drop raw labels of the shape "<alias>'s ..."), not implemented here.
--
-- FIX, STRUCTURAL ONLY (no word list, no regex over free text, per this
-- task's explicit instruction and ADR 0023 Q1a's brittleness rule):
--
--  (a) OWNER ALIASES — excluded via the SAME STRUCTURED SOURCES
--      `resolveOwnerAliases` (lib/kg/owner-aliases.ts) uses, read directly
--      in SQL instead of through that TS module: `profiles.display_name`
--      (full string, unconditional) and its first whitespace token, plus
--      any live, non-superseded, accepted `kg_user_claims` self-name
--      correction (`kind='self'`, `subject_key='owner'`,
--      `payload->>'attribute'='name'`). Matched by `public.kg__normalize_
--      label` equality (R2-3) against the raw candidate label, BEFORE the
--      existing prefix-collapse runs — EXACT FULL-STRING equality only,
--      never a prefix/token match, so a longer/different name that merely
--      shares the owner's first token (e.g. a two-word name starting with
--      it) is never touched by this exclusion. The bare first-name token
--      carries a collision guard (see the collision CTE's own comment,
--      round 3 "V2") that is, by construction, provably unable to ever
--      fire — kept for documentation, not because it changes behaviour.
--
--  (b) ORG LABELS — the ONLY structural (non-word-list) signal available
--      given the current schema: cross-kind corroboration, now
--      lifecycle/grounding-matched to `named`'s own pool (F2). A candidate
--      kind='person' label is dropped when the SAME string (case-
--      insensitive/trimmed) was ALSO independently extracted, and is
--      currently VISIBLE (grounded, or inferred when p_include_inferred), as
--      a kind='project' claim's `name` for this user.
--
--      HONEST RESIDUAL, reported per this task's instruction: this does
--      NOT catch the one live "org label" row above — that company name was
--      never independently extracted as kind='project' anywhere in this
--      corpus (verified: 0 matching rows), so no structural signal
--      distinguishes it from a genuine, relation-unstated acquaintance.
--      `relation_class='unknown'`/`relation_basis='none'` was considered and
--      REJECTED as a signal: PersonClaimSchema's own documented behaviour
--      (claims.ts) is that a claim whose relation was simply never stated
--      in that turn ALSO defaults to `relation_class='unknown'`,
--      `relation_basis` degrading to `'none'` on anything not resolvable to
--      "stated"/"inferred" — real, legitimately under-documented
--      acquaintances would be excluded right alongside this one row.
--      Filtering on that combination is not a structural org signal, it is
--      a proxy that happens to correlate on this one row; not applied.
--      Reliably distinguishing this case needs either a schema-level entity-
--      kind field on the extractor's Person schema (an extraction-time
--      change, out of this migration's scope) or a maintainer call to accept
--      a word-list/LLM-classification exception to ADR 0023 Q1a — flagged,
--      not decided here.
--
-- FRESH ADVERSARIAL REVIEW (round 2, scratchpad W1b_adv_round2.md): verdict
-- 068 SOLID/ship (untouched here). 069 one MED before apply, two LOW, all
-- fixed in THIS revision:
--
--  R2-1 [MED] — the collision population counted the OWNER'S OWN person
--     claims. Reproduced live (rolled back): accepting the ONE kg_claims row
--     whose name IS the owner's own full display name flips
--     `owner_first_token_collision` to true, which SKIPS the bare-token
--     alias and puts the owner's own name straight back in the facet at its
--     original ~283-claim count — reintroducing #111's exact symptom the
--     moment any owner-named person claim clears its gate (which #98 is open
--     to make happen). `firstNameCollides`'s own doc says a collision means
--     "some KNOWN PERSON... carries firstToken" — a DIFFERENT person, not
--     the owner's own name recurring. Fixed: `owner_first_token_collision`
--     now excludes any candidate row whose (normalized) name is itself one
--     of the owner's own unconditional aliases (full display_name or the
--     bare token) from counting as a collision — a collision now requires a
--     claim that is NOT already known to be the owner.
--  R2-2 [LOW-MED] — the collision test's visibility predicate
--     (`reject_reason is null`) diverged from the pool it protects (`named`'s
--     `claim_key is not null` + grounding). Reproduced live (rolled back):
--     accepting a DIFFERENT-person row sharing the owner's first token still
--     flipped `collided` to true even when that row can never appear in the
--     facet itself (not grounded) — the guard fired to protect a label the
--     facet cannot show anyway. Fixed: the collision test now joins
--     `kg_claim_lifecycle` and applies the EXACT SAME `claim_key is not
--     null` + grounding predicate `named` uses, so "collision" means "a
--     different, currently-VISIBLE person shares this token" — the read-time
--     question this guard actually needs to answer, a deliberate (and now
--     documented) divergence from `firstNameCollides`'s write-time
--     accepted-only test, which answers a different question (reattribution
--     risk at extraction time).
--  R2-3 [LOW] — the header's "mirrors firstNameCollides's own query exactly"
--     overstated it: normalization diverged from `normalizeLabel`
--     (lib/kg/resolve.ts) — `lower(split_part(btrim(name),' ',1))` treats an
--     apostrophe as part of a token ("Kabir's" first-tokens to "kabir's",
--     not "kabir"), so a punctuation/diacritic difference between the
--     extractor's spelling and `profiles.display_name` could silently miss
--     a real collision or a real alias match. Fixed: every owner-alias /
--     collision comparison now goes through `public.kg__normalize_label`
--     (migration 026) — the SAME SQL function `normalizeLabel` (lib/kg/
--     resolve.ts) is explicitly documented as byte-compatible with (NFKD,
--     diacritic-strip, lowercase, non-alnum runs collapsed to one space,
--     trim). This is IMMUTABLE, no extension dependency, and is structured-
--     label normalization (case/punctuation/diacritic canonicalization of an
--     already-identified name field), not semantic regex over free text —
--     consistent with ADR 0023 Q1a. Header claims below corrected to say
--     "normalizes via kg__normalize_label" rather than "exactly mirrors".
--
-- FRESH ADVERSARIAL REVIEW (round 3, scratchpad W1b_adv_round3.md): verdict
-- SOLID to ship, no blocking finding. Round 2's revision (above) kept
-- `reject_reason is null` as an EXTRA conjunct alongside the visibility
-- predicate, disclosed as a deliberate deviation from R2-2's literal text —
-- round 3 measured that variant against two others on the live corpus and
-- found a strictly better one ("V2"), adopted here, which REMOVES that
-- deviation entirely:
--  R3-1 [LOW-MED, header accuracy] — the round-2 header claimed the guard
--     means "a different real, visible, non-gated person referred to by
--     that same first name is never silently dropped from the facet." False
--     for the one case that matters: a person whose ONLY recorded name is
--     byte-equal to the owner's bare first token is EXCLUDED from the
--     collision-detection population BY R2-1's own fix (it always equals an
--     owner alias), so the guard can never fire to protect exactly that
--     row — proved live (rolled back): accepting that exact row still
--     yields 44 rows / owner absent, that row's own label dropped, guard
--     did not fire. Corrected below (see the collision CTE's own comment):
--     that case is DROPPED BY DESIGN — indistinguishable from the owner
--     without a structural signal this schema doesn't have, and #111 asks
--     for exactly that suppression — not a bug.
--  R3-2 [LOW, simplification, adopted] — "V2": drop `reject_reason is null`
--     entirely and narrow the first-TOKEN match to FULL-NAME equality
--     (`kg__normalize_label(c.name) = t.token`, replacing
--     `split_part(kg__normalize_label(c.name), ' ', 1) = t.token`).
--     Verified live (rolled back) behaviour-identical to round 2's shipped
--     revision on today's corpus (44 People rows, owner absent, facet JSON
--     md5 unchanged; the R2-1 accepted-owner-claim reproduction still keeps
--     the owner excluded). Structurally removes the gate-rejection
--     dependency #98 would otherwise eventually flip (see the collision
--     CTE's own comment for why the narrowed match makes the guard
--     provably inert rather than merely inert-today), so `reject_reason is
--     null` is no longer needed as a compensating conjunct.
--
-- SCOPE: only `claims_browse_entity_labels` changes, gated to `p_kind =
-- 'person'` (the `p_kind = 'project'` call this same function serves is
-- byte-identical to 066). `kg_claims_facets`'s `people` CTE and
-- `kg_claims_browse`'s `person_labels`/p_person filter both consume this
-- function's output already — both surfaces pick up the fix with no changes
-- of their own. Signature unchanged (pure CREATE OR REPLACE, no DROP
-- needed).
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

comment on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) is
  'Curated, alias-resolved, case-insensitive-prefix-collapsed label set for the Memory browser''s People/Projects facets (migration 055, extended by 060, fixed by 063 finding #6, 064 NEW-2, 066 RESIDUAL-1, 069 D8/#111, adversarially reviewed rounds 1-3 -- F1-F4, R2-1..R2-3, R3-1/R3-2 fixed). 069, p_kind=''person'' only: the raw label pool is pre-filtered BEFORE prefix-collapse to drop (a) any label EXACT-STRING-equal (R2-3: via public.kg__normalize_label) to the owner''s own full display_name, its bare first-name token, or any live, non-superseded (F3), accepted kg_user_claims self-name correction -- exact full-string equality only, never a prefix/token match, so a longer/different name merely sharing the owner''s first token (e.g. a two-word name starting with it) is never touched and always keeps showing as its own facet label. A kind=''person'' claim whose ONLY recorded name is byte-equal to the owner''s bare first token is therefore always treated as the owner and dropped -- #111''s fix working as intended (this schema has no structural signal to tell that apart from "a different person who happens to share that exact bare name"; round 3 finding R3-1). (b) drops any label the extractor ALSO independently tagged as kind=''project'' for this user, where that project claim is itself currently visible (F2: same claim_key-is-not-null + grounding predicate as this function''s own person pool). F4: a NULL profiles.display_name makes the full-name/first-token exclusion sources a no-op for that user -- only a live self-name correction can still exclude anything. p_kind=''project'' behaviour is byte-identical to 066. For p_kind=''project'': whether a label has its OWN alias is decided by ROW EXISTENCE in project_aliases (066), not by whether resolving changed the string (064''s bug); a label with its own row resolves via project_alias_resolve on its raw_label; a label with no row of its own falls back to resolving the group''s shared prefix_canonical (063 finding #6, preserved).';

-- Grants unchanged from 055/060/063/064/066 (same signature -- CREATE OR
-- REPLACE keeps existing privileges; no re-grant needed).
