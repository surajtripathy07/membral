import { redactPii } from "@membral/core";

// Memory v1, prompt v3 residual 2 (docs/goals/2026-09-13_memory-v1-build_goal.md
// step 2c, issue #151; maintainer decision 2026-09-13): the write-side quote
// check (merge.ts's `groundRecord`) and the serve-side receipt re-check
// (verify.ts's `verifyRecords`, D-021 rule 3) each ran their OWN whitespace-
// only `normalizeWhitespace` before an exact-substring `.includes()` check.
// A live diagnosis of the 32 unverified preference/learning rows on
// membral-personal found
// 6 of them (~19%) failing purely on cosmetic differences between the
// model's `quote` and the turn's stored text — a trailing period or "..."
// the model appended to a mid-sentence quote where the transcript actually
// continues past that point. Neither side normalized those away, so the two
// checks agreed (both said "not verified") but for the wrong reason: not
// because the record was ungrounded, but because whitespace-only
// normalization was not enough to see it. This module is the ONE place that
// normalization lives now — both merge.ts and verify.ts import
// `normalizeQuote` so a future normalization change can never make the two
// sides disagree again.
//
// Scope, deliberately narrow (see the diagnosis writeup in
// scratchpad/reports/step2c.md for the full breakdown): only cosmetic
// Unicode/punctuation variance is normalized here. Genuine paraphrase —
// a pronoun swapped, a typo silently corrected, markdown stripped, two
// non-adjacent spans stitched together with an ellipsis, or a computed
// value that never appeared verbatim — is NOT masked by this function on
// purpose; those records are being fixed by tightening the extraction
// prompt (v3's verbatim-copy rule), not by loosening the grounding check.
// Case WAS deliberately not folded here until the D3 diagnosis
// (handoff/d3-v5/diag, maintainer decision 2026-09-24): 6 of 35 unverified
// records were real, verbatim spans that failed only on case (the model
// re-cased a mid-sentence fragment's first word) or on ASCII quote-style
// interchange (' vs " vs `). Both are cosmetic — case-folding cannot
// manufacture a sentence nobody wrote — so `normalizeQuote` now folds case
// and treats every quote/apostrophe/backtick form as ONE class. Still
// language-agnostic: Unicode `toLowerCase` + character classes, no word
// lists.
//
// Maintainer's spec (verbatim, issue #151): "NFKC, unify quotes/apostrophes/
// dashes, collapse whitespace, collapse runs of `.`/`…` to a single token,
// strip trailing punctuation."

/**
 * Every quote-like character — ASCII ' " `, curly single/double quotes,
 * low-9 quotes, modifier apostrophe, primes — collapses to ONE class
 * (the ASCII apostrophe), maintainer decision 2026-09-24 (D3 diag: ASCII
 * ' vs " substitution was a CHECKER BUG class, not paraphrase).
 */
const QUOTE_CLASS = /['"`‘’‚‛“”„‟ʼ′″]/g;
/** En dash, em dash, minus sign, horizontal bar -> ASCII hyphen. */
const DASHES = /[‐‑‒–—―−]/g;
/** Two or more literal dots (an ellipsis character decomposes to "..." under NFKC, see below) collapse to one. */
const DOT_RUNS = /\.{2,}/g;
/** A trailing run of sentence/quote punctuation the model appends to make a mid-sentence fragment read as "finished". */
const TRAILING_PUNCTUATION = /[.,;:!?'"-]+$/;

/**
 * Character-level canonical form shared by `normalizeQuote` (whole-string)
 * and `snapQuoteToSource`'s per-token key, so the two can never drift:
 * NFKC, one quote class, one dash class, Unicode case-fold. Never changes
 * word content — only how the same characters are spelled.
 */
export function canonicalChars(s: string): string {
  return s.normalize("NFKC").replace(QUOTE_CLASS, "'").replace(DASHES, "-").toLowerCase();
}

/**
 * The one substring-comparison normalization for a `quote` <-> turn-`text`
 * check, used identically by merge.ts (write-side grounding) and verify.ts
 * (serve-side re-check).
 *
 * Order matters:
 *  1. NFKC — canonicalizes compatibility variants; notably U+2026 HORIZONTAL
 *     ELLIPSIS has a compatibility decomposition to three ASCII periods, so
 *     this step alone turns "…" into "..." with no separate ellipsis-char
 *     mapping needed.
 *  2. `canonicalChars`: one quote class (ASCII/curly ' " ` all equal), dash
 *     variants to "-", and a Unicode case-fold.
 *  3. Collapse whitespace runs (existing behavior, kept from the pre-v3
 *     `normalizeWhitespace` both files used) and trim.
 *  4. Collapse a run of 2+ dots (now including former ellipsis characters)
 *     to a single "." — a model that trails off mid-quote with "..." should
 *     compare equal to one that used a lone "." or nothing at all once the
 *     trailing-punctuation strip below also runs.
 *  5. Strip a trailing run of sentence/quote punctuation — the dominant
 *     residual: the model closes a quote it truncated mid-sentence with a
 *     period or "..." that the source text does not have at that point
 *     (the source simply continues).
 *
 * Never treats "..." as a mid-string wildcard — an
 * ellipsis MID-quote (two non-adjacent spans stitched together, omitting
 * real words in between) is a genuine paraphrase this function does not
 * and should not mask.
 */
export function normalizeQuote(s: string): string {
  return canonicalChars(s).replace(/\s+/g, " ").trim().replace(DOT_RUNS, ".").replace(TRAILING_PUNCTUATION, "");
}

// step2d finding 12 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151; driver follow-up 2026-09-13): PII redaction (merge.ts's
// `redactRecordPii`, phone/email only per step2d finding 2) runs on the
// model's raw `quote` BEFORE grounding — so a quote that genuinely was
// copied verbatim from the turn, but happened to contain a phone number or
// email, is stored with `[redacted]` in place of that PII while the turn's
// OWN text (`code_session_turns.text`) is never touched. Comparing the
// redacted quote against the UNREDACTED turn text then fails to find a
// match — not because the record is ungrounded, but because the two sides
// were redacted asymmetrically. Redacting the turn text the SAME way before
// comparing makes both sides agree again. Shared by merge.ts's write-side
// grounding and verify.ts's serve-side re-check, so they can never disagree
// over this the way they briefly could for cosmetic drift before
// `normalizeQuote` was shared (see this file's header).

/**
 * True when `quote` (already phone/email-redacted, if it ever needed to be)
 * is a substring of `turnText` ONCE `turnText` is redacted the same way —
 * so a PII-redacted quote still grounds against the turn it was genuinely
 * copied from verbatim.
 */
export function quoteMatchesTurnText(quote: string, turnText: string): boolean {
  return normalizeQuote(redactPii(turnText)).includes(normalizeQuote(quote));
}

// step2e finding 3 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151): a live diagnosis of 7 unverified quotes found none of them were
// genuinely un-groundable — each was a real, findable span in its receipt
// turn that failed only `quoteMatchesTurnText`'s EXACT-substring check, for
// one of three reasons: (1) the model quoted around the source's own
// markdown (dropped a `**`/backtick/`_` pair), (2) a stale "[redacted]"
// marker left over from the since-undone home-path redaction rule (the
// turn's own text now has the real value, the stored quote does not), or
// (3) the quote is genuinely STITCHED from two non-adjacent spans (a typo
// silently fixed, a parenthetical dropped, two sentences joined) — which
// must stay unverified, not be papered over.
//
// `snapQuoteToSource` tells these apart with one mechanism: the longest
// CONTIGUOUS run of matching WORD tokens between `quote` and `turnText`,
// compared markdown-insensitively (`**`/backtick/`_` stripped before
// comparing, then the same cosmetic normalization `normalizeQuote` already
// does) — case (1) and (2) naturally produce a run covering ~100% of the
// quote's tokens (markdown/the redaction marker were never real content to
// begin with), while case (3) produces two shorter, disjoint runs. A
// dedicated wildcard for the literal PII marker "[redacted]" lets case (2)
// match through it to whatever real value now sits there.
//
// Never invents text: the returned `snapped` string is always sliced
// verbatim out of the ORIGINAL `turnText` (markdown intact), for the exact
// span the matched tokens cover — this is what should replace the stored
// `quote` going forward (merge.ts at write time, `--reverify` for a row
// already live). A run covering less than 90% of the quote's tokens is
// rejected outright (`null`) — a stitched quote is not "a quote", however
// close two of its real fragments individually get.

const MARKDOWN_MATCH_CHARS = /[*`_]/g;
const REDACTED_MATCH_TOKEN = "[redacted]";
/** A stitched (non-contiguous) quote must never pass just because one half of it happens to be long — this is the floor on how much of the quote a single contiguous window must cover. */
const SNAP_MIN_COVERAGE = 0.9;

function stripMarkdownForMatch(s: string): string {
  return s.replace(MARKDOWN_MATCH_CHARS, "");
}

const SNAP_TRAILING_PUNCTUATION = /[.,;:!?'"-]+$/;

/**
 * Markdown-insensitive, cosmetically-normalized comparison key for one
 * whitespace-delimited token. Deliberately NOT `normalizeQuote` itself: that
 * function's trailing-punctuation strip is a whole-STRING boundary rule (a
 * quote that trails off mid-sentence). Applied unconditionally per-token, it
 * would collapse a standalone dash/punctuation token (an em dash rendered as
 * its own `\S+` token, a bullet's leading "-") down to the EMPTY string,
 * making two unrelated punctuation-only tokens compare equal — so the strip
 * here only applies when it leaves something behind; a token that IS only
 * punctuation keeps its (NFKC/dash-unified) form instead, so two of THOSE
 * only match when they're actually the same punctuation.
 */
function snapTokenKey(tok: string): string {
  const canonical = canonicalChars(stripMarkdownForMatch(tok));
  const stripped = canonical.replace(SNAP_TRAILING_PUNCTUATION, "");
  return stripped.length > 0 ? stripped : canonical;
}

export interface QuoteSnapResult {
  /** The exact slice of `turnText` (markdown intact) the matched window covers — store this in place of the model's original `quote`. */
  snapped: string;
  /** Matched window length divided by the quote's total token count, in (0, 1]. */
  coverage: number;
}

/**
 * See this file's header block above. `null` when nothing overlaps at all,
 * or the best contiguous window covers less than `SNAP_MIN_COVERAGE` of the
 * quote's tokens.
 */
export function snapQuoteToSource(quote: string, turnText: string): QuoteSnapResult | null {
  const quoteTokens = [...quote.matchAll(/\S+/g)];
  const turnTokens = [...turnText.matchAll(/\S+/g)];
  if (quoteTokens.length === 0 || turnTokens.length === 0) return null;

  const qKeys = quoteTokens.map((m) => snapTokenKey(m[0]));
  const tKeys = turnTokens.map((m) => snapTokenKey(m[0]));

  // Longest common contiguous run over the token arrays (classic
  // longest-common-substring DP, one row at a time) — a quote token that IS
  // the literal redaction marker matches ANY turn token (case 2 above).
  let bestLen = 0;
  let bestTurnStart = -1;
  let prevRow = new Array(tKeys.length + 1).fill(0);
  for (let i = 1; i <= qKeys.length; i++) {
    const currRow = new Array(tKeys.length + 1).fill(0);
    const qKey = qKeys[i - 1];
    for (let j = 1; j <= tKeys.length; j++) {
      const isWildcard = qKey === REDACTED_MATCH_TOKEN;
      if (qKey && (isWildcard || qKey === tKeys[j - 1])) {
        currRow[j] = prevRow[j - 1] + 1;
        if (currRow[j] > bestLen) {
          bestLen = currRow[j];
          bestTurnStart = j - currRow[j];
        }
      }
    }
    prevRow = currRow;
  }

  if (bestLen === 0) return null;
  const coverage = bestLen / qKeys.length;
  if (coverage < SNAP_MIN_COVERAGE) return null;

  const first = turnTokens[bestTurnStart];
  const last = turnTokens[bestTurnStart + bestLen - 1];
  const lastEnd = (last.index ?? 0) + last[0].length;
  return { snapped: turnText.slice(first.index, lastEnd), coverage };
}
