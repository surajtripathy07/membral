-- ============================================================
-- 086_memory_retire_reason.sql
-- Memory v1, D3 decision B (2026-09-24): retire-on-write.
-- Depends on: 084 (session_memories).
--
-- A record that fails the grounding check at insert (lib/memory/grounding.ts)
-- is now INSERTED retired (retired_at = now()) instead of stored live with
-- verified = false. `retired_at` alone cannot say WHY a row was retired, and
-- `--reverify` (scripts/memory/backfill.ts) must un-retire ONLY rows retired
-- for failing grounding that now pass — never a row retired by a re-run
-- (`--force`), a text-duplicate supersede, or an assistant-voiced preference
-- repair. Hence one machine-readable reason column:
--   'unverified:<no_quote|quote_not_found|quote_not_specific|ref_not_found>'
--     — failed grounding at write (or at --reverify);
--   'rerun' — retired by a --force re-extraction of the same session;
--   'duplicate' — an exact normalised-text duplicate of a newer live row;
--   'preference_assistant_turn' — backfill.ts --repair-paths' role repair.
-- Free text (no CHECK) so a new reason never needs a migration; NULL on
-- every pre-086 row (no backfill — the maintainer's call: those rows keep
-- `retired_at` with an unknown reason, and --reverify leaves them alone).
-- Serving paths already exclude retired rows (search RPC p_include_retired
-- false; summary/preamble `.is("retired_at", null)`; recall unless the caller
-- opts in), so this column changes no read behaviour.
-- ============================================================

alter table public.session_memories
  add column if not exists retire_reason text;

comment on column public.session_memories.retire_reason is
  'Why retired_at was set: unverified:<reason> | rerun | duplicate | preference_assistant_turn. NULL for live rows and for rows retired before migration 086.';

-- Review v6 round 2, R2-m4: which extraction pass wrote the row. 'user' =
-- the user-turn pass (its receipt must be a USER turn), NULL = the main
-- pass or a pre-086 row. `--reverify` re-checks a 'user' row under the
-- same user-turns-only constraint it was written under, so a repair can
-- never move its receipt onto an assistant turn. No existing column fits:
-- `thread` is the model's sub-goal label and `agent_id` drives serve rank.
alter table public.session_memories
  add column if not exists extraction_pass text;

comment on column public.session_memories.extraction_pass is
  'Which extraction pass wrote the row: user (user-turn pass, receipt must be a user turn) | NULL (main pass, or written before migration 086).';
