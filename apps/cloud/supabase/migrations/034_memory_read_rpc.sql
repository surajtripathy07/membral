-- ============================================================
-- 034_memory_read_rpc.sql
-- ADR 0027 M1 (issue #14) — read RPC for Memory nodes (kg_node_type.'Memory',
-- added in migration 033).
--
-- SPLIT from 033 on purpose: PG17 rejects a new enum value being referenced
-- anywhere in the same transaction that added it, and the Supabase CLI wraps
-- every migration file in exactly one transaction. Referencing
-- `type = 'Memory'` here only works because 033 already committed.
--
-- Security model — IDENTICAL to the migration 015 / 025 read-RPC family (NOT
-- migration 016's service-role / p_user_id shape, which is for the local MCP
-- server's own service-role key and has no place here):
--   * SECURITY INVOKER, so the call runs as the calling end user and RLS
--     (auth.uid() = user_id on kg_nodes) is enforced — the belt.
--   * As suspenders, an explicit `user_id = auth.uid()` predicate on the
--     kg_nodes access. No p_user_id argument exists, so there is nothing for
--     a caller to spoof (see 015_kg_read_rpcs.sql:11-23).
--   * search_path pinned to `public, pg_temp`.
--   * `deleted_at is null` (soft-delete) and `status is distinct from
--     'archived'` (issue #60 phase-1 archive semantics — hidden from browse,
--     same rule 015/025 apply to their listing CTEs) are both applied.
--   * EXECUTE revoked from public/anon; granted only to `authenticated`.
--
-- ADR 0027 Q5 says this RPC should be "security definer, service_role-only" —
-- see the "Implementation note (M1, 2026-07-25)" appended to Q5 in
-- docs/adr/0027-memories-vs-kg-reconciliation.md for why that sentence is not
-- followed: it self-contradicts (the 015/025 family it cites in the same
-- breath is invoker + authenticated-execute), and /memories is a logged-in
-- user-session surface, not an admin/service path. Adversarial review
-- confirmed the ACLs here are byte-identical to kg_read_path's.
--
-- LOUD FAILURE ON NO SESSION (driver decision, adversarial-review MINOR-5):
-- SECURITY INVOKER + an explicit `auth.uid()` predicate is normally enough —
-- a caller with no session just matches zero rows. But a future caller that
-- reaches this RPC through a service-role admin client (e.g. an M4 repoint
-- done carelessly) would have RLS bypassed entirely by the service_role, and
-- `auth.uid()` would be NULL, so `user_id = auth.uid()` would silently match
-- nothing rather than the "everyone's memories" a broken caller might expect.
-- Silent-empty is the wrong failure mode for that mistake: it looks like
-- success. So this function is plpgsql (not sql — `language sql` cannot
-- RAISE) and explicitly raises when there is no end-user session, forcing
-- that misuse to fail loudly instead of returning 200 + [].
--
-- No new indexes: idx_kg_nodes_user_type (migration 011) already covers
-- (user_id, type), so `type = 'Memory'` is index-backed for free.
--
-- M1 writes zero Memory rows (Stage M — ADR 0027 Q3 — is a later milestone),
-- so on any real database today this RPC is expected to return an empty
-- `memories` array for a real end-user session. That is the correct,
-- mechanical proof that M1 is read/write-inert: the RPC exists, type-checks,
-- and errors loudly on misuse, but there is nothing yet for a valid session
-- to return.
-- ------------------------------------------------------------
-- kg_read_memories(p_kind, p_limit): a user's Memory nodes, newest first.
--   p_kind  — optional filter on kg_nodes.kind (one of MEMORY_KINDS in
--             packages/core/src/graph.ts: decision | preference | pattern |
--             insight). Free text, no CHECK constraint (ADR 0027 rider —
--             kinds must be able to change freely), so this is a plain
--             equality filter, not an enum comparison.
--   p_limit — row cap, default 50, hard-capped at 200 regardless of what the
--             caller asks for.
-- Raises if called with no end-user session (auth.uid() is null) instead of
-- silently returning an empty array.
-- ------------------------------------------------------------
create or replace function public.kg_read_memories(p_kind text default null, p_limit int default 50)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'kg_read_memories requires an end-user session';
  end if;

  with rows as (
    select id, label, kind, confidence, status, created_at, source_conversation_id
    from public.kg_nodes
    where user_id = auth.uid() and type = 'Memory' and deleted_at is null
      and status is distinct from 'archived'
      and (p_kind is null or kind = p_kind)
    order by created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  )
  select jsonb_build_object(
    'memories',
    coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from rows r), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- Lock down execution: only logged-in end users, invoking as themselves.
-- ------------------------------------------------------------
revoke all on function public.kg_read_memories(text, int) from public;
revoke all on function public.kg_read_memories(text, int) from anon;
grant execute on function public.kg_read_memories(text, int) to authenticated;
