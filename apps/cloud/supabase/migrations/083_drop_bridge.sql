-- ============================================================
-- 083_drop_bridge.sql
-- 2026-09-12 refocus goal, W2 kill list: the bridge ("Continue in Claude
-- Code" — web-queued Claude Code sessions via a local `membral agent`
-- daemon, plus its OpenRouter backend) is deleted from the product. This
-- drops the bridge-only tables, functions, columns, and index introduced
-- in migrations 048/050/067/072/073/075.
--
-- NOT dropped, and deliberately so:
--   - public.devices (migration 050): despite its header calling it
--     "Bridge demo... device identity", it is ALSO used by the live,
--     kept device-authorization sign-in flow — POST /api/auth/device/approve
--     (lib/device-auth.ts's approveDeviceAuth) calls upsertOwnedDevice to
--     register/refresh a devices row on every `membral setup`/`login`
--     approval, and public.api_keys.device_id (migration 052) has a live
--     FK to it. Only the bridge-specific COLUMNS migration 050 added to
--     OTHER tables (bridge_sessions.device_id, agent_commands.device_id)
--     go away, and they go away automatically with those tables below —
--     public.devices itself, its indexes, and its RLS policies are
--     untouched by this migration.
--   - public.code_cross_links (migration 029): unrelated. It is the
--     one-directional link from the code lane to the chat graph — "bridge"
--     in its own migration's comments is a plain-English description of
--     that linking role, not a reference to this deleted feature. No
--     statement in this migration names it.
--   - public.search_conversations (last redefined in migration 075,
--     alongside two bridge functions in the SAME file): this is the
--     general /search feature's RPC (lib/search.ts's callSearchRpc),
--     unrelated to the bridge. Migration 075 touched it only because it
--     shared a return-type-conversion fix with the two bridge functions
--     dropped below — this migration does not touch it.
--   - apps/cloud/src/lib/kg/** and everything it reads/writes: out of
--     scope for this kill list by explicit instruction. bridge_about_you
--     (migration 073) reads kg_claims/kg_claim_lifecycle via
--     claim_browse_grounding() and public.memory_key() — dropping the
--     FUNCTION below does not touch either of those, or any kg_* table.
--
-- CASCADE use: NONE of the DROPs below need CASCADE. bridge_messages and
-- agent_commands both carry a foreign key TO bridge_sessions, so they are
-- dropped first, in that order, before bridge_sessions itself — by the
-- time bridge_sessions is dropped nothing still references it. No view,
-- policy, or trigger anywhere in the migration history reads any of these
-- three tables (verified by grepping every migration for their names) and
-- none of the three has a trigger of its own.
-- ============================================================

-- ------------------------------------------------------------
-- Tables. bridge_messages and agent_commands first (both FK-reference
-- bridge_sessions), then bridge_sessions itself. Every column, index, and
-- RLS policy in migrations 029/048/050/067/072 that lives ON these three
-- tables (bridge_sessions.device_id/context_selection/archived_at,
-- agent_commands.device_id, idx_bridge_sessions_user_active_updated, the
-- four owner-only RLS policies per table, etc.) drops automatically with
-- the table it's on — no separate statement needed for any of them.
-- ------------------------------------------------------------
drop table if exists public.bridge_messages;
drop table if exists public.agent_commands;
drop table if exists public.bridge_sessions;

-- ------------------------------------------------------------
-- Functions. Signatures match each function's LAST (authoritative)
-- definition — bridge_claim_next_command and bridge_related_by_conversation
-- were both last redefined in migration 075 (returns jsonb, not the
-- migration-048/050/055 `returns table`/`returns setof` shapes); dropping
-- the current signature is sufficient, there is no earlier overload left
-- to also drop (each migration's own `drop function if exists` already
-- retired the prior one).
-- ------------------------------------------------------------
drop function if exists public.bridge_claim_next_command(uuid, uuid);
drop function if exists public.bridge_about_you(uuid, int);
drop function if exists public.bridge_related_by_conversation(uuid, vector(1536), uuid, int);

-- ------------------------------------------------------------
-- profiles.openrouter_api_key (migration 048): per-user OpenRouter key for
-- the bridge's 'openrouter' backend. Plain column, no index, no
-- constraint referencing it — safe to drop outright.
-- ------------------------------------------------------------
alter table public.profiles
  drop column if exists openrouter_api_key;

-- ------------------------------------------------------------
-- idx_conversations_title_fts (migration 067): added ONLY to back
-- GET /api/bridge/context's title-only FTS leg (see that migration's own
-- header — "there is no query to index" anywhere else). `conversations`
-- itself, and its other index idx_conversations_fts (migration 001/010,
-- used by the general /search feature and mcp_search_unified), are
-- untouched.
-- ------------------------------------------------------------
drop index if exists public.idx_conversations_title_fts;

-- ------------------------------------------------------------
-- Dead-route audit (W2, scripts/dead-routes.sh): two routes with no
-- in-repo caller, unrelated to the bridge, deleted in the same pass.
-- Neither wrote to a table only it used — code-sessions/mirror's
-- mirrorCodeSessionsToConversations() writes `conversations`, already
-- written by POST /api/code-sessions and others; kg/resolve-entities'
-- kg_resolve_entities() RPC (migration 026, untouched here) mutates
-- kg_nodes/kg_edges, written by many other paths. No table drop needed
-- for either.
-- ------------------------------------------------------------
