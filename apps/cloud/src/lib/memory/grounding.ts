// The ONE grounding predicate (maintainer decision 2026-09-24, D3 diagnosis
// in handoff/d3-v5/diag/report.md). Before this module, merge.ts's write-time
// `groundRecord` and verify.ts's serve-time `verifyRecords` each carried
// their own version of "is this record grounded?", and they disagreed on 11
// of 156 live records — always stored=false, render=true — for two reasons:
//   1. merge.ts gated blocker/decision/learning quotes on
//      `isSpecificEnoughQuote`; verify.ts had no such gate (7 records).
//   2. a null `quote` on a non-outcome kind was permanently unverified at
//      write time, but verify.ts skipped the quote check entirely when the
//      quote was null (4 records).
// Both callers now call `groundAgainstTurns` and nothing else, so the stored
// `verified` flag and the render-time re-check cannot disagree.
//
// What the predicate accepts, in order (first hit wins):
//   a. the quote matches the CITED turn (normalize.ts's `quoteMatchesTurnText`:
//      NFKC, one quote class, case-folded, whitespace/trailing-punct tolerant).
//   b. the quote matches some OTHER turn verbatim (same normalisation) — the
//      model cited the wrong turn. The receipt is repaired to that turn; with
//      several hits, the one nearest the cited index wins (ties -> earlier).
//   c. the quote snaps to a contiguous span of the cited turn
//      (`snapQuoteToSource`, >= 90% token coverage, markdown-insensitive).
//   d. the quote snaps with 100% token coverage (every token, in order,
//      markdown-insensitive — i.e. still verbatim modulo markdown) to another
//      turn, nearest first. Partial snaps are never tried away from the cited
//      turn: that is how an unrelated turn gets stitched into a "match".
// A `preference` only ever grounds on a user turn (a/b/c/d all skip
// assistant turns for it). blocker/decision/learning additionally need a
// quote specific enough to be ABOUT the record (`isSpecificEnoughQuote`).
// An `outcome` needs its `ref` to appear (digest or text) in the quote's turn
// OR anywhere else in the session — the ref is usually printed a few turns
// away from the sentence that announces it (10 of the diag's 35 failures).
// A null quote grounds only an outcome, via its ref alone (nearest turn
// containing it). Every other kind with a null quote is unverified.
//
// Review v6 hardening (handoff/d3-v5/review-v6.md):
//   B1. refs match on token boundaries, never as a raw substring ("main"
//       inside "domain"). Only a SPECIFIC ref — a URL, a hex sha of >= 7
//       chars with at least one a-f letter, `#N`, or a path containing "/" —
//       may be found in another turn or ground a quote-less outcome. A
//       branch/tag name or bare filename must sit, as a whole token, in the
//       quote's own turn.
//   M2. steps b and d (moving the receipt AWAY from the cited turn) need an
//       `isSpecificEnoughQuote` quote for EVERY kind — a generic quote
//       ("looks good") never moves; steps a/c at the cited turn are unchanged.
//   m1. a quote under MIN_NORMALIZED_QUOTE_CHARS once normalised (e.g.
//       "........" -> "") matches nothing.
//   m3. `userTurnsOnly` (the user-turn pass) restricts every step to user
//       turns, as a preference always is.
import { FORGE_ITEM_SEGMENTS, issueRefNumber, parseHttpUrl } from "@/lib/attribution/grounding";
import { normalizeQuote, quoteMatchesTurnText, snapQuoteToSource } from "./normalize";
import type { MemoryKind } from "./schema";

export interface GroundingTurn {
  idx: number;
  role: string | null;
  text: string | null;
  props: { inputDigest?: unknown } | Record<string, unknown> | null;
  /** Issue #161: the file a tool turn touched, as the tool was given it (absolute); optional so callers without it are unchanged. */
  file_path?: string | null;
}

export interface GroundingInput {
  kind: MemoryKind;
  /** The record's own text — the specificity gate compares the quote against it. */
  text: string;
  quote: string | null;
  ref: string | null;
  turn_idx: number;
  /** m3: ground only on user turns (records from the user-turn pass). Preferences always are. */
  userTurnsOnly?: boolean;
}

/** Machine-readable failure reasons — stored as `retire_reason = "unverified:<reason>"` on retire-on-write. */
export type GroundingFailure = "no_quote" | "quote_not_found" | "quote_not_specific" | "ref_not_found";

export interface GroundingResult {
  verified: boolean;
  /** The receipt turn: repaired to where the quote (or, for a quote-less outcome, the ref) actually is when verified; the cited index otherwise. */
  turn_idx: number;
  /** Role of the turn at `turn_idx`; `null` when no turn has that index (a dangling receipt). */
  turn_role: "user" | "assistant" | null;
  /** The quote to store/serve — a verbatim slice of the source turn when a snap (c/d) matched, else the input quote. */
  quote: string | null;
  /** True when `quote` differs from the input (a snap re-derived it). */
  quoteChanged: boolean;
  /** `null` when verified. */
  reason: GroundingFailure | null;
}

const SPECIFICITY_GATED_KINDS: ReadonlySet<MemoryKind> = new Set(["blocker", "decision", "learning"]);

const CONTENT_TOKEN = /[a-z0-9_]{3,}/g;
const CONTENT_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "was",
  "were",
  "are",
  "not",
  "but",
  "you",
  "your",
  "from",
  "into",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "could",
  "now",
]);

/** Lowercased, stopword-filtered content words (>= 3 chars) — the vocabulary `isSpecificEnoughQuote` compares `quote` and `text` on. */
function contentTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(CONTENT_TOKEN) ?? []) {
    if (!CONTENT_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * step2e finding 4 (moved here from merge.ts so write and serve share it): a
 * quote substantial enough (>= 8 words or >= 40 chars) AND actually about
 * the same thing as `text` (shares a content word) to trust as a specific
 * receipt. Applies to blocker/decision/learning only.
 */
export function isSpecificEnoughQuote(quote: string, text: string): boolean {
  const words = quote.trim().split(/\s+/).filter(Boolean).length;
  const chars = quote.trim().length;
  if (words < 8 && chars < 40) return false;
  const quoteTokens = contentTokens(quote);
  for (const t of contentTokens(text)) {
    if (quoteTokens.has(t)) return true;
  }
  return false;
}

function inputDigestOf(turn: GroundingTurn): string {
  const digest = (turn.props as { inputDigest?: unknown } | null)?.inputDigest;
  return typeof digest === "string" ? digest : "";
}

/** m1: below this many characters after `normalizeQuote`, a quote grounds nothing. */
export const MIN_NORMALIZED_QUOTE_CHARS = 8;

const HEX_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * B1: a ref that names exactly one thing — a URL, a hex sha (>= 7 chars,
 * at least one a-f letter so a plain number is not a sha, and — R2-m1 —
 * at least one digit so a hex-spelled English word
 * like "defaced" or "facade" is not a sha), `#N`, or a path
 * with a "/". Only these may be found in a turn other than the quote's, or
 * ground a quote-less outcome. A branch/tag name ("main", "v1") or a bare
 * filename ("README.md") is too common to trust anywhere but the quote's
 * own turn.
 */
export function isSpecificRef(ref: string): boolean {
  const r = ref.trim();
  if (/^https?:\/\/\S+$/i.test(r)) return true;
  if (HEX_SHA.test(r) && /[a-f]/i.test(r) && /\d/.test(r)) return true;
  if (/^#\d+$/.test(r)) return true;
  return /^[^\s/]*\/\S*[^\s/]$/.test(r) && !/^origin\//.test(r);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * B1: `ref` as a whole token — not preceded by a word char, "/" (unless the
 * ref is itself a path), "." or "-",
 * not followed by a word char, "/" or "-" (a trailing "." or "," is fine).
 * A hex sha also matches as the prefix of a longer sha.
 * R2-m2: `allowPathSuffix` lets a path ref match as the tail of a longer
 * path ("/repo/apps/x.ts"). Only the quote's own turn allows it; anywhere
 * else the path as given must be a whole path token, so `src/index.ts`
 * never matches `packages/other/src/index.ts` in an unrelated turn.
 */
function refPattern(ref: string, allowPathSuffix: boolean): RegExp {
  const r = ref.trim();
  const hexTail = HEX_SHA.test(r) ? "[0-9a-f]*" : "";
  const before = allowPathSuffix && r.includes("/") ? "(?<![\\w.-])" : "(?<![\\w/.-])";
  return new RegExp(`${before}${escapeRegExp(r)}${hexTail}(?![\\w/-])`, HEX_SHA.test(r) ? "i" : "");
}

/**
 * The ref appears as a whole token (B1) in this turn's tool-input digest or
 * its text. `ownTurn` (R2-m2): this is the quote's (or, with no quote, the
 * cited) turn, where a path ref may match as a path suffix.
 */
export function refInTurn(ref: string, turn: GroundingTurn, ownTurn = true): boolean {
  if (!ref.trim()) return false;
  const re = refPattern(ref, ownTurn);
  const digest = inputDigestOf(turn);
  if (re.test(digest) || re.test(turn.text ?? "")) return true;
  // Issue #161: see `deepRelativePathRef`. Tool-input digest and touched file path only, never turn text.
  const deep = deepRelativePathRef(ref);
  if (deep === null) return false;
  const abs = absolutePathSuffixPattern(deep);
  return abs.test(digest) || abs.test(turn.file_path ?? "");
}

/** Issue #161: a repo-relative path needs at least this many segments to match the tail of an absolute path. */
export const MIN_DEEP_PATH_SEGMENTS = 3;

/**
 * Issue #161: outcome refs are repo-relative (`apps/cloud/src/x.ts`, made so by `relativizeRefPath`
 * against the session cwd) while tool-input digests keep the absolute path the tool was given
 * (`/Users/.../repo/apps/cloud/src/x.ts`, or a worktree's). A ref with a path in a turn other than
 * the cited one used to need a whole-path-token match, so these retired as `unverified:ref_not_found`
 * and `--reverify` could not recover them. Serve-time has no session cwd, so the rule is cwd-free:
 * a relative path of at least MIN_DEEP_PATH_SEGMENTS segments may match, in a turn's tool-input
 * digest or touched-file path only, as the tail of an ABSOLUTE path, anchored on a `/` boundary at the ref's start. The
 * segment floor keeps `src/index.ts` from matching `/r/packages/other/src/index.ts`; an absolute,
 * home-relative or `./` ref is not a candidate (returns null), and nor is a URL.
 */
export function deepRelativePathRef(ref: string): string | null {
  const r = ref.trim().replace(/^\.\//, "");
  if (!r || r.startsWith("/") || r.startsWith("~") || r.includes("://") || /\s/.test(r)) return null;
  const parts = r.split("/");
  if (parts.length < MIN_DEEP_PATH_SEGMENTS || parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return r;
}

function absolutePathSuffixPattern(path: string): RegExp {
  // A shell/argument token that starts with "/" or "~" (an absolute or home path) and ends in "/<path>".
  return new RegExp(`(?:^|[\\s"'=(])[~/][^\\s"']*/${escapeRegExp(path)}(?![\\w/-]|\\.\\w)`);
}

function asRole(role: string | null | undefined): "user" | "assistant" | null {
  return role === "user" || role === "assistant" ? role : null;
}

/** Sorts candidate turns nearest-first to `cited` (ties -> the earlier turn). */
function nearestFirst(turns: GroundingTurn[], cited: number): GroundingTurn[] {
  return [...turns].sort((a, b) => Math.abs(a.idx - cited) - Math.abs(b.idx - cited) || a.idx - b.idx);
}

interface QuoteHit {
  turn: GroundingTurn;
  quote: string;
}

function findQuoteHit(rec: GroundingInput, quote: string, turns: GroundingTurn[]): QuoteHit | null {
  const userOnly = rec.kind === "preference" || rec.userTurnsOnly === true;
  const eligible = (t: GroundingTurn) => !userOnly || t.role === "user";
  const cited = turns.find((t) => t.idx === rec.turn_idx);
  // M2: only a specific quote may move the receipt to another turn.
  const mayMove = isSpecificEnoughQuote(quote, rec.text);

  // a. cited turn, normalised substring.
  if (cited && eligible(cited) && quoteMatchesTurnText(quote, cited.text ?? "")) return { turn: cited, quote };

  const others = nearestFirst(
    turns.filter((t) => t.idx !== rec.turn_idx && eligible(t) && t.text),
    rec.turn_idx,
  );

  // b. another turn, normalised substring — nearest to the cited index.
  const verbatimElsewhere = mayMove ? others.find((t) => quoteMatchesTurnText(quote, t.text ?? "")) : undefined;
  if (verbatimElsewhere) return { turn: verbatimElsewhere, quote };

  // c. snap at the cited turn (>= 90% contiguous token coverage).
  if (cited?.text && eligible(cited)) {
    const snap = snapQuoteToSource(quote, cited.text);
    if (snap) return { turn: cited, quote: snap.snapped };
  }

  // d. full-coverage snap (verbatim modulo markdown) at another turn.
  if (!mayMove) return null;
  for (const t of others) {
    const snap = snapQuoteToSource(quote, t.text ?? "");
    if (snap && snap.coverage === 1) return { turn: t, quote: snap.snapped };
  }
  return null;
}

/**
 * The single grounding predicate — see this file's header. Pure, never
 * throws, never mutates its inputs. `turns` is every turn of the record's
 * session (any order).
 */
export function groundAgainstTurns(rec: GroundingInput, turns: readonly GroundingTurn[]): GroundingResult {
  const list = [...turns];
  const cited = list.find((t) => t.idx === rec.turn_idx);
  const fail = (reason: GroundingFailure): GroundingResult => ({
    verified: false,
    turn_idx: rec.turn_idx,
    turn_role: asRole(cited?.role),
    quote: rec.quote,
    quoteChanged: false,
    reason,
  });

  if (!rec.quote) {
    if (rec.kind !== "outcome") return fail("no_quote");
    // B1: with no quote, only a specific ref may ground the outcome.
    if (!rec.ref || !isSpecificRef(rec.ref)) return fail("ref_not_found");
    const ref = rec.ref;
    const hit = nearestFirst(
      list.filter((t) => refInTurn(ref, t, t.idx === rec.turn_idx)),
      rec.turn_idx,
    )[0];
    if (!hit) return fail("ref_not_found");
    return {
      verified: true,
      turn_idx: hit.idx,
      turn_role: asRole(hit.role),
      quote: null,
      quoteChanged: false,
      reason: null,
    };
  }

  if (normalizeQuote(rec.quote).length < MIN_NORMALIZED_QUOTE_CHARS) return fail("quote_not_found");
  const hit = findQuoteHit(rec, rec.quote, list);
  if (!hit) return fail("quote_not_found");
  if (SPECIFICITY_GATED_KINDS.has(rec.kind) && !isSpecificEnoughQuote(hit.quote, rec.text)) {
    return fail("quote_not_specific");
  }
  if (rec.kind === "outcome") {
    const ref = rec.ref;
    // B1: whole-token ref in the quote's own turn, or — for a specific ref
    // only — in any turn of the session.
    const found =
      !!ref &&
      (refInTurn(ref, hit.turn) || (isSpecificRef(ref) && list.some((t) => refInTurn(ref, t, t.idx === hit.turn.idx))));
    if (!found) return fail("ref_not_found");
  }
  return {
    verified: true,
    turn_idx: hit.turn.idx,
    turn_role: asRole(hit.turn.role),
    quote: hit.quote,
    quoteChanged: hit.quote !== rec.quote,
    reason: null,
  };
}

// --- D10 (W3): a ref's title and, on an MR ref, the issue it addresses.
// Both ride on a record already grounded above and are checked against its
// RESOLVED receipt turn / stored quote. A failure drops the field, never the
// record. No similarity, no meaning-based association and no linking-word
// list (D-057 stays off): only tokens that name each item as written.

/** A title needs at least this many words to prove anything by appearing in a turn. */
export const MIN_REF_TITLE_WORDS = 2;

/** Whitespace-tolerant, case-insensitive pattern for `title` — so the stored value is the turn's own substring. */
function titlePattern(title: string): RegExp | null {
  const words = title.normalize("NFKC").trim().split(/\s+/).filter(Boolean);
  if (words.length < MIN_REF_TITLE_WORDS) return null;
  return new RegExp(words.map(escapeRegExp).join("\\s+"), "iu");
}

/**
 * Every item number a text names as an item: `#N`, `!N`, `/N` (a URL path
 * segment), or JSON `"number": N` / `"iid": N` (gh/glab `--json`, MCP list
 * output). Never a bare digit run.
 */
const ITEM_TOKEN_SOURCES = [/[#!/](\d+)(?!\d)/g, /"number"\s*:\s*(\d+)(?!\d)/g, /"iid"\s*:\s*(\d+)(?!\d)/g];

function itemNumbers(text: string): number[] {
  return ITEM_TOKEN_SOURCES.flatMap((re) => [...text.matchAll(re)].map((m) => Number(m[1])));
}

/** A tool input that names item N in ITEM form: `view N`, `#N`/`!N`, `"issue_number": N`, `"iid": N` — never a bare digit run. */
function inputNamesItem(input: string, n: number): boolean {
  return new RegExp(`(?:\\bview\\s+|[#!]|"issue_number"\\s*:\\s*|"iid"\\s*:\\s*)${n}(?!\\d)`, "i").test(input);
}

/**
 * D10: keeps `title` only when the receipt turn ties it to `ref`'s own
 * number and to no other item:
 *   - ONE line holds the title (whitespace-tolerant, case-insensitive), names
 *     item N (`itemNumbers`), and names NO other item M != N — so a one-line
 *     list (`gh issue list --json`, compact MCP JSON, "#12 and #15: <title>")
 *     never lends one item's title to another; or
 *   - fallback for a single-item view: the tool input names N in item form
 *     (`inputNamesItem`), the output names no other item, and holds the title.
 * Returns the matched substring of the turn (its own casing and spacing), or
 * null. Pure.
 */
export function groundRefTitle(
  title: string | null | undefined,
  ref: string | null | undefined,
  turn: GroundingTurn | null | undefined,
): string | null {
  if (!title || !ref || !turn) return null;
  const pattern = titlePattern(title);
  const n = issueRefNumber(ref);
  if (!pattern || n === null) return null;
  const output = (turn.text ?? "").normalize("NFKC");
  const input = inputDigestOf(turn).normalize("NFKC");

  for (const line of `${output}\n${input}`.split("\n")) {
    const items = itemNumbers(line);
    if (!items.includes(n) || items.some((m) => m !== n)) continue;
    const m = line.match(pattern);
    if (m) return m[0];
  }

  if (inputNamesItem(input, n) && itemNumbers(output).every((m) => m === n)) {
    const m = output.match(pattern);
    if (m) return m[0];
  }
  return null;
}

const MR_URL_SEGMENTS: ReadonlySet<string> = new Set(["pull", "pulls", "pull-requests", "merge_requests"]);

function forgeUrlSegment(ref: string): string | null {
  const url = parseHttpUrl(ref.trim());
  if (!url) return null;
  const segs = url.pathname.split("/").filter(Boolean);
  for (let i = segs.length - 2; i >= 0; i--) {
    const seg = segs[i].toLowerCase();
    if (FORGE_ITEM_SEGMENTS.has(seg) && /^\d+$/.test(segs[i + 1])) return seg;
  }
  return null;
}

/** An MR/PR ref by its SHAPE alone — a trailing `!N` or a pull/merge_requests URL — never the model's ref_kind. */
export function isMergeRequestRef(ref: string): boolean {
  const r = ref.trim();
  if (/!\d+$/.test(r)) return true;
  const seg = forgeUrlSegment(r);
  return seg !== null && MR_URL_SEGMENTS.has(seg);
}

/** True when `token` appears in `quote` as its own token: not preceded by [\w/.!-], not followed by a digit. */
function hasToken(quote: string, token: string): boolean {
  return new RegExp(`(?<![\\w/.!-])${escapeRegExp(token)}(?!\\d)`).test(quote);
}

/** An issue target as written: bare `#N`, qualified `owner/repo#N`, or an issues URL. Anything else is no target. */
function isIssueTarget(target: string): boolean {
  if (/^#\d+$/.test(target)) return true;
  if (/^[\w.-]+(?:\/[\w.-]+)+#\d+$/.test(target)) return true;
  return forgeUrlSegment(target) === "issues" || forgeUrlSegment(target) === "issue";
}

/** The repo a ref names ("owner/repo", lower-case), or null when it names none (a bare `#N`/`!N`). */
function repoOf(ref: string): string | null {
  const url = parseHttpUrl(ref.trim());
  if (url) {
    const segs = url.pathname.split("/").filter(Boolean);
    const i = segs.findIndex((seg, j) => (seg === "-" || FORGE_ITEM_SEGMENTS.has(seg.toLowerCase())) && j > 0);
    return i > 0 ? segs.slice(0, i).join("/").toLowerCase() : null;
  }
  const m = ref.trim().match(/^(.+)[#!]\d+$/);
  return m ? m[1].toLowerCase() : null;
}

/** True unless both refs name a repo and the repos differ. */
function sameRepo(a: string, b: string): boolean {
  const ra = repoOf(a);
  const rb = repoOf(b);
  return ra === null || rb === null || ra === rb;
}

export type RefIssueBasis = "stated" | "inferred";

/**
 * D10 MR->issue edge (maintainer decisions 2026-10-03 and 2026-10-04, "LLM
 * link by meaning now"). The ref must be an MR by SHAPE and the target an
 * issue as written (`#12`, `owner/repo#12`, or its issues URL).
 *   - "stated": the record's own (grounded) quote names both items, each as
 *     its own token exactly as written (`hasToken`). If it does not, the
 *     edge is downgraded to "inferred" and checked as such.
 *   - "inferred": the session's meaning links them, but the issue must still
 *     appear as its own token (the same strict rule) in some turn of the
 *     session the extractor saw (`turns`: text or tool input) — the model
 *     never links an issue the session does not mention.
 * A missing or unknown basis keeps nothing. Returns the kept edge, or null.
 * Pure.
 */
export function groundRefIssue(
  rec: { ref: string | null | undefined; quote: string | null | undefined },
  issue: string | null | undefined,
  basis: RefIssueBasis | null | undefined,
  turns: readonly GroundingTurn[],
): { issue: string; basis: RefIssueBasis } | null {
  const ref = rec.ref?.trim();
  const target = issue?.trim();
  if (!ref || !target || (basis !== "stated" && basis !== "inferred")) return null;
  if (!isMergeRequestRef(ref) || !isIssueTarget(target)) return null;
  if (basis === "stated" && rec.quote && hasToken(rec.quote, ref) && hasToken(rec.quote, target)) {
    return { issue: target, basis: "stated" };
  }
  // An inferred edge never points at the MR itself: same number, same (or
  // unstated) repo — e.g. "#12" inferred for ".../pull/12".
  if (issueRefNumber(ref) === issueRefNumber(target) && sameRepo(ref, target)) return null;
  const inSession = turns.some((t) => hasToken(`${t.text ?? ""}\n${inputDigestOf(t)}`, target));
  return inSession ? { issue: target, basis: "inferred" } : null;
}
