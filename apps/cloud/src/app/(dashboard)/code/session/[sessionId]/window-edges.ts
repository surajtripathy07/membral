// UX pass 2: the "Show earlier/later turns" links of a `?turn=N` window load.
import { SESSION_TURN_WINDOW_AFTER, SESSION_TURN_WINDOW_BEFORE } from "@/lib/code-sessions/turn-window";

export const EDGE_LINK =
  "block text-label text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/**
 * A `?turn=N` load renders [from, to] only; these link to the windows either
 * side, landing on the turn next to this window's edge. Null where the
 * session ends. Pure.
 */
export function windowEdgeLinks(
  sessionId: string,
  win: { from: number; to: number; hasLater: boolean },
): { earlier: string | null; later: string | null } {
  const base = `/code/session/${sessionId}`;
  // Earlier: the window whose last turn is from-1 (its N = from-1-AFTER), landing on from-1.
  const earlier =
    win.from > 0 ? `${base}?turn=${Math.max(0, win.from - 1 - SESSION_TURN_WINDOW_AFTER)}#turn-${win.from - 1}` : null;
  // Later: the window starting at to+1 (its N = to+1+BEFORE), landing on to+1.
  const later = win.hasLater ? `${base}?turn=${win.to + 1 + SESSION_TURN_WINDOW_BEFORE}#turn-${win.to + 1}` : null;
  return { earlier, later };
}
