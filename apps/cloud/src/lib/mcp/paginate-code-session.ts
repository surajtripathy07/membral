/**
 * Splits one code session into parts for the MCP `get_code_session` tool.
 *
 * Same reason and shape as `get_conversation` paging (paginate-conversation.ts):
 * MCP hosts cap tool output (Claude Code: 25,000 tokens by default), so a long
 * session's `turns` (the user spine, the dominant size) come in parts sized by
 * each turn's `text`. Session metadata and summary are small and ride on every
 * part. `files_touched` can run to hundreds of paths, so it rides on the first
 * part only, capped at FILES_TOUCHED_CAP paths with a count of the rest.
 * `sub_agents` / `sub_agents_total` (migration 096) also ride on the first part
 * only; `parent_session_id` is small and rides on every part.
 *
 * Tool layer only: getCodeSession and the dashboard are not paginated.
 */

import { type ConversationPart, clampMaxChars, type PageSpec, paginateList } from "@/lib/mcp/paginate-conversation";

export const FILES_TOUCHED_CAP = 200;

const CODE_SESSION_SPEC: PageSpec = {
  listKey: "turns",
  contentKey: "text",
  subject: "session",
  toolName: "get_code_session",
};

export function paginateCodeSession(
  session: Record<string, unknown>,
  opts: { start?: number; maxChars?: number } = {},
): ConversationPart {
  const part = paginateList(session, CODE_SESSION_SPEC, opts);
  const data = part.data;
  const files = session.files_touched;
  const returned = data.returned as { start: number };

  if (returned.start > 0) {
    // Later parts: the first part already carried the file list and sub-agents.
    delete data.files_touched;
    delete data.sub_agents;
    delete data.sub_agents_total;
  } else if (Array.isArray(files) && files.length > FILES_TOUCHED_CAP) {
    data.files_touched = files.slice(0, FILES_TOUCHED_CAP);
    data.files_touched_total = files.length;
    data.files_touched_omitted = files.length - FILES_TOUCHED_CAP;
  }
  return { data, note: part.note };
}

/** Focus mode (`turn` given): turns within ±window of it, default 8, clamped 1–40. */
export const DEFAULT_TURN_WINDOW = 8;
export const MIN_TURN_WINDOW = 1;
export const MAX_TURN_WINDOW = 40;
/** Focus mode's turn-text budget when the caller passes no max_chars (still clamped like max_chars). */
export const DEFAULT_FOCUS_MAX_CHARS = 12_000;

export function clampWindow(window: number | undefined): number {
  if (window === undefined || !Number.isFinite(window)) return DEFAULT_TURN_WINDOW;
  return Math.min(MAX_TURN_WINDOW, Math.max(MIN_TURN_WINDOW, Math.floor(window)));
}

function turnIdx(t: unknown, pos: number): number {
  const idx = t && typeof t === "object" ? (t as Record<string, unknown>).idx : undefined;
  return typeof idx === "number" ? idx : pos;
}

function turnChars(t: unknown): number {
  const text = t && typeof t === "object" ? (t as Record<string, unknown>).text : undefined;
  return typeof text === "string" ? text.length : JSON.stringify(t ?? null).length;
}

/**
 * Focus mode for `get_code_session turn=<n>`: the turns whose idx is in
 * [turn - window, turn + window], clamped to the session, instead of the
 * session from `start`. A cited record names one turn; this returns the
 * words around it without the rest of the session. The window is filled
 * outward from the focus turn while the turn text fits `maxChars` (default
 * DEFAULT_FOCUS_MAX_CHARS), so a budget cut drops the far ends first; the
 * focus turn itself is always returned (cut and marked truncated when it
 * alone is over budget). Turns outside the window are never returned.
 *
 * Adds `focus {turn, window, first_idx, last_idx, total_turns}`, `prev_start`
 * (a `start` that reads the block of turns just before this slice; null at
 * the session's start) and `next_start` (the `start` that continues after
 * it; null at the end). A `turn` past the last turn returns an empty slice,
 * the counts and a note, not an error. files_touched and sub_agents ride only
 * when the slice begins at the session's first turn, as with paging.
 */
export function windowCodeSession(
  session: Record<string, unknown>,
  opts: { turn: number; window?: number; maxChars?: number },
): ConversationPart {
  const turn = Math.max(0, Math.floor(opts.turn));
  const window = clampWindow(opts.window);
  const maxChars = clampMaxChars(opts.maxChars ?? DEFAULT_FOCUS_MAX_CHARS);
  const raw = session.turns;
  const turns: unknown[] = Array.isArray(raw) ? raw : [];
  const total = turns.length;
  const totalChars = turns.reduce<number>((a, t) => a + turnChars(t), 0);

  const lastIdx = total > 0 ? turnIdx(turns[total - 1], total - 1) : -1;
  const pastEnd = turn > lastIdx;
  const inRange = (centreIdx: number): number[] => {
    // Array positions of the turns inside the window (turns arrive ordered by idx).
    const out: number[] = [];
    turns.forEach((t, pos) => {
      const idx = turnIdx(t, pos);
      if (idx >= centreIdx - window && idx <= centreIdx + window) out.push(pos);
    });
    return out;
  };
  let centreIdx = turn;
  let inWindow = pastEnd ? [] : inRange(turn);
  // Sparse idx: no turn within ±window of `turn`. Centre on the nearest turn instead (tie -> the earlier one).
  let recentred = false;
  if (!pastEnd && inWindow.length === 0 && total > 0) {
    let best = 0;
    for (let pos = 1; pos < total; pos++) {
      if (Math.abs(turnIdx(turns[pos], pos) - turn) < Math.abs(turnIdx(turns[best], best) - turn)) best = pos;
    }
    centreIdx = turnIdx(turns[best], best);
    inWindow = inRange(centreIdx);
    recentred = true;
  }

  // Fill outward from the turn nearest the focus while the budget holds.
  const kept = new Set<number>();
  const truncated = new Map<number, unknown>();
  if (!pastEnd && inWindow.length > 0) {
    let centre = 0;
    for (let i = 0; i < inWindow.length; i++) {
      const d = Math.abs(turnIdx(turns[inWindow[i]], inWindow[i]) - centreIdx);
      if (d < Math.abs(turnIdx(turns[inWindow[centre]], inWindow[centre]) - centreIdx)) centre = i;
    }
    const order: number[] = [centre];
    for (let step = 1; order.length < inWindow.length; step++) {
      if (centre - step >= 0) order.push(centre - step);
      if (centre + step < inWindow.length) order.push(centre + step);
    }
    let used = 0;
    let lo = centre;
    let hi = centre;
    for (const i of order) {
      // Keep the slice contiguous: stop growing a side once a turn on it does not fit.
      if (i < lo - 1 || i > hi + 1) continue;
      const pos = inWindow[i];
      const size = turnChars(turns[pos]);
      if (i === centre && size > maxChars) {
        const t = turns[pos] as Record<string, unknown>;
        truncated.set(pos, {
          ...t,
          text: typeof t.text === "string" ? t.text.slice(0, maxChars) : t.text,
          truncated: true,
          truncation_note: `Content cut to ${maxChars.toLocaleString("en-US")} of ${size.toLocaleString("en-US")} chars.`,
        });
        kept.add(pos);
        used = maxChars;
        continue;
      }
      if (used + size > maxChars) continue;
      kept.add(pos);
      used += size;
      lo = Math.min(lo, i);
      hi = Math.max(hi, i);
    }
  }
  const positions = [...kept].sort((a, b) => a - b);
  const slice = positions.map((pos) => truncated.get(pos) ?? turns[pos]);
  const firstPos = positions.length ? positions[0] : null;
  const lastPos = positions.length ? positions[positions.length - 1] : null;
  const firstIdx = firstPos === null ? null : turnIdx(turns[firstPos], firstPos);
  const lastIdxReturned = lastPos === null ? null : turnIdx(turns[lastPos], lastPos);

  const data: Record<string, unknown> = {
    ...session,
    turns: Array.isArray(raw) ? slice : raw,
    total_turns: total,
    total_chars: totalChars,
    focus: { turn, window, first_idx: firstIdx, last_idx: lastIdxReturned, total_turns: total },
    // Positions, never idx values: an empty slice reports {total, total}.
    returned: { start: firstPos ?? total, end: lastPos === null ? total : lastPos + 1 },
    prev_start: firstPos === null || firstPos === 0 ? null : Math.max(0, firstPos - positions.length),
    next_start: lastPos === null || lastPos >= total - 1 ? null : lastPos + 1,
  };
  if (firstPos !== 0) {
    delete data.files_touched;
    delete data.sub_agents;
    delete data.sub_agents_total;
  } else {
    const files = session.files_touched;
    if (Array.isArray(files) && files.length > FILES_TOUCHED_CAP) {
      data.files_touched = files.slice(0, FILES_TOUCHED_CAP);
      data.files_touched_total = files.length;
      data.files_touched_omitted = files.length - FILES_TOUCHED_CAP;
    }
  }

  let note: string | null = null;
  if (pastEnd && total > 0) {
    note = `turn=${turn} is past the end: this session has ${total} turns (last turn ${lastIdx}).`;
  } else if (pastEnd) {
    note = "This session has no turns.";
  } else if (firstIdx !== null && lastIdxReturned !== null) {
    const more = [
      data.prev_start !== null ? `start=${data.prev_start} for earlier turns` : null,
      data.next_start !== null ? `start=${data.next_start} for later ones` : null,
    ].filter(Boolean);
    note =
      (recentred ? `No turn within ±${window} of turn ${turn}; centred on the nearest, turn ${centreIdx}. ` : "") +
      `Showing turns ${firstIdx}–${lastIdxReturned} around turn ${centreIdx} (window ±${window}) of ${total}.` +
      (more.length ? ` Call get_code_session with ${more.join(", or ")}.` : "");
  }
  return { data, note };
}
