-- 117: session_memories carries the title of the issue/MR its ref names, and,
-- on an MR/PR ref, the issue that MR addresses (W3 D10, PROMPT_VERSION v18).
--
-- * ref_title — the item's own title, kept only when it appears verbatim
--               (whitespace-normalised, case-insensitive) in the record's
--               receipt turn, e.g. the output of an issue-view command.
-- * ref_issue — on an MR/PR ref only: the issue it addresses, kept only when
--               ONE verbatim quote names both numbers ("opened !14 for #12").
-- * ref_issue_basis — how the session links them (D10, maintainer 2026-10-04,
--               "LLM link by meaning now"): 'stated' (one quote names both)
--               or 'inferred' (the session's meaning; the issue must still
--               appear in the session). Set exactly when ref_issue is set.
--               Named ref_issue (not issue_ref) so it sorts with ref/ref_kind/
--               ref_title: every ref_* column describes the same `ref`.
--
-- Both are grounded in lib/memory/merge.ts's groundRecord; an ungrounded value
-- is dropped (null), never the record. Additive and nullable: existing rows
-- stay null until re-extracted. Constraints are added NOT VALID, then
-- validated, so the ALTER takes no long lock while existing rows are checked.

alter table public.session_memories
  add column if not exists ref_title text,
  add column if not exists ref_issue text,
  add column if not exists ref_issue_basis text;

alter table public.session_memories
  drop constraint if exists session_memories_ref_title_check,
  drop constraint if exists session_memories_ref_issue_check,
  drop constraint if exists session_memories_ref_issue_basis_check;

alter table public.session_memories
  add constraint session_memories_ref_title_check
    check (ref_title is null or char_length(ref_title) between 1 and 300) not valid,
  add constraint session_memories_ref_issue_check
    check (ref_issue is null or char_length(ref_issue) between 1 and 400) not valid,
  add constraint session_memories_ref_issue_basis_check
    check (
      (ref_issue is null and ref_issue_basis is null)
      or (ref_issue is not null and ref_issue_basis in ('stated', 'inferred'))
    ) not valid;

alter table public.session_memories validate constraint session_memories_ref_title_check;
alter table public.session_memories validate constraint session_memories_ref_issue_check;
alter table public.session_memories validate constraint session_memories_ref_issue_basis_check;
