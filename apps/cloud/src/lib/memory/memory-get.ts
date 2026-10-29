// memory_get(ids): stepped disclosure for one served record (goal 2026-10-25 box 3.3, M2).
// memory_search / memory_recall serve a record; this opens it: the compact record, its quote
// (the receipt), and the turns around it from its own session. Read-only.
//
// SCOPING: every query filters user_id (and the key's code project when the key is bound). An id that is
// another user's, out of scope, retired, malformed or simply missing is reported the same way
// (`not_found`), so the tool never confirms that someone else's record exists.

import { z } from "zod/v4";
import type { Db } from "@/lib/db/types";
import { getCodeSession } from "@/lib/mcp/code-tools";
import { windowCodeSession } from "@/lib/mcp/paginate-code-session";
import { type CompactServedRecord, compactServedRecords } from "@/lib/mcp/served-record-view";
import { buildServeContext, MEMORY_ROW_COLUMNS, type MemoryRow, toServedRecord } from "./verify";

export const MEMORY_GET_MAX_IDS = 10;
/** Turns either side of the record's turn. Smaller than get_code_session's default (8): this is a glance, not a read. */
export const MEMORY_GET_DEFAULT_WINDOW = 4;
export const MEMORY_GET_MAX_WINDOW = 40;
/** Per-window character budget: the window is a peek, not the session. */
const MEMORY_GET_WINDOW_MAX_CHARS = 8_000;
/** Whole-response budget shared by every record (quote, fields and window); a record past it reports `truncated`. */
export const MEMORY_GET_TOTAL_MAX_CHARS = 24_000;
/** A window smaller than this is not worth sending: the record reports `truncated` instead. */
const MEMORY_GET_WINDOW_MIN_CHARS = 500;
/** An id is a uuid; anything longer is never echoed. */
const MEMORY_GET_ID_MAX_CHARS = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MemoryGetArgsSchema = z.object({
  ids: z.array(z.string().min(1).max(MEMORY_GET_ID_MAX_CHARS)).min(1).max(MEMORY_GET_MAX_IDS),
  include: z.array(z.enum(["quote", "window"])).optional(),
  window: z.number().int().optional(),
});
export type MemoryGetArgs = z.infer<typeof MemoryGetArgsSchema>;

export interface MemoryGetWindow {
  focus: unknown;
  turns: unknown[];
}

export interface MemoryGetItem extends Omit<CompactServedRecord, "quote"> {
  quote?: string;
  /** The session's turns around the record's turn_idx; absent when not asked for or the session is unreadable. */
  window?: MemoryGetWindow;
  /** True when the response budget left no room (or less than asked) for this record's window. */
  truncated?: boolean;
}

export interface MemoryGetResult {
  records: MemoryGetItem[];
  not_found: string[];
}

export function clampMemoryGetWindow(window: number | undefined): number {
  if (window === undefined || !Number.isFinite(window)) return MEMORY_GET_DEFAULT_WINDOW;
  return Math.min(MEMORY_GET_MAX_WINDOW, Math.max(1, Math.floor(window)));
}

export async function memoryGet(
  db: Db,
  userId: string,
  codeScopeId: string | null,
  rawArgs: unknown,
): Promise<MemoryGetResult> {
  const parsed = MemoryGetArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(`memory_get: ids (1-${MEMORY_GET_MAX_IDS} record ids) is required`);
  }
  const args = parsed.data;
  const include = new Set(args.include ?? ["quote", "window"]);
  const window = clampMemoryGetWindow(args.window);
  const asked = [...new Set(args.ids.map((i) => i.trim()))];
  const valid = asked.filter((i) => UUID_RE.test(i)).map((i) => i.toLowerCase());

  let rows: MemoryRow[] = [];
  if (valid.length > 0) {
    let query = db
      .from("session_memories")
      .select(MEMORY_ROW_COLUMNS)
      .eq("user_id", userId)
      .in("id", valid)
      .is("retired_at", null);
    if (codeScopeId) query = query.eq("code_project_id", codeScopeId);
    const { data, error } = await query;
    if (error) throw new Error(`memory_get: read failed: ${error.message}`);
    rows = (data ?? []) as unknown as MemoryRow[];
  }

  const found = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const ordered = valid.map((id) => found.get(id)).filter((r): r is MemoryRow => r !== undefined);
  const not_found = asked.filter((i) => !found.has(i.toLowerCase())).map((i) => i.slice(0, MEMORY_GET_ID_MAX_CHARS));
  if (ordered.length === 0) return { records: [], not_found };

  const ctx = await buildServeContext(db, userId, ordered);
  const served = ordered.map((r) => toServedRecord(r, { verified: r.verified, turn_idx: r.turn_idx }, ctx));
  const compact = await compactServedRecords(db, served, userId, Date.now(), true);

  // One session read per distinct session, shared by every record in it.
  const sessions = new Map<string, Promise<Record<string, unknown> | null>>();
  const sessionOf = (id: string) => {
    let p = sessions.get(id);
    if (!p) {
      p = getCodeSession(db, userId, id, codeScopeId).then((d) =>
        d ? (d as unknown as Record<string, unknown>) : null,
      );
      sessions.set(id, p);
    }
    return p;
  };

  const records: MemoryGetItem[] = [];
  let used = 0;
  for (const rec of compact) {
    const item: MemoryGetItem = { ...rec };
    if (!include.has("quote")) delete item.quote;
    used += JSON.stringify(item).length;
    if (include.has("window")) {
      const session = await sessionOf(rec.session_id);
      if (session) {
        // The window gets what is left of the shared budget (at most the per-window cap); later records report
        // `truncated` rather than vanish.
        const maxChars = Math.min(MEMORY_GET_WINDOW_MAX_CHARS, MEMORY_GET_TOTAL_MAX_CHARS - used);
        if (maxChars < MEMORY_GET_WINDOW_MIN_CHARS) {
          item.truncated = true;
        } else {
          const part = windowCodeSession(session, { turn: rec.turn_idx, window, maxChars });
          const turns = part.data.turns;
          item.window = { focus: part.data.focus, turns: Array.isArray(turns) ? turns : [] };
          used += JSON.stringify(item.window).length;
        }
      }
    }
    records.push(item);
  }
  return { records, not_found };
}
