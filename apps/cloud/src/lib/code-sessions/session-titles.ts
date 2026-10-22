// UX W5: a display title for every session a dashboard row references
// (Today's threads, Issues rows, Usage outcome rows), so "3 sessions" becomes
// "Fix the login redirect +2 more" and the reader can tell whether they are
// the same session or different ones.
//
// The title is the session page's own source (`sessionDisplayTitle`,
// view.ts): short_title (migration 110), else title, else summary, else the first line of the first real user
// prompt. A sub-agent (child) session reads as its PARENT's title plus the
// sub-agent's label ("Fix the login redirect · Explore"), because a child's
// own title is usually the parent's brief. Never an absolute path:
// every title goes through `stripLocalPaths` last.
//
// Batched: a caller collects every id its rows reference and calls
// `getSessionTitles` ONCE per request. That call issues a fixed number of
// `.in()` reads (sessions, their parents, first prompts for the untitled
// ones), chunked only so a very long id list stays under the URL limit —
// never one query per row.
import type { Db } from "@/lib/db/types";
import { mapWithConcurrency, READ_FANOUT_LIMIT } from "@/lib/util/concurrency";
import { getFirstUserMessages } from "./queries";
import { sessionDisplayTitle, stripLocalPaths } from "./view";

export interface SessionTitleInfo {
  id: string;
  title: string;
  started_at: string | null;
}

/** A session a row references, as the row renders it: title, link target, and the turn that proves the row. */
export interface SessionTitleRef {
  id: string;
  title: string;
  started_at: string | null;
  /** The turn the row traces to, for the `#turn-N` anchor; null/absent links the session top. */
  turn_idx?: number | null;
  /** The session the link opens when it is not `id` — a sub-agent child whose turn shows the action. */
  target_session_id?: string | null;
}

export interface SessionTitleSourceRow {
  id: string;
  /** Migration 110's generated title; absent on rows read before it. */
  short_title?: string | null;
  title: string | null;
  summary: string | null;
  started_at: string | null;
  source?: string | null;
  source_session_id?: string | null;
  parent_source_session_id?: string | null;
  /** code_sessions.props.subAgent (child rows only). */
  sub_agent?: { description?: unknown; agentType?: unknown } | null;
}

/** Ids per `.in()` read — a UUID list this long stays well under PostgREST's URL limit. */
const ID_CHUNK = 150;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One line, no absolute path. */
export function cleanTitle(text: string): string {
  return stripLocalPaths(text).replace(/\s+/g, " ").trim();
}

/** The sub-agent's label: its description, else its agent type; null when it has neither. */
export function subAgentLabel(row: Pick<SessionTitleSourceRow, "sub_agent">): string | null {
  const sub = row.sub_agent;
  if (!sub || typeof sub !== "object") return null;
  const description = typeof sub.description === "string" ? sub.description.trim() : "";
  if (description) return description;
  const agentType = typeof sub.agentType === "string" ? sub.agentType.trim() : "";
  return agentType || null;
}

/**
 * The title a row shows for `row`: its own `sessionDisplayTitle`, or — for a
 * sub-agent child — its parent's, followed by " · <sub-agent label>" when the
 * child has one. Pure; `firstMessages` feeds the untitled fallback.
 */
export function composeSessionTitle(
  row: SessionTitleSourceRow,
  parent: SessionTitleSourceRow | null,
  firstMessages: ReadonlyMap<string, string>,
): string {
  const base = parent ?? row;
  const baseTitle = cleanTitle(sessionDisplayTitle({ ...base, firstUserMessage: firstMessages.get(base.id) ?? null }));
  if (!row.parent_source_session_id) return baseTitle;
  const label = subAgentLabel(row);
  return label ? `${baseTitle} · ${cleanTitle(label)}` : baseTitle;
}

/** Every distinct id across `lists`, in first-seen order. */
export function collectSessionIds(lists: Iterable<readonly (string | null | undefined)[]>): string[] {
  const seen = new Set<string>();
  for (const list of lists) for (const id of list) if (id) seen.add(id);
  return [...seen];
}

export type SessionTitleLookup = (ids: string[]) => Promise<Map<string, SessionTitleInfo>>;

/**
 * Titles for every id the rows reference, through ONE `lookup` call (no
 * per-row query). An empty id list skips the lookup entirely.
 */
export async function lookupTitlesOnce<T>(
  rows: readonly T[],
  idsOf: (row: T) => readonly (string | null | undefined)[],
  lookup: SessionTitleLookup,
): Promise<Map<string, SessionTitleInfo>> {
  const ids = collectSessionIds(rows.map(idsOf));
  if (ids.length === 0) return new Map();
  return lookup(ids);
}

/**
 * `ids` as SessionTitleRefs, newest first; an id the lookup never returned
 * (deleted, or another user's) is left out rather than shown as a placeholder.
 */
export function toSessionRefs(
  ids: readonly string[],
  titles: ReadonlyMap<string, SessionTitleInfo>,
  turnIdxOf?: (id: string) => number | null | undefined,
  /** The session whose turn `turnIdxOf` names, when not `id` itself (a sub-agent child). */
  targetOf?: (id: string) => string | null | undefined,
): SessionTitleRef[] {
  const refs: SessionTitleRef[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const info = titles.get(id);
    if (!info) continue;
    const target = targetOf?.(id);
    refs.push({
      id,
      title: info.title,
      started_at: info.started_at,
      turn_idx: turnIdxOf?.(id) ?? null,
      ...(target && target !== id ? { target_session_id: target } : {}),
    });
  }
  return refs.sort((a, b) => (Date.parse(b.started_at ?? "") || 0) - (Date.parse(a.started_at ?? "") || 0));
}

const TITLE_COLUMNS =
  "id, short_title, title, summary, started_at, source, source_session_id, parent_source_session_id, sub_agent:props->subAgent";

/**
 * Display titles for `sessionIds` (the caller's own sessions only — every
 * read is `.eq("user_id", userId)`). Call once per request with every id the
 * page's rows reference.
 */
export async function getSessionTitles(
  supabase: Db,
  userId: string,
  sessionIds: readonly string[],
): Promise<Map<string, SessionTitleInfo>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Map();

  // #173: each step's chunks are read concurrently (they were one after
  // another) and concatenated in chunk order; the three steps stay ordered
  // because each needs the previous step's rows.
  const rows: SessionTitleSourceRow[] = [];
  const idPages = await mapWithConcurrency(chunk(ids, ID_CHUNK), READ_FANOUT_LIMIT, (idChunk) =>
    Promise.resolve(supabase.from("code_sessions").select(TITLE_COLUMNS).eq("user_id", userId).in("id", idChunk)),
  );
  for (const { data, error } of idPages) {
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as SessionTitleSourceRow[]));
  }

  // Parents of the child rows, by (source, source_session_id) — the key a child names its parent by (089).
  const parentKeysBySource = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.parent_source_session_id || !r.source) continue;
    const set = parentKeysBySource.get(r.source) ?? new Set<string>();
    set.add(r.parent_source_session_id);
    parentKeysBySource.set(r.source, set);
  }
  const parentByKey = new Map<string, SessionTitleSourceRow>();
  const parentChunks = [...parentKeysBySource].flatMap(([source, keys]) =>
    chunk([...keys], ID_CHUNK).map((keyChunk) => ({ source, keyChunk })),
  );
  const parentPages = await mapWithConcurrency(parentChunks, READ_FANOUT_LIMIT, ({ source, keyChunk }) =>
    Promise.resolve(
      supabase
        .from("code_sessions")
        .select(TITLE_COLUMNS)
        .eq("user_id", userId)
        .eq("source", source)
        .in("source_session_id", keyChunk),
    ).then((res) => ({ source, ...res })),
  );
  for (const { source, data, error } of parentPages) {
    if (error) throw new Error(error.message);
    for (const p of (data ?? []) as SessionTitleSourceRow[])
      parentByKey.set(`${source}\u0000${p.source_session_id}`, p);
  }
  const parentOf = (r: SessionTitleSourceRow): SessionTitleSourceRow | null =>
    r.parent_source_session_id && r.source
      ? (parentByKey.get(`${r.source}\u0000${r.parent_source_session_id}`) ?? null)
      : null;

  // First prompts, only for the sessions whose title would otherwise fall to "Untitled session".
  const needPrompt = new Set<string>();
  for (const r of rows) {
    const base = parentOf(r) ?? r;
    if (!base.short_title?.trim() && !base.title?.trim() && !base.summary?.trim()) needPrompt.add(base.id);
  }
  const firstMessages = new Map<string, string>();
  // Small chunks: the read returns every user prose turn of each session, under a 1000-row response cap.
  const promptPages = await mapWithConcurrency(chunk([...needPrompt], 25), READ_FANOUT_LIMIT, (idChunk) =>
    getFirstUserMessages(supabase, userId, idChunk),
  );
  for (const page of promptPages) for (const [id, text] of page) firstMessages.set(id, text);

  const out = new Map<string, SessionTitleInfo>();
  for (const r of rows)
    out.set(r.id, { id: r.id, title: composeSessionTitle(r, parentOf(r), firstMessages), started_at: r.started_at });
  return out;
}

/** A Today thread row, as far as titles go: its folded session and the (possibly child) session that proves it. */
export interface ThreadSessionIds {
  sessions: readonly { id: string; proof_session_id: string }[];
}

/**
 * Id → title for every session the thread rows reference (both the folded
 * session and the child that proves the row): ONE lookup call, never per row.
 * Never throws — a failed lookup is `{}` and the rows still render.
 */
export async function threadSessionTitles(
  threads: readonly ThreadSessionIds[],
  lookup: SessionTitleLookup,
): Promise<Record<string, string>> {
  try {
    const titles = await lookupTitlesOnce(
      threads,
      (t) => t.sessions.flatMap((s) => [s.id, s.proof_session_id]),
      lookup,
    );
    return Object.fromEntries([...titles].map(([id, info]) => [id, info.title]));
  } catch {
    return {};
  }
}
