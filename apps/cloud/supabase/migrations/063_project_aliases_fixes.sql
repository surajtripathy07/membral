-- ============================================================
-- 063_project_aliases_fixes.sql
-- Fresh adversarial review of migration 060 (project_aliases, W7/D8):
-- VERDICT NOT SOLID, 3 HIGH + 4 MED. This migration fixes every HIGH/MED
-- finding except review finding #5 (repo_path lineage over-merges a reused
-- checkout directory) — deliberately deferred, see the note at the bottom of
-- this header; and review finding #8's "flatten on write" (LOW, and
-- contradicts the ORIGINAL spec's explicit "recursive, depth-capped" design,
-- so kept recursive but now correct under cycles — see finding #7 below).
-- 060 itself is NOT edited (already applied live) — every fix here is an
-- ALTER/CREATE OR REPLACE layered on top of it, same convention 057/058
-- used to fix 055 in place.
--
-- Finding #1 (HIGH) — no UPDATE policy: the route's `upsert(...,
-- {onConflict:"user_id,alias"})` is `INSERT ... ON CONFLICT DO UPDATE`,
-- which requires an UPDATE policy on the conflict path even though the
-- statement is nominally an INSERT (verified live by the reviewer: 42501 on
-- re-merge). Fixed below with a plain owner-scoped UPDATE policy.
--
-- Finding #2 (HIGH) — nothing in the repo ever seeds the table: the founder's
-- two live rows were hand-inserted with a spoofed `request.jwt.claims`
-- during W7's implementation; no code path calls project_alias_seed. Fixed
-- by (a) relaxing the guard to accept EITHER an end-user session (auth.uid()
-- = p_user, unchanged) OR a real service-role caller (auth.role() =
-- 'service_role', verified live to be exactly the claim PostgREST/supabase-js
-- sets for a genuine service-role-key request — NOT a spoofed JWT, the same
-- mechanism every other service-role RPC caller in this codebase already
-- relies on for RLS bypass) with an explicit p_user, and (b) wiring real
-- callers: POST /api/code-sessions (service-role client, fire-and-forget,
-- after a successful import) and GET /api/memory/projects/merge
-- (session-authenticated, awaited) — both outside this migration, see the
-- W7 report's "Review findings addressed" section for the exact files.
--
-- Finding #3 (HIGH) + #7 (MED) — a wrong auto-merge was irreversible, and
-- project_alias_seed could silently create a 2-cycle over an existing manual
-- merge (undoing it with no error). Fixed together with one design change:
-- `unmerge` now UPSERTS a self-referencing TOMBSTONE row (alias = canonical,
-- source = 'unmerged') instead of deleting — a self-row was previously
-- forbidden by project_aliases_no_self_alias, loosened below to allow it
-- ONLY for source='unmerged'. A tombstone (a) resolves to itself
-- (project_alias_resolve's existing next=current stop already handles a
-- self-hop correctly — no resolver change needed for this part) and (b) is
-- now checked by project_alias_seed before EVERY insert: a candidate edge
-- (alias, canonical) is skipped whenever EITHER label already appears as an
-- alias OR a canonical in any 'manual' OR 'unmerged' row for this user —
-- this is the literal fix for #7 too (a manual A->B row protects BOTH A and
-- B from ever being re-targeted by a later seed run, closing the exact
-- "seed inserts B->A over an existing manual A->B" scenario the reviewer
-- demonstrated).
--
-- Finding #7 (MED), second half — project_alias_resolve only guarded an
-- immediate self-hop (next = current), not a revisit of any earlier label in
-- the walk, so a 4-cycle resolved to a DIFFERENT label than TS's
-- canonicalize (which already tracked a `seen` set) — the Memory facet and
-- the /code list could group the same projects under different canonicals.
-- Fixed by giving project_alias_resolve the identical seen-set semantics:
-- both now stop at the first hop that revisits an already-seen label, sized
-- by the same 5-hop cap. Verified to agree on 2-, 3-, and 4-cycles (see the
-- W7 report).
--
-- Finding #4 (MED) — the normalizer strips the owner prefix unconditionally,
-- so `acme/web` and `beta/web` (two different orgs' same-named repos)
-- slug-merge into one project. Fixed WITHOUT changing
-- project_alias_normalize/normalizeProjectSlug (still the pure bare-name
-- transform, used elsewhere and tested against its own fixtures) — instead a
-- NEW project_alias_owner() extracts the segment before the last '/' (NULL
-- when the label has no slash, or has 2+ slashes — an absolute path or a
-- host/owner/repo identity string is not a confident two-part "owner/repo"
-- shape, so it's treated as ownerless, the safe backward-compatible
-- default). project_alias_seed's slug-edge generation now requires EITHER
-- owner agreement OR at least one side ownerless — and, within one
-- bare-name group that contains 2+ DISTINCT real (non-null) owners, an
-- ownerless label gets NO edge to anyone in that group at all (not just "no
-- edge to the conflicting owners") — this closes a hub-transitivity gap a
-- naive per-pair rule would leave open: an ownerless "dev/web" sitting next
-- to both "acme/web" and "beta/web" must never let union-find chain
-- acme<->dev<->beta into one component. Verified live: `dev/membral` (no
-- real owner — see below) vs `surajtripathy07/membral` no longer share a
-- SLUG edge at all (they still merge — the founder's real corpus already
-- relied on this, not slug — via the UNCHANGED remote-lineage/repo_path
-- edge); `acme/web` vs `beta/web` get no edge from either heuristic. Also
-- guards the "empty remnant" degeneracy (two different non-ASCII-heavy
-- labels stripping to the SAME short/empty bare name only because
-- non-ASCII characters are silently dropped): the bare-name group's HAVING
-- clause now also requires length >= 2, not just <> ''.
--
-- Finding #6 (MED) — a manual merge SPLIT an existing prefix-collapsed group
-- instead of moving it: claims_browse_entity_labels resolved each RAW label
-- through project_aliases BEFORE building the prefix-collapse pool, so
-- merging just the group's current canonical (e.g. "Acme AIX") left its
-- case-variant/prefix siblings ("Acme AIx", "Acme AIx Chrome extension")
-- behind as newly-orphaned, newly-canonical rows — the facet list grew
-- instead of shrinking. Fixed by REVERSING the order: the ORIGINAL 055
-- prefix-collapse runs FIRST over the raw label pool (unchanged algorithm),
-- giving every member of a prefix-group the SAME shared `prefix_canonical`;
-- project_alias_resolve then resolves that ONE shared value, not each raw
-- label individually — an alias on the group's prefix_canonical now moves
-- the WHOLE group atomically, and the case-variant issue disappears as a
-- side effect (case variants already collapse to one prefix_canonical
-- before any alias lookup happens). Verified live with the real "Acme AIx"
-- /"Acme AIX"/"Acme AIx Chrome extension" trio: after merging the
-- group's canonical into "Acme Hub", the Projects facet has ONE FEWER row,
-- not one more — see the W7 report.
--
-- DEFERRED — finding #5 (MED, repo_path lineage merges anything that ever
-- shared a directory): the reviewer's own "minimal fix" (require the
-- normalized last path segment to match the normalized display_name/
-- repo_identity tail) was checked against the founder's own motivating case
-- and BREAKS it — `surajtripathy07/membral-personal`'s bare name
-- ("membralpersonal") does not equal repo_path's last segment ("membral"),
-- so that specific tightening would un-merge the exact three rows this
-- heuristic exists for. No alternative tightening was found that preserves
-- the founder case while closing the reused-directory risk in the time
-- available; left as a known, documented risk rather than shipping a fix
-- that regresses the one real case this migration was built against.
-- Reversibility (finding #3's fix, above) is the mitigation: a wrong
-- repo_path-lineage merge can now be tombstoned via unmerge and will never
-- be re-seeded.
-- ============================================================

-- ------------------------------------------------------------
-- Finding #1: the missing UPDATE policy. Without this, PostgREST's
-- `INSERT ... ON CONFLICT (user_id, alias) DO UPDATE` (the merge route's
-- upsert) fails RLS on every conflict — a re-merge, or a manual merge meant
-- to override an auto-seeded row, 500s.
-- ------------------------------------------------------------
create policy "project_aliases: users update own rows" on public.project_aliases
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Findings #3/#7: widen `source` to allow the 'unmerged' tombstone, and
-- loosen the self-alias guard to permit alias = canonical ONLY for a
-- tombstone row (every other source keeps the original "no self-alias"
-- rule).
-- ------------------------------------------------------------
alter table public.project_aliases drop constraint project_aliases_source_check;
alter table public.project_aliases add constraint project_aliases_source_check
  check (source in ('slug', 'remote-lineage', 'manual', 'unmerged'));

alter table public.project_aliases drop constraint project_aliases_no_self_alias;
alter table public.project_aliases add constraint project_aliases_no_self_alias
  check (alias <> canonical or source = 'unmerged');

comment on table public.project_aliases is
  'Project label clubbing (migration 060, fixed by 063). alias -> canonical, one row per (user, alias). source: ''slug''|''remote-lineage'' (project_alias_seed), ''manual'' (POST /api/memory/projects/merge, action=merge — always upserts over any existing row for that alias), ''unmerged'' (same route, action=unmerge — a self-referencing tombstone: alias = canonical, resolves to itself, and project_alias_seed will never re-create a real alias for a label that appears as an alias OR canonical in ANY ''manual''/''unmerged'' row). Resolved recursively (depth-capped at 5, cycle-safe — see project_alias_resolve) by claims_browse_entity_labels (055/060/063) AFTER its prefix-collapse, so a merge moves a whole prefix-group, not just the one label it names.';

-- ------------------------------------------------------------
-- Finding #4: project_alias_owner(text) — the segment before the LAST '/',
-- normalized, or NULL when the label has no slash at all, or the prefix
-- itself contains a further slash (an absolute path or a host/owner/repo
-- identity string — not a confident two-part "owner/repo" shape, so treated
-- as ownerless, the safe/backward-compatible default). Deliberately no
-- special-case for a literal "dev" prefix — see this migration's header:
-- `dev/membral` and `surajtripathy07/membral` now correctly get DIFFERENT
-- owners ("dev" vs "surajtripathy07") and get no SLUG edge from each other;
-- they still merge, via the unchanged remote-lineage edge, which is what
-- actually did the work for this pair in the live founder run anyway
-- (project_alias_seed's own first live run inserted 0 slug rows, 2
-- remote-lineage rows for this exact trio).
-- ------------------------------------------------------------
create or replace function public.project_alias_owner(p_label text)
returns text
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  with base as (
    select btrim(coalesce(p_label, '')) as label
  ),
  prefix as (
    select label, substring(label from '^(.*)/[^/]*$') as pre from base
  )
  select case
    when pre is null then null  -- no slash at all
    when pre ~ '/' then null    -- 2+ slashes -- ambiguous, treat as ownerless
    else nullif(regexp_replace(lower(pre), '[^a-z0-9]', '', 'g'), '')
  end
  from prefix
$$;

comment on function public.project_alias_owner(text) is
  'Owner-segment extractor for slug-edge safety (migration 063, finding #4): the segment before the LAST ''/'' , normalized, or NULL when there is no slash or the prefix itself contains another slash. Mirrored in lib/memory/project-aliases.ts (projectOwnerSegment) — see that file''s test for the shared fixture list. Used only by project_alias_seed''s slug-edge generation, not by resolution.';

revoke all on function public.project_alias_owner(text) from public;
revoke all on function public.project_alias_owner(text) from anon;
grant execute on function public.project_alias_owner(text) to authenticated;
grant execute on function public.project_alias_owner(text) to service_role;

-- ------------------------------------------------------------
-- Finding #7 (second half): project_alias_resolve now tracks the full
-- `seen` path (an array), stopping at the first hop that revisits any
-- already-seen label — not just an immediate self-hop — giving it the exact
-- same cycle semantics as lib/memory/project-aliases.ts's canonicalize
-- (which already tracked a Set). Verified live to agree with the TS side on
-- 2-, 3-, and 4-member cycles (previously diverged on a 4-cycle: SQL landed
-- one hop later than TS). Same 5-hop cap, same signature.
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
  v_seen text[];
  v_depth int := 0;
begin
  if v_current = '' then
    return p_label;
  end if;

  v_seen := array[v_current];
  loop
    exit when v_depth >= 5;
    select pa.canonical into v_next
      from public.project_aliases pa
     where pa.user_id = p_user_id
       and pa.alias = v_current
     limit 1;
    exit when v_next is null or v_next = any(v_seen);
    v_current := v_next;
    v_seen := v_seen || v_current;
    v_depth := v_depth + 1;
  end loop;

  return v_current;
end;
$$;

comment on function public.project_alias_resolve(uuid, text) is
  'Recursive alias -> canonical resolution (migration 060, cycle-guard fixed by 063 finding #7): walks up to 5 hops, stopping at a miss or the first hop that revisits any label already seen on this walk (not just an immediate self-hop) — matching lib/memory/project-aliases.ts''s canonicalize exactly, so SQL (facets) and TS (/code list) never disagree on a cycle. A self-referencing ''unmerged'' tombstone row (alias = canonical) is naturally caught by this same seen-set check and resolves to itself. Session-bound via project_aliases'' own RLS.';

-- ------------------------------------------------------------
-- Finding #2: relax the guard to accept a real service-role caller (verified
-- live: auth.role() correctly reads 'service_role' from the JWT claim a
-- genuine service-role-key PostgREST/RPC request carries — this is the same
-- mechanism every other service-role call in this codebase already relies
-- on for RLS bypass, NOT a spoofed/impersonated end-user session) in
-- addition to the original end-user-session check.
--
-- Findings #4/#7 (seed side): owner-aware slug edges (see
-- project_alias_owner above) replace the old bare-name-only grouping;
-- remote-lineage edges are UNCHANGED (see this migration's header —
-- finding #5 deferred). The final insert now skips any candidate (alias,
-- canonical) pair where EITHER label already appears as an alias OR a
-- canonical in any 'manual'/'unmerged' row for this user (finding #3/#7's
-- reversibility guarantee: a seed run can never re-create or reverse an
-- edge a manual merge or an unmerge tombstone already decided).
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
  if not (auth.uid() = p_user or auth.role() = 'service_role') then
    raise exception 'project_alias_seed requires an end-user session matching p_user, or a service-role caller with an explicit p_user';
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

  -- Finding #4: bare name (project_alias_normalize) + owner
  -- (project_alias_owner) per label, guarded to at least 2 characters of
  -- bare name (the "empty remnant" degeneracy — two labels whose bare names
  -- collide only because non-ASCII content was silently stripped to
  -- near-nothing).
  insert into tmp_pa_owner (label, bare, owner)
  select label, public.project_alias_normalize(label), public.project_alias_owner(label)
    from tmp_pa_nodes
   where length(public.project_alias_normalize(label)) >= 2;

  -- (a) normalized-slug equality, owner-aware (finding #4). A bare-name
  -- group with at most one DISTINCT real (non-null) owner is "safe" -- star
  -- an edge from its lexicographically-first member to every other member,
  -- same as before. A group with 2+ distinct real owners is "conflicted":
  -- only members sharing the SAME owner edge to each other; an ownerless
  -- member gets NO edge in a conflicted group at all (not even to other
  -- ownerless members) -- this is what stops an ownerless label from
  -- transitively bridging two different real owners together via
  -- union-find.
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

  -- (b) git-remote lineage: UNCHANGED from 060 -- see this migration's
  -- header for why finding #5's tightening is deferred.
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

  -- Union-find via iterative minimum-label propagation (unchanged from 060
  -- -- see that migration's header for why this, not a recursive CTE).
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
  -- ties -> alphabetical. Findings #3/#7: a candidate (alias, canonical)
  -- pair is skipped whenever EITHER label already appears as an alias OR a
  -- canonical in any 'manual'/'unmerged' row for this user -- a manual
  -- merge or an unmerge tombstone always wins over this heuristic, and can
  -- never be silently reversed by a later seed run.
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

  return jsonb_build_object(
    'inserted_total', v_slug_inserted + v_lineage_inserted,
    'inserted_slug', v_slug_inserted,
    'inserted_remote_lineage', v_lineage_inserted
  );
end;
$$;

comment on function public.project_alias_seed(uuid) is
  'Seeds project_aliases (migration 060, fixed by 063) from owner-aware normalized-slug equality (source=''slug'', finding #4) and code_projects repo_path lineage (source=''remote-lineage'', unchanged -- finding #5 deferred, see this migration''s header) over this user''s own claims-first Projects-facet label population. Callable by an end-user session (auth.uid() = p_user) OR a real service-role caller with an explicit p_user (finding #2 -- auth.role() = ''service_role'', the genuine claim a service-role-key request carries, not a spoofed session). Idempotent AND reversibility-safe (findings #3/#7): on conflict (user_id, alias) do nothing, and never proposes an edge touching a label that already appears as an alias or canonical in any ''manual''/''unmerged'' row. Returns {inserted_total, inserted_slug, inserted_remote_lineage} counting only rows newly inserted by this call.';

revoke all on function public.project_alias_seed(uuid) from public;
revoke all on function public.project_alias_seed(uuid) from anon;
grant execute on function public.project_alias_seed(uuid) to authenticated;
grant execute on function public.project_alias_seed(uuid) to service_role;

-- ------------------------------------------------------------
-- Finding #6: claims_browse_entity_labels -- CREATE OR REPLACE, SAME 4-arg
-- signature as 055/060 (no drop needed). The ORIGINAL 055 prefix-collapse
-- now runs FIRST, over the raw label pool -- byte-identical to 055/060 as
-- an intermediate step. project_alias_resolve is then applied to the
-- resulting `prefix_canonical`, not to each raw label individually -- every
-- member of a prefix-group shares one prefix_canonical by construction, so
-- a manual alias on that ONE value moves the WHOLE group atomically instead
-- of splitting it (060's bug). 'person' is untouched: p_kind <> 'project'
-- skips the resolve step entirely, so `canonical_label = prefix_canonical`
-- -- byte-identical to 055/060's person output.
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
  -- migration 063 (finding #6): the ORIGINAL 055 prefix-collapse, unchanged
  -- -- runs over the RAW label pool, before any alias resolution.
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
  -- migration 063 (finding #6): project_aliases resolves the SHARED
  -- prefix_canonical, not each raw_label -- a merge on the group's current
  -- canonical moves every member of that group in one step. 'person' is a
  -- pass-through (canonical_label = prefix_canonical), byte-identical to
  -- 055/060.
  select
    pc.raw_label,
    case
      when p_kind = 'project' then public.project_alias_resolve(p_user_id, pc.prefix_canonical)
      else pc.prefix_canonical
    end as canonical_label
  from prefix_collapsed pc
$$;

comment on function public.claims_browse_entity_labels(uuid, text, boolean, boolean) is
  'Curated, alias-resolved, case-insensitive-prefix-collapsed label set for the Memory browser''s People/Projects facets (migration 055, extended by 060, fixed by 063 finding #6). CLAIMS-FIRST: distinct kg_claims.name for p_kind (person|project) from the visible population (claim_browse_grounding), optionally unioned with code_projects.display_name (p_include_code_projects, projects only). The 055 prefix-collapse runs FIRST over raw labels (unchanged); for p_kind=''project'', project_alias_resolve then resolves the resulting SHARED prefix_canonical (depth-capped at 5, cycle-safe) -- so a manual/seeded alias on a group''s canonical moves the whole group, never splits it. ''person'' behaviour is byte-identical to 055/060 (no resolve step).';

-- Grants unchanged from 055/060 (same signature -- CREATE OR REPLACE keeps
-- existing privileges; no re-grant needed).
