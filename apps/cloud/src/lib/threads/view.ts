// Pure view helpers for the Today / Yesterday / Blockers thread blocks —
// moved out of pulse/threads-content.tsx (G3 3D-2) with zero behaviour
// change. React components (JSX, hooks) stayed there; anything importable
// here is plain data-in, data-out.

import { sessionHref } from "@/components/session-title-list";
import { preferredRef } from "@/lib/code-sessions/ref-canon";
import { stripLocalPaths } from "@/lib/code-sessions/view";
import { itemKeyResolver, itemReadKey } from "@/lib/domain/ref-identity";
import type { ForgeFamily, ForgeRefKind } from "@/lib/forge/ref-url";
import { refLabel } from "@/lib/format/ref-label";
import { fmtUsd, fmtUsdEst } from "@/lib/format/usd";
import {
  type BuildRung,
  type RecurringBlocker,
  type ReviewRung,
  THREAD_WINDOW_DAYS,
  type Thread,
  type ThreadSession,
} from "@/lib/threads/open-threads";

/** Rows each capped block shows before its "+N more" (audit §3.3: 5 on Today). */
export const YESTERDAY_INITIAL = 5;
export const BLOCKERS_INITIAL = 3;

const REVIEW_WORDS: Record<ReviewRung, string> = {
  viewed: "viewed",
  checked_out: "checked out",
  reviewed: "reviewed",
  commented: "commented",
  approved: "approved",
};
const BUILD_WORDS: Record<BuildRung, string> = {
  edited: "edited",
  committed: "committed",
  pushed: "pushed",
  opened_mr: "opened MR",
  merged: "merged",
  closed: "closed",
};
const REVIEW_ORDER: readonly ReviewRung[] = ["viewed", "checked_out", "reviewed", "commented", "approved"];
const BUILD_ORDER: readonly BuildRung[] = ["edited", "committed", "pushed", "opened_mr", "merged", "closed"];

/** The ladder as words, highest observed rung per ladder: `reviewed · committed`, `triaged`, `discussed`. */
export function ladderWords(thread: Pick<Thread, "ladder">): string[] {
  const { review_verb, build_verb, triaged, discussed } = thread.ladder;
  if (discussed) return ["discussed"];
  const words: string[] = [];
  if (review_verb) words.push(REVIEW_WORDS[review_verb] ?? review_verb);
  if (build_verb) words.push(BUILD_WORDS[build_verb] ?? build_verb);
  if (triaged) words.push("triaged");
  return words.length > 0 ? words : ["discussed"];
}

/**
 * `$2.10 est.` — every dollar figure labelled (B11), through the one money
 * formatter (`fmtUsdEst`). No attributed cost (unpriced, or a share of 0: a
 * viewed-in-passing ref) is a bare dash with no `est.` — never `$0.00`.
 */
export function formatEstCost(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0) return "—";
  return fmtUsdEst(amount);
}

/**
 * A grouped row's chip text on Today: the shared D-065 rule (`refLabel`, also the Issues page's
 * `compactRefLabel`), from the same host check as the chip's link (`forgeUrl` with `forge_family`).
 */
export function threadRefLabel(t: { ref: string; refKind?: ForgeRefKind; forge_family?: ForgeFamily | null }): string {
  return refLabel(t.ref, { kind: t.refKind, family: t.forge_family });
}

/**
 * UX pass 2: Yesterday is the previous CALENDAR day in the viewer's own
 * timezone (this renders in the browser), judged by the action turn's time —
 * never a rolling 36 h, which pulled today's actions in under a "Yesterday"
 * heading dated "today".
 */
export function yesterdayBounds(now: number): { start: number; end: number } {
  const today = new Date(now);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  return { start, end };
}

/** A day window: [start, end) epoch ms, local midnight to local midnight. */
export interface DayBounds {
  start: number;
  end: number;
}

function inWindow(iso: string | null | undefined, now: number, bounds: DayBounds = yesterdayBounds(now)): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= bounds.start && t < bounds.end;
}

/** `YYYY-MM-DD` of a local calendar day. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local-midnight bounds of the calendar day `offset` days from the one holding `ms`. */
function dayBoundsAt(ms: number, offset = 0): DayBounds {
  const d = new Date(ms);
  return {
    start: new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime(),
    end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset + 1).getTime(),
  };
}

/** How far back the day navigation goes: the threads window the page already loads (THREAD_WINDOW_DAYS). */
// One day short of the loaded window (review r2 N2): sessions load from now − 30×24 h, so the 30th local day back is only partly there.
export const DAY_LOOKBACK_DAYS = THREAD_WINDOW_DAYS - 1;

/**
 * `?day=YYYY-MM-DD` as a local calendar day (the viewer's timezone). Absent,
 * malformed, a non-existent date, in the future, or older than the loaded
 * window → yesterday. Pure given `now`.
 */
export function parseDayParam(raw: string | null | undefined, now: number): DayBounds {
  const fallback = yesterdayBounds(now);
  const m = typeof raw === "string" ? raw.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return fallback;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const start = new Date(y, mo, d);
  if (start.getFullYear() !== y || start.getMonth() !== mo || start.getDate() !== d) return fallback;
  const bounds = dayBoundsAt(start.getTime());
  const today = dayBoundsAt(now);
  if (bounds.start > today.start) return fallback;
  if (bounds.start < dayBoundsAt(now, -DAY_LOOKBACK_DAYS).start) return fallback;
  return bounds;
}

/** "Today", "Yesterday", else "Thu 25 Sept" (the viewer's locale). */
export function dayLabel(bounds: DayBounds, now: number): string {
  const today = dayBoundsAt(now);
  if (bounds.start === today.start) return "Today";
  if (bounds.start === dayBoundsAt(now, -1).start) return "Yesterday";
  return new Date(bounds.start).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** The ‹ › targets: the neighbouring days' keys, null where navigation stops (today; the lookback edge). */
export function dayNav(bounds: DayBounds, now: number): { prev: string | null; next: string | null } {
  const today = dayBoundsAt(now);
  const oldest = dayBoundsAt(now, -DAY_LOOKBACK_DAYS);
  const prev = dayBoundsAt(bounds.start, -1);
  const next = dayBoundsAt(bounds.start, 1);
  return {
    prev: prev.start >= oldest.start ? dayKey(prev.start) : null,
    next: bounds.start < today.start ? dayKey(next.start) : null,
  };
}

function sumCost(sessions: readonly ThreadSession[]): number | null {
  let cost: number | null = null;
  for (const s of sessions) {
    if (s.cost_est !== null && s.cost_est !== undefined) cost = Math.round(((cost ?? 0) + s.cost_est) * 1e6) / 1e6;
  }
  return cost;
}

/** v4 item 5: when a session's row on the thread happened — its action turn, else the session start. */
export function sessionAt(s: Pick<ThreadSession, "at" | "started_at">): string | null {
  return s.at ?? s.started_at;
}

/**
 * The thread as the Yesterday block shows it (review S1): the verbs of the
 * thread's actions whose own turn falls in the window — every in-window action,
 * never an older one from the same long session — and the sessions those
 * actions ran in, cost summed over them (F5). A session with no recorded
 * action on the thread falls back to its row (dated by its proof turn, v4 item 5).
 */
export function yesterdayView(thread: Thread, now: number, bounds: DayBounds = yesterdayBounds(now)): Thread {
  const events = thread.events ?? [];
  const inWin = events.filter((e) => inWindow(e.at, now, bounds));
  const withEvents = new Set(events.map((e) => e.session));
  const winSessions = new Set(inWin.map((e) => e.session));
  // Review r2 S2: in the day view a session is dated by its latest action ON THAT DAY, never by
  // its end (a session ending after midnight is still yesterday's work).
  const dayAt = new Map<string, string>();
  for (const e of inWin) {
    const later = laterIso(dayAt.get(e.session) ?? null, e.at);
    if (later) dayAt.set(e.session, later);
  }
  const sessions = thread.sessions
    .filter((s) => (withEvents.has(s.id) ? winSessions.has(s.id) : inWindow(sessionAt(s), now, bounds)))
    .map((s) => ({ ...s, at: dayAt.get(s.id) ?? sessionAt(s), ended_at: null }));
  let review: ReviewRung | null = null;
  let build: BuildRung | null = null;
  let last: string | null = null;
  for (const e of inWin) {
    review = higher(REVIEW_ORDER, review, e.review_verb);
    build = higher(BUILD_ORDER, build, e.build_verb);
    last = laterIso(last, e.at);
  }
  for (const s of sessions) {
    if (withEvents.has(s.id)) continue;
    review = higher(REVIEW_ORDER, review, s.review_verb);
    build = higher(BUILD_ORDER, build, s.build_verb);
    last = laterIso(last, sessionAt(s));
  }
  const discussed = review === null && build === null && sessions.every((s) => s.tier === "discussed");
  return {
    ...thread,
    sessions,
    cost_est_total: sumCost(sessions),
    ladder: { review_verb: review, build_verb: build, triaged: thread.ladder.triaged, discussed },
    last_seen_at: last ?? thread.last_seen_at,
  };
}

/** Threads with a session in the Yesterday window, latest first (the order `recent_threads` already has). */
export function yesterdayThreads(
  recent: readonly Thread[],
  now: number,
  bounds: DayBounds = yesterdayBounds(now),
): Thread[] {
  return recent.map((t) => yesterdayView(t, now, bounds)).filter((t) => t.sessions.length > 0);
}

function higher<T extends string>(order: readonly T[], a: T | null, b: T | null): T | null {
  if (a === null) return b;
  if (b === null) return a;
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * The item a row stands for, through the one key function (D-064): hosts kept, so
 * `github.com/acme/api#5` and `codehub.example/acme/api#5` are two rows. Pass `keyOf` built
 * over the rows being merged (`itemKeyResolver`) so a host-less copy joins its one hosted row.
 */
export function refIdentity(
  t: Pick<Thread, "ref" | "refKind">,
  keyOf: (ref: string, kind: string) => string = itemReadKey,
): string {
  return keyOf(t.ref, t.refKind ?? "issue");
}

const threadScope = (threads: readonly Pick<Thread, "ref" | "refKind">[]) =>
  itemKeyResolver(threads.map((t) => ({ ref: t.ref, kind: t.refKind ?? "issue" })));

/**
 * One thread per item (D-064 key over these threads): the verbs merged into one ladder (highest
 * rung per ladder), the sessions unioned (each once), the cost re-summed over that union and the
 * host-qualified ref kept so the chip can still link. Two forges' `#5` stay two threads.
 */
export function mergeByRef(
  threads: readonly Thread[],
  keyOf: (ref: string, kind: string) => string = threadScope(threads),
): Thread[] {
  const merged = new Map<string, Thread>();
  for (const t of threads) {
    const key = refIdentity(t, keyOf);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...t, sessions: [...t.sessions] });
      continue;
    }
    const sessions = [...prev.sessions];
    for (const s of t.sessions) if (!sessions.some((x) => x.id === s.id)) sessions.push(s);
    sessions.sort((a, b) => (Date.parse(sessionAt(a) ?? "") || 0) - (Date.parse(sessionAt(b) ?? "") || 0));
    merged.set(key, {
      ...prev,
      ref: preferredRef(prev.ref, t.ref),
      url: prev.url ?? t.url,
      title: prev.title ?? t.title,
      forge_title: prev.forge_title ?? t.forge_title,
      first_commit_subject: prev.first_commit_subject ?? t.first_commit_subject,
      commit_count: Math.max(prev.commit_count ?? 0, t.commit_count ?? 0) || undefined,
      ladder: {
        review_verb: higher(REVIEW_ORDER, prev.ladder.review_verb, t.ladder.review_verb),
        build_verb: higher(BUILD_ORDER, prev.ladder.build_verb, t.ladder.build_verb),
        triaged: prev.ladder.triaged || t.ladder.triaged,
        discussed: prev.ladder.discussed && t.ladder.discussed,
      },
      sessions,
      cost_est_total: sumCost(sessions),
      last_seen_at: laterIso(prev.last_seen_at, t.last_seen_at),
      inferred_ref: prev.inferred_ref && t.inferred_ref,
      note: prev.note ?? t.note,
      dismissed: prev.dismissed || t.dismissed,
      dismiss_reason: prev.dismiss_reason ?? t.dismiss_reason,
    });
  }
  return [...merged.values()];
}

/** Priced rows first, most spend first; the unpriced ("—") rows after them, latest first. */
export function orderYesterday(threads: readonly Thread[]): Thread[] {
  const priced = (t: Thread) => (t.cost_est_total ?? 0) > 0;
  const at = (t: Thread) => Date.parse(t.last_seen_at ?? "") || 0;
  return [...threads].sort((a, b) => {
    if (priced(a) !== priced(b)) return priced(a) ? -1 : 1;
    if (priced(a)) return (b.cost_est_total ?? 0) - (a.cost_est_total ?? 0) || at(b) - at(a);
    return at(b) - at(a);
  });
}

/**
 * Yesterday as rendered: window-scoped, one row per (kind, repo#N), priced
 * first. UX W6: a ref already listed under Open threads (`shownAbove`) is
 * dropped, so each ref appears once on the page.
 */
export function yesterdayRows(
  recent: readonly Thread[],
  now: number,
  shownAbove: readonly Thread[] = [],
  bounds: DayBounds = yesterdayBounds(now),
): Thread[] {
  // One scope over both lists, so a host-less copy here and its hosted row above key alike.
  const keyOf = threadScope([...recent, ...shownAbove]);
  const above = new Set(shownAbove.map((t) => refIdentity(t, keyOf)));
  return orderYesterday(mergeByRef(yesterdayThreads(recent, now, bounds), keyOf)).filter(
    (t) => !above.has(refIdentity(t, keyOf)),
  );
}

/** Blockers most recurrent first, ties latest first — before any cap. */
export function orderBlockers(blockers: readonly RecurringBlocker[]): RecurringBlocker[] {
  const at = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);
  return [...blockers].sort((a, b) => {
    if (b.recurrence_count !== a.recurrence_count) return b.recurrence_count - a.recurrence_count;
    const ta = at(a.last_seen_at);
    const tb = at(b.last_seen_at);
    return (Number.isFinite(tb) ? tb : -Infinity) - (Number.isFinite(ta) ? ta : -Infinity);
  });
}

/** Whitespace collapsed, trailing punctuation dropped: two copies of one sentence compare equal. */
export function normalizeQuote(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.,;:!?…'"”’)\]]+$/u, "");
}

export function sessionTurnHref(sessionId: string, turnIdx: number | null | undefined): string {
  return sessionHref(sessionId, turnIdx);
}

export function fmtDay(iso: string | null, now: number): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  return sameDay ? "today" : then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Session id → display title (the caller builds it with `sessionDisplayTitle`, the session page's own source). */
export type SessionTitles = Readonly<Record<string, string>>;

const MAX_ROW_TITLE_CHARS = 80;

/** Stand-in when no title reached the page for a session (the lookup missed it) — the session page's own neutral fallback. */
export const UNTITLED_SESSION = "Untitled session";

/**
 * The session's title, one line, never an absolute path. The session that
 * PROVES the row (a sub-agent child reads "parent title · label") wins over
 * the session it folded into.
 */
export function sessionRowTitle(s: Pick<ThreadSession, "id" | "proof_session_id">, titles: SessionTitles): string {
  const raw = titles[s.proof_session_id] ?? titles[s.id];
  const clean = raw ? stripLocalPaths(raw).replace(/\s+/g, " ").trim() : "";
  if (!clean) return UNTITLED_SESSION;
  return clean.length > MAX_ROW_TITLE_CHARS ? `${clean.slice(0, MAX_ROW_TITLE_CHARS).trimEnd()}…` : clean;
}
/** `codehub.example/acme/billing#151` → `acme/billing` (host dropped; the repo header's text); a bare `#12` has no repo. */
export function refRepo(ref: string): string | null {
  const m = ref.match(/^([^/\s#!]+\.[^/\s#!]+)\/(.+[#!]\d+)$/);
  const short = m ? m[2] : ref;
  return short.match(/^(.*?)[#!]\d+$/)?.[1] || null;
}

export interface RepoGroup {
  repo: string | null;
  threads: Thread[];
}

/** Open threads under their repo, in the order the rows already have (groups by first appearance, rows keep their sort). */
export function groupByRepo(threads: readonly Thread[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const t of threads) {
    const repo = refRepo(t.ref);
    const key = (repo ?? "").toLowerCase();
    const g = groups.get(key);
    if (g) g.threads.push(t);
    else groups.set(key, { repo, threads: [t] });
  }
  return [...groups.values()];
}

/** A title that says nothing about the session (summarize.ts's no-prose fallback, or no title at all): the row shows no title instead. */
export function isPlaceholderTitle(title: string): boolean {
  // summarize.ts's heuristic summary PREFIXES the sentence ("A short session with no recorded prose. Touched 9 files: …").
  return title === UNTITLED_SESSION || /^A short session with no recorded prose/i.test(title);
}

/** Open-thread cost: the bare figure — the section's footer (cost line) carries "est." once. */
export function formatRowCost(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0) return "—";
  return fmtUsd(amount);
}
/** How a thread block is grouped: by latest session (default) or `?group=repo` — by repo. */
export type ThreadGrouping = "repo" | "session";

/** Sessions each project shows before its "+N more sessions". */
export const SESSIONS_PER_PROJECT_INITIAL = 5;
/** Refs a collapsed "viewed" line names before its "+N more". */
export const VIEWED_REFS_INITIAL = 5;

export interface SessionGroup {
  id: string;
  /** The session's display title; a placeholder becomes "Session · <date>". */
  title: string;
  /** Last activity: the session's end, else its latest action on these refs, else its start. */
  last_at: string | null;
  /** The whole session's est. cost (the per-session cost source), null when unpriced. */
  cost: number | null;
  threads: Thread[];
}

export interface ProjectSessionGroup {
  repo: string | null;
  sessions: SessionGroup[];
}

const timeMs = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** When the session last acted on this ref (review r2 S2: the ref's latest ACTION picks its session). */
function refActionAt(s: ThreadSession): string | null {
  return s.at ?? s.started_at;
}

/** The session header's date: its end when known (Open threads), else its latest action (the day view nulls `ended_at`). */
function sessionLastAt(s: ThreadSession): string | null {
  return s.ended_at ?? s.at ?? s.started_at;
}

/**
 * Session grouping: each ref under its LATEST session only (never twice),
 * sessions under their repo, newest activity first; refs within a session
 * keep the order they came in. Pure.
 */
export function groupBySession(threads: readonly Thread[], titles: SessionTitles, now: number): ProjectSessionGroup[] {
  const projects = new Map<string, { repo: string | null; sessions: Map<string, SessionGroup> }>();
  for (const t of threads) {
    if (t.sessions.length === 0) continue;
    const latest = t.sessions.reduce((a, b) => {
      const d = timeMs(refActionAt(b)) - timeMs(refActionAt(a));
      if (d !== 0) return d > 0 ? b : a;
      return timeMs(sessionLastAt(b)) > timeMs(sessionLastAt(a)) ? b : a;
    });
    const repo = refRepo(t.ref);
    const pKey = (repo ?? "").toLowerCase();
    let project = projects.get(pKey);
    if (!project) {
      project = { repo, sessions: new Map() };
      projects.set(pKey, project);
    }
    let g = project.sessions.get(latest.id);
    if (!g) {
      const raw = sessionRowTitle({ id: latest.id, proof_session_id: latest.id }, titles);
      const lastAt = sessionLastAt(latest);
      g = {
        id: latest.id,
        title: isPlaceholderTitle(raw) ? `Session · ${fmtDay(lastAt, now)}` : raw,
        last_at: lastAt,
        cost: latest.session_cost_usd ?? null,
        threads: [],
      };
      project.sessions.set(latest.id, g);
    } else if (timeMs(sessionLastAt(latest)) > timeMs(g.last_at)) {
      g.last_at = sessionLastAt(latest);
    }
    g.threads.push(t);
  }
  const out = [...projects.values()].map((p) => ({
    repo: p.repo,
    sessions: [...p.sessions.values()].sort((a, b) => timeMs(b.last_at) - timeMs(a.last_at)),
  }));
  return out.sort((a, b) => timeMs(b.sessions[0]?.last_at) - timeMs(a.sessions[0]?.last_at));
}

/** A ref whose only verb is "viewed" — collapsed with its session's other viewed refs into one line. */
export function isViewOnly(t: Pick<Thread, "ladder">): boolean {
  const w = ladderWords(t);
  return w.length === 1 && w[0] === "viewed";
}

/** What was OBSERVED about the item, for the row's text line: the forge's own title, else its first commit's subject. Never inferred. */
export function observedItemText(t: Pick<Thread, "forge_title" | "first_commit_subject">): string | null {
  return t.forge_title ?? t.first_commit_subject ?? null;
}
/** Blocker menu words (the reason codes live in lib/memory/blocker-dismiss.ts). */
export const BLOCKER_ACTIONS = [
  { reason: "resolved", label: "Resolved" },
  { reason: "ignored", label: "Ignore" },
] as const;
export type BlockerAction = (typeof BLOCKER_ACTIONS)[number]["reason"];
/** `?day=` link preserving the grouping param. */
export function dayHref(key: string, grouping: ThreadGrouping): string {
  return `/pulse?${grouping === "repo" ? "group=repo&" : ""}day=${key}`;
}

export function moreLabel(suffix: string) {
  return (n: number) => `+${n} more${suffix}`;
}
