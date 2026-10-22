-- ============================================================
-- 039_claims_core.sql
-- ADR 0030 D5 + ADR 0025 P2 (Q2/Q4/Q4-T/Q9/Q10) — the claims core schema
-- (goal: recenter on the verified record, step 12).
-- Depends on: 001 (profiles, conversations).
-- ============================================================
--
-- WHY THIS IS A FULL CREATE, NOT AN ALTER: ADR 0025 P1 shipped dark
-- (2beb11f) — claims are extracted and stored in `pass1_result` jsonb only.
-- `kg_claims` was never created as a relational table. So this migration
-- ships 0025 Q9's accepted base column set (the materialized projection)
-- TOGETHER WITH ADR 0030 D5's additive columns, in one CREATE TABLE, exactly
-- as D5 states it: "Migration N ships 0025 Q9's accepted column set plus the
-- fields below." There is no earlier version of this table to alter.
--
-- FOUR-STORE SPLIT (ADR 0030 D5): kg_claims is the rebuildable projection
-- (insert-only, fully reconstructable from pass1_result — a re-extraction
-- replaces a conversation's rows wholesale, never UPDATEs). kg_claim_lifecycle
-- is the writer-owned post-extraction state table (promoted/entailment/
-- verification/superseded_by/orphaned_at) — NOT rebuildable, keyed by
-- claim_key so it survives re-extraction. kg_user_claims is the durable
-- SOURCE table for corrections/retirements (never rebuilt, never derived) —
-- membral_correct (goal step 14) writes it; it may ship EMPTY here, but its
-- shape must already be fold-compatible (D5's explicit decision).
--
-- SCOPE OF THIS MIGRATION (goal step 12 / P2 = projection + schema + serving
-- surfaces): the mcp_claims_* RPCs (service-role, p_user_id-scoped) are goal
-- step 13 and are NOT created here — "grants per the two-mechanism split:
-- EXECUTE revoked from authenticated on nothing yet, because there is
-- nothing yet to revoke it from." The three end-user views
-- (kg_claims_servable, kg_claim_lifecycle_orphans, kg_active_blocks) are the
-- only new reachable surfaces this migration adds, and they are RLS +
-- require_auth_uid()-gated exactly like every other session-bound surface in
-- this repo (015/025/034 family), never the 016 service-role shape.
-- membral_correct itself is goal step 14 and is not implemented here either
-- — kg_user_claims exists and is fold-compatible, but nothing writes to it
-- yet.
--
-- TEMPORAL PRECEDENCE (sign-off status block, OQ7 MODIFICATION, 2026-07-26):
-- "a correction decisively supersedes all evidence with t_asserted/
-- conv_order_key up to its own timestamp; evidence from conversations after
-- the correction competes under the ordinary recency rules." This REPLACES
-- D5's body-text `claim_not_blocked()` (which was unconditional/eternal) —
-- the status block is the accepted, later-dated decision and wins per this
-- task's explicit instruction. Implemented as one added conjunct in the
-- blocking anti-join: `coalesce(c.t_asserted, '-infinity'::timestamptz) <=
-- u.t_asserted` (serve_candidates has no `conv_order_key` column of its own —
-- kg_claims.conv_order_key is aliased AS t_asserted in the union, so the
-- comparison reads off that alias on both branches). B1 (fresh adversarial
-- review, 2026-07-26) resolved the NULL-handling question this modification
-- initially left open: undated evidence IS suppressed (coalesced to
-- -infinity), not exempted — see claim_not_blocked()'s own comment for the
-- full reasoning.
--
-- VERSION-BUMP OBLIGATION (MJ5, fresh adversarial review 2026-07-26): goal
-- step 12a's re-extraction (Delta 6, `event_status`) changes the `event` kind's
-- payload_discriminator component list — per D5's own rule, step 12a MUST
-- bump `claim_key_version` (both the DB default below and
-- `claim-key.ts`'s `CURRENT_CLAIM_KEY_VERSION`) from 1 to 2 in the SAME
-- change, and run the executable re-key procedure D5 specifies. See
-- claim-key.ts's own comment on `CURRENT_CLAIM_KEY_VERSION` for the full
-- reasoning and failure mode if skipped.
-- ------------------------------------------------------------

-- ============================================================
-- 1. kg_claims — the rebuildable projection (0025 Q9 + ADR 0030 D5)
-- ============================================================

create table if not exists public.kg_claims (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  conversation_id      uuid not null references public.conversations(id) on delete cascade,

  -- 0025 Q9 base columns -----------------------------------------------
  turn                 int,
  kind                 text,
  subject_key          text,
  about_key            text,
  name                 text,
  relation_class       text,
  relation_raw         text,
  former               boolean,
  modality             text,
  text                 text,
  payload              jsonb not null default '{}'::jsonb,
  evidence_quote       text,
  evidence_key         text,
  conv_order_key       timestamptz,   -- coalesce(conversations.created_at, updated_at); NEVER synced_at (Q4-T)
  durable              boolean,
  confidence           real,
  sensitive            boolean not null default false,
  accepted             boolean not null default false,
  reject_reason        text,

  -- ADR 0030 D5 additive columns ----------------------------------------
  -- receipts (a turn index to a span)
  message_id           uuid,          -- populated once goal step 11 makes message ids addressable; NULL until then
  char_start           int,           -- offset into the ORIGINAL message text; NULL when the verbatim quote
  char_end             int,           --   is not found unchanged there (G3 matches post-normalization)
  quote_hash           text,          -- sha256(normalize(evidence_quote)) — detects re-normalization drift

  -- identity (Delta 2b)
  claim_key            text,          -- hash(claim_key_version, user_id, conversation_id, kind, subject_key,
                                       --   target_key, payload_discriminator); NULL for claims G0 dropped
                                       --   before a kind/payload could even be parsed
  claim_key_version    smallint not null default 1,
  target_key           text,          -- normalize(coalesce(name, about_key, '∅'))
  block_discriminator  text,          -- the narrowed fact identity a correction can match against (own payload)

  -- epistemics, as extracted
  claim_text           text,          -- decontextualized sentence, required on all kinds once Delta 7 lands
  assertion_class      text not null default 'stated',
  bridging_assumptions text[],
  event_status         text,          -- 'planned'|'booked'|'happened'|'cancelled'|NULL; event kind only,
                                       --   populated once Delta 6's re-extraction (goal step 12a) ships it

  -- entity linking (0025 promise, columns only)
  resolved_entity_id   uuid,
  link_basis           text,
  link_candidates      jsonb,

  created_at           timestamptz not null default now(),

  -- N4 (fresh adversarial review, 2026-07-26): "an inference whose assumptions
  -- cannot be stated is a guess, and D4 rule 6 applies" (Delta 17) — enforced
  -- structurally, not just by convention. A G0-dropped row (no parsed claim)
  -- keeps assertion_class at its 'stated' default, so this never fires for
  -- the best-effort G0 rows that have no bridging_assumptions to give.
  constraint kg_claims_inferred_needs_assumptions check (
    assertion_class <> 'inferred'
    or (bridging_assumptions is not null and array_length(bridging_assumptions, 1) > 0)
  )
);

comment on table public.kg_claims is
  'Materialized projection of pass-1 claims (ADR 0025 Q9 + ADR 0030 D5). Insert-only and fully rebuildable from kg_conversations_processed.pass1_result — a re-extraction replaces a conversation''s rows wholesale, never UPDATEs a row. One row per claim occurrence (not per fact identity — claim_key is many-to-one with rows). Written by the P2 projection writer (lib/kg/claims-write.ts).';

create index if not exists idx_kg_claims_user_kind_subject
  on public.kg_claims (user_id, kind, subject_key);

create index if not exists idx_kg_claims_user_kind_about
  on public.kg_claims (user_id, kind, about_key);

create index if not exists idx_kg_claims_user_claim_key
  on public.kg_claims (user_id, claim_key_version, claim_key);

create index if not exists idx_kg_claims_user_conversation
  on public.kg_claims (user_id, conversation_id);

alter table public.kg_claims enable row level security;

drop policy if exists "kg_claims: users see own rows" on public.kg_claims;
create policy "kg_claims: users see own rows" on public.kg_claims
  for select using (auth.uid() = user_id);
drop policy if exists "kg_claims: users insert own rows" on public.kg_claims;
create policy "kg_claims: users insert own rows" on public.kg_claims
  for insert with check (auth.uid() = user_id);
drop policy if exists "kg_claims: users update own rows" on public.kg_claims;
create policy "kg_claims: users update own rows" on public.kg_claims
  for update using (auth.uid() = user_id);
drop policy if exists "kg_claims: users delete own rows" on public.kg_claims;
create policy "kg_claims: users delete own rows" on public.kg_claims
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 2. kg_claim_lifecycle — writer-owned post-extraction state (ADR 0030 D5)
-- ============================================================

create table if not exists public.kg_claim_lifecycle (
  user_id              uuid not null references public.profiles(id) on delete cascade,
  claim_key_version    smallint not null,
  claim_key            text not null,

  promoted             boolean not null default false,
  evidence_fingerprint text,           -- hash(sorted contributing quote_hash / correction evidence_quote)

  -- denormalized re-key basis: the same fields claim_key hashes, kept as plain
  -- columns for no other purpose than giving a claim_key_version bump a join
  -- basis. Never read by serving, never read by the fold. No FK to kg_claims
  -- or conversations on purpose — a correction's lifecycle row denormalizes
  -- its own synthetic "conversation_id" (correction_id), which is not a row
  -- in `conversations` at all.
  conversation_id      uuid,
  kind                 text,
  subject_key          text,
  target_key           text,

  entailment           jsonb,          -- {label, score, model}; NULL until the verifier stage (goal step 12b) runs
  verification         jsonb,          -- {status: unverified|verified|refuted|needs_review, verifier_model, verified_at}
  superseded_by        text,           -- AUDIT ONLY: the correction's claim_key. Written after the fold; never
                                        --   read by the fold, never by serving (claim_serve_eligible does not
                                        --   reference it — suppression is by claim_not_blocked's fact-identity
                                        --   anti-join, not this column)
  update_op            text,           -- 'ADD'|'UPDATE'|'INVALIDATE'|'NOOP' — the op the writer's last run caused
  orphaned_at          timestamptz,    -- set when no kg_claims row currently carries this key; inert, never deleted

  fold_run_id          uuid,           -- the fold/writer run that last touched promoted/superseded_by/update_op
  verify_run_id         uuid,          -- the verifier run that last touched entailment/verification

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  primary key (user_id, claim_key_version, claim_key)
);

comment on table public.kg_claim_lifecycle is
  'Post-extraction state for a claim FACT IDENTITY (claim_key), not for any one kg_claims row. NOT rebuildable from pass1_result — regenerated only by re-running the fold/writer/verifier. Rows created at insert time by the projection (extraction claims) and by membral_correct (correction rows, goal step 14, same transaction). ADR 0030 D5.';

-- superseded_by partial index: the retirement clear-pass scans exactly the
-- rows stamped by a retired correction's key.
create index if not exists idx_kg_claim_lifecycle_superseded_by
  on public.kg_claim_lifecycle (user_id, superseded_by)
  where superseded_by is not null;

-- Not explicitly named by the ADR text; added because kg_claim_lifecycle_orphans
-- (below) scans `where orphaned_at is not null and user_id = ...` per caller,
-- and this is the same partial-index style the ADR already uses for
-- superseded_by and for kg_user_claims' two partial indexes below.
create index if not exists idx_kg_claim_lifecycle_orphaned
  on public.kg_claim_lifecycle (user_id)
  where orphaned_at is not null;

-- MN3 (fresh adversarial review, 2026-07-26): the orphan scan (claims-write.ts's
-- scanOrphans) and the fingerprint drift-reset (claims_lifecycle_upsert below)
-- both select `where user_id = ? and conversation_id = ?` per re-projected
-- conversation — the denormalized re-key basis's own join column, unindexed
-- until now.
create index if not exists idx_kg_claim_lifecycle_user_conversation
  on public.kg_claim_lifecycle (user_id, conversation_id);

alter table public.kg_claim_lifecycle enable row level security;

drop policy if exists "kg_claim_lifecycle: users see own rows" on public.kg_claim_lifecycle;
create policy "kg_claim_lifecycle: users see own rows" on public.kg_claim_lifecycle
  for select using (auth.uid() = user_id);
drop policy if exists "kg_claim_lifecycle: users insert own rows" on public.kg_claim_lifecycle;
create policy "kg_claim_lifecycle: users insert own rows" on public.kg_claim_lifecycle
  for insert with check (auth.uid() = user_id);
drop policy if exists "kg_claim_lifecycle: users update own rows" on public.kg_claim_lifecycle;
create policy "kg_claim_lifecycle: users update own rows" on public.kg_claim_lifecycle
  for update using (auth.uid() = user_id);
drop policy if exists "kg_claim_lifecycle: users delete own rows" on public.kg_claim_lifecycle;
create policy "kg_claim_lifecycle: users delete own rows" on public.kg_claim_lifecycle
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 3. kg_user_claims — durable SOURCE table: corrections + retirements
--    (ADR 0030 D5, Delta 15 / OQ7(a)). NEVER rebuilt, never derived. May
--    ship EMPTY (membral_correct is goal step 14) but must already be
--    fold-compatible — this is the explicit "ship the full mapping now,
--    not later" decision.
-- ============================================================

create table if not exists public.kg_user_claims (
  correction_id        uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,

  claim_key            text,           -- this row's OWN identity (recomputable from name/payload below);
                                        --   NULL on retirement rows, which carry no independent identity
  claim_key_version    smallint not null default 1,

  kind                 text,
  subject_key          text,
  about_key            text,
  target_key           text not null,  -- normalize(coalesce(name, about_key, '∅')) OF THE CORRECTED CLAIM
  block_discriminator  text,           -- computed from the CORRECTED claim's own payload (D5), narrowed per kind

  relation_class       text,           -- REQUIRED on relationship corrections (else the row cannot enter a
  former                boolean,        --   state group and the correction silently no-ops)
  name                 text,           -- mirrors 0025:737 — the asserted entity name
  payload              jsonb,          -- mirrors 0025:737 — the per-kind asserted payload

  claim_text           text,
  evidence_quote       text not null,  -- the correction utterance, verbatim: its own receipt (has_receipt)

  corrects             text,           -- claim_key of the claim being corrected
  retires              uuid references public.kg_user_claims(correction_id),  -- correction_id this row retires

  sensitive            boolean not null default false,
  accepted             boolean not null default true,   -- G5 applied at WRITE time by membral_correct, not here
  assertion_class      text not null default 'stated',
  t_asserted           timestamptz not null default now(),

  created_at           timestamptz not null default now(),

  -- EXACTLY ONE of corrects/retires is set (D5): a correction, or a retirement — never neither, never both.
  constraint kg_user_claims_corrects_xor_retires check (
    (corrects is not null and retires is null)
    or (retires is not null and corrects is null)
  )
);

comment on table public.kg_user_claims is
  'Durable SOURCE for user corrections and retirements (ADR 0030 D5, Delta 15). NEVER rebuilt, never derived from pass1_result. v1 scope: every row is a correction (corrects set) or a retirement (retires set) — there is no third form. Written by membral_correct (goal step 14); this migration ships the table empty but fold-compatible.';

create index if not exists idx_kg_user_claims_claim_key
  on public.kg_user_claims (user_id, claim_key_version, claim_key);

-- The blocking anti-join's outer lookup: a partial index over the only rows
-- claim_not_blocked() can match (live corrections).
create index if not exists idx_kg_user_claims_blocking
  on public.kg_user_claims (user_id, kind, subject_key, target_key, block_discriminator)
  where corrects is not null and retires is null;

-- The retirement probe (`not exists (... where r.retires = u.correction_id)`)
-- is a second scan of the same table on the hot path of every blocked-claim
-- evaluation.
create index if not exists idx_kg_user_claims_retirement_probe
  on public.kg_user_claims (user_id, retires)
  where retires is not null;

alter table public.kg_user_claims enable row level security;

drop policy if exists "kg_user_claims: users see own rows" on public.kg_user_claims;
create policy "kg_user_claims: users see own rows" on public.kg_user_claims
  for select using (auth.uid() = user_id);
drop policy if exists "kg_user_claims: users insert own rows" on public.kg_user_claims;
create policy "kg_user_claims: users insert own rows" on public.kg_user_claims
  for insert with check (auth.uid() = user_id);
drop policy if exists "kg_user_claims: users update own rows" on public.kg_user_claims;
create policy "kg_user_claims: users update own rows" on public.kg_user_claims
  for update using (auth.uid() = user_id);
drop policy if exists "kg_user_claims: users delete own rows" on public.kg_user_claims;
create policy "kg_user_claims: users delete own rows" on public.kg_user_claims
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 4. Object creation order, exactly as ADR 0030 D5 specifies (every object
--    depends on something above it; Postgres validates `language sql`
--    bodies at creation time, so the reverse order fails):
--      1. require_auth_uid()
--      2. verification_policy_ok(), assumption_policy_ok()  [OQ5 stubs]
--      3. serve_candidates                                  [view]
--      4. claim_effective_class()
--      5. claim_not_blocked()
--      6. claim_is_latest_correction()
--      7. claim_serve_eligible()
--      8. kg_claims_servable, kg_claim_lifecycle_orphans, kg_active_blocks
-- ============================================================

-- ------------------------------------------------------------
-- 4.1 require_auth_uid() — migration 034's loud-fail, in view-legal form.
-- plpgsql (not sql): RAISE has no expression form, so a `language sql`
-- function cannot contain one (034's own stated reason).
-- ------------------------------------------------------------
create or replace function public.require_auth_uid()
returns uuid
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'claims surface requires an end-user session';
  end if;
  return auth.uid();
end;
$$;

-- ------------------------------------------------------------
-- 4.2 The two OQ5 policy knobs. Shipped as stub functions returning true so
-- deciding a knob later is a one-function edit, not a migration.
--   verification_policy_ok: OQ5(a) — unverified-but-quote-grounded serves.
--   assumption_policy_ok:   OQ5(a) — structural-only (bridging_assumptions
--     enumerated and shown; no plausibility scoring).
--
-- FLAGGED DEVIATION FROM THE ADR'S LITERAL ORDERING LIST: D5's object-order
-- block lists BOTH stubs at step 2, before `serve_candidates` (step 3). That
-- cannot work as written — `assumption_policy_ok(c serve_candidates)` types
-- its argument as the view's row, so Postgres requires the view to exist
-- first (the same "validated at creation" rule the ADR itself invokes to
-- justify creating claim_is_latest_correction before claim_serve_eligible).
-- verification_policy_ok has no such dependency (kg_claim_lifecycle already
-- exists as a table), so it stays here; assumption_policy_ok is created
-- immediately after serve_candidates below instead. Flagged for the
-- reviewer rather than silently resolved.
-- ------------------------------------------------------------
create or replace function public.verification_policy_ok(l public.kg_claim_lifecycle)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select true;
$$;

-- ------------------------------------------------------------
-- 4.3 serve_candidates — the union of extraction claims and corrections
-- (ADR 0030 D5). 24 columns. `security_invoker = on` is load-bearing here,
-- not decorative: without it this view runs as its owner (`postgres`, which
-- carries BYPASSRLS on Supabase), and RLS on kg_claims/kg_user_claims
-- underneath would be silently defeated for every caller, including a
-- direct PostgREST read. WITH security_invoker = on, RLS on the base tables
-- is what actually scopes a caller to their own rows — this view carries NO
-- user predicate of its own on purpose: it is the shared substrate the
-- goal-step-13 service-role RPCs also read (where auth.uid() is NULL by
-- design), so a require_auth_uid() predicate here would raise on every MCP
-- call. See kg_claims_servable below for the session-bound surface that
-- adds the predicate.
-- ------------------------------------------------------------
create or replace view public.serve_candidates with (security_invoker = on) as
  select 'extraction'::text as claim_origin, c.claim_key_version, c.claim_key, c.user_id, c.kind,
         c.subject_key, c.target_key, c.block_discriminator, c.relation_class, c.former,
         c.name, c.event_status, c.conv_order_key as t_asserted,
         c.assertion_class, c.accepted, c.sensitive, c.claim_text, c.bridging_assumptions,
         c.conversation_id, conv.source as provider,
         c.message_id, c.evidence_quote as quote_verbatim, c.char_start, c.char_end
    from public.kg_claims c
    join public.conversations conv on conv.id = c.conversation_id and conv.user_id = c.user_id
  union all
  select 'user_correction'::text, u.claim_key_version, u.claim_key, u.user_id, u.kind,
         u.subject_key, u.target_key, u.block_discriminator, u.relation_class, u.former,
         u.name, u.payload->>'event_status', u.t_asserted,
         u.assertion_class, u.accepted, u.sensitive, u.claim_text, null::text[],
         u.correction_id,        -- conversation_id: the correction IS its own source document
         null::text,             -- provider null: it came from Membral, not from a provider
         null::uuid, u.evidence_quote,  -- message_id null; the receipt is the whole utterance
         null::int, null::int    -- offsets null: there is no enclosing message to offset into
    from public.kg_user_claims u
   where u.retires is null;      -- retirement rows are CONTROL RECORDS, not claims:
                                  --   no lifecycle row, never folded, never served

comment on view public.serve_candidates is
  'Union of extraction claims (kg_claims) and live corrections (kg_user_claims), 24 columns, ADR 0030 D5. security_invoker=on so RLS on the base tables actually scopes callers — this view carries no auth predicate of its own (shared substrate for the goal-step-13 service-role RPCs, where auth.uid() is NULL by design).';

-- assumption_policy_ok is created here, immediately after serve_candidates,
-- not at 4.2 above — see the flagged deviation note there.
create or replace function public.assumption_policy_ok(c public.serve_candidates)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select true;
$$;

-- ------------------------------------------------------------
-- 4.4 claim_effective_class() — serve-time-computed epistemic class. Never
-- stored: a stored stamp made D4 rule 5 inert (an on-conflict that never
-- refreshed it let a refuted claim serve as `stated` forever) — see ADR
-- 0030 D5.
-- ------------------------------------------------------------
create or replace function public.claim_effective_class(c public.serve_candidates, l public.kg_claim_lifecycle)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select case
    -- D4 rule 10 interim control: relationship claims from EXTRACTION only.
    -- Lifting it when the verifier ships is an edit to this branch — not a migration.
    when c.claim_origin = 'extraction'
     and c.kind = 'person' and c.relation_class is not null       then 'inferred'
    when l.entailment->>'label' is not null
     and l.entailment->>'label' <> 'entailed'                     then 'inferred'
    else c.assertion_class
  end
$$;

-- ------------------------------------------------------------
-- 4.5 claim_not_blocked() — the blocking anti-join, unconditional on
-- attachment (a correction suppresses extraction claims on its fact
-- identity whether or not its `corrects` pointer still resolves).
--
-- TEMPORAL PRECEDENCE (sign-off status block, OQ7 MODIFICATION — this
-- REPLACES the eternal-veto reading of D4 rule 3 / OQ2's suppression
-- clause the D5 body text describes): the added conjunct
-- `coalesce(c.t_asserted, '-infinity'::timestamptz) <= u.t_asserted` means a
-- correction suppresses only evidence asserted AT OR BEFORE its own
-- timestamp. Evidence from a conversation strictly AFTER the correction is
-- not matched by this subquery and therefore competes under the ordinary
-- recency rules (claim_is_latest_correction / the fold's recency tie-break)
-- rather than being suppressed forever.
--
-- RESOLVED PER FRESH ADVERSARIAL REVIEW (B1, 2026-07-26): `c.t_asserted`
-- NULL (an undated conversation — kg_claims.conv_order_key is nullable per
-- 0025 Q9) is coalesced to `-infinity`, so undated evidence IS suppressed by
-- any matching correction unconditionally, exactly like the pre-modification
-- eternal reading. This replaces the first draft's opposite choice (undated
-- evidence never suppressed), which the review found backwards: unknown-WHEN
-- is not known-to-be-AFTER, and the two failure directions are not
-- symmetric — under-suppression (a stale/wrong claim keeps serving next to a
-- correction) has NO escape surface, while over-suppression is fully
-- reversible via retirement (`kg_active_blocks`). Conservative-toward-safety
-- means suppressing what cannot be temporally placed, not the reverse.
-- ------------------------------------------------------------
create or replace function public.claim_not_blocked(c public.serve_candidates)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    -- Blocking is a control on MODEL-PRODUCED claims. A correction is never its own target:
    -- without this line an unattached correction matches every conjunct against ITSELF and
    -- suppresses the replacement it exists to supply.
    c.claim_origin <> 'extraction'
    or not exists (
      select 1
        from public.kg_user_claims u
       where u.user_id     = c.user_id
         and u.corrects   is not null           -- an assertion, not a correction, blocks nothing
         and u.retires    is null               -- retirement rows are control records
         and u.kind        = c.kind
         and u.subject_key = c.subject_key
         and u.target_key            is not distinct from c.target_key
         and u.block_discriminator   is not distinct from c.block_discriminator
         -- TEMPORAL PRECEDENCE (OQ7 MODIFICATION): suppress only evidence up to the
         -- correction's own timestamp. NULL c.t_asserted coalesces to -infinity, so
         -- undated evidence IS suppressed unconditionally (B1, see note above).
         and coalesce(c.t_asserted, '-infinity'::timestamptz) <= u.t_asserted
         -- not retired by the owner (append-only; see below)
         and not exists (select 1 from public.kg_user_claims r
                          where r.user_id = u.user_id and r.retires = u.correction_id)
    )
$$;

-- Index for the retirement probe already declared above (idx_kg_user_claims_retirement_probe).
-- Index for the outer lookup already declared above (idx_kg_user_claims_blocking).

-- ------------------------------------------------------------
-- 4.6 claim_is_latest_correction() — serving half of the fold's recency
-- rule. Corrections are exempt from blocking (never its targets), so
-- recency is the only thing that can separate two corrections contesting
-- the same fact identity; without this a user who corrects themselves twice
-- gets both corrections served, both `stated`, in no defined order.
-- ------------------------------------------------------------
create or replace function public.claim_is_latest_correction(c public.serve_candidates)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select c.claim_origin <> 'user_correction'
      or not exists (
           select 1
             from public.kg_user_claims u2
            where u2.user_id     = c.user_id
              and u2.corrects   is not null
              and u2.retires    is null
              and u2.kind        = c.kind
              and u2.subject_key = c.subject_key
              and u2.target_key            is not distinct from c.target_key
              and u2.block_discriminator   is not distinct from c.block_discriminator
              and not exists (select 1 from public.kg_user_claims r
                               where r.user_id = u2.user_id and r.retires = u2.correction_id)
              -- strictly later, with a deterministic tie-break so two corrections written in
              -- the same millisecond cannot both serve. NOTE: on correction rows
              -- serve_candidates projects conversation_id := correction_id (see the union),
              -- so c.conversation_id IS the correction id -- there is no correction_id column
              -- on the view to compare against.
              and (u2.t_asserted, u2.correction_id) > (c.t_asserted, c.conversation_id)
         )
$$;

-- ------------------------------------------------------------
-- 4.7 claim_serve_eligible() — the ONE shared eligibility predicate behind
-- both the goal-step-13 service-role RPCs and the owner-dashboard view
-- below. `superseded_by` is deliberately absent (audit-only, D5); `promoted`
-- is scoped by construction to relationship claims only (0025 Q4's group
-- gate is meaningless as a universal conjunct — Delta 19).
-- ------------------------------------------------------------
create or replace function public.claim_serve_eligible(c public.serve_candidates, l public.kg_claim_lifecycle)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select c.accepted
     and c.quote_verbatim is not null             -- has_receipt: D4 rule 4's first conjunct
     and (c.kind <> 'person' or l.promoted)       -- promoted gates its ORIGINAL universe only
     and l.orphaned_at is null                    -- an orphaned lifecycle row is inert
     and coalesce(l.verification->>'status','unverified') <> 'refuted'
     and public.claim_not_blocked(c)              -- the anti-join above
     and public.claim_is_latest_correction(c)     -- serving half of the fold recency rule
     and public.verification_policy_ok(l)         -- knob 1, OQ5
     and public.assumption_policy_ok(c)           -- knob 2, OQ5
$$;

-- ------------------------------------------------------------
-- 4.8 The three end-user views. Session-bound (015/025/034 family): RLS on
-- the base tables (the belt) + require_auth_uid() as an explicit predicate
-- (the suspenders, and 034's loud-fail — a service-role repoint fails
-- visibly instead of silently matching nothing). ALL declare
-- security_invoker = on for the same reason serve_candidates does: the flag
-- does not chain, and an inner view created without it runs as `postgres`
-- (BYPASSRLS on Supabase), defeating the outer view's own flag one level
-- down.
-- ------------------------------------------------------------

-- kg_claims_servable: the owner-dashboard read surface over serve_candidates
-- (not over kg_claims alone — the owner must see their own corrections too).
-- No sensitive filter: the owner is the audience Q9 says may see sensitive
-- claims.
--
-- FLAGGED FILL-IN: the ADR shows this view abbreviated
-- (`select ... from serve_candidates c join kg_claim_lifecycle l using (...)`).
-- The join clause and column list below are this implementer's fill-in, not
-- a literal ADR transcription: joined on the lifecycle PK (user_id,
-- claim_key_version, claim_key) as an INNER join (D5: "the row is written at
-- insert ... so the join is INNER and always finds a row"), selecting every
-- serve_candidates column plus claim_effective_class() computed inline and
-- enough lifecycle fields (promoted/entailment/verification/superseded_by/
-- orphaned_at) for a dashboard to render state, not just eligibility.
create or replace view public.kg_claims_servable with (security_invoker = on) as
  select
    c.claim_origin, c.claim_key_version, c.claim_key, c.user_id, c.kind, c.subject_key,
    c.target_key, c.block_discriminator, c.relation_class, c.former, c.name, c.event_status,
    c.t_asserted, c.assertion_class, public.claim_effective_class(c, l) as effective_class,
    c.accepted, c.sensitive, c.claim_text, c.bridging_assumptions, c.conversation_id,
    c.provider, c.message_id, c.quote_verbatim, c.char_start, c.char_end,
    l.promoted, l.entailment, l.verification, l.superseded_by, l.orphaned_at
  from public.serve_candidates c
  join public.kg_claim_lifecycle l
    on l.user_id = c.user_id and l.claim_key_version = c.claim_key_version and l.claim_key = c.claim_key
 where c.user_id = public.require_auth_uid()
   and public.claim_serve_eligible(c, l);

comment on view public.kg_claims_servable is
  'Owner-dashboard read surface: serve-eligible claims and corrections for the calling session (ADR 0030 D5). No sensitive filter — the owner is the audience Q9 says may see sensitive claims. NOT the MCP surface (that is the goal-step-13 service-role RPCs).';

-- kg_claim_lifecycle_orphans: lifecycle rows whose claim_key currently
-- matches no kg_claims row, left-joined to any correction pointing at the
-- orphaned key and to that correction's own retirement row (so a retired
-- correction reads as retired rather than sitting in the queue looking
-- actionable forever).
create or replace view public.kg_claim_lifecycle_orphans with (security_invoker = on) as
  select
    l.user_id, l.claim_key_version, l.claim_key, l.kind, l.subject_key, l.target_key,
    l.conversation_id, l.orphaned_at, l.promoted, l.superseded_by,
    u.correction_id as correcting_correction_id,
    u.claim_text    as correcting_claim_text,
    u.t_asserted    as correcting_t_asserted,
    (r.correction_id is not null) as retired
  from public.kg_claim_lifecycle l
  left join public.kg_user_claims u on u.corrects = l.claim_key and u.user_id = l.user_id
  left join public.kg_user_claims r on r.retires  = u.correction_id and r.user_id = l.user_id
 where l.orphaned_at is not null
   and l.user_id = public.require_auth_uid();

comment on view public.kg_claim_lifecycle_orphans is
  'Lifecycle rows currently matching no kg_claims row (ADR 0030 D5). An audit note, not a failure — orphans are un-orphaned automatically on return. Retired corrections pointing at an orphan are marked retired rather than looking actionable forever.';

-- kg_active_blocks: live, attached-or-not corrections and how many distinct
-- extraction claim_keys they currently suppress. The round-7 fix — universal
-- suppression makes blocking the NORMAL behaviour of a healthy correction,
-- not an exception state, so it needs a surface of its own (the orphans view
-- is scoped to `orphaned_at is not null` and misses every live block).
--
-- RESOLVED PER FRESH ADVERSARIAL REVIEW (MJ1, 2026-07-26; comment corrected
-- MINOR 9, round 2): the first draft's `suppressed_claims` counted by
-- fact-identity match ONLY, overstating a correction's effect on claims that
-- were never going to serve regardless (unaccepted, or with no receipt).
--
-- `suppressed_claims`' filter is NOT "the same conjuncts as claim_not_blocked()"
-- (an earlier draft of this comment said so, imprecisely) — it sits BETWEEN
-- claim_not_blocked() and claim_serve_eligible(), taking exactly TWO
-- conjuncts, named individually because they come from two different
-- functions:
--   - `coalesce(c.t_asserted, '-infinity'::timestamptz) <= u.t_asserted` —
--     FROM claim_not_blocked() itself: the B1-resolved temporal bound,
--     identical expression.
--   - `c.accepted and c.quote_verbatim is not null` — FROM
--     claim_serve_eligible()'s has_receipt/accepted conjuncts (N6), NOT from
--     claim_not_blocked() (which has neither conjunct at all — they are
--     claim_serve_eligible's own pre-filters, evaluated upstream of
--     claim_not_blocked in the RPCs' query plan).
-- Every OTHER claim_serve_eligible() conjunct is DELIBERATELY OMITTED here —
-- `l.promoted` (person-only, and this view has no lifecycle join to read it
-- from), `l.orphaned_at is null`, `verification <> 'refuted'`,
-- `claim_is_latest_correction()`, and the two OQ5 policy knobs. This view
-- answers "would this correction suppress this claim AT ALL" (a candidacy
-- question), not "is this claim otherwise fully serve-eligible" (a service
-- question) — conflating the two would make an already-orphaned or
-- already-refuted claim disappear from the count for a reason that has
-- nothing to do with the correction itself.
--
-- `touched_claims` is the broader, unfiltered fact-identity-match count (the
-- first draft's behaviour), kept as a second column for an owner who wants
-- to see "everything this correction's identity touches" versus "what it
-- actually suppresses right now."
create or replace view public.kg_active_blocks with (security_invoker = on) as
  select u.user_id, u.correction_id, u.kind, u.subject_key, u.target_key,
         u.block_discriminator, u.claim_text, u.t_asserted,
         count(distinct c.claim_key) filter (
           where c.accepted
             and c.quote_verbatim is not null
             and coalesce(c.t_asserted, '-infinity'::timestamptz) <= u.t_asserted
         ) as suppressed_claims,
         count(distinct c.claim_key) as touched_claims
    from public.kg_user_claims u
    left join public.serve_candidates c
           on c.user_id      = u.user_id
          and c.claim_origin = 'extraction'
          and c.kind         = u.kind
          and c.subject_key  = u.subject_key
          and c.target_key            is not distinct from u.target_key
          and c.block_discriminator   is not distinct from u.block_discriminator
   where u.user_id   = public.require_auth_uid()
     and u.corrects is not null
     and u.retires  is null
     and not exists (select 1 from public.kg_user_claims r
                      where r.user_id = u.user_id and r.retires = u.correction_id)
   group by 1,2,3,4,5,6,7,8;

comment on view public.kg_active_blocks is
  'Live corrections and how many distinct extraction claim_keys each affects (ADR 0030 D5; MJ1 fix + MINOR 9 comment correction, 2026-07-26). suppressed_claims filters on exactly two conjuncts drawn from two different functions: the B1 temporal bound (from claim_not_blocked) and accepted+has_receipt (from claim_serve_eligible, NOT from claim_not_blocked, which has neither) — every other claim_serve_eligible conjunct (promoted, orphaned_at, verification, claim_is_latest_correction, the OQ5 knobs) is deliberately omitted, since this view answers claim-suppression CANDIDACY, not full serve-eligibility. touched_claims is the broader unfiltered fact-identity-match count. The dashboard retire action is anchored here, not on the orphans view — retiring is a normal operation on a live correction.';

-- ------------------------------------------------------------
-- 5. Grants.
--
-- No EXECUTE grants/revokes on any function here: every function above is
-- `security invoker`, called only from the views (also security_invoker) or
-- from other functions in this same chain — none is a directly-callable
-- browser or service-role entry point. The three end-user views rely on
-- Supabase's default per-project ACLs (SELECT granted to `anon`/
-- `authenticated` on new relations, same as every other table/view in this
-- schema — no earlier migration in this repo grants/revokes table-level
-- SELECT explicitly) PLUS require_auth_uid()'s loud-fail: a caller with no
-- session (anon, or a service-role connection where auth.uid() is NULL)
-- gets a raised exception, never a silent empty result and never another
-- user's rows (RLS on the base tables holds regardless of the caller's
-- grant). `serve_candidates` itself carries no additional restriction
-- either, by design (see its own comment) — security_invoker + RLS already
-- makes a direct read of it safe.
--
-- "EXECUTE revoked from authenticated on nothing yet": the mcp_claims_*
-- RPCs (migration-016-shaped, service-role + explicit p_user_id, EXECUTE
-- revoked from public/anon/authenticated and granted only to service_role)
-- are goal step 13 and are NOT created in this migration — there is
-- structurally nothing yet to revoke that grant from.
-- ------------------------------------------------------------

-- ============================================================
-- 6. kg_nodes / kg_edges group-level epistemics (MJ3, fresh adversarial
-- review 2026-07-26 — ADR 0030 Delta 16, adopted at sign-off via OQ3(a);
-- 0025 Q9's own instruction: "add sensitive boolean not null default false
-- to kg_nodes and kg_edges IN THE SAME MIGRATION" as the claims table).
--
-- Before this ADR, NO serving surface read kg_claims at all (0025 Q9), which
-- is exactly why `sensitive` needs its own columns here rather than living
-- only on the projection — the graph-reading MCP/portrait surfaces never see
-- kg_claims, so a flag that lives only there has "no mechanism at all."
--
-- assertion_class default 'inferred' (NOT 'stated') governs the legacy
-- backfill: every node/edge ever written by a producer that never checked a
-- receipt defaults to the epistemically HONEST value. Defaulting to 'stated'
-- would relabel the whole current graph as user-attested in one migration.
-- `not null` for the same three-valued-logic reason as `sensitive`: a
-- nullable column plus an `= 'stated'` filter is how a predicate silently
-- returns nothing (Q9's own `where not sensitive` outage class).
--
-- entailment_status is nullable, no default — 'entailed'|'unchecked'|
-- 'refuted', populated once the verifier stage (goal step 12b) runs; NULL
-- reads as "not yet checked," which is what "unchecked" already means, so a
-- default of 'unchecked' would be a second spelling of NULL rather than new
-- information.
--
-- Both are ADDITIVE and DEFAULTED per the driver's arbitration — no backfill
-- migration, no data loss, existing rows simply gain the honest default.
-- ============================================================

alter table public.kg_nodes
  add column if not exists sensitive boolean not null default false,
  add column if not exists assertion_class text not null default 'inferred',
  add column if not exists entailment_status text;

comment on column public.kg_nodes.sensitive is
  'OR-aggregated over every accepted contributing claim (ADR 0025 Q9): one claim judging a fact sensitive is enough. Enforced at the MCP/portrait prompt boundary, not by row filtering alone (0025 Q9''s downstream table).';
comment on column public.kg_nodes.assertion_class is
  'AND-aggregated over claim_effective_class() of the CONTRIBUTORS (ADR 0030 D5/Delta 16): stated iff every contributor is effectively stated. Contributors = the user claims alone when any kg_user_claims row is present in the fold group (the override), else accepted claims supporting the adopted class/state, excluding claim_not_blocked-suppressed rows. Surfaced and labelled in MCP output, never filtered (D5) — only D7''s context card filters.';
comment on column public.kg_nodes.entailment_status is
  '''entailed''|''unchecked''|''refuted'', AND-aggregated over contributors (any refuted contributor makes the group refuted). NULL until the verifier stage (goal step 12b) runs — reads the same as ''unchecked''.';

alter table public.kg_edges
  add column if not exists sensitive boolean not null default false,
  add column if not exists assertion_class text not null default 'inferred',
  add column if not exists entailment_status text;

comment on column public.kg_edges.sensitive is
  'Mirrors kg_nodes.sensitive (ADR 0025 Q9) — same OR-aggregation rule, same enforcement point.';
comment on column public.kg_edges.assertion_class is
  'Mirrors kg_nodes.assertion_class (ADR 0030 Delta 16) — same AND-aggregation + contributors rule. This is the column person-portrait relationship edges read to decide whether "Aarti is your sibling" renders as stated or inferred.';
comment on column public.kg_edges.entailment_status is
  'Mirrors kg_nodes.entailment_status (ADR 0030 Delta 16).';
-- ------------------------------------------------------------

-- ============================================================
-- 7. claims_lifecycle_upsert() — the projection writer's atomic lifecycle
-- write primitive (MJ2, fresh adversarial review 2026-07-26).
--
-- WHY A FUNCTION, NOT supabase-js's `.upsert()`: the JS client's generic
-- upsert always sets EVERY column present in the payload on conflict, which
-- would clobber `promoted`/`entailment`/`verification` with the
-- projection's own (stale/default) values — exactly the failure D5's
-- "clear exactly one column" rule exists to prevent. A SQL function called
-- via `.rpc()` is the only way to express "on conflict do update set
-- orphaned_at = null, and only that" atomically from a JS caller.
--
-- TWO STATEMENTS, ONE TRANSACTION, EACH WITH ONE JOB (D5's own framing):
--   1. The ADR's LITERAL on-conflict rule: `on conflict (...) do update set
--      orphaned_at = null` — no WHERE guard narrowing it to "only when
--      currently orphaned"; it always fires on any conflict, which is a
--      harmless idempotent no-op write when the row was already
--      un-orphaned. This is deliberate fidelity to the ADR's literal SQL,
--      not an oversight — a narrower conditional statement would be a
--      *different* rule than the one specified.
--   2. MJ2's evidence_fingerprint drift-reset (D5: "a named exception to
--      the clear-exactly-one-column rule, not a violation of it"): for
--      every surviving key whose CONTRIBUTING EVIDENCE actually changed
--      (fingerprint differs from what is currently stored), reset
--      `entailment` to null and `verification.status` to 'needs_review',
--      and stamp the new fingerprint. Runs AFTER statement 1 in the same
--      function call, so a brand-new key's fingerprint (just set by
--      statement 1) compares equal to itself here and this is correctly a
--      no-op for fresh keys — the reset only fires for a claim_key that
--      ALREADY existed with a DIFFERENT fingerprint before this call.
--
-- A single top-level function call is one implicit Postgres transaction: if
-- either statement fails, the whole call rolls back — atomicity for free,
-- no explicit BEGIN/COMMIT needed.
--
-- SECURITY: `security invoker`, but this is an INTERNAL PIPELINE WRITE
-- PRIMITIVE (like GraphWriter's own methods), not an end-user-facing RPC —
-- it carries no `p_user_id`-vs-`auth.uid()` cross-check of its own, relying
-- entirely on kg_claim_lifecycle's own RLS policies (which DO still apply
-- under security invoker for a non-service-role caller) plus this grant.
-- EXECUTE revoked from public/anon/authenticated, granted only to
-- service_role — migration 036's `mcp_freshness` pattern, since the claims
-- projection writer runs under a service-role backend connection, never a
-- cookie-bound browser session.
-- ------------------------------------------------------------
create or replace function public.claims_lifecycle_upsert(p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Statement 1: D5's literal on-conflict rule.
  insert into public.kg_claim_lifecycle
    (user_id, claim_key_version, claim_key, promoted, conversation_id,
     kind, subject_key, target_key, evidence_fingerprint, orphaned_at)
  select
    (r->>'user_id')::uuid,
    (r->>'claim_key_version')::smallint,
    r->>'claim_key',
    false,
    (r->>'conversation_id')::uuid,
    r->>'kind',
    r->>'subject_key',
    r->>'target_key',
    r->>'evidence_fingerprint',
    null
  from jsonb_array_elements(p_rows) r
  on conflict (user_id, claim_key_version, claim_key)
  do update set orphaned_at = null;

  -- Statement 2 (MJ2): evidence_fingerprint drift-reset, selective.
  update public.kg_claim_lifecycle l
     set entailment = null,
         verification = jsonb_set(coalesce(l.verification, '{}'::jsonb), '{status}', '"needs_review"'::jsonb),
         evidence_fingerprint = incoming.new_fingerprint
    from (
      select (r->>'user_id')::uuid as user_id,
             (r->>'claim_key_version')::smallint as claim_key_version,
             r->>'claim_key' as claim_key,
             r->>'evidence_fingerprint' as new_fingerprint
        from jsonb_array_elements(p_rows) r
    ) incoming
   where l.user_id             = incoming.user_id
     and l.claim_key_version   = incoming.claim_key_version
     and l.claim_key           = incoming.claim_key
     and l.evidence_fingerprint is distinct from incoming.new_fingerprint;
end;
$$;

revoke all on function public.claims_lifecycle_upsert(jsonb) from public;
revoke all on function public.claims_lifecycle_upsert(jsonb) from anon;
revoke all on function public.claims_lifecycle_upsert(jsonb) from authenticated;
grant execute on function public.claims_lifecycle_upsert(jsonb) to service_role;
-- ------------------------------------------------------------
