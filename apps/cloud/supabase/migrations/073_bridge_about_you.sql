-- Migration 073 — ADR 0043 "Turn-zero About you": the grounded core.
--
-- One service-role RPC, D6: bridge_about_you(p_user_id uuid, p_limit int)
-- returns jsonb. Session-independent by construction (D1): no query, no
-- p_session_id. Implements, in SQL:
--   D1(a)  Relations — kind='person', relation_class in
--          ('spouse','child','parent'), former is not true, name is not
--          null; within-relation-class normalized-prefix dedupe (structural,
--          the longer label wins for DISPLAY, but the served receipt/
--          conversation_count come from whichever collapsed member —
--          winner or absorbed — has the higher distinct-conversation count,
--          per D1a's own clause, so absorbing a lower-corroboration long
--          label never discards a higher-corroboration short one's count).
--   D1(b)  Self attributes — payload.attribute in
--          ('name','role','employer','location') only; per attribute, the
--          VALUE with the highest distinct-conversation count, and only
--          when that count is >= 2 (never latest-wins).
--   D1(c)  Degrade — when (a) is empty, the top 2 grounded named person rows
--          by distinct-conversation count, any relation_class, same dedupe.
--          Never falls back to a census; hidden (empty array) when even the
--          degrade path finds nothing.
--   D1(d)  Order (relations: spouse, parent, child, then conversation_count
--          desc; then self: name, role, employer, location) and item cap
--          (p_limit, callers pass 8). The 1,200-char budget is NOT enforced
--          here — D4's owner-voice rendering (the text the budget is
--          measured over) happens in TypeScript at encode time (lib/bridge/
--          context.ts), not in this RPC.
--   D2     Grounded = claim_browse_grounding(c, l) = 'grounded' (accepted,
--          receipt-bearing, promoted-for-person, not blocked/refuted/
--          superseded) — NOT effective_class='stated'. sensitive is not
--          true, re-applied here (not assumed). No p_include_inferred in
--          v1 (D2: "no toggle in v1" — a parameter with no wiring is dead
--          surface, same reasoning issue #113/F8 already established for
--          p_session_id).
--   D3     Durable-only — excludes kind='event' (moot: kind is already
--          restricted to self/person), durable is false, event_status is
--          not null, former is true. Structured columns only.
--
-- GRAIN (D6, this implementer's call — ADR 0041/migration 070 is live):
-- candidates are grouped by public.memory_key() (070, object 1) directly
-- over kg_claims — the SAME per-fact-identity grain kg_memories_for (070)
-- uses — but this RPC reads kg_claims itself rather than kg_memories_for/
-- kg_memories: that aggregation's `returns table` (and its inst_json
-- projection) carries neither `payload` nor `durable` (confirmed absent —
-- D6's own forward note says object 10 "must carry payload and durable" as
-- a gap 0041 has not yet closed), both required by D3/D4. Re-deriving them
-- from kg_claims after kg_memories_for would mean a second per-instance
-- join back to kg_claims anyway, so this RPC computes the memory_key grain
-- once, directly, carrying payload/durable through from the start. Person
-- grounding uses claim_browse_grounding(c, l) (migration 055) rather than
-- hand-building a serve_candidates row — same function kg_memories_for's
-- own `graded` CTE uses for the identical purpose.
--
-- ACL (D6): stable, security invoker (prosecdef = false — the default,
-- stated explicitly), set search_path to public, pg_temp, tenancy by
-- `where user_id = p_user_id` ALONE — no auth.uid() guard, because
-- GET /api/bridge/context calls this via getBridgeServiceClient(), where
-- auth.uid() is NULL by design (unlike kg_memories_for, which IS reachable
-- from an end-user session and therefore needs require_session_or_service_
-- role()). Revoke from public/anon/authenticated; grant to service_role
-- only — the same shape as mcp_claims_identity/mcp_claims_context
-- (migration 040) and ADR 0041's own service-role group (070, objects 7-10).
--
-- No new index (D6: "there is no query to index").

create or replace function public.bridge_about_you(p_user_id uuid, p_limit int)
returns jsonb
language sql
stable
security invoker
set search_path to public, pg_temp
as $$
with base as materialized (
  select
    c.id, c.claim_key, c.kind, c.name, c.sensitive, c.created_at, c.conv_order_key, c.turn,
    c.conversation_id, c.evidence_quote, c.accepted, c.reject_reason, c.durable, c.payload,
    c.subject_key, c.target_key, c.relation_class, c.former, c.event_status,
    conv.title as conversation_title, conv.source as conversation_source,
    public.memory_key(c.kind, c.subject_key, c.target_key, c.relation_class, c.payload, c.claim_key) as memory_key
  from public.kg_claims c
  join public.kg_claim_lifecycle l
    on l.user_id = c.user_id and l.claim_key_version = c.claim_key_version and l.claim_key = c.claim_key
  left join public.conversations conv on conv.id = c.conversation_id and conv.user_id = p_user_id
  where c.user_id = p_user_id
    and c.claim_key is not null
    and c.kind in ('self', 'person')
    and c.sensitive is not true
    -- D3 — durable-only, structured columns only.
    and c.kind <> 'event'
    and c.durable is not false
    and c.event_status is null
    and c.former is not true
    -- D2 — grounded = the serve-eligible lane, not effective_class='stated'.
    and public.claim_browse_grounding(c, l) = 'grounded'
),
-- ================= Relations (D1a, D1c) =================
person_rows as (
  select * from base where kind = 'person' and relation_class is not null and name is not null
),
person_conv_counts as (
  select memory_key, count(distinct conversation_id) as conversation_count
  from person_rows
  group by memory_key
),
person_ranked as (
  select p.*, row_number() over (
    partition by p.memory_key order by coalesce(p.conv_order_key, p.created_at) desc, p.id desc
  ) as rn
  from person_rows p
),
-- One representative (most recent) instance per memory_key, carrying that
-- key's own distinct-conversation count — the ALL-classes candidate set
-- D1(c)'s degrade path also draws from (dedupe is within-class regardless
-- of whether the restricted or the unrestricted set is ultimately used).
person_candidates as (
  select r.*, cc.conversation_count
  from person_ranked r
  join person_conv_counts cc using (memory_key)
  where r.rn = 1
),
-- Structural, within-relation_class-only prefix dedupe (D1a): p is absorbed
-- when a DIFFERENT memory_key o in the SAME class has a strictly longer
-- normalized label whose value is a whitespace-boundary prefix of o's own
-- (`b || ' '` is a prefix of `a`, the longer wins). Two candidates whose
-- normalized labels are EQUAL cannot arise here — memory_key() already
-- folds an identical normalize(target_key) into ONE key upstream — so the
-- ADR's tie-break for that case (higher conversation_count, then later
-- t_asserted) has no reachable case to apply to on this schema.
--
-- What the winner DISPLAYS as (name/relation_class) is the longest label —
-- but per D1a's own clause, "the surviving receipt is the collapsed row
-- with the higher distinct-conversation count, then the later t_asserted":
-- the served conversation_count/receipt/durable/etc. come from whichever
-- member of the collapsed set (the winner itself, or any shorter label it
-- absorbed) has the HIGHEST distinct-conversation count — never
-- unconditionally the winner's own. Fix (round 4 adversarial review):
-- absorbing "Kiran" (a name seen in many conversations) into "Kiran Rao" (seen in one)
-- must not discard Kiran's corroboration.
person_deduped as (
  select
    p.relation_class,
    p.name,             -- display label: the WINNER's own (longest).
    p.memory_key,        -- display identity: the winner's own memory_key.
    best.id, best.claim_key, best.durable, best.turn, best.reject_reason, best.sensitive,
    best.conversation_title, best.conversation_source, best.conversation_id,
    best.evidence_quote, best.conv_order_key, best.created_at,
    best.conversation_count
  from person_candidates p
  cross join lateral (
    select o.*
    from person_candidates o
    where o.relation_class = p.relation_class
      and (
        o.memory_key = p.memory_key
        or public.memory_norm(p.name) like public.memory_norm(o.name) || ' %'
      )
    order by o.conversation_count desc, coalesce(o.conv_order_key, o.created_at) desc, o.memory_key
    limit 1
  ) best
  where not exists (
    select 1 from person_candidates o
    where o.relation_class = p.relation_class
      and o.memory_key <> p.memory_key
      and length(public.memory_norm(o.name)) > length(public.memory_norm(p.name))
      and public.memory_norm(o.name) like public.memory_norm(p.name) || ' %'
  )
),
core_relations as (
  select *, case relation_class when 'spouse' then 0 when 'parent' then 1 when 'child' then 2 else 3 end as rel_order
  from person_deduped
  where relation_class in ('spouse', 'child', 'parent')
),
-- D1(c) — top 2 by conversation_count, ties: later t_asserted, then name
-- ascending. Only ever consulted below when core_relations is empty.
degrade_relations as (
  select *, 0 as rel_order
  from person_deduped
  order by conversation_count desc, coalesce(conv_order_key, created_at) desc, name asc
  limit 2
),
relations_final as (
  select * from core_relations where exists (select 1 from core_relations)
  union all
  select * from degrade_relations where not exists (select 1 from core_relations)
),
-- ================= Self attributes (D1b) =================
self_rows as (
  select *, payload ->> 'attribute' as attribute, payload ->> 'value' as value
  from base
  where kind = 'self' and payload ->> 'attribute' in ('name', 'role', 'employer', 'location')
),
self_value_counts as (
  select memory_key, count(distinct conversation_id) as conversation_count
  from self_rows
  group by memory_key
),
self_ranked as (
  select s.*, row_number() over (
    partition by s.memory_key order by coalesce(s.conv_order_key, s.created_at) desc, s.id desc
  ) as rn
  from self_rows s
),
-- One representative (most recent) instance per (attribute, value) group.
self_candidates as (
  select r.*, vc.conversation_count
  from self_ranked r
  join self_value_counts vc using (memory_key)
  where r.rn = 1
),
-- Per attribute, the value-group with the highest conversation_count; ties:
-- later t_asserted, then value ascending. Never latest-wins (D1b).
self_winner as (
  select *, row_number() over (
    partition by attribute
    order by conversation_count desc, coalesce(conv_order_key, created_at) desc, value asc
  ) as attr_rank
  from self_candidates
),
self_final as (
  select *, case attribute when 'name' then 0 when 'role' then 1 when 'employer' then 2 when 'location' then 3 else 4 end as sub_order
  from self_winner
  -- The corroboration rule (D1b): unreachable for a one-conversation
  -- account by construction, not a bug (D1c).
  where attr_rank = 1 and conversation_count >= 2
),
-- ================= Combine, order, cap (D1d) =================
combined as (
  select
    id, claim_key, 'person'::text as item_kind, relation_class, name,
    null::text as attribute, null::text as value, durable, conversation_count, turn,
    reject_reason, sensitive, conversation_title, conversation_source, conversation_id,
    evidence_quote, conv_order_key, created_at, memory_key,
    0 as bucket, rel_order as sub_order
  from relations_final
  union all
  select
    id, claim_key, 'self'::text as item_kind, null::text as relation_class, null::text as name,
    attribute, value, durable, conversation_count, turn,
    reject_reason, sensitive, conversation_title, conversation_source, conversation_id,
    evidence_quote, conv_order_key, created_at, memory_key,
    1 as bucket, sub_order
  from self_final
),
ordered as (
  select *, row_number() over (
    order by bucket, sub_order, conversation_count desc nulls last,
             coalesce(conv_order_key, created_at) desc nulls last, memory_key
  ) as rn
  from combined
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'claim_id', o.id,
      'claim_key', o.claim_key,
      'kind', o.item_kind,
      'relation_class', o.relation_class,
      'name', o.name,
      'attribute', o.attribute,
      'value', o.value,
      'durable', o.durable,
      'conversation_count', o.conversation_count,
      'turn', o.turn,
      -- Every row here already passed D2's grounded-lane filter above, so
      -- this is a constant, not a per-row computation (no toggle in v1 —
      -- the moment p_include_inferred ships, this column stops being one).
      'receipt_status', 'grounded',
      'reject_reason', o.reject_reason,
      'sensitive', o.sensitive,
      'receipt', jsonb_build_object(
        'provider', o.conversation_source,
        'conversation_id', o.conversation_id,
        'conversation_title', o.conversation_title,
        'message_id', null,
        'turn', o.turn,
        'char_start', null,
        'char_end', null,
        'quote_verbatim', o.evidence_quote,
        't_asserted', o.conv_order_key
      )
    )
    order by o.rn
  ),
  '[]'::jsonb
)
from ordered o
where o.rn <= p_limit
$$;

comment on function public.bridge_about_you(uuid, int) is
  'ADR 0043 D1-D6 — turn-zero "About you" grounded core: relations (spouse/child/parent, degrade to top-2 named any-class) + corroborated self attributes (name/role/employer/location, >=2 conversations, never latest-wins), grounded-lane only (D2), D3 durable-only exclusions, within-relation-class normalized-prefix dedupe, ordered and capped at p_limit. Session-independent: no query, no p_session_id. No auth.uid() guard by design — GET /api/bridge/context calls this via the service-role client, where auth.uid() is NULL.';

revoke all on function public.bridge_about_you(uuid, int) from public;
revoke all on function public.bridge_about_you(uuid, int) from anon;
revoke all on function public.bridge_about_you(uuid, int) from authenticated;
grant execute on function public.bridge_about_you(uuid, int) to service_role;
