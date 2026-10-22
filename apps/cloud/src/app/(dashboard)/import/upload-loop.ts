// Pure logic for the /import page's batch-upload loop, split out of
// page.tsx (NEW-3, round-2 review) for two reasons: (1) it's unit-testable
// without jsdom/@testing-library, neither of which this repo has set up
// (see src/components/second-brain/__tests__/bootstrap-panel.test.tsx's
// header for the same constraint on a sibling component), and (2) Next.js's
// typed-routes generator restricts a page.tsx file to a fixed export
// surface (default, metadata, etc.) — any other named export fails
// `tsc --noEmit` against the generated .next/types.
//
// The bug this exists to prevent (NEW-3): the batch loop used to throw (on
// a non-ok response, or on exceeding MAX_STALL_RETRIES) WITHOUT ever calling
// setResult(cumulative) first — so a failure partway through a multi-chunk
// import silently discarded every import/update/error count already
// accumulated in that run. page.tsx now calls setResult(running)
// immediately before each throw; foldUploadResponse/nextStallState below are
// the pieces of logic responsible for building the `running` value that
// must survive that failure.

export type Provider = "chatgpt" | "claude";

export interface SkippedItem {
  id: string;
  reason: string;
}

export interface UploadResponse {
  provider?: Provider;
  total: number;
  /** The batch loop's progress denominator (conversations.length) — distinct
   * from `total` (which also counts never-processed skipped entries) so a
   * progress bar computed from this and nextOffset can actually reach 100%. */
  conversationsTotal?: number;
  imported: number;
  updated: number;
  skipped: SkippedItem[];
  /** Total skipped count — `skipped` above is capped at 20 for display. */
  skippedCount?: number;
  errors?: string[];
  durationMs: number;
  partial: boolean;
  nextOffset?: number;
  error?: string;
}

export interface Result {
  provider: Provider | null;
  total: number;
  imported: number;
  updated: number;
  skipped: SkippedItem[];
  skippedCount: number;
  errors: string[];
  durationMs: number;
}

/** Max consecutive same-offset retries before an import is reported as stalled. */
export const MAX_STALL_RETRIES = 3;

/** Pure fold step for one /api/import/upload response into the running cumulative total. */
export function foldUploadResponse(cumulative: Result, body: UploadResponse): Result {
  const skipped = body.skipped ?? [];
  return {
    provider: body.provider ?? cumulative.provider,
    total: body.total,
    imported: cumulative.imported + body.imported,
    updated: cumulative.updated + body.updated,
    skipped,
    skippedCount: body.skippedCount ?? skipped.length,
    errors: body.errors?.length ? [...cumulative.errors, ...body.errors] : cumulative.errors,
    durationMs: cumulative.durationMs + body.durationMs,
  };
}

export interface StallState {
  stalledAtOffset: number;
  stallRetries: number;
}

export const INITIAL_STALL_STATE: StallState = { stalledAtOffset: -1, stallRetries: 0 };

/**
 * Pure consecutive-no-progress tracker. A chunk upsert failure isolated
 * server-side (NEW-2) or a still-stalled server (the B1 safety net) both
 * come back with nextOffset === offset; retry the same offset a few times
 * (the upsert is idempotent) before giving up rather than looping forever.
 */
export function nextStallState(state: StallState, offset: number, nextOffset: number): StallState {
  if (nextOffset > offset) {
    return { stalledAtOffset: state.stalledAtOffset, stallRetries: 0 };
  }
  return {
    stalledAtOffset: nextOffset,
    stallRetries: nextOffset === state.stalledAtOffset ? state.stallRetries + 1 : 1,
  };
}
