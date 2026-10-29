-- The `auth` schema the local stack needs when GoTrue is gone (Lever 1, docs/design/2026-10-25_docker-free-store.md,
-- "Shared by both rungs: a GoTrue stub"). Applied by `membral local up` BEFORE the app migrations, never on hosted.
-- Idempotent: every statement is `if not exists` / `create or replace`, so it is a no-op on a volume GoTrue already
-- migrated (its auth.users and auth.refresh_tokens win; the columns used below exist in GoTrue's definitions).
-- Roles, schema grants and default privileges mirror supabase/postgres init-scripts/00000000000000-initial-schema.sql.

create schema if not exists extensions;
create schema if not exists auth;
create extension if not exists vector with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit nologin;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- GoTrue-compatible subset of auth.users: every column the app, the stub and the migrations read.
create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud varchar(255) default 'authenticated',
  role varchar(255) default 'authenticated',
  email varchar(255) unique,
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  phone text,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb default '{"provider":"email","providers":["email"]}',
  raw_user_meta_data jsonb default '{}',
  is_super_admin boolean,
  banned_until timestamptz,
  deleted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
-- A volume created by an earlier build of this stub lacks these; GoTrue's own table already has both.
-- The stock image ships a stripped auth.users (create-if-not-exists is then skipped), so add every column used.
alter table auth.users add column if not exists instance_id uuid;
alter table auth.users add column if not exists aud varchar(255) default 'authenticated';
alter table auth.users add column if not exists role varchar(255) default 'authenticated';
alter table auth.users add column if not exists email varchar(255);
alter table auth.users add column if not exists encrypted_password varchar(255);
alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists phone text;
alter table auth.users add column if not exists last_sign_in_at timestamptz;
alter table auth.users add column if not exists raw_app_meta_data jsonb default '{"provider":"email","providers":["email"]}';
alter table auth.users add column if not exists raw_user_meta_data jsonb default '{}';
alter table auth.users add column if not exists is_super_admin boolean;
alter table auth.users add column if not exists banned_until timestamptz;
alter table auth.users add column if not exists deleted_at timestamptz;
alter table auth.users add column if not exists created_at timestamptz default now();
alter table auth.users add column if not exists updated_at timestamptz default now();
alter table auth.users alter column id set default gen_random_uuid();

-- GoTrue-compatible sessions: only the columns the stub writes are guaranteed here (GoTrue's table has more, all nullable).
create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  not_after timestamptz
);

-- GoTrue's refresh-token table shape (rotation: the used token is marked revoked, its child inserted).
create table if not exists auth.refresh_tokens (
  id bigserial primary key,
  instance_id uuid,
  token varchar(255) unique,
  user_id varchar(255),
  revoked boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  parent varchar(255),
  session_id uuid
);
alter table auth.sessions add column if not exists user_id uuid;
alter table auth.sessions add column if not exists created_at timestamptz default now();
alter table auth.sessions add column if not exists updated_at timestamptz default now();
alter table auth.sessions add column if not exists not_after timestamptz;
alter table auth.sessions alter column id set default gen_random_uuid();
alter table auth.refresh_tokens add column if not exists instance_id uuid;
alter table auth.refresh_tokens add column if not exists token varchar(255);
alter table auth.refresh_tokens add column if not exists user_id varchar(255);
alter table auth.refresh_tokens add column if not exists revoked boolean;
alter table auth.refresh_tokens add column if not exists created_at timestamptz default now();
alter table auth.refresh_tokens add column if not exists updated_at timestamptz default now();
alter table auth.refresh_tokens add column if not exists parent varchar(255);
alter table auth.refresh_tokens add column if not exists session_id uuid;
create unique index if not exists refresh_tokens_token_uidx on auth.refresh_tokens (token);
create index if not exists refresh_tokens_user_id_idx on auth.refresh_tokens (user_id);
create index if not exists refresh_tokens_session_id_idx on auth.refresh_tokens (session_id);

-- GoTrue's current definitions: legacy per-claim GUC first, then the request.jwt.claims JSON PostgREST sets.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;

-- Store functions for the in-app GoTrue stub (apps/cloud/src/lib/local/auth-stub). The app reaches Postgres only
-- through PostgREST (schema `public`), so the stub reads and writes `auth` through these service_role-only RPCs.
-- Passwords arrive already bcrypt-hashed; tokens arrive already generated.
create or replace function public.local_auth_user_json(u auth.users, with_hash boolean default false)
returns jsonb language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'id', u.id, 'email', u.email, 'aud', coalesce(u.aud, 'authenticated'), 'role', coalesce(u.role, 'authenticated'),
    'email_confirmed_at', u.email_confirmed_at, 'phone', coalesce(u.phone, ''),
    'last_sign_in_at', u.last_sign_in_at, 'banned_until', u.banned_until,
    'raw_app_meta_data', coalesce(u.raw_app_meta_data, '{}'::jsonb),
    'raw_user_meta_data', coalesce(u.raw_user_meta_data, '{}'::jsonb),
    'created_at', u.created_at, 'updated_at', u.updated_at)
  || case when with_hash then jsonb_build_object('encrypted_password', u.encrypted_password) else '{}'::jsonb end
$$;

create or replace function public.local_auth_find_user(p_id uuid default null, p_email text default null,
                                                       p_with_hash boolean default false)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u auth.users;
begin
  if p_id is not null then
    select * into u from auth.users where id = p_id and deleted_at is null;
  else
    select * into u from auth.users where lower(email) = lower(p_email) and deleted_at is null limit 1;
  end if;
  if not found then return null; end if;
  return public.local_auth_user_json(u, p_with_hash);
end
$$;

create or replace function public.local_auth_list_users(p_page integer, p_per_page integer)
returns jsonb language sql security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'total', (select count(*) from auth.users where deleted_at is null),
    'users', coalesce((select jsonb_agg(public.local_auth_user_json(t)) from (
        select * from auth.users where deleted_at is null order by created_at, id
        limit greatest(p_per_page, 1) offset greatest(p_page - 1, 0) * greatest(p_per_page, 1)) t), '[]'::jsonb))
$$;

create or replace function public.local_auth_create_user(p_email text, p_password_hash text, p_user_meta jsonb,
                                                         p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u auth.users;
begin
  if exists (select 1 from auth.users where lower(email) = lower(p_email)) then
    return jsonb_build_object('error', 'email_exists');
  end if;
  insert into auth.users (aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
  values ('authenticated', 'authenticated', lower(p_email), p_password_hash,
          case when p_confirmed then now() else null end, coalesce(p_user_meta, '{}'::jsonb))
  returning * into u;
  return public.local_auth_user_json(u);
end
$$;

create or replace function public.local_auth_record_sign_in(p_user_id uuid)
returns void language sql security definer set search_path = pg_catalog, public as $$
  update auth.users set last_sign_in_at = now() where id = p_user_id
$$;

-- Inserts a refresh token. The session row is created first when missing: GoTrue's refresh_tokens.session_id has a
-- foreign key to auth.sessions, and a stub-created volume has none, so this works either way.
create or replace function public.local_auth_insert_refresh(p_token text, p_user_id uuid, p_session_id uuid,
                                                            p_parent text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_session_id is not null then
    insert into auth.sessions (id, user_id, created_at, updated_at) values (p_session_id, p_user_id, now(), now())
    on conflict (id) do nothing;
  end if;
  insert into auth.refresh_tokens (token, user_id, revoked, parent, session_id)
  values (p_token, p_user_id::text, false, p_parent, p_session_id);
end
$$;

-- Rotates a refresh token and returns {user_id, session_id, token}, or null when the caller must sign in again.
--   live token      -> marked revoked, child `p_new_token` inserted, child returned
--   revoked < 10 s  -> GoTrue's reuse interval: the token's active child is returned, so parallel refreshes (RSC
--                      prefetches sharing one cookie) all land on the same session instead of logging the user out
--   revoked >= 10 s -> reuse of a spent token: the whole token family (its session) is revoked, null returned
--   older than 30 days, session past not_after, unknown token -> null
-- Rotation and child insert share one statement block under a row lock, so a concurrent call always sees the child.
create or replace function public.local_auth_rotate_refresh(p_token text, p_new_token text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r auth.refresh_tokens; child text;
begin
  select * into r from auth.refresh_tokens where token = p_token for update;
  if not found then return null; end if;
  if r.created_at < now() - interval '30 days' then return null; end if;
  if r.session_id is not null and exists (
       select 1 from auth.sessions s where s.id = r.session_id and s.not_after is not null and s.not_after < now()) then
    return null;
  end if;
  if not coalesce(r.revoked, false) then
    update auth.refresh_tokens set revoked = true, updated_at = now() where id = r.id;
    insert into auth.refresh_tokens (token, user_id, revoked, parent, session_id)
    values (p_new_token, r.user_id, false, p_token, r.session_id);
    if r.session_id is not null then
      update auth.sessions set updated_at = now() where id = r.session_id;
    end if;
    return jsonb_build_object('user_id', r.user_id, 'session_id', r.session_id, 'token', p_new_token);
  end if;
  if r.updated_at >= now() - interval '10 seconds' then
    select c.token into child from auth.refresh_tokens c
     where c.parent = p_token and coalesce(c.revoked, false) = false order by c.id limit 1;
    if child is not null then
      return jsonb_build_object('user_id', r.user_id, 'session_id', r.session_id, 'token', child);
    end if;
  end if;
  -- Reuse outside the interval (or no live child): treat the family as stolen and end the session.
  if r.session_id is not null then
    update auth.refresh_tokens set revoked = true, updated_at = now()
     where session_id = r.session_id and coalesce(revoked, false) = false;
  end if;
  return null;
end
$$;
drop function if exists public.local_auth_consume_refresh(text);

-- scope: global = every refresh token of the user, local = the session, others = all but the session.
create or replace function public.local_auth_revoke(p_user_id uuid, p_scope text, p_session_id uuid)
returns void language sql security definer set search_path = pg_catalog, public as $$
  update auth.refresh_tokens set revoked = true, updated_at = now()
   where user_id = p_user_id::text and coalesce(revoked, false) = false
     and case p_scope
           when 'local' then session_id is not distinct from p_session_id
           when 'others' then session_id is distinct from p_session_id
           else true end
$$;

revoke all on function public.local_auth_user_json(auth.users, boolean) from public, anon, authenticated;
revoke all on function public.local_auth_find_user(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.local_auth_list_users(integer, integer) from public, anon, authenticated;
revoke all on function public.local_auth_create_user(text, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.local_auth_record_sign_in(uuid) from public, anon, authenticated;
revoke all on function public.local_auth_insert_refresh(text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.local_auth_rotate_refresh(text, text) from public, anon, authenticated;
revoke all on function public.local_auth_revoke(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.local_auth_find_user(uuid, text, boolean) to service_role;
grant execute on function public.local_auth_list_users(integer, integer) to service_role;
grant execute on function public.local_auth_create_user(text, text, jsonb, boolean) to service_role;
grant execute on function public.local_auth_record_sign_in(uuid) to service_role;
grant execute on function public.local_auth_insert_refresh(text, uuid, uuid, text) to service_role;
grant execute on function public.local_auth_rotate_refresh(text, text) to service_role;
grant execute on function public.local_auth_revoke(uuid, text, uuid) to service_role;
