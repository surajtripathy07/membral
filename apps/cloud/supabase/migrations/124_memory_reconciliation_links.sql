-- ============================================================
-- 124_memory_reconciliation_links.sql
-- L1 (recall-precision, docs/design/current-truth-recall.md, D-078): write-time reconciliation links.
--
-- Additive only. A projection on session_memories says "a newer record replaced this one":
--   superseded_by  the replacing (newer) record
--   supersede_kind supersedes | resolves | duplicates
--   valid_from / valid_to  the span the record was current (valid_to = the replacement's session start; valid_from
--   stays NULL until a write sets it: no row is rewritten here)
-- and a link table keeps every verdict (including refines/unrelated, which never hide anything), so a backfill
-- resumes and never re-judges a pair. Hiding is a projection only: nothing here sets retired_at, and clearing the
-- three projection columns (where run_id matches in memory_links) undoes a run.
--
-- Locking, honestly: ADD COLUMN (nullable, no default) takes ACCESS EXCLUSIVE on session_memories for a moment and
-- rewrites no row. The two new partial indexes on session_memories are built without CONCURRENTLY, so writes to
-- the table wait for the builds (seconds at prod size). Run off-peak.
--
-- Deploy order: migrate before the app. The serve path reads the new columns only when they exist.
-- ============================================================

set search_path = public, extensions;

alter table public.session_memories
  add column if not exists superseded_by uuid references public.session_memories(id) on delete set null,
  add column if not exists supersede_kind text check (supersede_kind in ('supersedes', 'resolves', 'duplicates')),
  add column if not exists valid_from timestamptz,
  add column if not exists valid_to timestamptz;

comment on column public.session_memories.superseded_by is
  'L1: the newer record that replaced this one (projection of memory_links; cleared by undo). Never retires the row.';
comment on column public.session_memories.valid_to is
  'L1: when the replacing record''s session began; NULL = still current.';

create index if not exists session_memories_current_idx
  on public.session_memories (user_id, code_project_id)
  where valid_to is null and retired_at is null;

create index if not exists session_memories_superseded_by_idx
  on public.session_memories (superseded_by)
  where superseded_by is not null;

create table if not exists public.memory_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  -- from_id is always the NEWER record, to_id the older one it replaces (the model never sets direction).
  from_id uuid not null references public.session_memories(id) on delete cascade,
  to_id uuid not null references public.session_memories(id) on delete cascade,
  relation text not null check (relation in ('supersedes', 'resolves', 'duplicates', 'refines', 'unrelated')),
  quote text,
  session_id uuid,
  turn_idx int,
  verified boolean not null default false,
  model text,
  prompt_version text,
  run_id text,
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, from_id, to_id, prompt_version),
  check (from_id <> to_id)
);

create index if not exists memory_links_user_to_idx on public.memory_links (user_id, to_id);
create index if not exists memory_links_from_idx on public.memory_links (from_id);
create index if not exists memory_links_to_idx on public.memory_links (to_id);
create index if not exists memory_links_run_idx on public.memory_links (run_id) where run_id is not null;

-- Both records must belong to the link's user and sit in one project (a link never crosses either).
create or replace function public.memory_links_same_owner() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from public.session_memories m
        where m.id in (new.from_id, new.to_id) and m.user_id = new.user_id) <> 2 then
    raise exception 'memory_links: both records must belong to user %', new.user_id;
  end if;
  if (select count(distinct m.code_project_id) from public.session_memories m
        where m.id in (new.from_id, new.to_id)) <> 1 then
    raise exception 'memory_links: both records must be in one project';
  end if;
  return new;
end;
$$;

drop trigger if exists memory_links_same_owner on public.memory_links;
create trigger memory_links_same_owner before insert or update on public.memory_links
  for each row execute function public.memory_links_same_owner();

-- Readable by its owner; written only by the service role (like memory_merges).
alter table public.memory_links enable row level security;
revoke all on public.memory_links from anon, authenticated;
grant select on public.memory_links to authenticated;

drop policy if exists own_rows on public.memory_links;
create policy own_rows on public.memory_links
  for select to authenticated
  using (user_id = auth.uid());

-- One transaction per plan: every judged pair is stored AND the projection set together, so a link never exists
-- without its projection (and a retry is idempotent: links conflict-skip, projections re-check liveness). SECURITY
-- INVOKER, user-scoped, called by the service role only; the owner trigger above checks user and project per link.
-- A target whose recorded replacement is retired is re-projected (valid_to treated as unset).
create or replace function public.apply_memory_reconciliation(
  p_user_id uuid, p_run_id text, p_model text, p_prompt_version text, p_links jsonb, p_projections jsonb
) returns int
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  hidden int := 0;
begin
  insert into public.memory_links
    (user_id, from_id, to_id, relation, quote, session_id, turn_idx, verified, model, prompt_version, run_id)
  select p_user_id, l.from_id, l.to_id, l.relation, l.quote, l.session_id, l.turn_idx,
         coalesce(l.verified, false), p_model, p_prompt_version, p_run_id
  from jsonb_to_recordset(coalesce(p_links, '[]'::jsonb))
    as l(from_id uuid, to_id uuid, relation text, quote text, session_id uuid, turn_idx int, verified boolean)
  -- A memoised abstention ('unrelated') or an undone link is upgraded by a later hiding verdict; an existing hiding
  -- link of the same relation is refreshed. Any other conflict is left alone.
  on conflict (user_id, from_id, to_id, prompt_version) do update
    set relation = excluded.relation, quote = excluded.quote, session_id = excluded.session_id,
        turn_idx = excluded.turn_idx, verified = excluded.verified, model = excluded.model,
        run_id = excluded.run_id, undone_at = null
    where excluded.relation in ('supersedes', 'resolves', 'duplicates')
      and (memory_links.relation = 'unrelated' or memory_links.undone_at is not null
           or memory_links.relation = excluded.relation);

  -- p_run_id tags links only; projections carry no run id (undo clears them by id, see undoSql).
  -- A projection is applied only with a verified, live hiding link behind it. A row with valid_to set and no
  -- superseded_by is left untouched; one whose recorded replacement is retired is re-projected.
  update public.session_memories m
  set superseded_by = p.superseded_by, supersede_kind = p.supersede_kind, valid_to = p.valid_to
  from jsonb_to_recordset(coalesce(p_projections, '[]'::jsonb))
    as p(id uuid, superseded_by uuid, supersede_kind text, valid_to timestamptz)
  where m.id = p.id and p.id <> p.superseded_by and m.user_id = p_user_id and m.retired_at is null
    and (m.valid_to is null
         or (m.superseded_by is not null
             and not exists (select 1 from public.session_memories r where r.id = m.superseded_by and r.retired_at is null)))
    and exists (select 1 from public.session_memories r
                where r.id = p.superseded_by and r.user_id = p_user_id and r.retired_at is null)
    and exists (select 1 from public.memory_links k
                where k.user_id = p_user_id and k.from_id = p.superseded_by and k.to_id = p.id
                  and k.verified and k.undone_at is null and k.relation = p.supersede_kind
                  and k.relation in ('supersedes', 'resolves', 'duplicates'));
  get diagnostics hidden = row_count;
  return hidden;
end;
$$;

revoke all on function public.apply_memory_reconciliation(uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_memory_reconciliation(uuid, text, text, text, jsonb, jsonb) to service_role;
