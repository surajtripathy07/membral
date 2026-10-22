-- ============================================================
-- 110_code_sessions_short_title.sql
-- A short (3-8 word) title per code session naming the main thing that
-- happened ("Review and merge checkout MR"), shown ahead of every other
-- title source by sessionDisplayTitle (lib/code-sessions/view.ts).
-- Depends on: 029 (code_sessions).
-- ============================================================
--
-- WHO WRITES: lib/code-sessions/summarize.ts (same LLM call as `summary`)
-- and lib/code-sessions/short-title.ts's backfill
-- (scripts/code-sessions/short-titles.ts), service-role client. A title is
-- written only after it passes validateShortTitle (3-8 words, <= 70 chars,
-- never narration like "The user ..."); a rejected title leaves NULL, so the
-- display falls back to title -> summary -> first prompt as before.
-- WHO READS: the owner, through the existing code_sessions select policy.
--
-- Nullable, no default, no backfill here: NULL means "not titled yet", which
-- is what the backfill's candidate filter selects on (resumable).
-- Separate from `title` (029): `title` is the harness's own stored title
-- (written at import for non-git sessions); `short_title` is generated.

alter table public.code_sessions
  add column if not exists short_title text;

comment on column public.code_sessions.short_title is
  'Generated 3-8 word title naming the main work done in the session (validated; NULL = not titled yet). Preferred over title/summary for display.';
