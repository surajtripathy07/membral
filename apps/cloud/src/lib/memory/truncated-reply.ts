// Issue #339: salvage for an extraction reply the model was cut off in the
// middle of (finish_reason "length"). The reply is a JSON object such as
// {"records": [{...}, {...}, {...  and the cut leaves it unparseable. The
// elements of an array that were closed BEFORE the cut are still whole JSON,
// so this walks the text (tracking string, escape and nesting state; never a
// regex) and returns them. The partial last element is discarded.
//
// Pure and total: never throws, whatever the input. The caller validates every
// returned element exactly as it would a normal reply (CLAUDE.md rule 3).

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWhitespace(text[i])) i++;
  return i;
}

/**
 * Index of the `[` that opens the value of `key` in the top-level object, or
 * -1 when the key is absent, is not an array, or was cut before its `[`.
 * Only keys directly inside the top-level object count (depth 1).
 */
function findTopLevelArray(text: string, key: string): number {
  let i = skipWhitespace(text, 0);
  if (text[i] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  // The last string closed at depth 1, as [start, end) including its quotes.
  let lastString: [number, number] | null = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        if (depth === 1) lastString = [stringStart, i + 1];
      }
      continue;
    }
    if (isWhitespace(ch)) continue;
    if (ch === '"') {
      inString = true;
      stringStart = i;
      continue;
    }
    if (ch === ":" && depth === 1 && lastString !== null) {
      let name: unknown = null;
      try {
        name = JSON.parse(text.slice(lastString[0], lastString[1]));
      } catch {
        name = null;
      }
      lastString = null;
      const valueAt = skipWhitespace(text, i + 1);
      if (name === key && text[valueAt] === "[") return valueAt;
      continue;
    }
    lastString = null;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth <= 0) return -1;
    }
  }
  return -1;
}

function tryParse(slice: string, out: unknown[]): void {
  try {
    out.push(JSON.parse(slice));
  } catch {
    // Not whole JSON: dropped, like any element the model got wrong.
  }
}

interface ArrayScan {
  /** Complete, well-formed elements, in order. */
  out: unknown[];
  /** Start index of the element left unfinished at the end of the text, or -1. */
  unfinishedStart: number;
  /** True when the array's own closing `]` was seen before the text ended. */
  closed: boolean;
}

/** Walks the array whose `[` is at `open`; the one scanner behind salvage and describe. */
function scanArray(text: string, open: number): ArrayScan {
  const out: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth > 0) {
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          tryParse(text.slice(start, i + 1), out);
          start = -1;
        }
      }
      continue;
    }
    // depth 0: between elements of the target array.
    if (isWhitespace(ch)) continue;
    if (ch === "," || ch === "]") {
      // A string or primitive element ends here; an object/array already did.
      if (start >= 0) tryParse(text.slice(start, i).trim(), out);
      start = -1;
      if (ch === "]") return { out, unfinishedStart: -1, closed: true };
      continue;
    }
    if (ch === "}") return { out, unfinishedStart: -1, closed: false };
    if (start < 0) start = i;
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
  }
  return { out, unfinishedStart: start, closed: false };
}

/**
 * The complete, well-formed elements of the array under top-level `key` in a
 * possibly truncated JSON object, in order. An element counts only when it
 * closed before the cut (an object or array whose bracket closed, or a string
 * or primitive followed by `,` or `]`). Returns [] for no such array, garbage,
 * or an empty string. Never throws.
 */
export function salvageArrayElements(text: string, key: string): unknown[] {
  try {
    if (typeof text !== "string" || typeof key !== "string") return [];
    const open = findTopLevelArray(text, key);
    if (open < 0) return [];
    return scanArray(text, open).out;
  } catch {
    return [];
  }
}

/**
 * True when the array under top-level `key` was closed (its matching `]` seen)
 * before the text ended, so it is complete even when empty. False for a cut
 * inside the array, an absent key, or garbage. Never throws.
 */
export function isArrayClosed(text: string, key: string): boolean {
  try {
    if (typeof text !== "string" || typeof key !== "string") return false;
    const open = findTopLevelArray(text, key);
    if (open < 0) return false;
    return scanArray(text, open).closed;
  } catch {
    return false;
  }
}

export type FirstCharClass =
  | "brace"
  | "bracket"
  | "fence"
  | "quote"
  | "letter"
  | "digit"
  | "whitespace_only"
  | "other"
  | "empty";

/** Issue #339: the structural shape of a cut-off reply. Numbers, booleans and a fixed enum only: no text. */
export interface TruncatedReplyShape {
  chars: number;
  firstCharClass: FirstCharClass;
  hasRecordsKey: boolean;
  /** The array's closing `]` was seen before the cut. */
  arrayClosed: boolean;
  completeElements: number;
  depthAtCut: number;
  inStringAtCut: boolean;
  lastElementChars: number;
}

const EMPTY_SHAPE: TruncatedReplyShape = {
  chars: 0,
  firstCharClass: "empty",
  hasRecordsKey: false,
  arrayClosed: false,
  completeElements: 0,
  depthAtCut: 0,
  inStringAtCut: false,
  lastElementChars: 0,
};

function classifyFirstChar(text: string): FirstCharClass {
  if (text.length === 0) return "empty";
  const at = skipWhitespace(text, 0);
  if (at >= text.length) return "whitespace_only";
  if (text.startsWith("```", at)) return "fence";
  const ch = text[at];
  if (ch === "{") return "brace";
  if (ch === "[") return "bracket";
  if (ch === '"') return "quote";
  if (/[A-Za-z]/.test(ch)) return "letter";
  if (/[0-9]/.test(ch)) return "digit";
  return "other";
}

/**
 * Nesting depth and string state where the text ended, counted from the first
 * `{` or `[` anywhere in it (so a fence or leading prose does not count).
 */
function endState(text: string): { depth: number; inString: boolean } {
  let first = 0;
  while (first < text.length && text[first] !== "{" && text[first] !== "[") first++;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if ((ch === "}" || ch === "]") && depth > 0) depth--;
  }
  return { depth, inString };
}

/**
 * Issue #339 debugging: the structure of a cut-off reply, with no text in it.
 * `completeElements` comes from the same scanner as `salvageArrayElements`, so
 * the two cannot disagree. Never throws.
 */
export function describeTruncatedReply(text: string, key: string): TruncatedReplyShape {
  try {
    if (typeof text !== "string") return { ...EMPTY_SHAPE };
    const { depth, inString } = endState(text);
    const open = typeof key === "string" ? findTopLevelArray(text, key) : -1;
    const scan = open >= 0 ? scanArray(text, open) : null;
    return {
      chars: text.length,
      firstCharClass: classifyFirstChar(text),
      hasRecordsKey: open >= 0,
      arrayClosed: scan ? scan.closed : false,
      completeElements: scan ? scan.out.length : 0,
      depthAtCut: depth,
      inStringAtCut: inString,
      lastElementChars: scan && scan.unfinishedStart >= 0 ? text.length - scan.unfinishedStart : 0,
    };
  } catch {
    return { ...EMPTY_SHAPE };
  }
}
