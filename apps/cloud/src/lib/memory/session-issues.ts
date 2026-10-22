// code_session_issues writer — goal 2026-09-26 W4 / P2 (D-051), migration 103.
//
// Sibling of write.ts's writeSessionIssues (migration 099 columns only), kept
// in its own module so the profile columns (review_verb, build_verb, tier,
// turn_share, related_to) and the derived role land without widening that
// file. tail-capture.ts calls this after groundSessionIssues; service-role
// client; never called with ungrounded rows.

import { preferredRef } from "@/lib/code-sessions/ref-canon";
import type { Db } from "@/lib/db/types";
import { itemKeyResolver } from "@/lib/domain/ref-identity";
import type { GroundedSessionIssue } from "./extract";

const MAX_REF_CHARS = 500;
const MAX_QUOTE_CHARS = 500;
const MAX_RELATED = 32;

type StoredIssueRow = { id: string; ref: string; kind: string; role: string; turn_share: number | string | null };

/**
 * Write a session's grounded issue rows. Every run's rows are the truth for
 * the (ref, kind) pairs it offers: the profile is re-derived from ALL the
 * session's turns each run, so role and turn_share are refreshed in place
 * (upsert, never ignoreDuplicates) and a stored row for the same (ref, kind)
 * under a DIFFERENT role is deleted — one ref never carries two roles.
 *
 * `replace` (the rows offered are the session's whole derived set — a run
 * from its first turn, or a re-derivation that re-offered the stored model
 * rows): the session's other rows are deleted too, so the stored set equals
 * what the current code derives. Rows are deleted, not retired: the table has
 * no retire column, and every row is re-derivable from the session's turns. Otherwise (a tail run) rows this run
 * does not offer (model-only refs from earlier windows) stay, but their
 * turn_share is aligned with this run's mode so the session's shares still
 * sum to 1: 0 beside observed shares, null beside `inferred` rows (equal
 * split at read time).
 *
 * An `inferred` row (a pre-W3 session: no verbs) is `referenced` (v4 item 7:
 * the role comes from verbs only); a stored model-pass role is not kept. Returns the number
 * of rows offered.
 */
export async function writeSessionIssueRows(
  supabase: Db,
  userId: string,
  sessionId: string,
  issues: readonly GroundedSessionIssue[],
  replace: boolean,
  opts: {
    /**
     * D-057 (migration 111): write the association columns (`source`, `segment_evidence`,
     * `segment_reason`) on EVERY row — null on rows the association did not link, so a row it
     * linked on an earlier run and no longer links is reset. Only while MEMBRAL_SESSION_ASSOC is
     * on: with it off the columns are never sent, and the writer works without migration 111.
     */
    withAssociation?: boolean;
  } = {},
): Promise<number> {
  const { data: storedData, error: readErr } = await supabase
    .from("code_session_issues")
    .select("id, ref, kind, role, turn_share")
    .eq("user_id", userId)
    .eq("session_id", sessionId);
  if (readErr) throw new Error(`writeSessionIssueRows: read failed: ${readErr.message}`);
  const stored = (storedData ?? []) as StoredIssueRow[];
  // R3 ADV 5 (D-064): stored and offered rows match by item identity, not exact spelling, so a
  // re-derived row spelled differently (host-less vs hosted, `!N` vs `#N`) meets its stored row.
  const keyOf = itemKeyResolver([
    ...stored.map((r) => ({ ref: r.ref, kind: r.kind })),
    ...issues.map((i) => ({ ref: i.ref.slice(0, MAX_REF_CHARS), kind: i.kind })),
  ]);
  const storedRole = new Map<string, string>();
  for (const r of stored) if (!storedRole.has(keyOf(r.ref, r.kind))) storedRole.set(keyOf(r.ref, r.kind), r.role);

  // The best stored spelling per item: a matched row keeps the hosted spelling when either side has it
  // (preferredRef) — a host-less re-derivation never downgrades a hosted stored ref (D-064).
  const storedRef = new Map<string, string>();
  for (const r of stored) {
    const k = keyOf(r.ref, r.kind);
    const prev = storedRef.get(k);
    storedRef.set(k, prev === undefined ? r.ref : preferredRef(prev, r.ref));
  }

  const rows = issues.map((i) => {
    const offeredRef = i.ref.slice(0, MAX_REF_CHARS);
    const prevRef = storedRef.get(keyOf(offeredRef, i.kind));
    const ref = prevRef === undefined ? offeredRef : preferredRef(prevRef, offeredRef);
    // v4 item 7: the role comes from the verbs only — a stored model-pass role (`worked_on` on
    // a row with no verb) is never carried forward; `default` keeps only a stored `referenced`.
    const kept = i.role_source === "default" ? storedRole.get(keyOf(ref, i.kind)) : undefined;
    const prior = kept === "referenced" ? kept : undefined;
    const share = i.turn_share === null ? null : Number.isFinite(i.turn_share) ? i.turn_share : 0;
    return {
      session_id: sessionId,
      user_id: userId,
      ref,
      number: i.number,
      kind: i.kind,
      role: prior ?? i.role,
      evidence_quote: i.evidence_quote.slice(0, MAX_QUOTE_CHARS),
      turn_idx: i.turn_idx,
      review_verb: i.review_verb,
      build_verb: i.build_verb,
      tier: i.tier,
      turn_share: share === null ? null : Math.min(1, Math.max(0, share)),
      related_to: i.related_to.slice(0, MAX_RELATED).map((r) => r.slice(0, MAX_REF_CHARS)),
      ...(opts.withAssociation
        ? {
            source: i.source ?? null,
            segment_evidence: i.segments && i.segments.length > 0 ? i.segments : null,
            segment_reason:
              i.segments && i.segments.length > 0
                ? i.segments
                    .map((g) => g.reason)
                    .filter(Boolean)
                    .join(" | ")
                    .slice(0, MAX_QUOTE_CHARS)
                : null,
          }
        : {}),
    };
  });
  const offered = new Map(rows.map((r) => [keyOf(r.ref, r.kind), { role: r.role, ref: r.ref }] as const));

  // Rows to drop: on a replacing run, every stored row this run no longer
  // derives (a row it derives again is upserted in place, so its created_at
  // holds); on a tail run, only a stored (ref, kind) whose role this run
  // derives differently.
  const dropIds = stored
    .filter((r) => {
      const o = offered.get(keyOf(r.ref, r.kind));
      // A stored row the run re-offers under another spelling is replaced by the new spelling
      // (the upsert keys on the exact ref, so keeping it would leave two rows for one item).
      if (!o) return replace;
      return o.role !== r.role || o.ref !== r.ref;
    })
    .map((r) => r.id);
  if (dropIds.length > 0) {
    const { error } = await supabase
      .from("code_session_issues")
      .delete()
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .in("id", dropIds);
    if (error) throw new Error(`writeSessionIssueRows: delete failed: ${error.message}`);
  }

  // Tail run: a stored row this run does not offer keeps its role, but its
  // share follows this run's mode (never a stale share next to fresh ones).
  if (!replace && rows.length > 0) {
    const inferredMode = rows.every((r) => r.turn_share === null);
    const stale = stored.filter((r) => {
      if (offered.has(keyOf(r.ref, r.kind))) return false;
      const share = r.turn_share === null ? null : Number(r.turn_share);
      return inferredMode ? share !== null : share === null || share > 0;
    });
    if (stale.length > 0) {
      const { error } = await supabase
        .from("code_session_issues")
        .update({ turn_share: inferredMode ? null : 0 })
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .in(
          "id",
          stale.map((r) => r.id),
        );
      if (error) throw new Error(`writeSessionIssueRows: share refresh failed: ${error.message}`);
    }
  }

  if (rows.length === 0) return 0;
  const { error } = await supabase
    .from("code_session_issues")
    .upsert(rows, { onConflict: "session_id,ref,kind,role", ignoreDuplicates: false });
  if (error) throw new Error(`writeSessionIssueRows: upsert failed: ${error.message}`);
  return rows.length;
}
