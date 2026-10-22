-- ============================================================
-- 082_claims_projected_marker.sql
-- Defect 1 (liveflow phase B, 2026-09-08): a conversation whose pass-1
-- extraction legitimately yields ZERO claims was indistinguishable, in
-- computeClaimsLag's bucket (b) (arrival-loop.ts D7), from one that simply
-- hadn't been projected yet — it counted as "not yet folded" on every call
-- forever, since that bucket's only signal was "does kg_claims have any
-- rows for this conversation_id", and zero rows means the same thing either
-- way. `projection_attempts` (migration 047) does not help: it counts
-- FAILURES only and is reset to 0 on every success, so it reads identically
-- (0) for "never attempted" and "attempted and succeeded with zero claims".
--
-- Fix: a per-conversation marker stamped on every projection SUCCESS
-- (claims-write.ts runClaimsProjection), independent of how many claim rows
-- that run produced. computeClaimsLag's bucket (b) now reads THIS column
-- instead of kg_claims row presence.
-- ============================================================

alter table public.kg_conversations_processed
  add column if not exists claims_projected_at timestamptz;

comment on column public.kg_conversations_processed.claims_projected_at is
  'Set to now() by claims-write.ts runClaimsProjection every time this conversation''s projection succeeds (delete+insert of its kg_claims rows completes without throwing), REGARDLESS of how many rows it wrote — including zero, a legitimate outcome for a conversation with no extractable self/person claims. Distinct from `projection_attempts` (migration 047), which counts only consecutive FAILURES and resets to 0 on success, so it cannot distinguish "never attempted" from "attempted, succeeded, zero claims" (both read as 0). arrival-loop.ts computeClaimsLag''s bucket (b) — "done + hash-matched but no kg_claims coverage" — reads this column instead of kg_claims row presence, so a conversation with a genuine zero-claim outcome clears the lag count instead of counting as "not yet folded" forever (liveflow phase B defect 1, 2026-09-08). Runs unconditionally every cycle in runClaimsProjection (projection re-runs for every status=done row every call, zero-LLM), so this timestamp always reflects the current pass1_result — no explicit invalidation needed on re-extraction.';
