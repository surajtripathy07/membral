// Exact anchors in a search query (docs/design/prompt-time-recall.md §3):
// file paths, forge refs and backticked identifiers. A record whose text,
// quote, ref or paths carry one of them is about the very thing the query
// names.
//
// Why: measured 2026-10-08, the prompt "lib/kg/queue.ts still reads
// process.env directly. Convert it to the env accessors ..." ranked four
// generic "use the env accessors" memories above the one ruling that kept
// that file as the exception. RRF sums rank positions over many shared words;
// one rare, exact token cannot win that sum. Users asked for the same thing
// on refs: "rank records matching the exact ref first".
//
// Two strengths (search.ts and rank.ts use them differently):
//   - STRONG: paths with a directory (`lib/kg/queue.ts`) and refs (`#157`,
//     `!123456`, `owner/repo#12`). A hit clears the relevance floor and
//     outranks fused relevance.
//   - WEAK: bare file names (`README.md`, `queue.ts`) and backticked
//     identifiers. Only a bounded relevance boost (CODE_ANCHOR_BOOST); never a
//     floor pass. A bare name is common across repos and directories.
// Every match is on a boundary: `queue.ts` is not in `lib/myqueue.ts`, `id`
// is not in `provide`, `#157` is not in `#1570`.
//
// Rule-based on purpose: these are literal tokens, not meaning, so no LLM call.

/** At most this many anchors are read from one query. */
export const MAX_QUERY_ANCHORS = 8;

/** Extensions that make a bare word like `queue.ts` a file name (`process.env` is not one). */
const FILE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|json|md|mdx|sql|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|cs|php|yml|yaml|toml|sh|css|scss|html|vue|svelte";

/**
 * First segments that make an extension-less path a real directory
 * (`apps/cloud/src`), as opposed to prose like `client/server/database`.
 */
const KNOWN_DIRS = new Set([
  "src",
  "lib",
  "libs",
  "app",
  "apps",
  "packages",
  "pkg",
  "cmd",
  "internal",
  "docs",
  "doc",
  "scripts",
  "script",
  "test",
  "tests",
  "spec",
  "specs",
  "components",
  "config",
  "configs",
  "bin",
  "plugins",
  "supabase",
  "migrations",
  "public",
  "assets",
  "tools",
  "node_modules",
  ".github",
  ".claude",
  ".vscode",
]);

/** Backticked words too common to identify anything. */
const COMMON_WORDS = new Set([
  "the",
  "and",
  "for",
  "not",
  "null",
  "true",
  "false",
  "new",
  "get",
  "set",
  "use",
  "run",
  "add",
  "fix",
  "test",
  "tests",
  "this",
  "that",
  "with",
  "from",
  "into",
  "data",
  "type",
  "name",
  "value",
  "error",
  "user",
  "main",
  "code",
  "file",
  "path",
  "list",
  "item",
  "key",
  "env",
  "api",
  "app",
  "src",
  "lib",
]);

const URL_RE = /\bhttps?:\/\/\S+/gi;
const BACKTICK_RE = /`([^`\n]{2,120})`/g;
// What may stand right before a path or file name: start, space, ( [ " ' * < =.
const LEAD = String.raw`(?:^|[\s(\["'*<=])`;
// `/`-joined segments, optionally led by ./ ../ ~/ or /.
const PATH_RE = new RegExp(String.raw`${LEAD}((?:~\/|\.{1,2}\/|\/)?[\w@.-]+(?:\/[\w@.-]+)+)`, "g");
const BARE_FILE_RE = new RegExp(String.raw`${LEAD}([\w-]+(?:\.[\w-]+)*\.(?:${FILE_EXT}))(?=$|[\s)\]"',;:.!?*>])`, "gi");
// #157 (issue, 1-5 digits: #123456 is a colour) and !123456 (merge request,
// 1-7 digits: large forges have six-digit MR numbers), whole (a#1 is not a ref).
// "page #1", "step #2", "item #3" are numbering, not refs: a `#N` right after one of these words is skipped.
const NUMBERING_WORDS = "page|step|item|line|row|chapter|section|part|slide|table|figure|question|q|no";
const REF_RE = new RegExp(String.raw`(?:^|[^\w/&])(?<!\b(?:${NUMBERING_WORDS})\s*)([#!]\d{1,7})(?![\w])`, "gi");
// owner/repo#12, group/sub/repo!12: the anchor keeps the repo qualifier (`owner/repo#12`).
const QUALIFIED_REF_RE = new RegExp(String.raw`${LEAD}([\w.-]+(?:\/[\w.-]+)+)([#!]\d{1,7})(?![\w])`, "g");

function isValidRef(ref: string): boolean {
  const digits = ref.length - 1;
  return ref.startsWith("#") ? digits <= 5 : digits <= 7;
}

const TRAILING_PUNCT = /[.,;:!?)\]'"*>]+$/;

export type QueryAnchorKind = "path" | "file" | "ref" | "code";

export interface QueryAnchor {
  kind: QueryAnchorKind;
  /** Lowercased literal. */
  value: string;
}

/** Is a `/`-joined token a file or directory path (not a date, not prose)? */
function isPathLike(token: string): boolean {
  const led = /^(?:~\/|\.{1,2}\/|\/)/.test(token);
  const segments = token.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  if (segments.every((s) => /^\d+$/.test(s))) return false; // 2026/10/08
  const last = segments[segments.length - 1];
  if (new RegExp(String.raw`\.(?:${FILE_EXT})$`, "i").test(last)) return true;
  // No file extension: a directory only when it says so.
  return led || KNOWN_DIRS.has(segments[0].toLowerCase());
}

/** `Node.js`, `Vue.js`: a capitalised product name, not a file. */
function isProductName(file: string): boolean {
  return /^[A-Z][a-z]+\.js$/.test(file);
}

function isUsefulCodeAnchor(inner: string): boolean {
  const v = inner.trim().toLowerCase();
  return v.length >= 3 && !COMMON_WORDS.has(v);
}

/**
 * The query's exact anchors, deduplicated, in order of appearance, at most
 * MAX_QUERY_ANCHORS. A bare file name already covered by a path anchor
 * (`queue.ts` inside `lib/kg/queue.ts`) is dropped. Pure.
 */
export function extractQueryAnchors(query: string): QueryAnchor[] {
  const out: QueryAnchor[] = [];
  const seen = new Set<string>();
  const add = (kind: QueryAnchorKind, raw: string) => {
    const value = raw
      .trim()
      .replace(TRAILING_PUNCT, "")
      .replace(/^(?:~\/|\.{1,2}\/|\/)/, "")
      .toLowerCase();
    if (value.length < 2 || seen.has(value)) return;
    seen.add(value);
    out.push({ kind, value });
  };

  const noUrls = query.replace(URL_RE, " ");
  for (const m of noUrls.matchAll(BACKTICK_RE)) {
    const inner = m[1].trim().replace(TRAILING_PUNCT, "");
    if (inner.includes("/") && isPathLike(inner)) add("path", inner);
    else if (new RegExp(String.raw`^[\w-]+(?:\.[\w-]+)*\.(?:${FILE_EXT})$`, "i").test(inner)) add("file", inner);
    else if (isUsefulCodeAnchor(inner)) add("code", inner);
  }
  const plain = noUrls.replace(BACKTICK_RE, " ");
  for (const m of plain.matchAll(PATH_RE)) {
    const token = m[1].replace(TRAILING_PUNCT, "");
    if (isPathLike(token)) add("path", token);
  }
  for (const m of plain.matchAll(BARE_FILE_RE)) if (!isProductName(m[1])) add("file", m[1]);
  for (const m of plain.matchAll(QUALIFIED_REF_RE)) if (isValidRef(m[2])) add("ref", `${m[1]}${m[2]}`);
  for (const m of plain.matchAll(REF_RE)) if (isValidRef(m[1])) add("ref", m[1]);

  const paths = out.filter((a) => a.kind === "path").map((a) => a.value);
  return out
    .filter((a) => a.kind !== "file" || !paths.some((p) => p.endsWith(`/${a.value}`)))
    .slice(0, MAX_QUERY_ANCHORS);
}

/** The record fields an anchor is looked for in. */
export interface AnchorHaystack {
  text: string;
  quote?: string | null;
  ref?: string | null;
  paths?: readonly string[] | null;
  /** Normalised repo identity of the record's project, when known: lets a bare `#12` carry a qualified `owner/repo#12` anchor. */
  repo?: string | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface AnchorHits {
  /** Strong anchors the record carries: paths with a directory, and refs. */
  strong: number;
  /** Weak anchors the record carries: bare file names and backticked identifiers. */
  weak: number;
}

/**
 * Which of `anchors` the record carries, all on boundaries:
 *   - path / file: not after a word char, `.` or `-`, and not before a word
 *     char, `-` or `.x` -- `apps/cloud/src/lib/kg/queue.ts` carries
 *     `lib/kg/queue.ts`, but `lib/myqueue.ts` does not carry `queue.ts`,
 *     `old-readme.md` not `readme.md`, `reindex.ts` not `index.ts`;
 *   - ref: whole -- a bare anchor `#12` is carried by `owner/repo#12` and `#12`;
 *     a qualified anchor `owner/repo#12` only by that qualified form, or by a
 *     bare `#12` on a record whose `repo` is that repo; `#1570` and `a#12` never;
 *   - code: identifier boundaries -- `id` is not in `provide`. Pure.
 */
export function anchorHits(record: AnchorHaystack, anchors: readonly QueryAnchor[]): AnchorHits {
  const hits: AnchorHits = { strong: 0, weak: 0 };
  if (anchors.length === 0) return hits;
  const hay = [record.text, record.quote ?? "", record.ref ?? "", ...(record.paths ?? [])].join("\n").toLowerCase();
  for (const a of anchors) {
    const v = escapeRegExp(a.value);
    if (a.kind === "ref") {
      const at = a.value.search(/[#!]/);
      if (at > 0) {
        // Qualified (`owner/repo#12`): the qualified form, or the bare number
        // when the record's project is that repo.
        const repo = record.repo?.toLowerCase();
        const sameRepo = !!repo && (repo === a.value.slice(0, at) || repo.endsWith(`/${a.value.slice(0, at)}`));
        const bare = escapeRegExp(a.value.slice(at));
        const re = sameRepo ? `(?:(?<![\\w&/])|(?<=[\\w.-]/[\\w.-]+))${bare}(?![\\w])` : `(?<![\\w.-])${v}(?![\\w])`;
        if (new RegExp(re).test(hay)) hits.strong++;
      } else if (new RegExp(`(?:(?<![\\w&/])|(?<=[\\w.-]/[\\w.-]+))${v}(?![\\w])`).test(hay)) hits.strong++;
    } else if (a.kind === "path" || a.kind === "file") {
      if (new RegExp(`(?<![\\w.-])${v}(?![\\w-]|\\.\\w)`).test(hay)) {
        if (a.kind === "path") hits.strong++;
        else hits.weak++;
      }
    } else if (new RegExp(`(?<![\\w$])${v}(?![\\w$])`).test(hay)) {
      hits.weak++;
    }
  }
  return hits;
}

/** Total anchors carried, both strengths. Pure. */
export function countAnchorHits(record: AnchorHaystack, anchors: readonly QueryAnchor[]): number {
  const h = anchorHits(record, anchors);
  return h.strong + h.weak;
}

/**
 * Each weak-anchor hit (bare file name or code identifier) multiplies the fused relevance by (1 + CODE_ANCHOR_BOOST),
 * at most CODE_ANCHOR_MAX_HITS hits: up to +20%, about four adjacent RRF ranks.
 * It breaks near-ties toward the record naming the identifier, never lifts a
 * weak match over a clearly stronger one.
 */
export const CODE_ANCHOR_BOOST = 0.1;
export const CODE_ANCHOR_MAX_HITS = 2;

export function codeAnchorBoost(relevance: number, codeHits: number): number {
  return relevance * (1 + CODE_ANCHOR_BOOST * Math.min(codeHits, CODE_ANCHOR_MAX_HITS));
}
