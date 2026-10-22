// The `?turn=N` deep-link window (UX pass 2): turns N-BEFORE … N+AFTER render
// first; the session page links to the windows either side. Shared by the query
// (queries.ts) and the page's edge links (window-edges.ts) so they never drift.

export const SESSION_TURN_WINDOW_BEFORE = 15;
export const SESSION_TURN_WINDOW_AFTER = 50;

/** The idx range a `?turn=N` load asks for: [N-15, N+50], floored at 0 (never clamped above — the rows decide). Pure. */
export function turnWindow(aroundTurn: number): { from: number; to: number } {
  const n = Math.max(aroundTurn, 0);
  return { from: Math.max(0, n - SESSION_TURN_WINDOW_BEFORE), to: n + SESSION_TURN_WINDOW_AFTER };
}
