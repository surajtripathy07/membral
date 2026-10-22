-- ============================================================
-- 052_api_keys_device_auth.sql
-- Device-code sign-in for the Membral CLI (`membral setup`): a short
-- user-facing code + a long, secret device code, following the shape of the
-- OAuth 2.0 Device Authorization Grant (RFC 8628) / GitHub CLI's device
-- flow. Two tables:
--
--   api_keys              — MULTIPLE keys per user, unlike the single
--                            profiles.api_key_hash/api_key_prefix columns
--                            (issue #83 era, unchanged by this migration).
--                            Device-bound keys minted by the approve flow
--                            below live here. lib/api-keys.ts's
--                            validateApiKey checks profiles FIRST (legacy
--                            behaviour, byte-for-byte unchanged) and only
--                            falls through to this table on a miss.
--
--   device_auth_requests  — one row per `membral setup` run. The CLI POSTs
--                            /api/auth/device/start (no auth) and gets back
--                            a `deviceCode` (long, secret, hashed at rest
--                            here exactly like an lls_ key — see
--                            device_code_hash) and a short `userCode`
--                            (printed to the terminal, e.g. "WM7K-4F2Q").
--                            The user visits /device, signs in if needed,
--                            and approves or denies; the CLI polls
--                            /api/auth/device/poll with its deviceCode
--                            until the row is resolved.
--
-- Two columns on device_auth_requests go beyond the task brief's original
-- bullet list — both load-bearing, not decoration, so documented at length
-- here rather than silently added:
--
--   device_id (nullable, NO FK): the CLI's own client-generated device id
--   (packages/cli/src/device.ts's ~/.membral/device.json `id` — same
--   convention as migration 050's devices.id) threaded through from start
--   to approve, so approve knows which devices row to bind the new key to.
--   NO FK because at start time that devices row usually does NOT exist yet
--   — a brand-new device's devices row is only created BY approve. Same
--   "no FK, fails closed" shape as profiles.api_key_scope_node_id
--   (migration 024) and api_keys.scope_node_id below.
--
--   pending_api_key (text, nullable): the RAW api key, staged here
--   transiently between approve (which mints it) and the first poll that
--   delivers it to the CLI (which reads it once and scrubs the column back
--   to NULL in a best-effort follow-up UPDATE — see lib/device-auth.ts's
--   pollDeviceAuth). Approve only ever persists the HASH into
--   api_keys.key_hash; this column is the one deliberate exception to
--   "never store a raw key," and it exists only because in a device flow
--   the browser (which approves) and the CLI (which needs the raw value)
--   are two different processes — something has to hold the secret for the
--   few seconds between mint and first delivery, same as GitHub's and
--   Vercel's device-flow implementations. `consumed_at` is the atomicity
--   guard: the delivering UPDATE sets `consumed_at = now()` gated on
--   `status = 'approved' AND consumed_at IS NULL`, so two concurrent polls
--   can never both win the race and both receive the key (a single
--   UPDATE ... WHERE ... is atomic under Postgres row-level locking; the
--   loser's WHERE clause simply matches zero rows).
-- ============================================================

-- ------------------------------------------------------------
-- api_keys: multiple keys per user. Same single-scope XOR shape as
-- profiles (migration 029): scope_node_id / scope_code_project_id have NO
-- FK on purpose (a stale/deleted id fails CLOSED — an empty result set —
-- never open; see migration 024's header for the full rationale), and the
-- CHECK below encodes "area-scoped XOR code-project-scoped XOR unscoped" at
-- the schema level, mirroring profiles_api_key_single_scope.
-- ------------------------------------------------------------
create table public.api_keys (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  key_hash                 text not null unique,
  key_prefix               text not null,
  device_id                uuid references public.devices(id) on delete set null,
  label                    text,
  scope_node_id            uuid,
  scope_code_project_id    uuid,
  created_at               timestamptz not null default now(),
  last_used_at             timestamptz,
  revoked_at               timestamptz,
  constraint api_keys_single_scope
    check (num_nonnulls(scope_node_id, scope_code_project_id) <= 1)
);

comment on column public.api_keys.scope_node_id is
  'Area scope (mirrors profiles.api_key_scope_node_id, issue #83): NULL = unscoped, else a public.kg_nodes.id. No FK on purpose — see this migration''s header.';
comment on column public.api_keys.scope_code_project_id is
  'Code-project scope (mirrors profiles.api_key_scope_code_project_id, ADR 0021 Q7): NULL = unscoped, else a public.code_projects.id. No FK on purpose — see this migration''s header.';
comment on column public.api_keys.device_id is
  'Device this key was minted for via the device-auth approve flow below (POST /api/auth/device/approve). NULL for a key not tied to a specific device. ON DELETE SET NULL: deleting a device must never cascade-delete the key it authorized.';
comment on table public.api_keys is
  'Multiple lls_ API keys per user (device-code sign-in, migration 052). Coexists with the legacy single-key profiles.api_key_hash/api_key_prefix columns — see lib/api-keys.ts''s validateApiKey, which checks profiles first, then falls through here.';

-- key_hash already gets a unique index from the UNIQUE constraint above —
-- validateApiKey's `.eq("key_hash", hash)` lookup uses it directly.
create index idx_api_keys_user on public.api_keys (user_id);

alter table public.api_keys enable row level security;

create policy "api_keys: users see own rows" on public.api_keys
  for select using (auth.uid() = user_id);
create policy "api_keys: users insert own rows" on public.api_keys
  for insert with check (auth.uid() = user_id);
create policy "api_keys: users update own rows" on public.api_keys
  for update using (auth.uid() = user_id);
create policy "api_keys: users delete own rows" on public.api_keys
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- device_auth_requests: see this migration's header for device_id /
-- pending_api_key. RLS enabled with NO policies at all — every route in
-- this feature (start/poll/approve/deny) talks through the service-role
-- client, which bypasses RLS. Unlike api_keys above, an ordinary
-- authenticated user has no business reading this table directly (it holds
-- hashed secrets and, transiently, a raw one) — same "service-role-only,
-- RLS enabled, zero policies" shape as rate_limit_hits (migration 028).
-- ------------------------------------------------------------
create table public.device_auth_requests (
  id                 uuid primary key default gen_random_uuid(),
  device_code_hash   text not null unique,
  user_code          text not null unique,
  device_id          uuid,
  device_name        text,
  device_platform    text,
  status             text not null default 'pending'
                       check (status in ('pending', 'approved', 'denied', 'expired')),
  user_id            uuid references public.profiles(id) on delete cascade,
  api_key_id         uuid references public.api_keys(id) on delete set null,
  pending_api_key    text,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '10 minutes'),
  approved_at        timestamptz,
  consumed_at        timestamptz
);

comment on column public.device_auth_requests.device_id is
  'The CLI''s own client-generated device id (packages/cli/src/device.ts, same convention as devices.id from migration 050), carried from start through to approve. No FK — see this migration''s header.';
comment on column public.device_auth_requests.pending_api_key is
  'Transient staging for the RAW api key between approve (mint) and the first poll (deliver-once, then scrubbed to NULL). Never the long-term source of truth — api_keys.key_hash is. See this migration''s header for the race-safety argument.';
comment on table public.device_auth_requests is
  'One row per `membral setup` device-code sign-in run (migration 052). user_code is shown to the human ("WM7K-4F2Q"); device_code_hash is the SHA-256 of the secret the CLI polls with. Rows are not deleted on expiry/denial — they age out; no sweep job is wired up in this stopgap.';

create index idx_device_auth_requests_status_expires
  on public.device_auth_requests (status, expires_at);

alter table public.device_auth_requests enable row level security;
