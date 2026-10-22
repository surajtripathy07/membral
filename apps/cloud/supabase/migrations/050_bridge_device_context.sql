-- ============================================================
-- 050_bridge_device_context.sql
-- Bridge demo (stopgap, follow-on to 048): device identity + turn-zero
-- context selection.
--
-- Device identity closes a real gap in 048's design: `bridge_claim_next_command`
-- claimed the oldest pending command for a USER, with no notion of WHICH
-- machine should run it. That's fine when only one `membral agent` daemon is
-- ever running, but breaks the moment a user runs the agent on two machines
-- (or runs `membral continue` on a laptop, then tries to continue that same
-- CLI session from a desktop's daemon) — a `continue_session` command needs
-- the transcript-holding machine specifically, or it 400s inside `claude
-- --resume`. `devices` + `bridge_sessions.device_id` / `agent_commands.device_id`
-- let a command be pinned to a specific machine (or left NULL — any machine
-- may claim it, e.g. a fresh `start_session`).
--
-- `devices.id` is CLIENT-generated (the CLI's ~/.membral/device.json, not
-- gen_random_uuid() here) — the cloud only ever upserts a row a device
-- already decided its own id for, so no default.
--
-- context_selection is NOT this migration's concern — a parallel in-flight
-- change owns that column's read/write path; this migration only adds it so
-- that work isn't blocked on a migration-ordering dependency.
-- ============================================================

-- ------------------------------------------------------------
-- devices: one row per (user, machine). Upserted by GET /api/bridge/agent/next
-- on every poll (last_seen_at bump), so "is the agent online" is just
-- `now() - last_seen_at < 10s` at read time (see GET /api/bridge/devices).
-- ------------------------------------------------------------
create table public.devices (
  id             uuid not null,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  name           text not null,
  platform       text,
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now(),
  primary key (id),
  unique (user_id, id)
);

create index idx_devices_user_last_seen
  on public.devices (user_id, last_seen_at);

alter table public.devices enable row level security;

create policy "devices: users see own rows" on public.devices
  for select using (auth.uid() = user_id);
create policy "devices: users insert own rows" on public.devices
  for insert with check (auth.uid() = user_id);
create policy "devices: users update own rows" on public.devices
  for update using (auth.uid() = user_id);
create policy "devices: users delete own rows" on public.devices
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- bridge_sessions.device_id: the machine this session is pinned to (NULL =
-- unpinned — any device's daemon may claim its next command). Set at
-- creation for `membral continue` origin (that machine holds the interactive
-- CLI session), or later once POST /api/bridge/agent/result reports the
-- first cliSessionId for a web-originated session.
-- ------------------------------------------------------------
alter table public.bridge_sessions
  add column device_id uuid references public.devices(id) on delete set null;

create index idx_bridge_sessions_device
  on public.bridge_sessions (device_id);

-- ------------------------------------------------------------
-- bridge_sessions.context_selection: the user's turn-zero context selection
-- (owned by a parallel change, not this one — see this migration's header).
-- ------------------------------------------------------------
alter table public.bridge_sessions
  add column context_selection jsonb;

-- ------------------------------------------------------------
-- agent_commands.device_id: which machine must claim this command. Set at
-- enqueue time (continue_session inherits bridge_sessions.device_id;
-- start_session is NULL unless the caller pins one) and again by
-- bridge_claim_next_command() itself on claim, so a claimed-but-not-yet-
-- resolved command's device is visible without joining bridge_sessions.
-- ------------------------------------------------------------
alter table public.agent_commands
  add column device_id uuid references public.devices(id) on delete set null;

create index idx_agent_commands_device
  on public.agent_commands (device_id);

-- ============================================================
-- bridge_claim_next_command: replaces 048's 1-arg version. Same FOR UPDATE
-- SKIP LOCKED shape, now additionally scoped to commands this device is
-- allowed to run: unpinned (device_id IS NULL) or pinned to p_device_id.
-- Claiming stamps device_id = p_device_id, so an unpinned command becomes
-- pinned to whichever daemon actually picked it up.
-- ------------------------------------------------------------
drop function if exists public.bridge_claim_next_command(uuid);

create function public.bridge_claim_next_command(p_user_id uuid, p_device_id uuid)
returns setof public.agent_commands
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.agent_commands
     set status = 'claimed',
         claimed_at = now(),
         device_id = p_device_id
   where id = (
     select id
       from public.agent_commands
      where user_id = p_user_id
        and status = 'pending'
        and (device_id = p_device_id or device_id is null)
      order by created_at
      limit 1
      for update skip locked
   )
  returning *;
$$;

comment on function public.bridge_claim_next_command(uuid, uuid) is
  'Bridge demo: atomically claims the oldest pending agent_commands row for p_user_id that p_device_id is allowed to run (device_id IS NULL or = p_device_id), stamping device_id = p_device_id on claim. FOR UPDATE SKIP LOCKED avoids double-claiming across concurrent daemon polls. Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only — see 048''s header. Replaces the 1-arg version from 048 (dropped above).';

revoke all on function public.bridge_claim_next_command(uuid, uuid) from public;
revoke all on function public.bridge_claim_next_command(uuid, uuid) from anon;
revoke all on function public.bridge_claim_next_command(uuid, uuid) from authenticated;
grant execute on function public.bridge_claim_next_command(uuid, uuid) to service_role;
