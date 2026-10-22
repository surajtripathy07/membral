-- ============================================================
-- 072_bridge_sessions_archived_at.sql
-- Goal 2026-08-27 D8 (bridge session list disambiguation): a 0-turn bridge
-- session (e.g. a web session for a long-running chat
-- created, then abandoned before the CLI backend ever attached, so
-- it has zero bridge_messages) currently has no way to be dismissed from
-- the list — DELETE is available (RLS policy "bridge_sessions: users
-- delete own rows") but is not reversible, and this feature wants a
-- reversible archive per the driver's call.
--
-- `bridge_sessions` (migration 041) has no status/archived column and no
-- generic jsonb column reusable for this — `context_selection` (migration
-- 050) is a different, already-in-use shape (the turn-zero context panel's
-- stored selection), not a status flag. Additive-only: a nullable
-- `archived_at timestamptz`, NULL = active (every existing row stays
-- active on this migration), set = archived, settable back to NULL =
-- unarchive. Same `IF NOT EXISTS` convention as prior additive migrations
-- (037/039/040/051/067) — no CONCURRENTLY needed at this table's size.
--
-- Partial index on (user_id, updated_at) WHERE archived_at IS NULL backs
-- BOTH new query shapes GET /api/bridge/sessions needs: the default
-- exclude-archived filter (`archived_at IS NULL`) and the existing
-- `.eq("user_id", ...).order("updated_at", {ascending:false})` — the table
-- had no updated_at index at all before this (only
-- idx_bridge_sessions_user_created on (user_id, created_at)), so this is
-- also filling that pre-existing gap, not just serving the new filter.
-- ============================================================

alter table public.bridge_sessions
  add column if not exists archived_at timestamptz;

create index if not exists idx_bridge_sessions_user_active_updated
  on public.bridge_sessions (user_id, updated_at)
  where archived_at is null;
