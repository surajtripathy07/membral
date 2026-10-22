import { redactPii } from "../redact.js";
import { cap, MAX_SUBJECT_CHARS } from "./assemble.js";
import { positionals } from "./git.js";
import { programAndArgs, shellWords, splitShellChain } from "./shell.js";
import type { ForgeAction, ToolActionInput } from "./types.js";

// --- sha for a quiet commit (F2) ------------------------------------------

// git subcommands that move HEAD: after one, an earlier sha-less commit is no
// longer what `rev-parse HEAD` prints.
const HEAD_MOVING = new Set([
  "commit",
  "cherry-pick",
  "revert",
  "merge",
  "rebase",
  "reset",
  "checkout",
  "switch",
  "pull",
  "am",
  "filter-repo",
]);
const COMMIT_CLASS = new Set(["commit", "cherry-pick", "revert", "merge"]);
// `git log` flags that make its first line something other than HEAD.
const LOG_NOT_HEAD =
  /^(--all|--branches|--remotes|--tags|--glob|--author|--committer|--grep|--reverse|--since|--until|--after|--before|--first-parent|--merges|--no-merges|-S|-G|--walk-reflogs|-g)/;
const SHA_ONLY_LINE = /^[0-9a-f]{7,40}$/;
const LOG_FIRST_LINE = /^(?:\*\s+)?(?:commit\s+)?([0-9a-f]{7,40})\b/;
// `git log` header lines that precede the subject in the default (non-oneline) format.
const LOG_HEADER_LINE = /^[A-Za-z][\w-]*:\s/;

/**
 * The commit subject `git log` printed alongside the sha, when unambiguous
 * (A-B6): oneline (`<sha> [(refs)] subject`) or default format (`commit
 * <sha>` header lines, then the indented subject line) — never guessed from
 * anything else.
 */
function logSubjectFromLines(firstLine: string, lines: string[]): string | undefined {
  if (/^(?:\*\s+)?commit\s+[0-9a-f]{7,40}\b/i.test(firstLine)) {
    for (const line of lines.slice(1)) {
      if (LOG_HEADER_LINE.test(line)) continue;
      return line || undefined;
    }
    return undefined;
  }
  const rest = firstLine
    .replace(/^(?:\*\s+)?[0-9a-f]{7,40}\b/i, "")
    .replace(/^\s*\([^)]*\)/, "")
    .trim();
  return rest || undefined;
}

interface GitSeg {
  sub?: string;
  rest: string[];
  repo: string;
  program: string;
}

function gitSegments(command: string): GitSeg[] {
  const out: GitSeg[] = [];
  let cdRepo = "";
  for (const segment of splitShellChain(command)) {
    const pa = programAndArgs(shellWords(segment));
    if (!pa) continue;
    if (pa.program === "cd") {
      cdRepo = pa.args[0] ?? "";
      out.push({ program: "cd", rest: pa.args, repo: cdRepo });
      continue;
    }
    if (pa.program !== "git") {
      out.push({ program: pa.program, rest: pa.args, repo: cdRepo });
      continue;
    }
    let i = 0;
    let repo = cdRepo;
    while (i < pa.args.length && pa.args[i].startsWith("-")) {
      if (pa.args[i] === "-C") repo = pa.args[i + 1] ?? repo;
      if (pa.args[i] === "-C" || pa.args[i] === "-c") i += 2;
      else i++;
    }
    out.push({ program: "git", sub: pa.args[i], rest: pa.args.slice(i + 1), repo });
  }
  return out;
}

/** The sha (and, for `git log`, the subject) a trailing `git rev-parse HEAD` / `git log` (of HEAD) printed, when the chain shape makes it unambiguous. */
function headShaFromQuery(segs: GitSeg[], result: string): { sha: string; subject?: string } | undefined {
  // Allow `| head -N` after the query.
  let last = segs.length - 1;
  while (last >= 0 && segs[last].program === "head") last--;
  const q = segs[last];
  if (!q || q.program !== "git") return undefined;
  const pos = positionals(q.rest);
  const lines = result
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (q.sub === "rev-parse") {
    if (pos.length !== 1 || pos[0] !== "HEAD") return undefined;
    if (!q.rest.every((a) => a === "HEAD" || /^(--short(=\d+)?|--verify|-q|--quiet)$/.test(a))) return undefined;
    const tail = lines[lines.length - 1];
    return tail && SHA_ONLY_LINE.test(tail) ? { sha: tail.toLowerCase() } : undefined;
  }
  if (q.sub === "log") {
    if (q.rest.includes("--") || pos.some((a) => a !== "HEAD") || q.rest.some((a) => LOG_NOT_HEAD.test(a)))
      return undefined;
    // The log's first line must be the first line of output: everything before it prints nothing.
    const silent = segs
      .slice(0, last)
      .every(
        (g) =>
          g.program === "cd" ||
          (g.program === "git" &&
            (g.sub === "add" || (g.sub === "commit" && g.rest.some((a) => a === "-q" || a === "--quiet")))),
      );
    if (!silent) return undefined;
    const m = lines[0] ? LOG_FIRST_LINE.exec(lines[0]) : null;
    if (!m) return undefined;
    return { sha: m[1].toLowerCase(), subject: logSubjectFromLines(lines[0], lines) };
  }
  return undefined;
}

/**
 * Session-scoped helper: `git commit -q` prints no sha, so its `committed`
 * action starts sha-less. When a LATER call in the same session (or later in
 * the same chain) is `git rev-parse HEAD` or `git log` of HEAD and its result
 * shows a sha, that sha is attached to the most recent sha-less commit in the
 * same repo — provided nothing moved HEAD in between. Otherwise the sha stays
 * unset. Feed it every Bash call whose result arrived, with the actions the
 * turn now carries (they are mutated in place).
 *
 * It also gives an `opened_mr` with no head branch of its own the branch the
 * session last pushed, unless a checkout/switch to a branch came in between
 * (B5); with no such push the branch stays unset.
 */
export function createCommitShaBackfill(): { observe(call: ToolActionInput, actions: ForgeAction[]): void } {
  const waiting = new Map<string, ForgeAction>();
  // B5: the branch this session last pushed, and the repo (the `cd`/`-C` directory) it was pushed
  // from; an MR created later without `--head` in that same repo is that branch's.
  let lastPushed: { branch: string; repo: string } | undefined;
  // The shell's directory as the session's `cd`s left it ("" = where it started).
  let cwd = "";
  return {
    observe(call, actions) {
      try {
        const bash = call.toolName.toLowerCase() === "bash";
        const command = bash && typeof call.input?.command === "string" ? call.input.command : "";
        const allSegs = command ? gitSegments(command) : [];
        const at = (g: GitSeg | undefined) => (g?.repo ? g.repo : cwd);
        const pushRepo = at([...allSegs].reverse().find((g) => g.program === "git" && g.sub === "push"));
        const createRepo = at(
          allSegs.find((g) => (g.program === "gh" || g.program === "glab") && g.rest.includes("create")),
        );
        for (const a of actions) {
          if (a.verb === "pushed" && a.branch) lastPushed = { branch: a.branch, repo: pushRepo };
          else if (a.verb === "navigated" && a.refKind === "branch") lastPushed = undefined;
          else if (a.verb === "opened_mr" && !a.branch && lastPushed && lastPushed.repo === createRepo)
            a.branch = lastPushed.branch;
        }
        const lastCd = [...allSegs].reverse().find((g) => g.program === "cd");
        if (lastCd) cwd = lastCd.repo;
        if (!bash) return;
        if (!command || typeof call.result !== "string") return;
        const segs = allSegs;
        // A-B6: an amend (`rewrote`, refKind commit) is a quiet commit just like a
        // plain `commit -q` — it also gets its sha (and subject) from a later HEAD
        // query, so the newest sha replaces the stale one instead of staying null.
        const commits = actions.filter(
          (a) => (a.verb === "committed" || a.verb === "rewrote") && a.refKind === "commit",
        );
        const commitSegs = segs.filter((g) => g.program === "git" && g.sub !== undefined && COMMIT_CLASS.has(g.sub));
        const aligned = commits.length === commitSegs.length;
        let c = 0;
        for (const g of segs) {
          if (g.program !== "git" || !g.sub || !HEAD_MOVING.has(g.sub)) continue;
          waiting.delete(g.repo);
          if (!COMMIT_CLASS.has(g.sub)) continue;
          const action = aligned ? commits[c++] : undefined;
          if (action && !action.sha) waiting.set(g.repo, action);
        }
        if (call.isError === true) return;
        const head = headShaFromQuery(segs, call.result);
        if (!head) return;
        const lastGit = [...segs].reverse().find((g) => g.program === "git");
        const repo = lastGit?.repo ?? "";
        const target = waiting.get(repo);
        if (target) {
          target.sha = head.sha;
          // Never the command text (B10/A-B6): only a subject `git log` itself
          // printed fills a gap, and it never overwrites one already known —
          // redacted and capped the same way a same-result subject is (B10).
          if (head.subject && !target.subject) {
            const subject = cap(redactPii(head.subject), MAX_SUBJECT_CHARS);
            if (subject) target.subject = subject;
          }
          waiting.delete(repo);
        }
      } catch {
        // B12 — degrade, never fail.
      }
    },
  };
}
