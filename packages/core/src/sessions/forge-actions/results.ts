import type { Partial } from "./git.js";
import { parseForgeUrl } from "./refs.js";
import type { ForgeRefKind } from "./types.js";

// --- result parsing ------------------------------------------------------

// `[main abc1234] subject`, `[feature/x (root-commit) abc1234] subject`,
// `[detached HEAD abc1234] subject`.
const COMMIT_LINE = /^\[(.+?) ([0-9a-f]{7,40})\] ?(.*)$/gm;
// ` * [new branch]      15178-5 -> 15178-5`, `   abc1234..def5678  main -> main`,
// ` + abc1234...def5678 main -> main (forced update)`.
// A `! [rejected] main -> main (fetch first)` line has the same `->` shape but
// proves nothing was pushed — only `[new branch]`/`[new tag]`/`[up to date]`
// brackets and `old..new` ranges count. The `To <remote>` header alone proves
// nothing either: git prints it before a rejection too.
const PUSH_REF_LINE =
  /^\s*(?:[*+=\s-]\s+)?(?:\[(?!rejected|remote rejected)[^\]]+\]|[0-9a-f]+\.\.\.?[0-9a-f]+)\s+(\S+)\s+->\s+(\S+)/m;
const PUSH_REJECTED = /^\s*!\s+\[(?:rejected|remote rejected)\]|failed to push/m;
const PUSH_TRACKING_LINE = /^branch '([^']+)' set up to track/m;
const PUSH_DELETED_LINE = /^\s*-\s+\[deleted\]\s+(\S+)/m;
export const ITEM_URL_IN_RESULT = /https?:\/\/[^\s"'<>)\]]+\/(?:-\/)?(?:merge_requests|pull|issues)\/\d+/;
// Only a merge/pull request URL can be what an `mr create` / `pr create` made (never an issue URL a view printed).
export const MR_URL_IN_RESULT = /https?:\/\/[^\s"'<>)\]]+\/(?:-\/)?(?:merge_requests|pull)\/(\d+)/g;
export const WEB_URL_JSON = /"(?:web_url|html_url|url)"\s*:\s*"([^"]+)"/;
const STATE_JSON = /"state"\s*:\s*"([A-Za-z_]+)"/;
const STATE_FIELD = /^state:\s*([A-Za-z_]+)/im;
const STATE_HEADER = /^(open|opened|merged|closed|draft|locked)\s+[•·]/im;
const TITLE_FIELD = /^title:\s*(.+)$/m;
export const MCP_TITLE_JSON = /"title"\s*:\s*"([^"]+)"/;
// glab's `source_branch:  <branch>` text field; gh has no plain-text head field in
// current output, but an older/future `head:` line is tolerated the same way.
const VIEW_BRANCH_FIELD = /^(?:source_branch|Source branch):\s*(\S+)/im;
const VIEW_HEAD_FIELD = /^head:\s*(\S+)/im;
// `glab mr view --json` / glab-family MCP `get_merge_request`; `gh pr view --json headRefName`;
// GitHub MCP `get_pull_request`'s nested `head.ref`.
export const VIEW_BRANCH_JSON = /"source_branch"\s*:\s*"([^"]+)"/;
export const VIEW_HEAD_REF_NAME_JSON = /"headRefName"\s*:\s*"([^"]+)"/;
export const VIEW_HEAD_REF_NESTED_JSON = /"head"\s*:\s*\{[^}]*?"ref"\s*:\s*"([^"]+)"/;

const STATE_WORDS: Record<string, string> = {
  open: "opened",
  opened: "opened",
  merged: "merged",
  closed: "closed",
  locked: "locked",
  draft: "draft",
};

export function parseState(result: string): string | undefined {
  const m = STATE_JSON.exec(result) ?? STATE_FIELD.exec(result) ?? STATE_HEADER.exec(result);
  if (!m) return undefined;
  return STATE_WORDS[m[1].toLowerCase()];
}

interface ViewBlock {
  state?: string;
  number?: string;
  kind?: ForgeRefKind;
  title?: string;
  branch?: string;
}

// Fork signals (L1): a fork's head branch is not a branch of this repo, so it never maps to the MR.
const VIEW_CROSS_REPO_JSON = /"isCrossRepository"\s*:\s*true/;
const VIEW_HEAD_OWNER_JSON = /"headRepositoryOwner"\s*:\s*\{[^}]*?"login"\s*:\s*"([^"]+)"/;
const VIEW_REPO_OWNER_URL = /"url"\s*:\s*"https?:\/\/[^/"]+\/([^/"]+)\/[^/"]+\/pull\/\d+"/;
const VIEW_SOURCE_PROJECT_JSON = /"source_project_id"\s*:\s*(\d+)/;
const VIEW_TARGET_PROJECT_JSON = /"target_project_id"\s*:\s*(\d+)/;
const VIEW_HEAD_LABEL_JSON = /"head"\s*:\s*\{[^}]*?"label"\s*:\s*"([^":]+):/;
const VIEW_BASE_LABEL_JSON = /"base"\s*:\s*\{[^}]*?"label"\s*:\s*"([^":]+):/;

/** True when a view result shows the MR's head lives in a fork (another owner / project). */
function isForkView(text: string): boolean {
  if (VIEW_CROSS_REPO_JSON.test(text)) return true;
  const headOwner = VIEW_HEAD_OWNER_JSON.exec(text)?.[1];
  const repoOwner = VIEW_REPO_OWNER_URL.exec(text)?.[1];
  if (headOwner && repoOwner && headOwner.toLowerCase() !== repoOwner.toLowerCase()) return true;
  const src = VIEW_SOURCE_PROJECT_JSON.exec(text)?.[1];
  const tgt = VIEW_TARGET_PROJECT_JSON.exec(text)?.[1];
  if (src && tgt && src !== tgt) return true;
  const headLabel = VIEW_HEAD_LABEL_JSON.exec(text)?.[1];
  const baseLabel = VIEW_BASE_LABEL_JSON.exec(text)?.[1];
  return !!headLabel && !!baseLabel && headLabel.toLowerCase() !== baseLabel.toLowerCase();
}

/**
 * Source/head branch off a view result's text field, JSON field, or glab's `(branch)` header line.
 * None for a fork's head (L1): that branch name belongs to another repo.
 */
function branchFromViewText(text: string): string | undefined {
  if (isForkView(text)) return undefined;
  return (
    VIEW_BRANCH_FIELD.exec(text)?.[1] ??
    viewHeadBranch(VIEW_HEAD_FIELD.exec(text)?.[1]) ??
    VIEW_BRANCH_JSON.exec(text)?.[1] ??
    VIEW_HEAD_REF_NAME_JSON.exec(text)?.[1] ??
    VIEW_HEAD_REF_NESTED_JSON.exec(text)?.[1] ??
    GLAB_CREATED_LINE.exec(text)?.[1]
  );
}

const VIEW_BLOCK_TITLE = /^title:\s/;
const VIEW_TTY_HEADER = /\s([#!])(\d+)\s*$/;
const VIEW_NUMBER_FIELD = /^number:\s*(\d+)\s*$/m;
const VIEW_URL_FIELD = /^url:\s*(\S+)/m;

/**
 * The item blocks of a view result, each with the item it names: gh's non-TTY
 * `title:\t…` block (`number:\tN`, `url:` for PRs), glab's `title: …` block
 * (`url: …`), or gh's TTY header `Title #N` directly above `Open • …`.
 */
function viewBlocks(result: string): ViewBlock[] {
  const lines = result.split("\n");
  const starts: Array<{ at: number; marker?: string; number?: string; headerTitle?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (VIEW_BLOCK_TITLE.test(lines[i])) {
      starts.push({ at: i });
      continue;
    }
    const h = VIEW_TTY_HEADER.exec(lines[i]);
    if (h && i + 1 < lines.length && STATE_HEADER.test(lines[i + 1]))
      starts.push({ at: i, marker: h[1], number: h[2], headerTitle: lines[i].slice(0, h.index).trim() });
  }
  return starts.map((st, k) => {
    const text = lines.slice(st.at, k + 1 < starts.length ? starts[k + 1].at : lines.length).join("\n");
    const b: ViewBlock = {
      state: parseState(text),
      number: st.number,
      title: st.headerTitle ?? TITLE_FIELD.exec(text)?.[1]?.trim(),
      branch: branchFromViewText(text),
    };
    if (st.marker === "!") b.kind = "merge_request";
    const url = VIEW_URL_FIELD.exec(text);
    const parsed = url ? parseForgeUrl(url[1]) : null;
    if (parsed?.ref) {
      b.kind = parsed.refKind;
      b.number = /(\d+)$/.exec(parsed.ref)?.[1];
    }
    b.number = b.number ?? VIEW_NUMBER_FIELD.exec(text)?.[1];
    return b;
  });
}

/**
 * Fill `state`/`title`/`branch` on the call's `viewed` actions (B2, and the same
 * attribution reused for a result-borne title/branch). One viewed item: the
 * result's state/title/branch is its own. Several: each goes only to the one
 * segment whose item its output block names (number, and kind when the
 * block shows it); anything ambiguous gets neither.
 */
export function viewStates(pending: Array<Partial & { sharedTail?: boolean }>, result: string): void {
  const views = pending.filter((p) => p.verb === "viewed");
  if (views.length === 0) return;
  const items = new Set(views.map((v) => `${v.refKind ?? ""}\n${v.ref ?? ""}\n${v.branch ?? ""}\n${v.url ?? ""}`));
  if (items.size === 1) {
    const state = parseState(result);
    if (state) for (const v of views) v.state = state;
    const first = viewBlocks(result)[0];
    const title = first?.title ?? TITLE_FIELD.exec(result)?.[1]?.trim();
    if (title) for (const v of views) v.title = title;
    // Another command's output follows the view's (`gh issue view 7 && cat notes.md`): only the
    // view's own metadata header — the lines before its `--` body separator — can name a branch.
    const shared = views.some((v) => v.sharedTail);
    const own = shared ? viewHeader(result) : result;
    const branch =
      own === undefined ? undefined : shared ? branchFromViewText(own) : (first?.branch ?? branchFromViewText(own));
    if (branch) for (const v of views) if (!v.branch) v.branch = branch;
    return;
  }
  const foundState = new Map<Partial, string | null>();
  const foundTitle = new Map<Partial, string | null>();
  const foundBranch = new Map<Partial, string | null>();
  for (const b of viewBlocks(result)) {
    if (!b.number) continue;
    const matches = views.filter(
      (v) => v.ref !== undefined && /(\d+)$/.exec(v.ref)?.[1] === b.number && (!b.kind || b.kind === v.refKind),
    );
    if (matches.length !== 1) continue;
    const v = matches[0];
    if (b.state) foundState.set(v, foundState.has(v) ? null : b.state);
    if (b.title) foundTitle.set(v, foundTitle.has(v) ? null : b.title);
    if (b.branch) foundBranch.set(v, foundBranch.has(v) ? null : b.branch);
  }
  for (const [v, state] of foundState) if (state) v.state = state;
  for (const [v, title] of foundTitle) if (title) v.title = title;
  for (const [v, branch] of foundBranch) if (branch && !v.branch) v.branch = branch;
}

// git's own lines after a checkout (gh/glab run git): "Switched to (a new) branch 'x'", "Already on 'x'".
const SWITCHED_LINE = /^(?:Switched to (?:a new )?branch|Already on) '([^']+)'/gm;

/**
 * W5: the local branch `gh pr checkout N` / `glab mr checkout N` landed on, read from
 * git's own output. Only when the MR checkout is the call's one branch switch and the
 * output names exactly one branch; otherwise the branch stays unknown.
 */
export function checkoutBranch(pending: Array<Partial>, result: string): void {
  const switches = pending.filter(
    (p) =>
      (p.verb === "checked_out" && p.refKind === "merge_request") || (p.verb === "navigated" && p.refKind === "branch"),
  );
  if (switches.length !== 1) return;
  const co = switches[0];
  if (co.verb !== "checked_out" || co.branch) return;
  const names = new Set([...result.matchAll(SWITCHED_LINE)].map((m) => m[1]));
  if (names.size === 1) co.branch = [...names][0];
}

const SWITCHED_TO_LINE = /^Switched to (?:a new )?branch '([^']+)'/gm;

/**
 * W3 D9: a plain `git checkout <name>` / `git switch <name>` is confirmed a branch only when git's own
 * `Switched to [a new] branch '<name>'` line names it (otherwise the name may be a path or a sha).
 * Only adds `branchConfirmed`; `ref`/`branch` stay as parsed (D-055 lineage reads them).
 */
export function confirmPlainCheckout(pending: Array<Partial>, result: string | undefined): void {
  const names = new Set(result === undefined ? [] : [...result.matchAll(SWITCHED_TO_LINE)].map((m) => m[1]));
  for (const p of pending) if (p.plainCheckout && p.ref !== undefined && names.has(p.ref)) p.branchConfirmed = true;
}

/** A non-TTY view's metadata lines, up to the `--` line gh and glab print before the body; undefined without one. */
function viewHeader(result: string): string | undefined {
  const lines = result.split("\n");
  const sep = lines.findIndex((l) => l.trim() === "--");
  return sep === -1 ? undefined : lines.slice(0, sep).join("\n");
}

/** Every `[branch sha] subject` line, in output order. */
export function parseCommitResults(result: string): Array<{ sha: string; branch?: string; subject: string }> {
  const out: Array<{ sha: string; branch?: string; subject: string }> = [];
  for (const m of result.matchAll(COMMIT_LINE)) {
    const head = m[1].replace(/ \((?:root-commit|detached HEAD)\)$/, "");
    const branch = head === "detached HEAD" ? undefined : head;
    out.push({ sha: m[2].toLowerCase(), branch, subject: m[3] });
  }
  return out;
}

// A commit/merge that ran but recorded nothing, or a git failure printed
// without the harness flagging an error (`… || true`, `| tail`).
export const NOTHING_COMMITTED =
  /nothing to commit|nothing added to commit|no changes added to commit|^Already up[ -]to[ -]date|hook (?:failed|exited with (?:code|status) [1-9])/im;
export const GIT_FAILED = /^(?:fatal|error): /m;

// gh: `✓ Merged pull request #5`, `✓ Squashed and merged …`, `✓ Rebased and merged …`;
// glab: `✓ Merged`, `Merged merge request !17`.
export const MERGED_LINE = /^\s*(?:[✓✔]\s*)?(?:Squashed and merged|Rebased and merged|Merged)\b/im;
// Auto-merge / merge-when-pipeline-succeeds: the merge has not happened yet.
// A merge queue (gh's "added to the merge queue", "queued to merge") is also not a merge yet.
export const MERGE_PENDING =
  /will be (?:automatically )?merged|when (?:the )?pipeline succeeds|auto-?merge (?:is )?(?:enabled|set)|set to (?:auto-?)?merge|\bqueued?\b/i;
// `--disable-auto` only turns auto-merge off; it merges nothing.
export const AUTO_MERGE_FLAG =
  /^(--auto|--auto-merge|--disable-auto|--when-pipeline-succeeds|--merge-when-pipeline-succeeds)(=.*)?$/;
// Claude Code's result for a backgrounded Bash call: the command has not finished.
export const BACKGROUND_RESULT = /running in (?:the )?background|Command running in background/i;

/** The segment sends itself to the background (an unquoted `&` that is not `&&`, `|&` or a redirection). */
export function backgrounded(segment: string): boolean {
  const code = segment.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "").replace(/&&|\|&|[0-9]*>&[0-9-]*|&>>?|<&[0-9-]*/g, "");
  return code.includes("&");
}
// gh `✓ Closed pull request #5` / `✓ Closed issue #9`; glab `✓ Closed Merge request !17`.
export const CLOSED_LINE = /^\s*(?:[✓✔]\s*)?Closed\b/im;
// gh `✓ Reopened issue owner/repo#6 (title)`; glab `✓ Reopened Issue #6`.
export const REOPENED_LINE = /^\s*(?:[✓✔]\s*)?Reopened\b/im;
// Failure text gh/glab/git print even when a `|| true` or a pipe hides the exit code.
export const FORGE_FAILED =
  /^\s*(?:X|!|✗)\s|GraphQL:|not mergeable|^(?:error|fatal|failed)\b|could not|unable to|^Exit code [1-9]/im;
// glab mr create: `!17201 Some title (15178-debits)`.
export const GLAB_CREATED_LINE = /^!\d+\s.*\(([^()\s]+)\)\s*$/m;

export function parsePushResult(result: string): {
  pushed: boolean;
  rejected: boolean;
  branch?: string;
  deleted?: string;
} {
  const deleted = PUSH_DELETED_LINE.exec(result)?.[1];
  const ref = PUSH_REF_LINE.exec(result);
  const tracking = PUSH_TRACKING_LINE.exec(result);
  // Only a proven ref line or `Everything up-to-date` counts, and never when
  // the same result carries a rejection (a mixed result is not a delivery).
  const rejected = PUSH_REJECTED.test(result);
  const pushed = !rejected && (ref !== null || /^Everything up-to-date/m.test(result));
  const branch = ref?.[2] ?? tracking?.[1];
  return { pushed, rejected, branch: branch?.replace(/^refs\/heads\//, ""), deleted };
}

export function viewHeadBranch(value: string | undefined): string | undefined {
  return value && !value.includes(":") ? value : undefined;
}
