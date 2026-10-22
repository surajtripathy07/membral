// memory_search (W3): rule-based reading of a date phrase inside the query
// ("last week", "yesterday", "in September", "Oct 1"). chrono-node does the
// parsing; no LLM. The phrase is stripped from the text used for full-text
// search and the query embedding (the words "last week" match nothing useful),
// and the window it names becomes a bounded recency BOOST in search.ts -- never
// a filter, because the reading is an inference. Only explicit since/days
// filter.
//
// Only UNAMBIGUOUS phrases count (isUnambiguousDatePhrase): a relative phrase
// ("last week", "yesterday", "3 days ago", "since Monday"), a month with a day
// ("Oct 1", "1 October"), or a full ISO date. chrono also reads a bare month
// ("march"), a weekday abbreviation ("mon"), a slash pair ("8/10") and
// "today's" -- in a search query those are as likely topic words, so they are
// left alone. If stripping would leave nothing, the original text is searched.

import * as chrono from "chrono-node";

export interface QueryDateWindow {
  /** The phrase as written in the query. */
  phrase: string;
  /** Inclusive start, ISO UTC. */
  from: string;
  /** Exclusive end, ISO UTC. */
  to: string;
}

export interface ParsedQueryDates {
  /** The query with every date phrase (and a preposition right before it) removed. */
  text: string;
  /** The union of every phrase's window, or null when the query names no date. */
  window: QueryDateWindow | null;
}

const DAY_MS = 86_400_000;

// A preposition that only introduces the date ("in September", "since monday")
// goes with the phrase, so the embedding does not see a dangling "in".
const LEADING_PREPOSITION = /\b(in|on|during|since|from|before|after|around|over|at|of|by)\s*$/i;

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const UNIT = "(?:day|days|week|weeks|month|months|year|years)";
const UNAMBIGUOUS = [
  /^(?:yesterday|today|tonight)$/i,
  new RegExp(`^(?:last|past|this|previous)\\s+(?:week|month|year|${WEEKDAY}|\\d+\\s+${UNIT})$`, "i"),
  new RegExp(`^(?:\\d+|a|one|two|three|four|five|six|seven)\\s+${UNIT}\\s+ago$`, "i"),
  new RegExp(`^${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?$`, "i"),
  new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+\\d{4})?$`, "i"),
  /^\d{4}-\d{2}-\d{2}$/,
];
const SINCE_WEEKDAY = new RegExp(`^${WEEKDAY}$`, "i");

/** Is chrono's match `text` (preceded by `head`, followed by `tail`) a date phrase nobody would mean as a topic word? */
export function isUnambiguousDatePhrase(text: string, head: string, tail: string): boolean {
  if (/^['\u2019]/.test(tail)) return false; // possessive: "today's plan"
  if (/^\w/.test(tail) || /\w$/.test(head)) return false; // inside a word
  if (UNAMBIGUOUS.some((re) => re.test(text.trim()))) return true;
  // "since Monday": the preposition makes a full weekday name a date.
  return /\bsince\s*$/i.test(head) && SINCE_WEEKDAY.test(text.trim());
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function windowOf(result: chrono.ParsedResult, now: Date): { from: Date; to: Date } | null {
  const c = result.start;
  // A bare time ("at 5pm") names no day -- not a date reference for search.
  if (!c.isCertain("day") && !c.isCertain("month") && !c.isCertain("weekday")) return null;

  let start = c.date();
  // chrono resolves a bare weekday or month to the nearest one, which can be in
  // the future ("monday" on a Saturday). A search looks back: use the past one.
  if (start.getTime() > now.getTime() && !c.isCertain("day") && c.isCertain("weekday")) {
    start = new Date(start.getTime() - 7 * DAY_MS);
  }
  if (start.getTime() > now.getTime() && !c.isCertain("year") && c.isCertain("month")) {
    start = new Date(Date.UTC(start.getUTCFullYear() - 1, start.getUTCMonth(), start.getUTCDate()));
  }

  let from: Date;
  let to: Date;
  if (result.end) {
    from = startOfUtcDay(start);
    to = new Date(startOfUtcDay(result.end.date()).getTime() + DAY_MS);
  } else if (/\bweeks?\b/i.test(result.text)) {
    from = startOfUtcDay(start);
    to = new Date(from.getTime() + 7 * DAY_MS);
  } else if (/\bmonths?\b/i.test(result.text) || (!c.isCertain("day") && c.isCertain("month"))) {
    from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    to = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  } else {
    from = startOfUtcDay(start);
    to = new Date(from.getTime() + DAY_MS);
  }
  if (from.getTime() > now.getTime()) return null; // still in the future: not a past window
  return { from, to };
}

/** Find date phrases in `query`, strip them, and return the window they name. Pure; `now` is injectable for tests. */
export function parseQueryDates(query: string, now: Date = new Date()): ParsedQueryDates {
  const results = chrono.parse(query, { instant: now, timezone: "UTC" });
  let text = query;
  let from: Date | null = null;
  let to: Date | null = null;
  const phrases: string[] = [];

  // Right to left, so earlier indexes stay valid while cutting.
  for (const r of [...results].sort((a, b) => b.index - a.index)) {
    const head = text.slice(0, r.index);
    if (!isUnambiguousDatePhrase(r.text, head, text.slice(r.index + r.text.length))) continue;
    const w = windowOf(r, now);
    if (!w) continue;
    const prep = LEADING_PREPOSITION.exec(head)?.[1]?.toLowerCase();
    // "since monday" / "after Sept 20" run up to today, not just that one day.
    if (!r.end && (prep === "since" || prep === "after" || prep === "from")) {
      w.to = new Date(startOfUtcDay(now).getTime() + DAY_MS);
    }
    phrases.unshift(r.text);
    if (!from || w.from < from) from = w.from;
    if (!to || w.to > to) to = w.to;
    const before = head.replace(LEADING_PREPOSITION, "");
    text = `${before} ${text.slice(r.index + r.text.length)}`;
  }

  // "between Sept 28 and Oct 1" leaves "between and" behind.
  text = text
    .replace(/\bbetween\s+and\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!from || !to) return { text: query.trim(), window: null };
  // A query that is only a date still searches its own words rather than nothing.
  if (!text) text = query.trim();
  return { text, window: { phrase: phrases.join(", "), from: from.toISOString(), to: to.toISOString() } };
}
