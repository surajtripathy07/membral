-- ============================================================
-- 060_project_aliases.sql
-- Project clubbing (goal 2026-08-26 W7/D8): the same real project shows up
-- under several raw labels — `dev/membral`, `surajtripathy07/membral`,
-- `surajtripathy07/membral-personal` in code_projects.display_name — because
-- claims_browse_entity_labels' (migration 055) collapse algorithm only ever
-- merges labels that are a case-insensitive PREFIX of one another, and none
-- of these three is a prefix of another. This migration adds a small,
-- explicit alias table plus two seeding heuristics, and threads resolution
-- through claims_browse_entity_labels so the Projects facet, the Memory
-- browser, and (via lib/memory/project-aliases.ts) the code list and the
-- bridge context proposal all agree on one canonical label per project.
--
-- FOUNDER-1K VERIFICATION (2026-08-27, live psql against the real corpus):
-- three code_projects rows for this user all share repo_path
-- '/Users/<you>/dev/membral' (a GitHub remote renamed over time, and
-- one session captured before any remote existed) despite three DIFFERENT
-- repo_identity values (two remote-derived, one path-fallback) — repo_path
-- is the real "same underlying project" signal here, not repo_identity
-- (which is unique per (user_id, repo_identity) by construction and can
-- never itself repeat). Two of the three display_names ALSO agree under
-- normalized-slug equality (`dev/membral`, `surajtripathy07/membral` both
-- normalize to "membral"); `surajtripathy07/membral-personal` does not
-- (normalizes to "membralpersonal") and is pulled into the same group only
-- via the repo_path lineage edge. Both heuristics below are therefore
-- necessary; either alone leaves this exact case only partially merged.
--
-- `acmeaix.com` -> `Acme AIx`: normalized-slug equality DOES collapse
-- these two strings to the same value ("acmeaix") — verified directly
-- against project_alias_normalize() below. But `acmeaix.com` is not
-- itself a candidate label anywhere in this corpus: it appears only
-- embedded inside the PROSE of an unrelated kg_claims row (kind='project')
-- that merely mentions it — never as a kg_claims.name value, a
-- code_projects.display_name, or any other column the seed function reads
-- (verified live: `select distinct name from kg_claims where kind='project'`
-- and every code_projects identity column for this user were checked by
-- hand; neither contains the literal "acmeaix.com"). The seed therefore
-- cannot produce this merge from the current corpus, and per this task's own
-- instruction no row is hand-inserted to fake it — see the W7 report for the
-- full before/after facet JSON this finding is based on.
-- ============================================================

-- ------------------------------------------------------------
-- project_aliases: one row per (user, alias) — alias always maps to exactly
-- one canonical label. source records provenance: 'slug' (normalized-slug
-- equality), 'remote-lineage' (code_projects rows sharing a repo_path),
-- 'manual' (the "Merge into..." action, POST /api/memory/projects/merge).
-- No self-alias (a label can't be its own alias) — that's just "not
-- aliased," represented by the absence of a row.
-- ------------------------------------------------------------
create table public.project_aliases (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  canonical   text not null,
  alias       text not null,
  source      text not null check (source in ('slug', 'remote-lineage', 'manual')),
  created_at  timestamptz not null default now(),
  primary key (user_id, alias),
  constraint project_aliases_no_self_alias check (alias <> canonical)
);

comment on table public.project_aliases is
  'Project label clubbing (migration 060, goal 2026-08-26 W7/D8): alias -> canonical, one row per (user, alias). Seeded by project_alias_seed() (source=''slug''|''remote-lineage''); a manual merge (POST /api/memory/projects/merge) writes source=''manual'' and always wins on conflict (upsert). Resolved recursively (depth-capped at 5) by project_alias_resolve() and lib/memory/project-aliases.ts''s canonicalize(), consulted by claims_browse_entity_labels (migration 055) before its existing prefix-collapse groups labels for the Projects facet.';

create index idx_project_aliases_user_canonical on public.project_aliases (user_id, canonical);

alter table public.project_aliases enable row level security;

create policy "project_aliases: users see own rows" on public.project_aliases
  for select using (auth.uid() = user_id);
create policy "project_aliases: users insert own rows" on public.project_aliases
  for insert with check (auth.uid() = user_id);
create policy "project_aliases: users delete own rows" on public.project_aliases
  for delete using (auth.uid() = user_id);
-- No update policy: a re-merge is delete + insert (or upsert, which the
-- merge route uses) so the audit trail (created_at) always reflects the
-- most recent merge decision for that alias, and no policy is needed for a
-- write pattern that never happens.

-- ------------------------------------------------------------
-- project_alias_normalize(text) — casefold, strip a leading `dev/` or
-- `owner/` prefix (both are just "everything up to the LAST '/'", so one
-- regexp_replace handles both), strip a trailing TLD-shaped suffix
-- (.com/.ai/.io/... — BEFORE punctuation stripping, else "acmeaix.com"
-- would become "acmeaixcom" instead of "acmeaix"), then strip every
-- remaining non-alphanumeric character (punctuation/-/_/./whitespace).
-- `immutable` — pure string transform. Mirrored byte-for-byte by
-- lib/memory/project-aliases.ts's normalizeProjectSlug (unit-tested against
-- the same fixtures).
-- ------------------------------------------------------------
create or replace function public.project_alias_normalize(p_label text)
returns text
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(lower(btrim(coalesce(p_label, ''))), '^.*/', ''),
      '\.(com|ai|io|net|org|co|app|dev|xyz|so)$', ''
    ),
    '[^a-z0-9]', '', 'g'
  )
$$;

comment on function public.project_alias_normalize(text) is
  'Slug normalizer for project-label clubbing (migration 060): lower+trim, strip up to the last ''/'' (covers both a leading dev/ and an owner/ prefix), strip a trailing TLD-shaped suffix, strip all remaining punctuation/whitespace. Mirrored in lib/memory/project-aliases.ts (normalizeProjectSlug) — see that file''s test for the shared fixture list.';

revoke all on function public.project_alias_normalize(text) from public;
revoke all on function public.project_alias_normalize(text) from anon;
grant execute on function public.project_alias_normalize(text) to authenticated;
grant execute on function public.project_alias_normalize(text) to service_role;

-- ------------------------------------------------------------
-- project_alias_resolve(p_user_id, p_label) — walks alias -> canonical ->
-- canonical... up to depth 5 (a manual merge layered on top of an
-- auto-seeded one, or a rare chain of manual re-merges), stopping early on a
-- miss or a self-referencing hop. Session-bound (security invoker; RLS on
-- project_aliases scopes the read to auth.uid() = p_user_id, same shape
-- claims_browse_entity_labels/kg_claims_facets/kg_claims_browse already
-- rely on for their own tables).
-- ------------------------------------------------------------
create or replace function public.project_alias_resolve(p_user_id uuid, p_label text)
returns text
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_current text := btrim(coalesce(p_label, ''));
  v_next text;
  v_depth int := 0;
begin
  if v_current = '' then
    return p_label;
  end if;

  loop
    exit when v_depth >= 5;
    select pa.canonical into v_next
      from public.project_aliases pa
     where pa.user_id = p_user_id
       and pa.alias = v_current
     limit 1;
    exit when v_next is null or v_next = v_current;
    v_current := v_next;
    v_depth := v_depth + 1;
  end loop;

  return v_current;
end;
$$;

comment on function public.project_alias_resolve(uuid, text) is
  'Recursive alias -> canonical resolution (migration 060), depth-capped at 5, stopping early on a miss or a self hop. Used by claims_browse_entity_labels (migration 055) for kind=''project'' before its existing prefix-collapse groups labels. Session-bound via project_aliases'' own RLS (security invoker, no separate auth.uid() check needed here — the table read itself is scoped).';

revoke all on function public.project_alias_resolve(uuid, text) from public;
revoke all on function public.project_alias_resolve(uuid, text) from anon;
grant execute on function public.project_alias_resolve(uuid, text) to authenticated;
grant execute on function public.project_alias_resolve(uuid, text) to service_role;

-- ------------------------------------------------------------
-- project_alias_seed(p_user) — seeds project_aliases from two heuristics
-- over this user's own data (idempotent: `on conflict (user_id, alias) do
-- nothing`, so re-running never overwrites a 'manual' row, or any existing
-- 'slug'/'remote-lineage' row, and inserts nothing new on a repeat run with
-- unchanged source data):
--
--   (a) 'slug' — labels whose project_alias_normalize() value is equal.
--       Candidate labels are EXACTLY the source kg_claims_facets' own
--       Projects facet treats as authoritative (claims_browse_entity_labels,
--       migration 055): kg_claims.name for kind='project' from the visible
--       (grounded/inferred/corrected) population, UNION
--       code_projects.display_name for this user.
--
--   (b) 'remote-lineage' — code_projects rows for this user that share a
--       non-null, non-empty repo_path. repo_identity itself is unique per
--       (user_id, repo_identity) by construction (migration 029's own
--       constraint) and so can never repeat — repo_path is the column that
--       actually carries "same underlying project, different remote state
--       over time" in real data (see this file's header for the founder-1k
--       case this was built against).
--
-- Both edge sets feed one union-find over the candidate labels (iterative
-- minimum-label propagation via a bounded UPDATE loop — simpler and safer
-- at this demo scale than a recursive CTE, which has no built-in cycle guard
-- against the 2-cycles a symmetric edge set always creates). Canonical per
-- resulting component = the label with the highest occurrence count across
-- kg_claims.name + code_projects.display_name, ties -> shortest, ties ->
-- alphabetical; every other member of a component (size > 1) becomes an
-- alias row pointing at it.
-- ------------------------------------------------------------
create or replace function public.project_alias_seed(p_user uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_changed int;
  v_slug_inserted int := 0;
  v_lineage_inserted int := 0;
begin
  if auth.uid() is null or auth.uid() <> p_user then
    raise exception 'project_alias_seed requires an end-user session matching p_user';
  end if;

  create temporary table tmp_pa_nodes (
    label text primary key
  ) on commit drop;

  create temporary table tmp_pa_edges (
    a text not null,
    b text not null,
    source text not null
  ) on commit drop;

  create temporary table tmp_pa_comp (
    label text primary key,
    root text not null
  ) on commit drop;

  -- Candidate labels: the same claims-first source claims_browse_entity_labels
  -- (055) treats as the Projects facet's raw population.
  insert into tmp_pa_nodes (label)
  select distinct label from (
    select btrim(c.name) as label
      from public.kg_claims c
      join public.kg_claim_lifecycle l
        on l.user_id = c.user_id
       and l.claim_key_version = c.claim_key_version
       and l.claim_key = c.claim_key
     where c.user_id = p_user
       and c.claim_key is not null
       and c.kind = 'project'
       and c.name is not null
       and public.claim_browse_grounding(c, l) in ('grounded', 'inferred', 'corrected')
    union all
    select btrim(cp.display_name) as label
      from public.code_projects cp
     where cp.user_id = p_user
       and cp.display_name is not null
  ) s
  where label is not null and label <> ''
  on conflict (label) do nothing;

  -- (a) normalized-slug equality: connect every label in a normalize()-equal
  -- group to the lexicographically-first member (a star graph is enough
  -- input for the union-find propagation below to connect the whole group).
  insert into tmp_pa_edges (a, b, source)
  select g.rep, n.label, 'slug'
    from (
      select public.project_alias_normalize(label) as norm, min(label) as rep
        from tmp_pa_nodes
       group by public.project_alias_normalize(label)
      having public.project_alias_normalize(label) <> '' and count(*) > 1
    ) g
    join tmp_pa_nodes n
      on public.project_alias_normalize(n.label) = g.norm
     and n.label <> g.rep;

  -- (b) git-remote lineage: code_projects rows for this user sharing a
  -- non-null repo_path are the same underlying project. See this function's
  -- header for why repo_path, not repo_identity, is the signal here.
  insert into tmp_pa_edges (a, b, source)
  select g.rep, cp.display_name, 'remote-lineage'
    from (
      select repo_path, min(display_name) as rep
        from public.code_projects
       where user_id = p_user
         and repo_path is not null
         and btrim(repo_path) <> ''
         and display_name is not null
       group by repo_path
      having count(*) > 1
    ) g
    join public.code_projects cp
      on cp.user_id = p_user
     and cp.repo_path = g.repo_path
     and cp.display_name is not null
     and cp.display_name <> g.rep;

  insert into tmp_pa_comp (label, root)
  select label, label from tmp_pa_nodes
  on conflict (label) do nothing;

  -- Union-find via iterative minimum-label propagation: repeat "adopt my
  -- lowest-root neighbor's root" until nothing changes. Monotonically
  -- decreasing per label, bounded below by the label itself -> guaranteed
  -- to converge, and safe against the cycles a symmetric edge set creates
  -- (unlike an un-guarded recursive CTE walk).
  loop
    with sym as (
      select a, b from tmp_pa_edges
      union all
      select b, a from tmp_pa_edges
    ),
    proposal as (
      select c.label, min(c2.root) as new_root
        from tmp_pa_comp c
        join sym e on e.a = c.label
        join tmp_pa_comp c2 on c2.label = e.b
       group by c.label
    )
    update tmp_pa_comp t
       set root = p.new_root
      from proposal p
     where t.label = p.label
       and p.new_root < t.root;
    get diagnostics v_changed = row_count;
    exit when v_changed = 0;
  end loop;

  -- Canonical per component (size > 1): highest occurrence count across
  -- kg_claims.name + code_projects.display_name, ties -> shortest label,
  -- ties -> alphabetical.
  with freq as (
    select label, count(*) as n from (
      select btrim(c.name) as label
        from public.kg_claims c
       where c.user_id = p_user and c.kind = 'project' and c.name is not null
      union all
      select btrim(cp.display_name) as label
        from public.code_projects cp
       where cp.user_id = p_user and cp.display_name is not null
    ) s
    group by label
  ),
  members as (
    select tc.root, tc.label, coalesce(f.n, 0) as n
      from tmp_pa_comp tc
      left join freq f on f.label = tc.label
  ),
  sized as (
    select root from tmp_pa_comp group by root having count(*) > 1
  ),
  canonical as (
    select m.root, (array_agg(m.label order by m.n desc, length(m.label) asc, m.label asc))[1] as canon
      from members m
      join sized s on s.root = m.root
     group by m.root
  ),
  ins as (
    insert into public.project_aliases (user_id, canonical, alias, source)
    select
      p_user,
      can.canon,
      m.label,
      case
        when exists (
          select 1 from tmp_pa_edges e
           where e.source = 'remote-lineage' and (e.a = m.label or e.b = m.label)
        ) then 'remote-lineage'
        else 'slug'
      end
      from members m
      join canonical can on can.root = m.root
     where m.label <> can.canon
    on conflict (user_id, alias) do nothing
    returning source
  )
  select
    count(*) filter (where source = 'slug'),
    count(*) filter (where source = 'remote-lineage')
    into v_slug_inserted, v_lineage_inserted
  from ins;

  return jsonb_build_object(
    'inserted_total', v_slug_inserted + v_lineage_inserted,
    'inserted_slug', v_slug_inserted,
    'inserted_remote_lineage', v_lineage_inserted
  );
end;
$$;

comment on function public.project_alias_seed(uuid) is
  'Seeds project_aliases (migration 060) from normalized-slug equality (source=''slug'') and code_projects repo_path lineage (source=''remote-lineage'') over this user''s own claims-first Projects-facet label population. Idempotent: on conflict (user_id, alias) do nothing — never overwrites an existing row of any source, including a ''manual'' merge. Returns {inserted_total, inserted_slug, inserted_remote_lineage} counting only rows newly inserted by this call.';

revoke all on function public.project_alias_seed(uuid) from public;
revoke all on function public.project_alias_seed(uuid) from anon;
grant execute on function public.project_alias_seed(uuid) to authenticated;
grant execute on function public.project_alias_seed(uuid) to service_role;

-- ------------------------------------------------------------
-- claims_browse_entity_labels — CREATE OR REPLACE, SAME 4-arg signature as
-- migration 055 (no drop needed). Only the 'project' path changes: each raw
-- label is first resolved through project_aliases (project_alias_resolve,
-- recursive, depth-capped at 5) into a `resolved_label`, and the EXISTING
-- case-insensitive-prefix collapse (055, unchanged) then runs over the pool
-- of resolved labels instead of the raw ones — an alias always wins over the
-- prefix heuristic, and the prefix heuristic still catches anything the
-- alias table doesn't cover (e.g. "Acme AIx" / "Acme AIX" case
-- variants). 'person' is untouched: resolved_label = raw_label for every
-- row, so the pool is exactly the same label set 055 produced — byte-
-- identical output for people.
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
  ),
  -- migration 060: for kind='project', resolve through project_aliases
  -- BEFORE the prefix collapse below groups labels. 'person' is a pass-
  -- through (resolved_label = raw_label), so this CTE is a no-op for people.
  resolved as (
    select
      l.raw_label,
      case
        when p_kind = 'project' then public.project_alias_resolve(p_user_id, l.raw_label)
        else l.raw_label
      end as resolved_label
    from labels l
  ),
  pool as (
    select distinct resolved_label as pool_label from resolved
  )
  select
    r.raw_label,
    (
      select m.pool_label
        from pool m
       where left(lower(r.resolved_label), length(m.pool_label)) = lower(m.pool_label)
       order by length(m.pool_label), m.pool_label
       limit 1
    ) as canonical_label
  from resolved r
$$;

comment on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) is
  'Curated, alias-resolved, case-insensitive-prefix-collapsed label set for the Memory browser''s People/Projects facets (migration 055, extended by 060). CLAIMS-FIRST: distinct kg_claims.name for p_kind (person|project) from the visible population (claim_browse_grounding), optionally unioned with code_projects.display_name (p_include_code_projects, projects only). migration 060: for p_kind=''project'', each raw label is resolved through project_aliases (project_alias_resolve, depth-capped at 5) BEFORE the prefix collapse — an alias always wins over the shortest-prefix heuristic. ''person'' behaviour is byte-identical to 055 (resolved_label = raw_label there). canonical_label is the shortest same-population resolved label that is a case-insensitive prefix of the row''s own resolved label.';

-- Grants unchanged from migration 055 (same signature — CREATE OR REPLACE
-- keeps existing privileges; no re-grant needed).
