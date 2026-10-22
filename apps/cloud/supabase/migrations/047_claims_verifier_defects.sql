-- ============================================================
-- 047_claims_verifier_defects.sql
-- ADR 0030 goal step 12b — two independently-motivated fixes riding the same
-- migration slot (arbitrated in the ADR 0030 addendum "D9 — the arrival
-- loop": "047 = goal step 12b (the D6 defect fixes above)"; the serving-grain
-- fix below is bundled in per this task's own instructions, since both are
-- small, both ride 12b's mandatory fresh adversarial review, and there is no
-- reason to spend a second migration slot on a one-line grain predicate and
-- a one-column addition).
--
-- PIECE A — null-`block_discriminator` serving-grain collapse (#98's
-- diagnosis, reinforced-prompt re-extraction run: "browse/card fact-identity
-- grain (046's null-discriminator collapse) now costs real volume — 186
-- accepted claims dedup to 74 served identities (insights 60->2)").
--
-- root cause: mcp_claims_browse (migration 046) DISTINCT ONs on
-- `(kind, target_key, block_discriminator)`. Postgres's DISTINCT ON treats
-- NULL as equal to NULL for grouping (the same rule ORDER BY uses to sort
-- NULLs together) — so for the three kinds whose block_discriminator is
-- always NULL (claim-key.ts's blockDiscriminatorFromOwnPayload: `project`,
-- `decision`, `insight` all return `null`), EVERY claim sharing one
-- `(kind, target_key)` pair collapses onto ONE served row, latest
-- t_asserted wins — silently dropping every other genuinely distinct fact.
-- `target_key` is `about` for decision/insight (claim-key.ts's targetKey()),
-- so this fires whenever the corpus has more than one distinct decision or
-- insight "about" the same topic — an ordinary, expected shape, not an edge
-- case (confirmed on the real corpus: 60 insight identities collapsed to 2).
--
-- fix: widen the grain to `(kind, target_key, coalesce(block_discriminator,
-- claim_key))`. `claim_key` already hashes `payload_discriminator`
-- (claim-key.ts: for decision/insight, `sha256(text)`; for project, a
-- constant, since target_key=name alone already identifies a project) plus
-- `conversation_id` — so for a kind whose OWN block_discriminator is NULL,
-- coalescing onto claim_key stops collapsing distinct facts. For every kind
-- whose block_discriminator IS non-null (self/person/place/preference/
-- event/commitment), `coalesce` picks block_discriminator exactly as
-- before — the fix is a no-op on that half of the grain, byte-identical to
-- 046 (mcp_claims_identity, whose only two kinds — self/person — both carry
-- a non-null block_discriminator, is UNAFFECTED and is not touched here).
--
-- residual, stated honestly (matches 046's own N2 comment's spirit): a
-- decision/insight claim_key also hashes conversation_id, so the SAME
-- insight text restated verbatim in a second conversation is NOT deduped
-- into the earlier occurrence — it serves as its own row. That is the safe
-- direction of the trade (over-serving a genuine restatement, never
-- silently dropping a distinct fact) and is exactly what claim_key's own
-- design already treats as a separate identity (D5: claim_key deliberately
-- excludes only evidence_key/turn, not conversation_id). Revisit only if
-- restated-insight duplication itself becomes the complaint.
--
-- the {freshness, data} envelope the eval harness parses is built entirely
-- in TypeScript (context-card.ts / mcp/server.ts) OVER this RPC's row set —
-- this migration changes ROW COUNT for null-discriminator kinds (by design:
-- that is the bug) but not the RPC's 13-column output SHAPE, so the envelope
-- wrapping stays byte-compatible.
--
-- PIECE B — `kg_conversations_processed.attempts` (#102 D6, second half:
-- "an attempts cap on rows stuck status='failed' so a permanently-malformed
-- conversation stops being re-extracted, and re-billed, on every single
-- sweep forever"). Column only, here — the skip-past-N-attempts logic itself
-- is a `pass1.ts` code change (this migration does not encode a cap value;
-- see MAX_PASS1_ATTEMPTS in pass1.ts). Defaults to 0 for every existing row
-- (including today's already-`failed` rows, which is the conservative
-- choice: they get a fresh attempts budget rather than being retroactively
-- treated as already-exhausted).
--
-- PIECE C — `kg_conversations_processed.projection_attempts` (fresh
-- adversarial review round 2, goal step 12b fix round, MED finding 3): "a
-- deterministically-failing conversation must not freeze folding forever."
-- A DISTINCT counter from Piece B's `attempts` — that one tracks pass1
-- extraction retries; this one tracks CONSECUTIVE claims-projection
-- (claims-write.ts's runClaimsProjection) failures for a conversation whose
-- pass1 extraction already succeeded. The two failure modes are orthogonal
-- (a conversation can projection-fail for reasons that have nothing to do
-- with pass1 — a malformed pass1_result shape, a lifecycle RPC error — while
-- its own pass1 `attempts` stays 0 forever), so reusing `attempts` would
-- conflate two independent retry budgets and let one reset the other's
-- streak. Column only, here — MAX_PROJECTION_ATTEMPTS and the skip-past-N
-- (exclude, don't retry) logic live in claims-write.ts. Defaults to 0 for
-- every existing row, same conservative choice as Piece B.
-- ============================================================

-- ------------------------------------------------------------
-- Piece A: mcp_claims_browse — widened DISTINCT ON grain.
-- Everything else (eligibility conjuncts, pagination, total_count window,
-- T1/N1 tie-breaks, security invoker / grants) is BYTE-IDENTICAL to 046 —
-- only the DISTINCT ON's third grouping expression (and the two ORDER BYs
-- that must lead with it) changed.
-- ------------------------------------------------------------
create or replace function public.mcp_claims_browse(
  p_user_id uuid,
  p_limit int default 200,
  p_offset int default 0
)
returns table (
  kind                text,
  target_key          text,
  block_discriminator text,
  name                text,
  relation_class      text,
  former              boolean,
  event_status        text,
  claim_text          text,
  effective_class     text,
  claim_origin        text,
  sensitive           boolean,
  receipt             jsonb,
  total_count         bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with eligible as (
    select
      c.kind, c.target_key, c.block_discriminator, c.claim_key, c.name, c.relation_class, c.former,
      c.event_status, c.claim_text, c.claim_origin, c.sensitive, c.provider, c.conversation_id,
      c.message_id, c.char_start, c.char_end, c.quote_verbatim, c.t_asserted,
      public.claim_effective_class(c, l) as effective_class
      from public.serve_candidates c
      join public.kg_claim_lifecycle l
        on l.user_id = c.user_id
       and l.claim_key_version = c.claim_key_version
       and l.claim_key = c.claim_key
     where c.user_id = p_user_id
       and l.orphaned_at is null
       and c.sensitive is not true
       and public.claim_serve_eligible(c, l)
       -- NO kind restriction, NO query predicate: this is the browse
       -- surface — every eligible kind, unconditionally.
  ),
  deduped as (
    -- 047 FIX: grain widened from (kind, target_key, block_discriminator) to
    -- (kind, target_key, coalesce(block_discriminator, claim_key)) — see the
    -- header. `claim_key` appended after the coalesced discriminator as the
    -- SAME intra-group tie-break 046's N1 fix already established
    -- (`t_asserted` alone is neither unique nor non-null).
    --
    -- FIX ROUND (F5, fresh adversarial review): for the null-discriminator
    -- kinds this migration's own grain widening targets, the coalesce falls
    -- back to `claim_key` — so every row inside one DISTINCT ON group
    -- necessarily shares the SAME claim_key (one fact identity, quoted more
    -- than once). `t_asserted`/`claim_key` are therefore NOT discriminating
    -- tie-breaks for THIS case (both are identical across the group's rows —
    -- conversation-level and identity-level attributes, not per-occurrence
    -- ones), leaving which occurrence's message_id/char_start/char_end
    -- surfaces as the receipt otherwise underdetermined by the ORDER BY.
    --
    -- FIX ROUND 2 (fresh adversarial review, goal step 12b fix round, LOW
    -- finding 5): `char_end, quote_verbatim` appended right after
    -- `char_start` — `message_id` is hardcoded NULL everywhere today
    -- (message_id is only populated once goal step 11 makes message ids
    -- addressable, per claims-write.ts's own comment), so in PRACTICE it
    -- never discriminates yet, and two occurrences of one claim_key CAN
    -- share the same char_start (e.g. one quote is a strict prefix of
    -- another, or offsets simply collide). `char_end` breaks that tie in the
    -- overwhelmingly common case; `quote_verbatim` (an actual value, never
    -- null on an eligible row) is the final, total tie-break.
    --
    -- FIX ROUND 3 (fresh adversarial review, goal step 12b fix round, HIGH
    -- finding 1): `t_asserted desc nulls last, claim_key` moved to sort
    -- IMMEDIATELY after the DISTINCT ON prefix, AHEAD of the receipt columns
    -- — fix rounds F5/2 above had put message_id/char_start/char_end/
    -- quote_verbatim first instead, which meant EVERY group that can span
    -- more than one claim_key (every kind whose block_discriminator is
    -- non-null: self/person/preference/event/commitment/place — e.g. two
    -- different "lives in <city>" facts asserted months apart) picked its
    -- surviving row by character offset, not recency: a January claim could
    -- beat a July one. Putting t_asserted/claim_key first restores 046's
    -- latest-wins behavior for those groups with zero regression to F5's
    -- actual target: for the null-discriminator kinds the grain widening
    -- exists for (project/decision/insight), the coalesce falls back to
    -- claim_key, so every row in ONE DISTINCT ON group already shares the
    -- SAME claim_key — t_asserted and claim_key are therefore CONSTANT
    -- across that group's rows and do not discriminate there, leaving the
    -- receipt-column chain that follows to pick a REPRODUCIBLE occurrence
    -- exactly as F5/fix-round-2 intended. The full ordering is a real total
    -- order either way: multi-key groups resolve by recency first, then the
    -- receipt chain as a final tie-break; single-key groups resolve by the
    -- receipt chain alone (t_asserted/claim_key being constant there).
    select distinct on (kind, target_key, coalesce(block_discriminator, claim_key))
      kind, target_key, block_discriminator, claim_key, name, relation_class, former, event_status,
      claim_text, claim_origin, sensitive, provider, conversation_id, message_id, char_start,
      char_end, quote_verbatim, t_asserted, effective_class
      from eligible
     order by kind, target_key, coalesce(block_discriminator, claim_key), t_asserted desc nulls last, claim_key,
              message_id nulls last, char_start nulls last, char_end nulls last, quote_verbatim
  ),
  counted as (
    -- Total eligible fact count, computed over every deduped row BEFORE
    -- limit/offset clips the page — every row on a page carries the same
    -- total_count.
    select *, count(*) over() as total_count
      from deduped
  )
  select
    kind, target_key, block_discriminator, name, relation_class, former, event_status, claim_text,
    effective_class, claim_origin, sensitive,
    jsonb_build_object(
      'provider', provider,
      'conversation_id', conversation_id,
      'message_id', message_id,
      'char_start', char_start,
      'char_end', char_end,
      'quote_verbatim', quote_verbatim,
      't_asserted', t_asserted
    ) as receipt,
    total_count
    from counted
   -- T1 (046, unchanged): deterministic total order — recency first, then
   -- claim_key as the unique tie-break.
   order by t_asserted desc nulls last, claim_key
   limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.mcp_claims_browse(uuid, int, int) is
  'Claims-first browse surface for the context-card generator (ADR 0030 D7, goal step 16, migration 046; grain fix + tie-break fix migration 047, tie-break widened again 047 fix round 2, tie-break ORDER corrected 047 fix round 3). One claim per fact identity (kind, target_key, coalesce(block_discriminator, claim_key)) across ALL kinds — deduped exactly like mcp_claims_identity (latest t_asserted wins) for kinds whose block_discriminator is non-null (fix round 3, HIGH finding 1, restored this: an intervening fix round had the receipt tie-break columns sorting AHEAD of t_asserted, so every multi-claim_key group picked its surviving row by character offset instead of recency — identity and browse now genuinely match on recency-first dedup again); kinds whose discriminator is NULL (project/decision/insight) dedupe on claim_key instead of collapsing to one-per-target (047 fix, #98: 186 accepted claims were deduping to 74 served identities pre-fix) — for those, every row in a DISTINCT ON group already shares one claim_key, so t_asserted/claim_key are constant there and the receipt-column chain (message_id, char_start, char_end, quote_verbatim) is what actually picks a reproducible occurrence. total_count is a count(*) over() window over the full deduped set, riding along on every row. Deterministic order: t_asserted desc nulls last, then claim_key (T1, the final page order — unchanged by fix round 3); the DISTINCT ON''s own intra-group tie-break is t_asserted desc nulls last, claim_key, THEN message_id nulls last, char_start nulls last, char_end nulls last, quote_verbatim (N1; reordered in fix round 3, HIGH finding 1, to put recency ahead of the receipt columns — message_id/char_start were appended in the 047 fix round, F5; char_end/quote_verbatim in the 047 fix round 2, LOW finding 5, since message_id is hardcoded NULL everywhere today and char_start alone can still tie — the full chain is a real total order, a REPRODUCIBLE pick rather than merely a likely-unique one). Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

revoke all on function public.mcp_claims_browse(uuid, int, int) from public;
revoke all on function public.mcp_claims_browse(uuid, int, int) from anon;
revoke all on function public.mcp_claims_browse(uuid, int, int) from authenticated;
grant execute on function public.mcp_claims_browse(uuid, int, int) to service_role;

-- ------------------------------------------------------------
-- mcp_claims_identity is DELIBERATELY NOT touched here: its only two kinds
-- (self, person) both carry a non-null block_discriminator (attribute /
-- relation_class respectively — claim-key.ts's blockDiscriminatorFromOwnPayload),
-- so the null-discriminator collapse this migration fixes cannot occur on
-- that surface. Re-stating 046's version would be a no-op `create or
-- replace` with zero behavior change — skipped to keep this migration's
-- diff scoped to the actual defect.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- Piece B: kg_conversations_processed.attempts (#102 D6 second half).
-- Column only — pass1.ts is where the cap (MAX_PASS1_ATTEMPTS) is enforced
-- and where this column is incremented on failure / reset on success.
-- ------------------------------------------------------------
alter table public.kg_conversations_processed
  add column if not exists attempts integer not null default 0;

comment on column public.kg_conversations_processed.attempts is
  'Consecutive pass1 failures for this conversation since its last success (#102 D6). pass1.ts increments this on every status=failed write and resets it to 0 on status=done; a conversation whose attempts reaches MAX_PASS1_ATTEMPTS is excluded from the pending set (skip-past-N, logged loudly) so a permanently-malformed conversation stops being re-extracted, and re-billed, on every sweep forever.';

-- ------------------------------------------------------------
-- Piece C: kg_conversations_processed.projection_attempts (fresh adversarial
-- review round 2, goal step 12b fix round, MED finding 3). Column only —
-- MAX_PROJECTION_ATTEMPTS and the skip-past-N (exclude, don't retry forever)
-- logic live in claims-write.ts's runClaimsProjection.
-- ------------------------------------------------------------
alter table public.kg_conversations_processed
  add column if not exists projection_attempts integer not null default 0;

comment on column public.kg_conversations_processed.projection_attempts is
  'Consecutive claims-projection (claims-write.ts runClaimsProjection) failures for this conversation since its last successful projection (fresh adversarial review round 2, goal step 12b fix round, MED finding 3). Distinct from `attempts` above (Piece B, pass1 retries) — the two failure modes are orthogonal, so conflating the counters would let one reset the other''s streak. runClaimsProjection increments this on a caught per-conversation failure and resets it to 0 on success; a conversation whose projection_attempts reaches MAX_PROJECTION_ATTEMPTS is EXCLUDED from projection (skipped without being attempted, counted separately as conversationsExcluded, logged loudly every run) so a deterministically-failing conversation stops freezing runClaimsStage''s fold (claims-stage.ts F1) forever — the fold proceeds once conversationsFailed reaches 0, which excluding (rather than endlessly re-attempting and re-failing) a permanently-broken conversation makes possible. Needs manual repair (fix the underlying data, then reset this column to 0) to ever be re-attempted.';
