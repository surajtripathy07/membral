-- ============================================================
-- 041_membral_correct_write.sql
-- ADR 0030 D5 — membral_correct's atomic write primitive (goal step 14).
-- Depends on: 039 (kg_user_claims, kg_claim_lifecycle).
-- ============================================================
--
-- WHY THIS NEEDS A MIGRATION, given the task's steer that step 14 "likely"
-- needs no new schema: no TABLE or COLUMN is added here (kg_user_claims and
-- kg_claim_lifecycle already exist, fold-compatible, from 039) — but D5 is
-- explicit that "membral_correct writes the kg_user_claims row + its
-- lifecycle row atomically" ("Corrections get their lifecycle row in the
-- same transaction as the correction itself"), and supabase-js has no way to
-- open one transaction across two `.from(...).insert(...)` calls from
-- application code. Migration 039 solved the SAME problem for the
-- projection writer with `claims_lifecycle_upsert` (see that migration's own
-- header: "A SQL function called via `.rpc()` is the only way to express
-- this atomically from a JS caller") — this is that same primitive, shaped
-- for the correction write path instead of the fold's upsert path. A
-- function is the smallest schema object that makes atomicity possible; not
-- adding one would leave D5's atomicity requirement unmet.
--
-- SCOPE, STATED UNAMBIGUOUSLY (tightened per fresh adversarial review,
-- 2026-07-26 — an earlier draft of this comment was found ambiguous on a
-- fast read): THIS FUNCTION DOES NOT ENFORCE G5. IT ENFORCES NOTHING. It
-- does zero validation beyond what the two tables' own constraints already
-- enforce (NOT NULL, the corrects/retires XOR check, and — as of migration
-- 042 — the `kg_user_claims_g5_owner_only` CHECK, a defense-in-depth
-- backstop added there, not here). Every semantic decision — resolving
-- `corrects` to an existing claim's identity, computing
-- block_discriminator/target_key FROM THE CORRECTED CLAIM, G5's
-- subject-must-be-owner rejection, the retirement lookup — happens in
-- TypeScript (lib/kg/claims-correct.ts) BEFORE this function is ever called,
-- exactly like claims_lifecycle_upsert trusts its caller's rows. "G5 is
-- enforced by REFUSING TO CALL this function" describes the CALLER's
-- behaviour, not this function's: membral_correct.ts rejects with a thrown
-- error and never reaches this RPC at all when the subject is not the
-- owner (D5: "it rejects, it does not store-then-filter"). That TS-side
-- refusal is what makes "never stored" true — this function has no
-- opinion on the question and would happily write a non-owner row if a
-- future caller ever passed it one, which is exactly why 042 adds the
-- CHECK constraint as a second, independent line of defense.
--
-- ONE FUNCTION, TWO WRITES, ONE (implicit) TRANSACTION: a single top-level
-- Postgres function call is one transaction — if either INSERT fails, both
-- roll back. `p_lifecycle` is nullable: the retirement path (a
-- `kg_user_claims` row with `retires` set, `corrects` null) writes NO
-- lifecycle row at all (D5: "Retirement rows are control records, not
-- claims ... given no lifecycle row, never folded") and does not need this
-- function's atomicity at all (a single-table insert has nothing to be
-- atomic WITH) — the TS caller uses a plain `.insert()` for that path and
-- reserves this RPC for the corrects branch. It is accepted here anyway
-- (nullable) so the one primitive covers both branches if a future caller
-- prefers it, rather than assuming the retire path forever avoids it.
-- ============================================================

create or replace function public.membral_correct_write(
  p_user_id uuid,
  p_correction jsonb,
  p_lifecycle jsonb default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_correction_id uuid;
begin
  insert into public.kg_user_claims (
    correction_id, user_id, claim_key, claim_key_version, kind, subject_key, about_key,
    target_key, block_discriminator, relation_class, former, name, payload,
    claim_text, evidence_quote, corrects, retires, sensitive, accepted, assertion_class, t_asserted
  )
  values (
    coalesce((p_correction->>'correction_id')::uuid, gen_random_uuid()),
    p_user_id,
    p_correction->>'claim_key',
    coalesce((p_correction->>'claim_key_version')::smallint, 1),
    p_correction->>'kind',
    p_correction->>'subject_key',
    p_correction->>'about_key',
    p_correction->>'target_key',
    p_correction->>'block_discriminator',
    p_correction->>'relation_class',
    (p_correction->>'former')::boolean,
    p_correction->>'name',
    coalesce(p_correction->'payload', '{}'::jsonb),
    p_correction->>'claim_text',
    p_correction->>'evidence_quote',
    p_correction->>'corrects',
    (p_correction->>'retires')::uuid,
    coalesce((p_correction->>'sensitive')::boolean, false),
    coalesce((p_correction->>'accepted')::boolean, true),
    coalesce(p_correction->>'assertion_class', 'stated'),
    coalesce((p_correction->>'t_asserted')::timestamptz, now())
  )
  returning correction_id into v_correction_id;

  -- Retirement rows (p_lifecycle null) get no lifecycle row (D5: "never
  -- folded"). Corrects rows always pass p_lifecycle — the TS caller builds
  -- it unconditionally on that branch.
  if p_lifecycle is not null then
    insert into public.kg_claim_lifecycle (
      user_id, claim_key_version, claim_key, promoted, conversation_id,
      kind, subject_key, target_key, evidence_fingerprint, orphaned_at
    )
    values (
      p_user_id,
      (p_lifecycle->>'claim_key_version')::smallint,
      p_lifecycle->>'claim_key',
      -- D5: "membral_correct writes promoted := true on the lifecycle row
      -- it creates" — a correction is one piece of evidence at
      -- confidence 1.0, which 0025 Q4's single-evidence branch already
      -- promotes; this is that arithmetic applied at write time rather
      -- than waiting for the next fold.
      true,
      (p_lifecycle->>'conversation_id')::uuid,
      p_lifecycle->>'kind',
      p_lifecycle->>'subject_key',
      p_lifecycle->>'target_key',
      p_lifecycle->>'evidence_fingerprint',
      null
    )
    -- Idempotency guard for a naive caller retry after a network error whose
    -- write actually succeeded: v_correction_id/claim_key are derived from a
    -- FRESH gen_random_uuid()-backed correction_id on every real call, so a
    -- genuine collision here should never happen — this is a defensive
    -- no-op, not a documented ADR behaviour.
    on conflict (user_id, claim_key_version, claim_key) do nothing;
  end if;

  return v_correction_id;
end;
$$;

comment on function public.membral_correct_write(uuid, jsonb, jsonb) is
  'Atomic write primitive for membral_correct (ADR 0030 D5, goal step 14): one kg_user_claims row + (for the corrects branch) its kg_claim_lifecycle row, in one transaction. THIS FUNCTION ENFORCES NOTHING, INCLUDING G5 — the caller (lib/kg/claims-correct.ts) resolves identity, computes block_discriminator/target_key from the CORRECTED claim, and rejects (throws, never calls this function) when G5 fails. Migration 042 adds a CHECK constraint on kg_user_claims as an independent, defense-in-depth backstop for G5 — this function itself performs no such check.';

revoke all on function public.membral_correct_write(uuid, jsonb, jsonb) from public;
revoke all on function public.membral_correct_write(uuid, jsonb, jsonb) from anon;
revoke all on function public.membral_correct_write(uuid, jsonb, jsonb) from authenticated;
grant execute on function public.membral_correct_write(uuid, jsonb, jsonb) to service_role;
