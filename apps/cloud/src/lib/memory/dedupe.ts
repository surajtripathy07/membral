// Same-fact detection shared by every serve surface (L2, docs/design/current-truth-recall.md section 3): the token
// Jaccard / containment rule with its identifier, lifecycle-verb and environment/outcome guards, moved verbatim from
// prompt-recall.ts so memory_search, memory_recall, the preamble and prompt recall collapse paraphrases one way.
// Pure; no I/O.

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with".split(" "),
);

/**
 * Per-text memo for the derived sets below. The pairwise collapse compares every record with every other, so without
 * it each text is re-tokenized once per pair (the preamble's 476-record collapse took ~2.2 s of CPU, almost all of it
 * regex and set building). The cached Sets are shared and must be treated as read-only (no caller mutates them). The
 * cache is cleared when it grows past MEMO_MAX entries, so it stays bounded in a long-lived server.
 */
const MEMO_MAX = 4_000;
function memoized<V>(derive: (text: string) => V): (text: string) => V {
  const cache = new Map<string, V>();
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const v = derive(text);
    if (cache.size >= MEMO_MAX) cache.clear();
    cache.set(text, v);
    return v;
  };
}

/** Lowercased word tokens, punctuation stripped, stopwords removed. Pure; the returned Set is shared, do not mutate. */
export const tokenSet: (text: string) => Set<string> = memoized(
  (text) =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}#]+/gu, " ")
        .split(" ")
        .filter((t) => t && !STOPWORDS.has(t)),
    ),
);

export function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** Shared tokens over the smaller set's size: 1 when one set holds the other. Pure. */
export function containment(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  return min === 0 ? 0 : sharedCount(a, b) / min;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Token-set Jaccard at or above this collapses two records into one line. */
export const PROMPT_RECALL_DUPLICATE_JACCARD = 0.6;
/**
 * Two `outcome` records with the same ref collapse at this token containment, shared / min(|A|, |B|), instead of
 * Jaccard: parallel sessions word one event ("PR #370 merged, closing #361") differently and at different lengths, and
 * the longer report's extra tokens sank Jaccard (4/17 for a short and a long #370 line; four paraphrases took four of
 * five slots, eval loops 2 and 3, 2026-10-09). Containment ignores the longer text's extras.
 */
export const PROMPT_RECALL_SAME_REF_OUTCOME_CONTAINMENT = 0.4;
/** Both texts need at least this many tokens before a text match may collapse them: short texts differ by one word. */
export const PROMPT_RECALL_DUPLICATE_MIN_TOKENS = 6;

/** A number or identifier: contains a digit, or `#12`/`!12`, a sha-like hex run, a `dpl_…` deployment id. */
const IDENTIFIER_TOKEN = /\d|^[#!]\d+$|^[0-9a-f]{7,}$|^dpl_\w+$/;

/** The text's number/identifier tokens, lowercased, edge punctuation stripped. Pure. */
const identifierTokens: (text: string) => Set<string> = memoized(
  (text) =>
    new Set(
      text
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.replace(/^[^\p{L}\p{N}#!]+|[^\p{L}\p{N}]+$/gu, ""))
        .filter((t) => t && IDENTIFIER_TOKEN.test(t)),
    ),
);

/** Lifecycle verb forms -> one family. "rolled back" is matched as a phrase first. */
const LIFECYCLE_FAMILIES: Record<string, string> = {
  open: "open",
  opens: "open",
  opened: "open",
  merged: "merge",
  merging: "merge",
  merges: "merge",
  reverted: "revert",
  closed: "close",
  deployed: "deploy",
  released: "release",
  reopened: "reopen",
  abandoned: "abandon",
};

/**
 * The lifecycle verb families a text names (opened, merged, reverted, closed, deployed, rolled back, released,
 * reopened, abandoned). "closed" is dropped beside "merge": a merge closes ("merged, closing #361"). Pure.
 */
const lifecycleVerbs: (text: string) => Set<string> = memoized(lifecycleVerbsOf);
function lifecycleVerbsOf(text: string): Set<string> {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  if (/\brolled back\b/.test(lower)) out.add("rollback");
  for (const t of lower.split(/[^\p{L}]+/u)) {
    const fam = LIFECYCLE_FAMILIES[t];
    if (fam) out.add(fam);
  }
  if (out.has("merge")) out.delete("close");
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

function subsetOf(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/** Reversal families: a text naming one of these says something the same text without it does not. */
const REVERSAL_FAMILIES = new Set(["revert", "rollback", "abandon", "reopen"]);

/**
 * The lifecycle guard: two texts may collapse when one's FORWARD verb families (merge, deploy, release, close) are
 * a subset of the other's ({merge} and {merge, deploy} are one event told at two lengths, eval loop 2). Any
 * difference that involves a reversal family (revert, rollback, abandon, reopen) requires equal verb sets:
 * "merged" vs "merged, then reverted" are different facts. Pure.
 */
function verbsCompatible(a: string, b: string): boolean {
  const va = lifecycleVerbs(a);
  const vb = lifecycleVerbs(b);
  for (const t of va) if (!vb.has(t) && REVERSAL_FAMILIES.has(t)) return false;
  for (const t of vb) if (!va.has(t) && REVERSAL_FAMILIES.has(t)) return false;
  return subsetOf(va, vb) || subsetOf(vb, va);
}

/** Environment words: "to staging" vs "to production" are different facts. */
const ENV_WORDS = new Set(["staging", "prod", "production", "preview", "canary"]);
/** Outcome words: "passed" vs "failed" are different facts, and one told without the word is not the same fact. */
const OUTCOME_WORDS = new Set(["failed", "failing", "broken", "green", "passed"]);

function wordsOf(text: string, vocab: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^\p{L}]+/u)) if (vocab.has(t)) out.add(t);
  return out;
}
const outcomeWordsOf = memoized((text) => wordsOf(text, OUTCOME_WORDS));
const envWordsOf = memoized((text) => wordsOf(text, ENV_WORDS));

/**
 * The environment/outcome guard: outcome words must match exactly; environment words must match too, except that a
 * text with none may be the short telling of one that names one ("merged" vs "merged ... deployed to prod", eval
 * loop 2), so only two sets that each carry an environment the other lacks (staging vs production) stay apart. Pure.
 */
function envOutcomeCompatible(a: string, b: string): boolean {
  if (!sameSet(outcomeWordsOf(a), outcomeWordsOf(b))) return false;
  const ea = envWordsOf(a);
  const eb = envWordsOf(b);
  return subsetOf(ea, eb) || subsetOf(eb, ea);
}

/**
 * Two texts say the same thing: both have at least PROMPT_RECALL_DUPLICATE_MIN_TOKENS tokens, the same set of
 * number/identifier tokens ("migration 118" never merges with "migration 119"), compatible lifecycle verbs
 * (verbsCompatible), and token Jaccard at or above PROMPT_RECALL_DUPLICATE_JACCARD.
 *
 * `sharedRef`, when given (two outcomes with that same ref): containment at PROMPT_RECALL_SAME_REF_OUTCOME_CONTAINMENT
 * replaces Jaccard; the ref is left out of the identifier comparison (both records carry it, whether or not their
 * texts repeat it); and one identifier set may be a subset of the other ("merged" vs "merged, migration 113, abc1234
 * deployed": one event told at two lengths), while two sets that each carry an identifier the other lacks
 * ("migration 118" vs "migration 119") stay apart. Without it the identifier sets must be equal. Pure.
 */
function sameText(a: string, b: string, sharedRef?: string): boolean {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size < PROMPT_RECALL_DUPLICATE_MIN_TOKENS || tb.size < PROMPT_RECALL_DUPLICATE_MIN_TOKENS) return false;
  const refForms = new Set<string>();
  if (sharedRef) {
    const r = sharedRef.toLowerCase();
    refForms.add(r);
    refForms.add(r.replace(/^.*?([#!]\d+)$/, "$1"));
    refForms.add(r.replace(/^.*?[#!](\d+)$/, "$1"));
  }
  const ids = (t: string) => new Set([...identifierTokens(t)].filter((x) => !refForms.has(x)));
  const ia = ids(a);
  const ib = ids(b);
  if (sharedRef ? !(subsetOf(ia, ib) || subsetOf(ib, ia)) : !sameSet(ia, ib)) return false;
  if (!verbsCompatible(a, b)) return false;
  if (!envOutcomeCompatible(a, b)) return false;
  return sharedRef
    ? containment(ta, tb) >= PROMPT_RECALL_SAME_REF_OUTCOME_CONTAINMENT
    : jaccard(ta, tb) >= PROMPT_RECALL_DUPLICATE_JACCARD;
}

/** What sameThing reads: text, kind, ref. */
export interface SameFactInput {
  kind: string;
  text: string;
  ref: string | null;
}

/**
 * The dedupe rule for one pair: the texts pass sameText, and either both carry the same kind and ref or neither
 * carries a ref. A shared ref alone never merges two records (two rulings on one PR are two rulings). Two outcomes
 * with the same ref need containment PROMPT_RECALL_SAME_REF_OUTCOME_CONTAINMENT instead of Jaccard.
 */
export function sameThing(a: SameFactInput, b: SameFactInput): boolean {
  if (a.ref && b.ref) {
    if (a.kind !== b.kind || oneLine(a.ref) !== oneLine(b.ref)) return false;
    // One event (same ref) reported as an outcome by several sessions: a looser text match, same identifier guard.
    if (a.kind === "outcome") return sameText(a.text, b.text, oneLine(a.ref));
  } else if (a.ref || b.ref) {
    return false;
  }
  return sameText(a.text, b.text);
}

/** The vector rule needs at least this token containment (shared / smaller set) as well as the cosine. */
export const VECTOR_RULE_MIN_CONTAINMENT = 0.5;

/**
 * Same fact by meaning (L2): two records of one kind whose embeddings are at or above `threshold` (the caller reads
 * it per family, vectorThreshold) AND that pass the same guards as the text rule: equal ref (or neither has one),
 * equal identifier sets, compatible lifecycle verbs, compatible environment/outcome words. The guards keep
 * "migration 118" apart from "migration 119" and "failed" apart from "passed" however close the vectors are. Pure.
 */
export function sameFactByVector(a: SameFactInput, b: SameFactInput, cosine: number, threshold: number): boolean {
  if (!(cosine >= threshold) || a.kind !== b.kind) return false;
  // Embeddings put a statement and its reversal close together, and no word list may decide which is which (repo
  // rule), so the vector rule also needs the texts to share half the smaller text's content tokens.
  // KNOWN LIMIT: a reversal that reuses most of the same tokens ("retry the 504 import" vs "do not retry the 504
  // import") still passes; L1's model verdict (supersedes / duplicate_of / unrelated, with a quote) resolves it.
  if (containment(tokenSet(a.text), tokenSet(b.text)) < VECTOR_RULE_MIN_CONTAINMENT) return false;
  if (a.ref || b.ref) {
    if (!(a.ref && b.ref) || oneLine(a.ref) !== oneLine(b.ref)) return false;
  }
  if (
    tokenSet(a.text).size < PROMPT_RECALL_DUPLICATE_MIN_TOKENS ||
    tokenSet(b.text).size < PROMPT_RECALL_DUPLICATE_MIN_TOKENS
  )
    return false;
  if (!sameSet(identifierTokens(a.text), identifierTokens(b.text))) return false;
  return verbsCompatible(a.text, b.text) && envOutcomeCompatible(a.text, b.text);
}
