-- ============================================================
-- 066_project_aliases_tombstone.sql
-- Second re-verification of 064 (fresh adversarial review, round 3):
-- RESIDUAL-1 (MED) — the ONLY remaining finding. 060/063/064 are NOT
-- edited (already applied live) — this is a CREATE OR REPLACE layered on
-- top, same convention as every prior fix in this chain.
--
-- RESIDUAL-1 — 064's own-alias-wins fix used
-- `nullif(project_alias_resolve(p_user_id, pc.raw_label), pc.raw_label)` to
-- detect "this label has its own alias": if resolving changed the string,
-- use that; otherwise fall back to the group's prefix_canonical. But an
-- 'unmerged' TOMBSTONE (migration 063, findings #3/#7) resolves a label TO
-- ITSELF by design (that's what "un-merge" means) — so `nullif(X, X)` is
-- NULL for a tombstoned label exactly the same as for a label with NO alias
-- row at all, and the expression falls through to the prefix_canonical
-- fallback, silently ignoring the tombstone. Checked (rolled back):
-- tombstoning `acme/widgets-app` left
-- claims_browse_entity_labels still resolving it to `dev/widgets` (via its
-- prefix sibling's group), while project_alias_resolve() and the TS
-- /code list both correctly returned the label itself — the Memory browser
-- and /code disagreed again, the same divergence class NEW-2 (064) fixed
-- for the general case, relocated to the unmerge path specifically. One
-- click reachable on the demo account (NEW-3/064 renders an unmerge chip
-- for exactly this label, one of only two seeded rows).
--
-- Fixed per the reviewer's own minimal fix: decide "does this label have
-- its own alias row" by ROW EXISTENCE in project_aliases, not by whether
-- resolving happened to change the string — a tombstone row exists (alias
-- = canonical, source = 'unmerged') just like any other alias row, so
-- existence-testing sees it correctly regardless of what it resolves to.
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
  labels as (
    select candidate as raw_label from named where candidate is not null and candidate <> ''
  ),
  -- 055/060/063/064: the ORIGINAL prefix-collapse, unchanged -- runs over
  -- the RAW label pool, before any alias resolution.
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
  -- migration 066 (RESIDUAL-1): "does this label have its own alias row" is
  -- now decided by ROW EXISTENCE in project_aliases (alias = raw_label),
  -- not by nullif-ing the resolved value against raw_label -- a tombstone
  -- ('unmerged', alias = canonical) is a real row and now correctly counts
  -- as "has its own alias," even though resolving it returns the label
  -- itself. Only a label with genuinely NO row of its own falls back to
  -- resolving the group's shared prefix_canonical (064's fix, preserved for
  -- that case). 'person' is a pass-through (canonical_label =
  -- prefix_canonical), byte-identical to 055/060/063/064.
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
  'Curated, alias-resolved, case-insensitive-prefix-collapsed label set for the Memory browser''s People/Projects facets (migration 055, extended by 060, fixed by 063 finding #6, 064 NEW-2, 066 RESIDUAL-1). CLAIMS-FIRST: distinct kg_claims.name for p_kind (person|project) from the visible population (claim_browse_grounding), optionally unioned with code_projects.display_name (p_include_code_projects, projects only). The 055 prefix-collapse runs FIRST over raw labels (unchanged). For p_kind=''project'': whether a label has its OWN alias is decided by ROW EXISTENCE in project_aliases (066 -- a tombstone counts, even though it resolves to itself), not by whether resolving changed the string (064''s bug); a label with its own row resolves via project_alias_resolve on its raw_label; a label with no row of its own falls back to resolving the group''s shared prefix_canonical (063 finding #6, preserved). ''person'' behaviour is byte-identical to 055/060/063/064 (no resolve step).';

-- Grants unchanged from 055/060/063/064 (same signature -- CREATE OR
-- REPLACE keeps existing privileges; no re-grant needed).
