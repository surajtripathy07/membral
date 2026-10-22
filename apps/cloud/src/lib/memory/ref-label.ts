/**
 * W3 D5/D10: the ONE way an issue or MR reference is rendered for an agent —
 * the SessionStart preamble's "Seen in the last 7 days" section (preamble.ts,
 * current-work.ts) and memory_search's compact record (mcp/served-record-view.ts).
 *
 * - `refLabel`: `#123 Title` when a title is known, else `#123`; the title is
 *   cut at REF_TITLE_DISPLAY_MAX characters with an ellipsis.
 * - `issueLinkPhrase`: the MR→issue link of D-071 with its basis, never as
 *   fact: `stated` → "for #12", `inferred` → "probably for #12".
 *
 * Pure; no I/O.
 */
import { canonicalItemRef, HOSTLIKE } from "@/lib/code-sessions/ref-canon";

/** Titles are kept short on every surface (D5 brief: ~60 chars). */
export const REF_TITLE_DISPLAY_MAX = 60;

const MARKED = /^(.*?)([#!])(\d+)$/;
const GITHUB_URL = /^https?:\/\/(?:[\w-]+\.)*github\.[a-z]+\//i;

/** Host-stripped, lower-cased `owner/repo` of a project identity or a ref prefix (`""` when none). */
function repoPath(x: string): string {
  const segs = x
    .trim()
    .replace(/^https?:\/\//i, "")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  if (segs.length >= 3 && HOSTLIKE.test(segs[0])) segs.shift();
  return segs.join("/");
}

/**
 * The short token of a stored ref spelling: `#N` / `!N` when the ref names
 * `ownProject`'s repo (or no repo, or `ownProject` is unknown), else
 * `owner/repo#N` so an item of another repo never passes for this one's.
 * An item URL becomes `#N` (`!N` for a merge request off GitHub) by the same
 * rule. A spelling that is not ref syntax is returned trimmed.
 */
export function shortRefToken(ref: string, ownProject?: string | null): string {
  const t = ref.trim().replace(/[.,;:)\]]+$/, "");
  let prefix: string;
  let mark: string;
  let num: number;
  const m = MARKED.exec(t);
  if (m) {
    prefix = m[1].replace(/\/+$/, "");
    mark = m[2];
    num = Number(m[3]);
  } else {
    const c = /^https?:\/\//i.test(t) ? canonicalItemRef(t, null) : null;
    if (!c) return t;
    prefix = c.ref.slice(0, c.ref.lastIndexOf("#"));
    mark = c.kind === "merge_request" && !GITHUB_URL.test(t) ? "!" : "#";
    num = c.number;
  }
  const repo = prefix.includes("/") ? repoPath(prefix) : "";
  const other = !!repo && !!ownProject && repo !== repoPath(ownProject);
  return `${other ? repo : ""}${mark}${num}`;
}

function shortTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length <= REF_TITLE_DISPLAY_MAX ? t : `${t.slice(0, REF_TITLE_DISPLAY_MAX - 1).trimEnd()}…`;
}

/** `#123 Title` when `title` is non-empty, else `#123`. `token` is rendered as given (see `shortRefToken`). */
export function refLabel(token: string, title?: string | null): string {
  const t = title?.trim() ? shortTitle(title) : "";
  return t ? `${token} ${t}` : token;
}

export type RefIssueBasis = "stated" | "inferred";

/**
 * D-071: an MR's issue with its basis. `stated` → `for #12`; `inferred` →
 * `probably for #12`. Null when there is no issue or the basis is not one of
 * the two (an unlabelled link is never shown).
 */
export function issueLinkPhrase(
  issue: string | null | undefined,
  basis: string | null | undefined,
  ownProject?: string | null,
): string | null {
  if (!issue?.trim()) return null;
  const token = shortRefToken(issue, ownProject);
  if (basis === "stated") return `for ${token}`;
  if (basis === "inferred") return `probably for ${token}`;
  return null;
}
