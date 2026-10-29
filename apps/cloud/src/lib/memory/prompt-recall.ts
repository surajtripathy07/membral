// Prompt-time recall (docs/design/prompt-time-recall.md): the UserPromptSubmit
// push. The SessionStart preamble runs before the prompt exists; this runs on
// every prompt, searches the repo's own memories with the prompt as the query,
// and returns at most PROMPT_RECALL_MAX_RECORDS one-line records -- or
// nothing, which is the common case.
//
// Pipeline: resolve the repo to a project (unknown repo -> nothing, never a
// search across every project) -> memorySearch with the relevance floor on,
// exact anchors on (query-anchors.ts), kinds decision/learning/outcome/blocker
// (blockers only while fresh, lib/domain/blockers.ts) -> keep verified records
// only -> collapse same-thing records into one line ("seen in N sessions")
// -> one line each, plus, under a record whose session later recorded an
// outcome, one `  ↳ later that session: …` line (what that session went on to
// do). When slots remain and the first search was quick, a second search with
// the served texts as its query fills them. The first search has
// PROMPT_RECALL_BUDGET_MS; past it the answer is empty.
//
// OLD CLIENTS: a CLI that sends no `budget_ms` waits 2 s and cuts the answer to
// 5 lines. For it (and any budget under PROMPT_RECALL_EXTENDED_MIN_CLIENT_BUDGET_MS)
// the answer stays the legacy shape: no second hop, no follow-ups, no note, at
// most PROMPT_RECALL_LEGACY_MAX_RECORDS records (header + 3 + footer), first
// search only, within the 1.5 s budget.
//
// CONTINUATION (self-recall.ts): when the CLI sends `continuation` (the prompt
// is Claude Code's "This session is being continued…" summary), the answer is
// that session's OWN records first -- decisions and outcomes, then findings
// naming files, then ref-carrying records, its sub-agents' included -- read by
// direct selects under PROMPT_RECALL_BUDGET_MS, deduplicated, at most
// CONTINUATION_MAX_RECORDS. Slots left over go to the topic search, run on the
// summary's next-step/pending/current-work text only (continuationFocusText),
// never on the whole summary. The result carries `mode: "continuation"`.

import type { Db } from "@/lib/db/types";
import { ageText } from "@/lib/domain/age";
import { handoffSearchEnabled } from "@/lib/env";
import { lexicalMinHits } from "@/lib/llm/embedding-family";
import { log } from "@/lib/log";
import {
  oneLine,
  PROMPT_RECALL_DUPLICATE_JACCARD,
  PROMPT_RECALL_DUPLICATE_MIN_TOKENS,
  PROMPT_RECALL_SAME_REF_OUTCOME_CONTAINMENT,
  sameThing,
  sharedCount,
  tokenSet,
} from "./dedupe";
import { safeSlice } from "./over-cap";
import { extractQueryAnchors } from "./query-anchors";
import { memorySearch, type QueryEmbedding, resolveProjectId, startQueryEmbedding } from "./search";
import { continuationFocusText, loadSessionSelfRecords, type SelfRecallTarget } from "./self-recall";

export {
  PROMPT_RECALL_DUPLICATE_JACCARD,
  PROMPT_RECALL_DUPLICATE_MIN_TOKENS,
  PROMPT_RECALL_SAME_REF_OUTCOME_CONTAINMENT,
};

import { asOfDay } from "./serve-filter";
import { type MemoryRow, rankAndServe, type ServedRecord } from "./verify";

/**
 * Server budget for the first search; past it the answer is empty. The second hop and the follow-up read each have
 * their own budget, cut to the request deadline (PROMPT_RECALL_DEADLINE_CAP_MS), and fall back to what is in hand.
 */
export const PROMPT_RECALL_BUDGET_MS = 1_500;
/**
 * How long hop 1 may wait for the query embedding: the hop-1 cutoff itself (MEMBRAL_PROMPT_RECALL_EMBED_DEADLINE_MS
 * overrides; 0 switches the fallback off). memorySearch caps the wait at the cutoff minus a verify reserve (500 ms) so
 * the keyword rows, which still need verifying before they can be served, always fit: with the 1500 ms budget the
 * embedding wait ends at 1000 ms.
 */
export const PROMPT_RECALL_EMBED_DEADLINE_MS = PROMPT_RECALL_BUDGET_MS;

/** The embed deadline, or undefined (env value 0) to switch the deadline and keyword fallback off: hop 1 then waits for the vector. */
function embedDeadlineMs(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.MEMBRAL_PROMPT_RECALL_EMBED_DEADLINE_MS?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return PROMPT_RECALL_EMBED_DEADLINE_MS;
  return n === 0 ? undefined : n;
}
/** The second hop runs only when the first search took less than this. */
export const PROMPT_RECALL_SECOND_HOP_GUARD_MS = 1_200;
export const PROMPT_RECALL_SECOND_HOP_BUDGET_MS = 1_500;
/** The second hop's query (the served records' texts, joined) is cut to this. */
export const PROMPT_RECALL_SECOND_HOP_QUERY_CHARS = 1_000;
export const PROMPT_RECALL_FOLLOW_UP_BUDGET_MS = 500;
/** Extended path: the path-anchor read (memory_anchor_records) runs beside hop 1; past this it is skipped. */
export const PROMPT_RECALL_ANCHOR_BUDGET_MS = 300;
/** At most this many path-anchor records join the candidate pool, ahead of hop 1's results (of 5 slots). */
export const PROMPT_RECALL_ANCHOR_MAX_RECORDS = 2;
/** Extended path: the title-anchor read (memory_title_anchor_records) runs beside hop 1 under the same budget. */
export const PROMPT_RECALL_TITLE_ANCHOR_MAX_RECORDS = 2;
/** A session title must share at least this many distinct content tokens with the prompt. */
export const PROMPT_RECALL_TITLE_MIN_SHARED_TOKENS = 2;
/** At most this many prompt tokens go to the title-anchor read. */
const PROMPT_RECALL_TITLE_MAX_TOKENS = 24;
export const PROMPT_RECALL_MAX_RECORDS = 5;
/** The record cap for a client that sent no budget_ms (an old CLI cuts at 5 lines: header + 3 + footer). */
export const PROMPT_RECALL_LEGACY_MAX_RECORDS = 3;
/** A client budget at or above this gets the second hop, follow-ups and the note; the CLI sends 4,000. */
export const PROMPT_RECALL_EXTENDED_MIN_CLIENT_BUDGET_MS = 3_500;
/**
 * Extended path: one request deadline, set when buildPromptRecall starts, at start + min(client budget - this reserve,
 * PROMPT_RECALL_DEADLINE_CAP_MS). The reserve covers auth, the event insert and the network, so hop 1's records are
 * never lost to the client's own timeout.
 */
export const PROMPT_RECALL_CLIENT_RESERVE_MS = 1_200;
export const PROMPT_RECALL_DEADLINE_CAP_MS = 2_800;
/** Hop 2 starts only when at least this much is left before the deadline. */
export const PROMPT_RECALL_SECOND_HOP_MIN_LEFT_MS = 700;
/** The follow-up read starts only when at least this much is left before the deadline. */
export const PROMPT_RECALL_FOLLOW_UP_MIN_LEFT_MS = 300;
/** memorySearch's limit: room for PROMPT_RECALL_MAX_RECORDS verified records to survive the verified filter. */
export const PROMPT_RECALL_SEARCH_LIMIT = 10;
/**
 * Line cut for a client that sent no `line_max` (the CLI on prod cuts every prompt-recall and self-recall line at
 * 420 chars, mid-URL): over it the age goes first, then the URL, then the ref, and a text that alone still passes it
 * is cut at a word boundary (see renderPromptRecallLine). A new CLI sends `line_max` (its MAX_PROMPT_LINE_CHARS,
 * LINE_MAX_CEILING).
 */
export const PROMPT_RECALL_LINE_MAX_CHARS = 420;
/**
 * A new client's line, worst case: head (~65, with "as of" and age) + the record's full text (≤ 500,
 * MEMORY_TEXT_MAX_HARD) + ` (ref)` (~30) + ` (seen in N sessions)` (~25) + ` → url` (~100) = ~720. Typical
 * records (text ≤ 300, the prompt's soft target) give ~520.
 */
export const PROMPT_RECALL_LINE_MAX_CEILING = 720;
export const PROMPT_RECALL_LINE_MAX_FLOOR = 300;
/**
 * Header + lines + footer, newline-joined, for a legacy client (line cut 420). Past it the last record is dropped.
 * Claude Code caps a hook's additionalContext at 10,000 chars. A client sending `line_max` gets these scaled by
 * line_max / 420 (blockCaps).
 */
export const PROMPT_RECALL_TOTAL_MAX_CHARS = 3_000;

/** The request's `line_max`, clamped to the supported range; absent means a legacy client (420). */
export function resolveLineMax(lineMax: number | undefined | null): number {
  if (lineMax === undefined || lineMax === null || !Number.isFinite(lineMax)) return PROMPT_RECALL_LINE_MAX_CHARS;
  return Math.min(PROMPT_RECALL_LINE_MAX_CEILING, Math.max(PROMPT_RECALL_LINE_MAX_FLOOR, Math.round(lineMax)));
}
/** A block total scaled to the client's line cut: `base` at the legacy 420, proportionally more past it. */
export function scaleTotal(base: number, lineMax: number): number {
  return Math.round((base * lineMax) / PROMPT_RECALL_LINE_MAX_CHARS);
}
/** A follow-up line (`  ↳ later that session: <outcome text>`) is cut to this. It counts toward the total cap. */
export const PROMPT_RECALL_FOLLOW_UP_MAX_CHARS = 300;
export const PROMPT_RECALL_FOLLOW_UP_PREFIX = "  ↳ later that session: ";
/** One line before the open-a-source footer: a re-search with the same prompt only finds these records again. */
export const PROMPT_RECALL_RESEARCH_NOTE =
  "These came from a memory_search on this prompt; a new search needs different terms, or open a source turn.";
/** The footer naming each shown record's full session id and turn, so get_code_session can open its source there. */
export const PROMPT_RECALL_FOOTER_PREFIX = "Open a record's source: get_code_session ";
/** The footer stays under the CLI's 300-char line cut (preamble-hook.ts MAX_LINE_CHARS); entries past it become "…". */
export const PROMPT_RECALL_FOOTER_MAX_CHARS = 290;
/** The pointer line for records the client already has: `Also relevant, shown earlier this session: <title> (#<id8>), …`. */
export const PROMPT_RECALL_ALREADY_SENT_PREFIX = "Also relevant, shown earlier this session: ";
export const PROMPT_RECALL_ALREADY_SENT_MAX_ENTRIES = 5;
export const PROMPT_RECALL_ALREADY_SENT_TITLE_CHARS = 60;
/** Prompts under this many words are not searched (CLI skips them too). */
export const PROMPT_RECALL_MIN_WORDS = 4;
/** The prompt is cut to this many characters before it becomes a search query. */
export const PROMPT_RECALL_MAX_QUERY_CHARS = 2_000;

export const PROMPT_RECALL_HEADER =
  "Membral: past work related to this prompt (true when recorded; check live state yourself):";

const KINDS = ["decision", "learning", "outcome", "blocker"];
/** The kinds prompt recall reads: with MEMBRAL_HANDOFF_SEARCH on, handoff notes too (call-time read). */
function recallKinds(): string[] {
  return handoffSearchEnabled() ? [...KINDS, "handoff"] : KINDS;
}
/** The served kinds whose text feeds the second hop's query. */
const SECOND_HOP_KINDS = new Set<string>(["decision", "blocker", "outcome"]);

export interface PromptRecallInput {
  prompt: string;
  repo: string;
  /** Harness session id, for the recall log only. */
  session?: string | null;
  /**
   * The client's own wait (the request's `budget_ms`). Absent, or under PROMPT_RECALL_EXTENDED_MIN_CLIENT_BUDGET_MS:
   * the legacy answer (see OLD CLIENTS above).
   */
  clientBudgetMs?: number;
  /** The request's `line_max`: the longest line the client shows whole. Absent: a legacy client, 420 (resolveLineMax). */
  lineMax?: number;
  /**
   * Records the client already injected in this session. The cap is applied first; of the top records, these are not
   * shown again (one pointer line names them) and their slots are NOT refilled with lower-ranked records.
   */
  excludeRecordIds?: readonly string[];
  /** Set when the prompt continues a harness session: that session's own records are served first (CONTINUATION). */
  continuation?: SelfRecallTarget;
}

export interface PromptRecallResult {
  /** Header, one line per record (each with its optional follow-up line), the re-search note, then the open-a-session footer; [] when nothing cleared the floor. */
  lines: string[];
  /** The shown records' ids only (what the route logs as served). */
  record_ids: string[];
  /** The shown follow-up outcomes' ids; internal, not logged (memory_recall_events has no slot for them). */
  followup_ids?: string[];
  /** 2 when the second-hop search ran; absent when nothing was searched. */
  hops?: 1 | 2;
  /** Why lines is empty; the route returns it so the CLI hook can log it. */
  skipped?: PromptRecallSkip;
  /** "continuation" when the continued session's own records were looked up first; absent on the topic path. */
  mode?: "continuation";
  /** Continuation only: how many of record_ids came from the continued session itself. */
  self_records?: number;
  /** Continuation only: why the session's own read gave nothing (absent when it served records). */
  self_skipped?: "not_uploaded" | "no_session_records" | "timeout" | "error";
  /** Elapsed ms per stage reached (stages not reached are absent); the route logs it and never returns it. */
  stages_ms?: Record<string, number>;
  /** Hop 1's query embedding missed its deadline (or the breaker was open) and keyword-only rows were served; absent = not skipped. */
  embedding_skipped?: boolean;
  /** The deadline hop 1 gave the embedding, ms. */
  embed_deadline_ms?: number;
  /** "open" when the embed breaker skipped the dense leg without waiting. */
  embedding_breaker?: "open";
  /** The stage(s) still running when the first-hop cap fired ("+"-joined when legs ran in parallel); skipped "timeout" only. */
  stage_at_timeout?: string;
}

export type PromptRecallSkip =
  | "short_prompt"
  | "slash_command"
  | "unknown_repo"
  | "no_match"
  | "timeout"
  | "error"
  | "no_session_records"
  | "not_uploaded"
  | "already_sent";

/** Continuation: at most this many records (the 3-record legacy budget x 2), self first, then the topic fallback. */
export const CONTINUATION_MAX_RECORDS = 6;
/** Continuation block cap: 6 x 420-char lines plus header and footer (legacy client; scaled by line_max / 420 like the prompt-recall total). */
export const CONTINUATION_TOTAL_MAX_CHARS = 3_600;
export const CONTINUATION_HEADER =
  "Membral: what this session recorded before it was continued, then related past work (true when recorded; check live state yourself):";
/** The SessionStart (`compact`/`resume`) variant's header. */
export const SESSION_SELF_HEADER = "This session so far (from Membral; true when recorded, check live state yourself):";

/** Prompts this hook never searches: slash commands and very short prompts. Pure. */
export function promptSkipReason(prompt: string): "short_prompt" | "slash_command" | null {
  const p = prompt.trim();
  if (p.startsWith("/")) return "slash_command";
  if (p.split(/\s+/).filter(Boolean).length < PROMPT_RECALL_MIN_WORDS) return "short_prompt";
  return null;
}

/**
 * `[decision · 2d ago · session abcd1234] <quote, else full text> (#ref) → https://…`. The record's quote (else text) is never cut (a cut
 * drops exactly the consequence a ruling states). Past PROMPT_RECALL_LINE_MAX_CHARS the URL is dropped first, then
 * the ref. Only text longer than the schema allows is cut, as a last resort. Pure.
 */
export function renderPromptRecallLine(
  r: ServedRecord,
  now: number,
  seenIn = 1,
  lineMax = PROMPT_RECALL_LINE_MAX_CHARS,
): string {
  const day = asOfDay(r.when);
  const head = `[${r.kind} · ${day ? `as of ${day} · ` : ""}${ageText(r.when, now)} · session ${r.session_id.slice(0, 8)}] `;
  // M2 (goal 2026-10-25 box 3.4): the verbatim quote is the receipt. It leads, framed as a citation, and the
  // extracted `text` follows in whatever room is left (a short user ruling alone would lose the decision).
  // A record with no quote (e.g. an imported one) renders its text as before.
  const quote = r.quote?.trim() ? oneLine(r.quote) : "";
  const fullText = oneLine(r.text);
  const ref = r.ref ? oneLine(r.ref) : "";
  const seen = seenIn > 1 ? ` (seen in ${seenIn} sessions)` : "";
  const url = r.ref_url ? ` → ${r.ref_url}` : "";
  // The URL outranks the relative age: when the full head pushes the line past the cap, the age goes first.
  const shortHead = `[${r.kind} · ${day ? `as of ${day} · ` : ""}session ${r.session_id.slice(0, 8)}] `;
  const candidates = (body: string): string[] => {
    const tail = ref && !body.includes(ref) ? ` (${ref})` : "";
    return [
      `${head}${body}${tail}${seen}${url}`,
      `${shortHead}${body}${tail}${seen}${url}`,
      `${head}${body}${tail}${seen}`,
      `${head}${body}${seen}`,
      `${head}${body}`,
    ];
  };
  const fit = (body: string): string | null => candidates(body).find((l) => l.length <= lineMax) ?? null;
  const cite = quote ? `said: "${quote}"` : "";
  const sep = " — ";
  const addText = fullText && fullText !== quote && !quote.includes(fullText);
  const text = cite || fullText;
  const full = cite && addText ? `${cite}${sep}${fullText}` : text;
  const whole = fit(full);
  if (whole) return whole;
  if (cite && addText) {
    // The quote fits without the text: append as much of the text as the room allows (word-cut, with an ellipsis).
    const base = fit(cite);
    if (base) {
      const room = lineMax - base.length - sep.length - 1;
      if (room >= 20) {
        const cut = safeSlice(fullText, room);
        const atWord = /\s/.test(fullText.charAt(cut.length)) ? cut : cut.replace(/\s*\S*$/, "");
        const part = (atWord || cut).trimEnd();
        const withText = fit(`${cite}${sep}${part}…`);
        if (withText) return withText;
      }
      return base;
    }
  }
  // The body alone passes the client's cut (a legacy client, quote over ~330): cut it at a word boundary and end
  // with a short open hint, so the line is whole rather than sliced mid-word or mid-URL by the client.
  const suffix = `… (open: ${r.session_id.slice(0, 8)})`;
  const room = lineMax - shortHead.length - suffix.length;
  const cut = safeSlice(text, Math.max(0, room));
  const atWord = /\s/.test(text.charAt(cut.length)) ? cut : cut.replace(/\s*\S*$/, "");
  return `${shortHead}${(atWord || cut).trimEnd()}${suffix}`;
}

/**
 * Question and filler words of four letters or more: they carry no programme name, so they never count toward a
 * title match.
 */
const TITLE_STOPWORDS = new Set(
  "about after again also been before being could does doing done from have here into just like make more much need only over please should some still such than that them then there these they this those very want were what when where which while will with would your".split(
    " ",
  ),
);

/**
 * The text's content tokens for title matching: tokenSet's tokens that are letter runs of four or more, minus
 * TITLE_STOPWORDS. Pure.
 */
export function titleTokens(text: string): Set<string> {
  return new Set([...tokenSet(text)].filter((t) => /^\p{L}{4,}$/u.test(t) && !TITLE_STOPWORDS.has(t)));
}

/**
 * Collapses records that say the same thing, at serve time (recurs_of/supersedes links are mostly unset): each record
 * joins the first earlier group whose leader (its best-ranked member) passes sameThing with it. Each group takes its
 * best-ranked member's place and shows its newest member; `seenIn` maps that shown id to the group's distinct-session
 * count. Deterministic, pure.
 */
export function collapsePromptRecallDuplicates(records: readonly ServedRecord[]): {
  records: ServedRecord[];
  seenIn: Map<string, number>;
} {
  const groups: { members: ServedRecord[] }[] = [];
  for (const r of records) {
    // Complete linkage: a record joins only if it is the same thing as every member.
    const g = groups.find((x) => x.members.every((m) => sameThing(m, r)));
    if (g) g.members.push(r);
    else groups.push({ members: [r] });
  }
  const seenIn = new Map<string, number>();
  const out = groups.map((g) => {
    const newest = g.members.reduce((a, b) => (Date.parse(b.when) > Date.parse(a.when) ? b : a));
    // Members may already be collapsed records (rankAndServe): their own seen_in counts, not just themselves.
    const told = g.members.reduce((n, m) => n + (m.seen_in ?? 1), 0);
    const sessions = new Set([...g.members.map((m) => m.session_id)]).size;
    const total = Math.max(told, sessions);
    if (total > 1 || g.members.length > 1) seenIn.set(newest.id, total);
    else seenIn.set(newest.id, 1);
    return newest;
  });
  return { records: out, seenIn };
}

/** A later outcome from a served record's own session. */
export interface PromptRecallFollowUp {
  id: string;
  text: string;
}

/** `  ↳ later that session: <outcome text>`, cut to PROMPT_RECALL_FOLLOW_UP_MAX_CHARS. Pure. */
export function renderPromptRecallFollowUp(f: PromptRecallFollowUp): string {
  const line = `${PROMPT_RECALL_FOLLOW_UP_PREFIX}${oneLine(f.text)}`;
  return line.length <= PROMPT_RECALL_FOLLOW_UP_MAX_CHARS
    ? line
    : `${line.slice(0, PROMPT_RECALL_FOLLOW_UP_MAX_CHARS - 1)}…`;
}

/**
 * Header, one line per record (each followed by its follow-up line, when followUps has one for its id), the re-search
 * note, footer. The last record (with its follow-up) is dropped while the block passes maxTotalChars: 5 x 420 plus 5
 * follow-ups of 300 can pass 3,000 (scaled with line_max), so the guard fires on long records. Pure.
 */
export function renderPromptRecallBlock(
  records: readonly ServedRecord[],
  now: number,
  maxTotalChars = PROMPT_RECALL_TOTAL_MAX_CHARS,
  followUps: ReadonlyMap<string, PromptRecallFollowUp> = new Map(),
  seenIn: ReadonlyMap<string, number> = new Map(),
  shape: { maxRecords?: number; note?: boolean; header?: string; lineMax?: number; alreadySent?: string | null } = {},
): { lines: string[]; shown: ServedRecord[]; followUpIds: string[] } {
  const note = shape.note ?? true;
  let shown = records.slice(0, shape.maxRecords ?? PROMPT_RECALL_MAX_RECORDS);
  for (;;) {
    const footer = renderPromptRecallFooter(shown);
    const followUpIds: string[] = [];
    const body = shown.flatMap((r) => {
      const f = followUps.get(r.id);
      const line = renderPromptRecallLine(r, now, seenIn.get(r.id) ?? 1, shape.lineMax);
      if (!f) return [line];
      followUpIds.push(f.id);
      return [line, renderPromptRecallFollowUp(f)];
    });
    const lines = [
      shape.header ?? PROMPT_RECALL_HEADER,
      ...body,
      ...(shape.alreadySent ? [shape.alreadySent] : []),
      ...(note ? [PROMPT_RECALL_RESEARCH_NOTE] : []),
      ...(footer ? [footer] : []),
    ];
    if (shown.length <= 1 || lines.join("\n").length <= maxTotalChars) return { lines, shown, followUpIds };
    shown = shown.slice(0, -1);
  }
}

/**
 * `Also relevant, shown earlier this session: <title1> (#<id8>), <title2> (#<id8>)`: the already-sent records, no
 * bodies. A title is the record text's first PROMPT_RECALL_ALREADY_SENT_TITLE_CHARS characters (records have no title
 * of their own). At most PROMPT_RECALL_ALREADY_SENT_MAX_ENTRIES entries; entries that would pass lineMax are dropped
 * from the end. Null when there are none. Pure.
 */
export function renderPromptRecallAlreadySent(
  records: readonly Pick<ServedRecord, "id" | "text">[],
  lineMax = PROMPT_RECALL_LINE_MAX_CHARS,
): string | null {
  const entries = records.slice(0, PROMPT_RECALL_ALREADY_SENT_MAX_ENTRIES).map((r) => {
    const text = oneLine(r.text);
    const title =
      text.length > PROMPT_RECALL_ALREADY_SENT_TITLE_CHARS
        ? `${safeSlice(text, PROMPT_RECALL_ALREADY_SENT_TITLE_CHARS - 1).trimEnd()}…`
        : text;
    return `${title} (#${r.id.slice(0, 8)})`;
  });
  for (let n = entries.length; n > 0; n--) {
    const line = `${PROMPT_RECALL_ALREADY_SENT_PREFIX}${entries.slice(0, n).join(", ")}`;
    if (line.length <= lineMax) return line;
  }
  return null;
}

/** Do two path lists share a file: equal, or one ends with `/` + the other (case-insensitive)? Pure. */
export function pathsShare(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  if (!a?.length || !b?.length) return false;
  const lb = b.map((x) => x.toLowerCase());
  return a.some((x) => {
    const p = x.toLowerCase();
    return lb.some((q) => p === q || p.endsWith(`/${q}`) || q.endsWith(`/${p}`));
  });
}

/** Same non-null ref (whitespace-normalised)? Pure. */
function refsShare(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && oneLine(a) === oneLine(b);
}

/**
 * For each served record, the latest live, verified `outcome` of the same user's same session written at a later
 * turn that shares the record's ref or one of its paths (an unrelated outcome of a long session is noise under the
 * record: eval loop 2 showed a deploy line under two 504-retry rulings). One query for every served session, the pick
 * made per record here. Skipped when that outcome is the record itself, is another served record, or says the same
 * text. Never a record from another session.
 */
export async function loadPromptRecallFollowUps(
  db: Db,
  userId: string,
  records: readonly ServedRecord[],
): Promise<Map<string, PromptRecallFollowUp>> {
  const out = new Map<string, PromptRecallFollowUp>();
  const sessionIds = [...new Set(records.map((r) => r.session_id).filter(Boolean))];
  if (sessionIds.length === 0) return out;
  const { data, error } = await db
    .from("session_memories")
    .select("id, code_session_id, text, turn_idx, ref, paths")
    .eq("user_id", userId)
    .in("code_session_id", sessionIds)
    .eq("kind", "outcome")
    .eq("verified", true)
    .is("retired_at", null)
    .limit(200);
  if (error) throw new Error(`prompt recall follow-ups: read failed: ${error.message}`);
  type OutcomeRow = {
    id: string;
    code_session_id: string;
    text: string;
    turn_idx: number;
    ref: string | null;
    paths: string[] | null;
  };
  const bySession = new Map<string, OutcomeRow[]>();
  for (const row of (data ?? []) as OutcomeRow[]) {
    const list = bySession.get(row.code_session_id) ?? [];
    list.push(row);
    bySession.set(row.code_session_id, list);
  }
  const servedIds = new Set(records.map((r) => r.id));
  for (const r of records) {
    let pick: OutcomeRow | undefined;
    for (const f of bySession.get(r.session_id) ?? []) {
      if (!(f.turn_idx > r.turn_idx) || servedIds.has(f.id)) continue;
      if (oneLine(f.text) === oneLine(r.text)) continue;
      if (!refsShare(f.ref, r.ref) && !pathsShare(f.paths, r.paths)) continue;
      if (!pick || f.turn_idx > pick.turn_idx) pick = f;
    }
    if (pick) out.set(r.id, { id: pick.id, text: pick.text });
  }
  return out;
}

/**
 * `Open a record's source: get_code_session id=<full id> turn=<n>, id=<full id> turn=<n>`: each shown record's
 * (session, turn) once, in order. Entries that would push the line past PROMPT_RECALL_FOOTER_MAX_CHARS are dropped
 * from the end and replaced by "…". Pure.
 */
export function renderPromptRecallFooter(
  records: readonly Pick<ServedRecord, "session_id" | "turn_idx">[],
): string | null {
  const entries = [
    ...new Set(
      records
        .filter((r) => r.session_id)
        .map((r) => (Number.isInteger(r.turn_idx) ? `id=${r.session_id} turn=${r.turn_idx}` : `id=${r.session_id}`)),
    ),
  ].slice(0, PROMPT_RECALL_MAX_RECORDS);
  if (entries.length === 0) return null;
  for (let n = entries.length; n > 0; n--) {
    const more = n < entries.length ? ", …" : "";
    const line = `${PROMPT_RECALL_FOOTER_PREFIX}${entries.slice(0, n).join(", ")}${more}`;
    if (line.length <= PROMPT_RECALL_FOOTER_MAX_CHARS) return line;
  }
  return null;
}

/**
 * Path-anchor leg (extended path): records of this project naming one of the prompt's file paths (never a bare file name), on a
 * path boundary (`queue.ts` matches `lib/kg/queue.ts`, never `extraction-queue.ts`), via memory_anchor_records
 * (migration 122): live, verified, the prompt-recall kinds, newest first, at most PROMPT_RECALL_ANCHOR_MAX_RECORDS.
 * Postgres keeps a path as one lexeme, so the search's lexical leg never matches a partial path, and such a record can
 * rank far below the candidate pool (eval loop 2: 79th of 736). [] when the prompt names no path. Throws on a read
 * error; the caller skips the leg.
 */
export async function loadPromptRecallAnchors(
  db: Db,
  userId: string,
  projectId: string,
  prompt: string,
): Promise<ServedRecord[]> {
  // Path tokens only (contain a "/"): a bare `route.ts` or `index.ts` names dozens of files and floods the slots.
  const tokens = extractQueryAnchors(prompt)
    .filter((a) => a.kind === "path" && a.value.includes("/"))
    .map((a) => a.value);
  if (tokens.length === 0) return [];
  const { data, error } = await db.rpc("memory_anchor_records", {
    p_user_id: userId,
    p_code_project_id: projectId,
    p_tokens: tokens,
    p_kinds: recallKinds(),
    p_limit: PROMPT_RECALL_ANCHOR_MAX_RECORDS,
  });
  if (error) throw new Error(`prompt recall anchors: read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as MemoryRow[];
  if (rows.length === 0) return [];
  const served = await rankAndServe(db, userId, rows, "tool", PROMPT_RECALL_ANCHOR_MAX_RECORDS);
  return served.filter((r) => r.verified);
}

/**
 * Title-anchor leg (extended path): the newest outcomes and decisions of sessions whose short title shares at least
 * PROMPT_RECALL_TITLE_MIN_SHARED_TOKENS content tokens (titleTokens) with the prompt, via memory_title_anchor_records
 * (migration 123), at most PROMPT_RECALL_TITLE_ANCHOR_MAX_RECORDS. A prompt that resumes <programme>
 * names the programme; its latest records rarely do, so the search ranked them below older rewordings (eval loop 2).
 * [] when the prompt has fewer tokens than the minimum. Throws on a read error; the caller skips the leg.
 */
export async function loadPromptRecallTitleAnchors(
  db: Db,
  userId: string,
  projectId: string,
  prompt: string,
): Promise<ServedRecord[]> {
  const tokens = [...titleTokens(prompt)].slice(0, PROMPT_RECALL_TITLE_MAX_TOKENS);
  if (tokens.length < PROMPT_RECALL_TITLE_MIN_SHARED_TOKENS) return [];
  const { data, error } = await db.rpc("memory_title_anchor_records", {
    p_user_id: userId,
    p_project_id: projectId,
    p_tokens: tokens,
    p_limit: PROMPT_RECALL_TITLE_ANCHOR_MAX_RECORDS,
  });
  if (error) throw new Error(`prompt recall title anchors: read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as MemoryRow[];
  if (rows.length === 0) return [];
  const served = await rankAndServe(db, userId, rows, "tool", PROMPT_RECALL_TITLE_ANCHOR_MAX_RECORDS);
  return served.filter((r) => r.verified);
}

/**
 * Hop 2 keeps a record only when it shares a ref, a path or a thread with a hop-1 record, or (given `titles` and
 * `promptTokens`) when its session title shares PROMPT_RECALL_TITLE_MIN_SHARED_TOKENS content tokens with the prompt. Its query is the served
 * texts, so its floor measures closeness to those texts, not to the prompt, and the served records carry no
 * unboosted score to re-check: without this, generic records padded the empty slots (eval loop 2, import-504).
 * `threads` maps record id -> thread, `titles` record id -> session title. Pure.
 */
export function relatedToServed(
  candidate: ServedRecord,
  served: readonly ServedRecord[],
  threads: ReadonlyMap<string, string | null>,
  byTitle: { titles?: ReadonlyMap<string, string | null>; promptTokens?: ReadonlySet<string> } = {},
): boolean {
  const title = byTitle.titles?.get(candidate.id);
  if (
    title &&
    byTitle.promptTokens &&
    sharedCount(titleTokens(title), byTitle.promptTokens) >= PROMPT_RECALL_TITLE_MIN_SHARED_TOKENS
  ) {
    return true;
  }
  const thread = threads.get(candidate.id);
  return served.some(
    (s) =>
      refsShare(candidate.ref, s.ref) ||
      pathsShare(candidate.paths, s.paths) ||
      (!!thread && oneLine(thread).toLowerCase() === oneLine(threads.get(s.id) ?? "").toLowerCase()),
  );
}

/** id -> thread and id -> session title for the given records (same user). */
async function loadThreads(
  db: Db,
  userId: string,
  ids: readonly string[],
): Promise<{ threads: Map<string, string | null>; titles: Map<string, string | null> }> {
  const threads = new Map<string, string | null>();
  const titles = new Map<string, string | null>();
  if (ids.length === 0) return { threads, titles };
  const { data, error } = await db
    .from("session_memories")
    .select("id, thread, session_title")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw new Error(`prompt recall threads: read failed: ${error.message}`);
  for (const row of (data ?? []) as { id: string; thread: string | null; session_title?: string | null }[]) {
    threads.set(row.id, row.thread);
    titles.set(row.id, row.session_title ?? null);
  }
  return { threads, titles };
}

class BudgetExceeded extends Error {}

function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetExceeded()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Per-stage wall time for the route's log line. A stage is recorded when it settles, so one the budget cut off is
 * absent from stages_ms and named by stage_at_timeout instead (parallel legs: all still-running ones, "+"-joined).
 */
function stageTimer(
  clock: () => number,
  extra: Pick<PromptRecallResult, "embedding_skipped" | "embed_deadline_ms" | "embedding_breaker"> = {},
) {
  const stages: Record<string, number> = {};
  const running = new Set<string>();
  return {
    /** `label` is what stage_at_timeout shows while it runs (default: the name). */
    async run<T>(name: string, fn: () => Promise<T>, label = name): Promise<T> {
      const at = clock();
      running.add(label);
      try {
        return await fn();
      } finally {
        running.delete(label);
        stages[name] = clock() - at;
      }
    },
    sync<T>(name: string, fn: () => T): T {
      const at = clock();
      try {
        return fn();
      } finally {
        stages[name] = clock() - at;
      }
    },
    /** A snapshot: a cut-off stage settling later must not change what was already returned. */
    report(atTimeout = false): Pick<PromptRecallResult, "stages_ms" | "stage_at_timeout"> {
      return {
        stages_ms: { ...stages },
        ...extra,
        ...(atTimeout && running.size > 0 ? { stage_at_timeout: [...running].join("+") } : {}),
      };
    },
  };
}

export async function buildPromptRecall(
  db: Db,
  userId: string,
  codeScopeId: string | null,
  input: PromptRecallInput,
  opts: {
    now?: Date;
    budgetMs?: number;
    secondHopGuardMs?: number;
    secondHopBudgetMs?: number;
    followUpBudgetMs?: number;
    clock?: () => number;
  } = {},
): Promise<PromptRecallResult> {
  if (input.continuation) return buildContinuationRecall(db, userId, codeScopeId, input, input.continuation, opts);
  const clock = opts.clock ?? Date.now;
  const requestStart = clock();
  const embedInfo: Pick<PromptRecallResult, "embedding_skipped" | "embed_deadline_ms" | "embedding_breaker"> = {};
  const timer = stageTimer(clock, embedInfo);
  const skip = promptSkipReason(input.prompt);
  if (skip) return { lines: [], record_ids: [], skipped: skip };
  const now = opts.now ?? new Date();
  // The hop-1 query embedding starts here, before the project lookup, so the two overlap. memorySearch waits for it
  // only up to the deadline (it runs a keyword-only search from the start) and then serves keyword rows instead.
  const hop1Query = input.prompt.trim().slice(0, PROMPT_RECALL_MAX_QUERY_CHARS).trim(); // trimmed after the slice: memorySearch re-trims and the handle must match
  const hop1Deadline = embedDeadlineMs();
  const hop1Embedding: QueryEmbedding = startQueryEmbedding(userId, hop1Query);
  const guardMs = opts.secondHopGuardMs ?? PROMPT_RECALL_SECOND_HOP_GUARD_MS;
  const extended =
    input.clientBudgetMs !== undefined && input.clientBudgetMs >= PROMPT_RECALL_EXTENDED_MIN_CLIENT_BUDGET_MS;
  // Extended path only: the extras (hop 2, follow-ups) start and run only inside this deadline.
  const deadline =
    requestStart +
    Math.min((input.clientBudgetMs ?? 0) - PROMPT_RECALL_CLIENT_RESERVE_MS, PROMPT_RECALL_DEADLINE_CAP_MS);
  const maxRecords = extended ? PROMPT_RECALL_MAX_RECORDS : PROMPT_RECALL_LEGACY_MAX_RECORDS;
  // Hop 1 passes `staged` so its embedding and RPC are timed apart (stage_at_timeout "hop1_search:embed_query").
  const search = (projectId: string, query: string, staged = false) =>
    memorySearch(
      db,
      userId,
      projectId,
      { query, kind: recallKinds(), limit: PROMPT_RECALL_SEARCH_LIMIT },
      {
        now,
        floor: true,
        logEvent: false,
        ...(staged
          ? {
              stages: { run: (name, fn) => timer.run(name, fn, `hop1_search:${name}`) },
              queryEmbedding: hop1Embedding,
              ...(hop1Deadline !== undefined
                ? { embedDeadlineMs: hop1Deadline, hop1BudgetMs: opts.budgetMs ?? PROMPT_RECALL_BUDGET_MS }
                : {}),
              onEmbedOutcome: (o) => {
                embedInfo.embed_deadline_ms = o.embed_deadline_ms;
                if (o.embedding_skipped) embedInfo.embedding_skipped = true;
                if (o.embedding_breaker) embedInfo.embedding_breaker = o.embedding_breaker;
              },
            }
          : {}),
      },
    );

  // Hop 1 (the prompt as the query) under its own 1.5 s cap: past it the answer is empty.
  const firstHop = async () => {
    // Always one project: the key's bound, else the caller's repo. An
    // unknown repo has no memories of its own, so nothing is served.
    const projectId = await timer.run("resolve_project", () => resolveProjectId(db, userId, input.repo, codeScopeId));
    if (!projectId) return null;
    const started = clock();
    const query = hop1Query;
    // Extended path: the path-anchor leg runs beside the search; past its budget or on an error it adds nothing.
    const anchorLeg = extended
      ? withBudget(
          timer.run("anchor_leg", () => loadPromptRecallAnchors(db, userId, projectId, query)),
          PROMPT_RECALL_ANCHOR_BUDGET_MS,
        ).catch((err: unknown) => {
          log.warn("prompt recall anchor leg skipped", {
            user_id: userId,
            error: err instanceof BudgetExceeded ? "over budget" : err instanceof Error ? err.message : String(err),
          });
          return [] as ServedRecord[];
        })
      : Promise.resolve([] as ServedRecord[]);
    // Extended path: the title-anchor leg, same budget and same skip rule.
    const titleLeg = extended
      ? withBudget(
          timer.run("title_anchor_leg", () => loadPromptRecallTitleAnchors(db, userId, projectId, query)),
          PROMPT_RECALL_ANCHOR_BUDGET_MS,
        ).catch((err: unknown) => {
          log.warn("prompt recall title anchor leg skipped", {
            user_id: userId,
            error: err instanceof BudgetExceeded ? "over budget" : err instanceof Error ? err.message : String(err),
          });
          return [] as ServedRecord[];
        })
      : Promise.resolve([] as ServedRecord[]);
    const [result, pathAnchored, titleAnchored] = await Promise.all([
      search(projectId, query, true),
      anchorLeg,
      titleLeg,
    ]);
    // Path anchors rank first (query-anchors.ts: a record naming the prompt's file is about that file), then title
    // anchors (the newest records of the session the prompt names), then the search.
    const pathIds = new Set(pathAnchored.map((r) => r.id));
    // L5: a title match is two shared words with a session title and has no relevance floor of its own, so on its own it
    // answered an off-topic question ("the extraction queue" for a tool the store never mentions). It adds records
    // only beside a search that cleared the floor: title anchors reorder and extend an answer, they never create one.
    // Calibrated families only (lexicalMinHits > 0); the hosted default family keeps its title anchors as before.
    const titleKept = lexicalMinHits() > 0 && result.records.length === 0 ? [] : titleAnchored;
    const anchored = [
      ...pathAnchored,
      ...titleKept.filter((r) => !pathIds.has(r.id)).slice(0, PROMPT_RECALL_TITLE_ANCHOR_MAX_RECORDS),
    ];
    const anchorIds = new Set(anchored.map((r) => r.id));
    // A push surface serves only records whose receipt still grounds.
    // Same-thing records (same kind+ref, or near-identical text) take one slot before the cap.
    const collapsed = collapsePromptRecallDuplicates([
      ...anchored,
      ...result.records.filter((r) => r.verified && !anchorIds.has(r.id)),
    ]);
    return { projectId, elapsedMs: clock() - started, collapsed };
  };

  let first: Awaited<ReturnType<typeof firstHop>>;
  try {
    first = await withBudget(firstHop(), opts.budgetMs ?? PROMPT_RECALL_BUDGET_MS);
    hop1Embedding.abort(); // no-op once settled; cancels a call nobody is waiting on (unknown repo)
  } catch (err) {
    hop1Embedding.abort();
    if (err instanceof BudgetExceeded) {
      const { stages_ms, stage_at_timeout } = timer.report(true);
      log.warn("prompt recall over budget, served nothing", { user_id: userId, stages_ms, stage_at_timeout });
      return { lines: [], record_ids: [], skipped: "timeout", ...timer.report(true) };
    }
    log.warn("prompt recall failed, served nothing", {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { lines: [], record_ids: [], skipped: "error", ...timer.report() };
  }
  if (!first) return { lines: [], record_ids: [], skipped: "unknown_repo", ...timer.report() };
  // Already injected this session: the cap comes FIRST, then the already-sent records leave the top records. Their
  // slots are not refilled with lower-ranked records (rank 6+ was judged not worth showing); one pointer line names them.
  const excluded = new Set(input.excludeRecordIds ?? []);
  const capped = first.collapsed.records.slice(0, maxRecords);
  if (capped.length === 0) return { lines: [], record_ids: [], skipped: "no_match", ...timer.report() };
  const records = capped.filter((r) => !excluded.has(r.id));
  const alreadySent = capped.filter((r) => excluded.has(r.id));
  if (records.length === 0) return { lines: [], record_ids: [], skipped: "already_sent", ...timer.report() };
  const seenIn = new Map(first.collapsed.seenIn);

  // Hop 2: only while slots remain and hop 1 was quick. Its query is what hop 1 served, so it reaches the sessions
  // those records point at. An extra: past its own budget, or on an error, hop 1's records are served alone.
  let hops: 1 | 2 = 1;
  const hopQuery = records
    .filter((r) => SECOND_HOP_KINDS.has(r.kind))
    .map((r) => oneLine(r.text))
    .join(" ")
    .slice(0, PROMPT_RECALL_SECOND_HOP_QUERY_CHARS)
    .trim();
  if (
    extended &&
    records.length + alreadySent.length < maxRecords &&
    first.elapsedMs < guardMs &&
    // Hop 1 gave up on the embedding (slow provider or breaker open): hop 2 would wait on a fresh one with SDK defaults.
    !embedInfo.embedding_skipped &&
    hopQuery &&
    clock() + PROMPT_RECALL_SECOND_HOP_MIN_LEFT_MS < deadline
  ) {
    try {
      const hop1 = [...records];
      const promptTokens = titleTokens(input.prompt.slice(0, PROMPT_RECALL_MAX_QUERY_CHARS));
      const servedIds = new Set([...hop1.map((r) => r.id), ...excluded]);
      const { second, threads, titles } = await withBudget(
        timer.run("second_hop", async () => {
          const second = await search(first.projectId, hopQuery);
          const ids = [...servedIds, ...second.records.filter((r) => !servedIds.has(r.id)).map((r) => r.id)];
          return { second, ...(await loadThreads(db, userId, ids)) };
        }),
        Math.min(opts.secondHopBudgetMs ?? PROMPT_RECALL_SECOND_HOP_BUDGET_MS, deadline - clock()),
      );
      hops = 2;
      const fresh = collapsePromptRecallDuplicates(second.records.filter((r) => r.verified && !servedIds.has(r.id)));
      for (const r of fresh.records) {
        if (records.length + alreadySent.length >= maxRecords) break;
        if (!relatedToServed(r, hop1, threads, { titles, promptTokens })) continue;
        if (records.some((s) => sameThing(s, r))) continue;
        records.push(r);
        seenIn.set(r.id, fresh.seenIn.get(r.id) ?? 1);
      }
    } catch (err) {
      log.warn("prompt recall second hop failed, served the first", {
        user_id: userId,
        error: err instanceof BudgetExceeded ? "over budget" : err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A follow-up is an extra: when its read fails or runs past its budget, serve the records without one.
  let followUps = new Map<string, PromptRecallFollowUp>();
  if (extended && clock() + PROMPT_RECALL_FOLLOW_UP_MIN_LEFT_MS < deadline) {
    try {
      followUps = await withBudget(
        timer.run("follow_ups", () => loadPromptRecallFollowUps(db, userId, records)),
        Math.min(opts.followUpBudgetMs ?? PROMPT_RECALL_FOLLOW_UP_BUDGET_MS, deadline - clock()),
      );
    } catch (err) {
      log.warn("prompt recall follow-ups failed, served none", {
        user_id: userId,
        error: err instanceof BudgetExceeded ? "over budget" : err instanceof Error ? err.message : String(err),
      });
    }
  }
  // The block may drop trailing records to stay under its total cap: log only what is shown.
  const { lines, shown, followUpIds } = timer.sync("render", () =>
    renderPromptRecallBlock(
      records,
      now.getTime(),
      scaleTotal(PROMPT_RECALL_TOTAL_MAX_CHARS, resolveLineMax(input.lineMax)),
      followUps,
      seenIn,
      {
        maxRecords,
        note: extended,
        lineMax: resolveLineMax(input.lineMax),
        alreadySent: renderPromptRecallAlreadySent(alreadySent, resolveLineMax(input.lineMax)),
      },
    ),
  );
  return { lines, record_ids: shown.map((r) => r.id), followup_ids: followUpIds, hops, ...timer.report() };
}

/**
 * The continued session's own records, deduplicated and capped at maxRecords, under one budget. Throws
 * BudgetExceeded past it; the callers turn that into an empty answer.
 */
async function selfRecords(
  db: Db,
  userId: string,
  codeScopeId: string | null,
  target: SelfRecallTarget,
  budgetMs: number,
  maxRecords: number,
): Promise<{ found: boolean; records: ServedRecord[]; seenIn: Map<string, number> }> {
  const load = await withBudget(loadSessionSelfRecords(db, userId, codeScopeId, target), budgetMs);
  // One session restates a ruling across turns and sub-agents: same-thing records take one slot.
  const collapsed = collapsePromptRecallDuplicates(load.records);
  return { found: load.found, records: collapsed.records.slice(0, maxRecords), seenIn: collapsed.seenIn };
}

/** CONTINUATION (see the header): self records first, then the topic search on the summary's focus text. */
async function buildContinuationRecall(
  db: Db,
  userId: string,
  codeScopeId: string | null,
  input: PromptRecallInput,
  target: SelfRecallTarget,
  opts: { now?: Date; budgetMs?: number; secondHopBudgetMs?: number; clock?: () => number },
): Promise<PromptRecallResult> {
  const clock = opts.clock ?? Date.now;
  const requestStart = clock();
  const now = opts.now ?? new Date();
  const deadline =
    requestStart +
    Math.min((input.clientBudgetMs ?? 0) - PROMPT_RECALL_CLIENT_RESERVE_MS, PROMPT_RECALL_DEADLINE_CAP_MS);
  const base = { mode: "continuation" as const };

  let records: ServedRecord[] = [];
  let seenIn = new Map<string, number>();
  let selfSkip: "not_uploaded" | "no_session_records" | "timeout" | "error" | null = null;
  let selfError: string | null = null;
  try {
    const self = await selfRecords(
      db,
      userId,
      codeScopeId,
      target,
      opts.budgetMs ?? PROMPT_RECALL_BUDGET_MS,
      CONTINUATION_MAX_RECORDS,
    );
    records = self.records;
    seenIn = self.seenIn;
    if (records.length === 0) selfSkip = self.found ? "no_session_records" : "not_uploaded";
  } catch (err) {
    selfSkip = err instanceof BudgetExceeded ? "timeout" : "error";
    selfError = err instanceof BudgetExceeded ? "over budget" : err instanceof Error ? err.message : String(err);
  }
  const selfCount = records.length;

  // Topic fallback on the summary's next-step text only, while slots and time remain.
  const query = continuationFocusText(input.prompt);
  const tryTopic =
    records.length < CONTINUATION_MAX_RECORDS &&
    query.split(/\s+/).filter(Boolean).length >= PROMPT_RECALL_MIN_WORDS &&
    clock() + PROMPT_RECALL_SECOND_HOP_MIN_LEFT_MS < deadline;
  if (selfError !== null) {
    log.warn("prompt recall continuation self read failed", {
      user_id: userId,
      skipped: selfSkip,
      fallback: tryTopic ? "attempted" : "skipped",
      error: selfError,
    });
  }
  if (tryTopic) {
    try {
      const found = await withBudget(
        (async () => {
          const projectId = await resolveProjectId(db, userId, input.repo, codeScopeId);
          if (!projectId) return null;
          return memorySearch(
            db,
            userId,
            projectId,
            { query, kind: recallKinds(), limit: PROMPT_RECALL_SEARCH_LIMIT },
            { now, floor: true, logEvent: false },
          );
        })(),
        Math.min(opts.secondHopBudgetMs ?? PROMPT_RECALL_BUDGET_MS, deadline - clock()),
      );
      const servedIds = new Set(records.map((r) => r.id));
      const fresh = collapsePromptRecallDuplicates(
        (found?.records ?? []).filter((r) => r.verified && !servedIds.has(r.id)),
      );
      for (const r of fresh.records) {
        if (records.length >= CONTINUATION_MAX_RECORDS) break;
        if (records.some((s) => sameThing(s, r))) continue;
        records.push(r);
        seenIn.set(r.id, fresh.seenIn.get(r.id) ?? 1);
      }
    } catch (err) {
      log.warn("prompt recall continuation topic search failed, served the session's own records", {
        user_id: userId,
        error: err instanceof BudgetExceeded ? "over budget" : err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (records.length === 0)
    return {
      lines: [],
      record_ids: [],
      skipped: selfSkip ?? "no_session_records",
      ...base,
      self_skipped: selfSkip ?? "no_session_records",
    };
  const { lines, shown } = renderPromptRecallBlock(
    records,
    now.getTime(),
    scaleTotal(CONTINUATION_TOTAL_MAX_CHARS, resolveLineMax(input.lineMax)),
    new Map(),
    seenIn,
    {
      maxRecords: CONTINUATION_MAX_RECORDS,
      note: false,
      header: selfCount > 0 ? CONTINUATION_HEADER : PROMPT_RECALL_HEADER,
      lineMax: resolveLineMax(input.lineMax),
    },
  );
  const shownSelf = shown.filter((r) => records.indexOf(r) < selfCount).length;
  return {
    lines,
    record_ids: shown.map((r) => r.id),
    ...base,
    self_records: shownSelf,
    ...(selfSkip ? { self_skipped: selfSkip } : {}),
  };
}

/**
 * The SessionStart (`compact`/`resume`) variant: the session's own records only, under the SESSION_SELF_HEADER, no
 * topic search (the preamble serves the repo's recent work beside it). Never throws: past the budget or on an error
 * it returns no lines.
 */
export async function buildSessionStartSelfRecall(
  db: Db,
  userId: string,
  codeScopeId: string | null,
  target: SelfRecallTarget,
  opts: { now?: Date; budgetMs?: number; lineMax?: number } = {},
): Promise<{
  lines: string[];
  record_ids: string[];
  skipped?: "no_session_records" | "not_uploaded" | "timeout" | "error";
}> {
  try {
    const self = await selfRecords(
      db,
      userId,
      codeScopeId,
      target,
      opts.budgetMs ?? PROMPT_RECALL_BUDGET_MS,
      CONTINUATION_MAX_RECORDS,
    );
    if (self.records.length === 0) {
      return { lines: [], record_ids: [], skipped: self.found ? "no_session_records" : "not_uploaded" };
    }
    const { lines, shown } = renderPromptRecallBlock(
      self.records,
      (opts.now ?? new Date()).getTime(),
      scaleTotal(CONTINUATION_TOTAL_MAX_CHARS, resolveLineMax(opts.lineMax)),
      new Map(),
      self.seenIn,
      {
        maxRecords: CONTINUATION_MAX_RECORDS,
        note: false,
        header: SESSION_SELF_HEADER,
        lineMax: resolveLineMax(opts.lineMax),
      },
    );
    return { lines, record_ids: shown.map((r) => r.id) };
  } catch (err) {
    log.warn("session-start self recall failed, served none", {
      user_id: userId,
      error: err instanceof BudgetExceeded ? "over budget" : err instanceof Error ? err.message : String(err),
    });
    return { lines: [], record_ids: [], skipped: err instanceof BudgetExceeded ? "timeout" : "error" };
  }
}
