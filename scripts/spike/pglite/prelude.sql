-- Mirrors supabase/postgres init-scripts/00000000000000-initial-schema.sql (roles, schema grants, default privileges)
-- and the PostgREST-claims form of the auth helper functions. Source fetched 2026-10-25 from
-- https://github.com/supabase/postgres (migrations/db/init-scripts/00000000000000-initial-schema.sql).
create schema if not exists extensions;
create schema if not exists auth;
create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls;
create role authenticator noinherit nologin;
grant anon to authenticator; grant authenticated to authenticator; grant service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}', created_at timestamptz default now());
-- GoTrue's current definitions: legacy per-claim GUC first, then the request.jwt.claims JSON.
create or replace function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000001','local@membral.local');
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
set search_path = public, extensions;
alter role current_user set search_path = public, extensions;
