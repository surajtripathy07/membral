-- ============================================================
-- 064_project_aliases_guard.sql
-- Re-verification of 063 (fresh adversarial review, round 2): 5 of 7
-- HIGH/MED findings genuinely fixed; the fix pass ITSELF introduced two new
-- defects (NEW-1 HIGH, NEW-2 HIGH/MED) plus two MED UI/perf gaps (NEW-3,
-- NEW-4). 060/063 are NOT edited (already applied live) — everything below
-- is an ALTER/CREATE OR REPLACE layered on top, same convention as 057/058
-- on 055 and 063 on 060.
--
-- NEW-1 (HIGH) — 063's relaxed guard fails OPEN on NULL. Postgres three-
-- valued logic: `auth.uid() = p_user` is NULL (not false) when auth.uid()
-- is NULL; `NULL or NULL` = NULL; `not NULL` = NULL; `if NULL then` does
-- NOT execute the THEN branch — so `if not (a or b) then raise` silently
-- SKIPS the raise and lets the function body run with NO scoping check at
-- all whenever both auth.uid() and auth.role() are NULL (a direct
-- superuser/no-JWT connection, verified live by the reviewer as `postgres`
-- with no claims). 058's own convention (`auth.uid() is null or auth.uid()
-- <> p_user_id`) is null-safe because `IS NULL` always evaluates to a real
-- boolean, never NULL — 063's `=` comparisons did not have that property
-- and nothing wrapped them. Fixed by wrapping BOTH operands in
-- coalesce(..., false), the reviewer's own literal minimal fix. Audited
-- every other guard added in 060/063: project_alias_resolve and
-- claims_browse_entity_labels have no explicit boolean auth guard at all
-- (they rely on RLS on the underlying table reads, which is a real
-- Postgres row-filter, not a plpgsql boolean short-circuit — not subject to
-- this class of bug); project_alias_normalize/project_alias_owner are pure
-- string functions with no auth logic. project_alias_seed's guard is the
-- only place this pattern was introduced, and 060's ORIGINAL version of it
-- already used 058's safe `is null or <>` idiom — the bug was introduced
-- specifically by 063's added service-role OR-branch.
--
-- NEW-2 (HIGH/MED) — 063's finding-#6 fix (resolve the shared
-- prefix_canonical instead of each raw label) went too far: a label that
-- HAS ITS OWN alias row (e.g. a manual merge on
-- `surajtripathy07/membral-personal`, which also happens to have a shorter
-- prefix sibling `surajtripathy07/membral` in the same raw-label pool) had
-- that alias silently ignored — the facet resolved the group's shared
-- prefix_canonical instead, disagreeing with the `/code` list's TS
-- `canonicalize` (which resolves each raw label directly and always did).
-- Fixed by giving a label's OWN alias precedence, falling back to the
-- group's prefix_canonical only when the label has no alias of its own:
-- `coalesce(nullif(resolve(raw_label), raw_label), resolve(prefix_canonical))`
-- — the reviewer's own literal minimal fix. This preserves 063's group-move
-- behaviour (merging a group's CURRENT canonical still moves every member
-- that has no alias of its own, via the fallback) while letting an
-- individual member's explicit alias win over group membership (the exact
-- case that was broken). TS needs no code change: `/code`'s `canonicalize`
-- already resolves each code_projects row's own raw label directly with no
-- prefix-collapse concept at all (project_alias_seed writes one explicit
-- alias row per non-canonical group member, so TS never needed a
-- prefix-collapse fallback to begin with) — a new parity test locks this
-- agreement in rather than changing production TS code.
--
-- NEW-3 (MED) — finding #3's fix (tombstone-based unmerge) was reachable
-- via the API but not the UI: GET only ever returned source='manual' rows,
-- so a seeded (slug/remote-lineage) merge had no unmerge chip, and the
-- label it swallowed never appeared in the merge-source dropdown (which
-- only ever listed facet CANONICAL labels). SQL-only migration; the actual
-- fix is in route.ts (GET now returns every row, any source) and
-- project-merge-control.tsx (chips render for every row; the source
-- dropdown's options are the union of facet canonical labels AND every
-- fetched alias) — see the W7 report's "Round 3" section for those diffs.
--
-- NEW-4 (MED) — seeding ran on every GET /api/memory/projects/merge and
-- every /code render (measured ~14.5ms + temp-table catalog churn per call,
-- scaling with label population, on the TTFB path). Fixed by throttling
-- INSIDE project_alias_seed itself (one gate, shared by all three call
-- sites, including the import-route hook — simpler and more robust than
-- per-call-site throttling, and the import hook reseeding the same data
-- more than once every few minutes is exactly as wasteful as the other two
-- paths): a new project_alias_seed_runs(user_id, ran_at) stamp table: a
-- call within RESEED_COOLDOWN (10 minutes) of the last run for this user
-- returns immediately with `skipped_recent_run: true` and no work done.
-- ============================================================

-- ------------------------------------------------------------
-- NEW-4: per-user "last seeded" stamp, same owner-scoped RLS shape as
-- project_aliases itself.
-- ------------------------------------------------------------
create table public.project_alias_seed_runs (
  user_id  uuid primary key references public.profiles(id) on delete cascade,
  ran_at   timestamptz not null default now()
);

comment on table public.project_alias_seed_runs is
  'One row per user: the last time project_alias_seed actually did work (migration 064, NEW-4). Read/written only by project_alias_seed itself — callers never touch this table directly. A call within 10 minutes of ran_at short-circuits with no work done.';

alter table public.project_alias_seed_runs enable row level security;

create policy "project_alias_seed_runs: users see own rows" on public.project_alias_seed_runs
  for select using (auth.uid() = user_id);
create policy "project_alias_seed_runs: users insert own rows" on public.project_alias_seed_runs
  for insert with check (auth.uid() = user_id);
create policy "project_alias_seed_runs: users update own rows" on public.project_alias_seed_runs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- A service-role caller (POST /api/code-sessions) bypasses RLS entirely
-- (rolbypassrls = true, verified live) — no separate policy needed for it.

-- ------------------------------------------------------------
-- NEW-1 + NEW-4: project_alias_seed — CREATE OR REPLACE, SAME 1-arg
-- signature (no drop needed). Guard rewritten null-safe; a throttle check
-- added right after the guard, and the stamp write added at the very end,
-- only on the path that actually did work.
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
  v_last_run timestamptz;
begin
  -- NEW-1: both operands coalesced to a real boolean -- `IF NULL THEN` never
  -- silently skips the raise again, regardless of which claims are absent.
  if not (
    coalesce(auth.uid() = p_user, false) or coalesce(auth.role() = 'service_role', false)
  ) then
    raise exception 'project_alias_seed requires an end-user session matching p_user, or a service-role caller with an explicit p_user';
  end if;

  -- NEW-4: throttle -- a call within 10 minutes of the last one that
  -- actually did work is a no-op. Read-only up to this point; nothing has
  -- created a temp table or touched project_aliases yet, so this is cheap
  -- even on the throttled path.
  select ran_at into v_last_run from public.project_alias_seed_runs where user_id = p_user;
  if v_last_run is not null and v_last_run > now() - interval '10 minutes' then
    return jsonb_build_object(
      'inserted_total', 0, 'inserted_slug', 0, 'inserted_remote_lineage', 0, 'skipped_recent_run', true
    );
  end if;

  create temporary table tmp_pa_nodes (
    label text primary key
  ) on commit drop;

  create temporary table tmp_pa_owner (
    label text primary key,
    bare text not null,
    owner text
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

  -- Finding #4 (063): bare name (project_alias_normalize) + owner
  -- (project_alias_owner) per label, guarded to at least 2 characters of
  -- bare name.
  insert into tmp_pa_owner (label, bare, owner)
  select label, public.project_alias_normalize(label), public.project_alias_owner(label)
    from tmp_pa_nodes
   where length(public.project_alias_normalize(label)) >= 2;

  -- (a) normalized-slug equality, owner-aware (063 finding #4). See that
  -- migration's header for the "safe" (<=1 distinct real owner) vs
  -- "conflicted" (2+ distinct real owners -> only same-owner members edge
  -- to each other, ownerless members get NO edge at all) split.
  with grp as (
    select bare, count(distinct owner) filter (where owner is not null) as n_owners
      from tmp_pa_owner
     group by bare
    having count(*) > 1
  ),
  safe_groups as (
    select bare from grp where n_owners <= 1
  ),
  safe_reps as (
    select bare, min(label) as rep from tmp_pa_owner where bare in (select bare from safe_groups) group by bare
  ),
  safe_edges as (
    select sr.rep as a, n.label as b, 'slug' as source
      from safe_reps sr
      join tmp_pa_owner n on n.bare = sr.bare and n.label <> sr.rep
  ),
  conflicted_subgroups as (
    select bare, owner, min(label) as rep
      from tmp_pa_owner
     where bare in (select bare from grp where n_owners > 1)
       and owner is not null
     group by bare, owner
    having count(*) > 1
  ),
  conflicted_edges as (
    select cs.rep as a, n.label as b, 'slug' as source
      from conflicted_subgroups cs
      join tmp_pa_owner n on n.bare = cs.bare and n.owner = cs.owner and n.label <> cs.rep
  )
  insert into tmp_pa_edges (a, b, source)
  select a, b, source from safe_edges
  union all
  select a, b, source from conflicted_edges;

  -- (b) git-remote lineage: UNCHANGED from 060/063 -- finding #5's
  -- tightening deferred (see 063's header).
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

  -- Union-find via iterative minimum-label propagation (unchanged from
  -- 060/063).
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

  -- Canonical per component (size > 1): highest occurrence count, ties ->
  -- shortest label, ties -> alphabetical. Findings #3/#7 (063): a candidate
  -- (alias, canonical) pair is skipped whenever EITHER label already
  -- appears as an alias OR a canonical in any 'manual'/'unmerged' row for
  -- this user.
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
  protected as (
    select alias as label from public.project_aliases where user_id = p_user and source in ('manual', 'unmerged')
    union
    select canonical as label from public.project_aliases where user_id = p_user and source in ('manual', 'unmerged')
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
       and not exists (select 1 from protected p where p.label = m.label)
       and not exists (select 1 from protected p where p.label = can.canon)
    on conflict (user_id, alias) do nothing
    returning source
  )
  select
    count(*) filter (where source = 'slug'),
    count(*) filter (where source = 'remote-lineage')
    into v_slug_inserted, v_lineage_inserted
  from ins;

  -- NEW-4: stamp -- only on the path that actually did work.
  insert into public.project_alias_seed_runs (user_id, ran_at)
  values (p_user, now())
  on conflict (user_id) do update set ran_at = excluded.ran_at;

  return jsonb_build_object(
    'inserted_total', v_slug_inserted + v_lineage_inserted,
    'inserted_slug', v_slug_inserted,
    'inserted_remote_lineage', v_lineage_inserted,
    'skipped_recent_run', false
  );
end;
$$;

comment on function public.project_alias_seed(uuid) is
  'Seeds project_aliases (migration 060, fixed by 063, guard/throttle fixed by 064) from owner-aware normalized-slug equality (source=''slug'') and code_projects repo_path lineage (source=''remote-lineage'') over this user''s own claims-first Projects-facet label population. Callable by an end-user session (auth.uid() = p_user) OR a real service-role caller with an explicit p_user -- both operands null-safe (064 NEW-1: coalesce(..., false), closing a fail-open bug 063 introduced). Throttled to at most once per 10 minutes per user (064 NEW-4, project_alias_seed_runs) -- a call inside that window returns immediately with skipped_recent_run:true. Idempotent AND reversibility-safe (063 findings #3/#7): on conflict (user_id, alias) do nothing, and never proposes an edge touching a label that already appears as an alias or canonical in any ''manual''/''unmerged'' row.';

revoke all on function public.project_alias_seed(uuid) from public;
revoke all on function public.project_alias_seed(uuid) from anon;
grant execute on function public.project_alias_seed(uuid) to authenticated;
grant execute on function public.project_alias_seed(uuid) to service_role;

-- ------------------------------------------------------------
-- NEW-2: claims_browse_entity_labels -- CREATE OR REPLACE, SAME 4-arg
-- signature as 055/060/063 (no drop needed). Only the final SELECT changes:
-- a label's OWN alias (project_alias_resolve on its raw_label) wins when it
-- has one; only a label with NO alias of its own falls back to resolving
-- the shared prefix_canonical (063's finding-#6 fix, kept for that case).
-- 'person' is untouched (still a pass-through, no resolve step at all).
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
  -- 055/060/063: the ORIGINAL prefix-collapse, unchanged -- runs over the
  -- RAW label pool, before any alias resolution.
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
  -- migration 064 (NEW-2): a label's OWN alias wins first (resolved
  -- directly on raw_label) -- this is what makes a manual/seeded alias on
  -- ONE specific member of a prefix-group (e.g.
  -- `surajtripathy07/membral-personal`, which has a shorter prefix sibling
  -- `surajtripathy07/membral` in the same pool) actually take effect,
  -- instead of being silently overridden by the group's shared
  -- prefix_canonical (063's bug). Only a label with NO alias of its own
  -- (project_alias_resolve returns it unchanged) falls back to resolving
  -- the group's prefix_canonical -- this is what still makes merging a
  -- group's CURRENT canonical move every OTHER member that has no alias of
  -- its own (063's finding-#6 fix, preserved for that case). 'person' is a
  -- pass-through (canonical_label = prefix_canonical), byte-identical to
  -- 055/060/063.
  select
    pc.raw_label,
    case
      when p_kind = 'project' then coalesce(
        nullif(public.project_alias_resolve(p_user_id, pc.raw_label), pc.raw_label),
        public.project_alias_resolve(p_user_id, pc.prefix_canonical)
      )
      else pc.prefix_canonical
    end as canonical_label
  from prefix_collapsed pc
$$;

comment on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) is
  'Curated, alias-resolved, case-insensitive-prefix-collapsed label set for the Memory browser''s People/Projects facets (migration 055, extended by 060, fixed by 063 finding #6, fixed again by 064 NEW-2). CLAIMS-FIRST: distinct kg_claims.name for p_kind (person|project) from the visible population (claim_browse_grounding), optionally unioned with code_projects.display_name (p_include_code_projects, projects only). The 055 prefix-collapse runs FIRST over raw labels (unchanged). For p_kind=''project'': a label''s OWN alias (project_alias_resolve on its raw_label) wins when it has one (064 NEW-2 -- makes a manual/seeded alias on one prefix-group member actually take effect, and keeps the Memory facet and the /code list, which always resolved raw labels directly, in agreement); a label with no alias of its own falls back to resolving the group''s shared prefix_canonical (063 finding #6 -- still makes merging a group''s current canonical move every untouched member). ''person'' behaviour is byte-identical to 055/060/063 (no resolve step).';

-- Grants unchanged from 055/060/063 (same signature -- CREATE OR REPLACE
-- keeps existing privileges; no re-grant needed).
