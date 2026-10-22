-- ============================================================
-- 106_thread_dismissals.sql
-- Goal 2026-09-26 P5 review F1/F3/F8 (D-051): an Open threads dismissal
-- ("resolved elsewhere" / "not a delivery item") gets its own table.
-- Depends on: 084 (session_memories), 099 (code_session_issues).
-- ============================================================
--
-- WHY a table and not a `decision` row in session_memories (the W7 shape):
--   * D-051 — threads are dashboard-only. A session_memories row is served
--     by every memory read path (MCP session_summary, memory_recall with
--     durable_only=false, the memory browser); a marker filter would have to
--     be repeated in each of them and in every future one. A table nothing
--     but lib/threads reads cannot leak.
--   * B1 — the W7 row claimed `turn_role user, turn_idx 0` of the ref's latest
--     session: a receipt for a turn that never said it.
--   * F1 — identity is (kind, ref): a glab-style issue #17 and MR !17 share the
--     stored ref string `host/owner/repo#17`, so the unique key carries kind.
--   * F8 — the dashboard reads this table whole (paginated), never a 1000-row
--     slice of all decision memories.
--
-- WHO WRITES: POST /api/threads/dismiss with the caller's cookie client
-- (insert-own policy; re-dismiss = update-own of created_at + reason only).
-- WHO READS: lib/threads/queries.ts (select-own).
-- Re-dismiss (review B1): a thread dismissed at T0 re-opens when a later
-- build action lands (open-threads.ts compares against created_at). Clicking
-- Dismiss again must move created_at forward, so the owner may UPDATE their
-- own row — but only the two columns (column-level grant), so user_id, kind
-- and ref stay immutable. Chosen over a service-role write: RLS stays the
-- second check and no code path holds a key that bypasses it.
-- No delete policy: a dismissal is a fact about a click.

create table if not exists public.thread_dismissals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  ref         text not null check (char_length(ref) between 1 and 500),
  kind        text not null check (kind in ('issue', 'merge_request')),
  reason      text not null check (reason in ('resolved_elsewhere', 'not_delivery_item')),
  created_at  timestamptz not null default now(),
  unique (user_id, kind, ref)
);

comment on table public.thread_dismissals is
  'Open threads the owner dismissed on Today (goal 2026-09-26 P5). Dashboard-only (D-051): no memory, MCP or preamble path reads it.';

alter table public.thread_dismissals enable row level security;

drop policy if exists "thread_dismissals_select_own" on public.thread_dismissals;
create policy "thread_dismissals_select_own"
  on public.thread_dismissals for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "thread_dismissals_insert_own" on public.thread_dismissals;
create policy "thread_dismissals_insert_own"
  on public.thread_dismissals for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "thread_dismissals_update_own" on public.thread_dismissals;
create policy "thread_dismissals_update_own"
  on public.thread_dismissals for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.thread_dismissals from anon;
revoke update, delete, truncate, references, trigger on public.thread_dismissals from authenticated;
grant select, insert on public.thread_dismissals to authenticated;
grant update (created_at, reason) on public.thread_dismissals to authenticated;

-- Move W7-shaped dismissal rows out of session_memories so no memory path
-- keeps serving them. The selector is the exact row shape the W7 writer
-- (9c703a4 lib/threads/queries.ts writeThreadDismissal) produced — never a
-- text prefix alone, which an extracted decision can share. Only live rows
-- move (a retired row is not a dismissal anyone still holds), and the
-- originals are RETIRED (archive over delete), not deleted. Idempotent: a
-- re-run finds no live W7 rows left.
with moved as (
  update public.session_memories m
  set retired_at = now(), retire_reason = 'moved_to_thread_dismissals'
  where m.kind = 'decision'
    and m.source = 'hook'
    and m.turn_idx = 0
    and m.turn_role = 'user'
    and m.quote is null
    and m.durable = false
    and m.retired_at is null
    and m.ref_kind in ('mr', 'issue')
    and m.ref is not null
    and char_length(m.ref) between 1 and 500
    and (m.text = 'Open thread dismissed (resolved elsewhere): ' || m.ref
      or m.text = 'Open thread dismissed (not a delivery item): ' || m.ref)
  returning m.user_id, m.ref, m.ref_kind, m.text, m.created_at
)
insert into public.thread_dismissals (user_id, ref, kind, reason, created_at)
select
  w.user_id,
  w.ref,
  case when w.ref_kind = 'mr' then 'merge_request' else 'issue' end,
  case when w.text like 'Open thread dismissed (not a delivery item):%' then 'not_delivery_item' else 'resolved_elsewhere' end,
  w.created_at
from moved w
on conflict (user_id, kind, ref) do nothing;
