// G2 step 2.4e: the pure row shaping behind write/io.ts's retire writes
// (retireExtractorRowsForSession, retireRowsByIds, retagUnverifiedAsRerun,
// retireBlockersResolvedLater). The Supabase updates, their filters, the
// timestamp taken per call and the error/warn lines stay in write/io.ts.

/** A resolved blocker's receipt, as retireBlockersResolvedLater receives it. */
export interface ResolvedBlockerReceipt {
  resolvedBySessionId: string;
  quote: string;
  turnIdx: number;
}

/** The update payload that retires a row: `retired_at` then `retire_reason`. */
export function retireUpdate(retiredAt: string, reason: string): { retired_at: string; retire_reason: string } {
  return { retired_at: retiredAt, retire_reason: reason };
}

/** The update payload that retires a resolved blocker with its receipt (migration 092 columns). */
export function resolvedBlockerUpdate(
  retiredAt: string,
  reason: string,
  receipt: ResolvedBlockerReceipt,
): {
  retired_at: string;
  retire_reason: string;
  resolved_by_session_id: string;
  resolution_quote: string;
  resolution_turn_idx: number;
} {
  return {
    retired_at: retiredAt,
    retire_reason: reason,
    resolved_by_session_id: receipt.resolvedBySessionId,
    resolution_quote: receipt.quote,
    resolution_turn_idx: receipt.turnIdx,
  };
}

/** The ids of the rows an update returned, in order; a null result reads as none. */
export function returnedIds(data: unknown): string[] {
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}
