-- ============================================================
-- 028_rate_limits.sql
-- Postgres-backed sliding-window rate limiting (GitHub issue #67).
-- Depends on: nothing (self-contained; no FK to user tables — buckets are
-- opaque text keys built in application code, see lib/rate-limit.ts).
-- ============================================================
--
-- WHY: there was NO rate limiting anywhere. Cost-bearing routes (/api/search
-- embeds every query, /api/extract runs 50+ convs, /api/embed 100, /api/mcp,
-- /api/stats, /api/memories) were unbounded per user, and validateApiKey
-- (lib/api-keys.ts) was a straight sha256 lookup with no failed-attempt
-- throttle — a brute-force surface on the lls_ keyspace.
--
-- NO NEW INFRA (ADR posture): the limiter is backed by this table + one RPC,
-- not Redis/Upstash. The whole check is a single round-trip to the Postgres
-- the app already talks to.
--
-- DESIGN — append-only (bucket_key, hit_at) log, NOT (bucket_key, window_start,
-- count):
--   * A fixed-window counter resets on a boundary and permits a 2x burst
--     straddling that boundary (N at 0:59, N more at 1:00). An append-only log
--     is a TRUE sliding window — every check counts only the hits in the last
--     `window` seconds, so the limit holds across any window position.
--   * Cost is one row per hit, but the function prunes this bucket's aged-out
--     rows on every call, so live rows stay bounded to ~ (active buckets x
--     limit). At our limits (max 300/min/key) that is tiny.
--   * The one composite index (bucket_key, hit_at) serves both the in-window
--     count and the prune delete.
--
-- REAPING: the per-call prune below removes a bucket's own expired rows, so a
-- bucket that keeps getting hit stays trimmed. A bucket that goes silent leaves
-- <= `limit` stale rows behind until it is hit again; an optional out-of-band
-- sweep `delete from public.rate_limit_hits where hit_at < now() - interval
-- '1 day'` (cron / pg_cron) reaps abandoned buckets. Not required for
-- correctness — the in-window count always ignores expired rows.
--
-- RLS / SECURITY: the limiter ONLY ever runs server-side under the
-- SUPABASE_SERVICE_ROLE_KEY (lib/rate-limit.ts getServiceClient). This table is
-- service-role only: RLS is enabled with NO policies (so anon/authenticated get
-- zero rows via PostgREST), and EXECUTE on the RPC is revoked from
-- public/anon/authenticated and granted only to service_role — the exact
-- lock-down pattern used by migrations 014/016 for their service-role RPCs.

-- ------------------------------------------------------------
-- rate_limit_hits: one row per recorded request hit.
-- bucket_key is an opaque application-built key, e.g. "search:user:<uuid>",
-- "mcp:key:<prefix>", "keyfail:ip:<ip>" (see lib/rate-limit.ts).
-- ------------------------------------------------------------
create table if not exists public.rate_limit_hits (
  id         bigint generated always as identity primary key,
  bucket_key text        not null,
  hit_at     timestamptz not null default now()
);

-- Serves both the in-window count (bucket_key = k and hit_at >= start) and the
-- prune delete (bucket_key = k and hit_at < start).
create index if not exists idx_rate_limit_hits_bucket_time
  on public.rate_limit_hits (bucket_key, hit_at);

-- ------------------------------------------------------------
-- rate_limit_check(p_key, p_limit, p_window_seconds) -> jsonb
--   { allowed: bool, retry_after: int (seconds), remaining: int }
--
-- Atomically: prunes this bucket's expired rows, counts the in-window hits,
-- and — if under the limit — records the current hit. Returns the decision.
--
-- ATOMICITY: a per-bucket transaction-scoped advisory lock serializes
-- concurrent checks for the same key, so the count -> insert cannot race two
-- callers through the last free slot. Different buckets never contend (the lock
-- is keyed on hashtext(p_key)).
--
-- retry_after (when blocked) = seconds until the OLDEST in-window hit expires,
-- i.e. the earliest moment the count drops below the limit and a slot frees up.
--
-- SECURITY INVOKER: the only caller is the service-role server client, which
-- bypasses RLS regardless; INVOKER keeps it from being an ambient-authority
-- SECURITY DEFINER. EXECUTE is service_role-only (granted below).
-- ------------------------------------------------------------
create or replace function public.rate_limit_check(
  p_key text,
  p_limit int,
  p_window_seconds int
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_now          timestamptz := now();
  v_window_start timestamptz := v_now - make_interval(secs => p_window_seconds);
  v_count        int;
  v_oldest       timestamptz;
  v_allowed      boolean;
  v_remaining    int;
  v_retry_after  int := 0;
begin
  -- Serialize same-bucket checks for an atomic count -> insert.
  perform pg_advisory_xact_lock(hashtext(p_key));

  -- Cheap prune of this bucket's aged-out rows (keeps the table bounded).
  delete from public.rate_limit_hits
   where bucket_key = p_key and hit_at < v_window_start;

  select count(*), min(hit_at)
    into v_count, v_oldest
    from public.rate_limit_hits
   where bucket_key = p_key and hit_at >= v_window_start;

  if v_count < p_limit then
    insert into public.rate_limit_hits (bucket_key, hit_at) values (p_key, v_now);
    v_allowed     := true;
    v_remaining   := p_limit - v_count - 1;
    v_retry_after := 0;
  else
    v_allowed     := false;
    v_remaining   := 0;
    -- Oldest in-window hit + window = when a slot next frees. At least 1s.
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds) - v_now)))::int
    );
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'retry_after', v_retry_after,
    'remaining', v_remaining
  );
end;
$$;

-- Service-role only (matches 014/016). Ordinary sessions must never call this
-- directly nor read the hits table.
alter table public.rate_limit_hits enable row level security;

revoke all on function public.rate_limit_check(text, int, int) from public;
revoke all on function public.rate_limit_check(text, int, int) from anon;
revoke all on function public.rate_limit_check(text, int, int) from authenticated;
grant execute on function public.rate_limit_check(text, int, int) to service_role;
