-- ============================================================
-- 019_kg_stage_a_naming_fallback.sql
-- Flag Stage A tree rows whose label came from the deterministic sanitizer
-- fallback, not the LLM (issue #79 — observed literal 'null' LifeArea/Item
-- labels and 'null' kind strings; created_by_model=gpt-4o-mini).
--
-- stage-a.ts's naming guard rejects empty/whitespace/'null'/'undefined'/'none'
-- LLM names (case-insensitive) and substitutes a deterministic name (the
-- cluster's top central_topic, or "Untitled group"/"General"). This column
-- records when that substitution fired, so promote.ts can carry the flag onto
-- the live node (kg_nodes.props.naming_fallback) for later review —
-- prevention + auditability, not silent masking.
-- ============================================================

alter table public.kg_stage_a_tree
  add column naming_fallback boolean not null default false;
