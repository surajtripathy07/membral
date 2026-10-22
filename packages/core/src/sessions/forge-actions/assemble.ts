import { redactPii, redactSecrets } from "../redact.js";
import { segmentAction } from "./gh-glab.js";
import type { Partial } from "./git.js";
import type { UrlRef } from "./refs.js";
import { parseForgeUrl, withKnownHost } from "./refs.js";
import { ownResultUrls, substituteVars } from "./repo.js";
import {
  BACKGROUND_RESULT,
  backgrounded,
  CLOSED_LINE,
  checkoutBranch,
  confirmPlainCheckout,
  FORGE_FAILED,
  GIT_FAILED,
  GLAB_CREATED_LINE,
  MERGE_PENDING,
  MERGED_LINE,
  MR_URL_IN_RESULT,
  NOTHING_COMMITTED,
  parseCommitResults,
  parsePushResult,
  REOPENED_LINE,
  viewStates,
} from "./results.js";
import type { DirState } from "./segment-repo.js";
import {
  DIR_WORDS,
  foldAssignments,
  gitDirMove,
  hasCompound,
  moveDir,
  normalizeAbsolute,
  resolveTarget,
  settleRepo,
  silentSegment,
  trackForgeEnv,
} from "./segment-repo.js";
import { chainSegments, programAndArgs, shellWords } from "./shell.js";
import type { ForgeAction, ForgeActionSource } from "./types.js";

const MAX_REF_CHARS = 200;
const MAX_URL_CHARS = 500;
export const MAX_SUBJECT_CHARS = 200;
const MAX_TITLE_CHARS = 200;
const MAX_SKILL_CHARS = 80;
const MAX_STATE_CHARS = 20;
const MAX_SHA_CHARS = 40;

// --- assembling a Bash turn's actions ---------------------------------------

export function cap(s: string | undefined, max: number): string | undefined {
  if (typeof s !== "string") return undefined;
  const r = redactSecrets(s).trim();
  return r ? r.slice(0, max) : undefined;
}

export function finish(
  p: Partial & { sha?: string; subject?: string; skill?: string },
  source: ForgeActionSource,
): ForgeAction {
  const a: ForgeAction = { verb: p.verb, source };
  const ref = cap(p.ref, MAX_REF_CHARS);
  if (ref) a.ref = ref;
  if (p.refKind) a.refKind = p.refKind;
  const sha = cap(p.sha, MAX_SHA_CHARS);
  if (sha) a.sha = sha;
  const url = cap(p.url, MAX_URL_CHARS);
  if (url) a.url = url;
  const state = cap(p.state, MAX_STATE_CHARS);
  if (state) a.state = state;
  const branch = cap(p.branch, MAX_REF_CHARS);
  if (branch) a.branch = branch;
  // The subject is the one free-form field kept (B10); emails and phone numbers never are.
  const subject = cap(typeof p.subject === "string" ? redactPii(p.subject) : undefined, MAX_SUBJECT_CHARS);
  if (subject) a.subject = subject;
  // A title is the same kind of free-form field as a subject — same redaction, same cap.
  const title = cap(typeof p.title === "string" ? redactPii(p.title) : undefined, MAX_TITLE_CHARS);
  if (title) a.title = title;
  const skill = cap(p.skill, MAX_SKILL_CHARS);
  if (skill) a.skill = skill;
  if (p.branchConfirmed) a.branchConfirmed = true;
  if (p.repoUnknown) a.repoUnknown = true;
  if (p.dir !== undefined) a.dir = p.dir;
  if (p.shownRepo) a.shownRepo = p.shownRepo;
  return a;
}

/** `gh pr merge …` / `glab mr merge …`, with or without an auto-merge flag. */
function isMergeCommand(segment: string): boolean {
  const pa = programAndArgs(shellWords(segment));
  if (!pa || (pa.program !== "gh" && pa.program !== "glab")) return false;
  const [resource, action] = pa.args;
  return (
    action === "merge" &&
    (resource === "pr" ||
      resource === "prs" ||
      resource === "pull-request" ||
      resource === "mr" ||
      resource === "merge-request")
  );
}

/**
 * Each `merged` action's own output block when a call ran several merge commands.
 * Merge outcome lines (an affirmative merge or a pending/auto-merge line) tie to the
 * merge commands in order when their counts agree; a block then runs from just after
 * the previous outcome line through its own. When they do not tie, only the call's
 * last merge gets a block: the output from the last outcome line on. One merge
 * command alone keeps the whole-output rule (no entry).
 */
function mergeOutputBlocks(mergeSegs: Array<Partial | null>, result: string): Map<Partial, string> {
  const blocks = new Map<Partial, string>();
  if (mergeSegs.length < 2) return blocks;
  const lines = result.split("\n");
  const outcomes: number[] = [];
  lines.forEach((l, i) => {
    if (MERGED_LINE.test(l) || MERGE_PENDING.test(l)) outcomes.push(i);
  });
  if (outcomes.length === mergeSegs.length) {
    mergeSegs.forEach((p, k) => {
      if (p) blocks.set(p, lines.slice(k === 0 ? 0 : outcomes[k - 1] + 1, outcomes[k] + 1).join("\n"));
    });
    return blocks;
  }
  // Untied: no earlier merge can be proven by a sibling's outcome line — empty block, unproven.
  mergeSegs.slice(0, -1).forEach((p) => {
    if (p) blocks.set(p, "");
  });
  const last = mergeSegs[mergeSegs.length - 1];
  if (last) blocks.set(last, outcomes.length > 0 ? lines.slice(outcomes[outcomes.length - 1]).join("\n") : "");
  return blocks;
}

/**
 * The URL of the item an `mr create` / `pr create` made: only a merge/pull request URL.
 * glab prints `!N title (branch)` above it, so the first such URL numbered N after that
 * line wins. Otherwise the last one, when the create printed last; with later output
 * after it, only a single unambiguous URL.
 */
function createdItemUrl(result: string, sharedTail: boolean): string | undefined {
  const glab = /^!(\d+)\s.*\([^()\s]+\)\s*$/m.exec(result);
  const urls = [...result.matchAll(MR_URL_IN_RESULT)];
  if (glab) {
    const after = urls.find((m) => (m.index ?? 0) > glab.index && m[1] === glab[1]);
    if (after) return after[0];
  }
  if (urls.length === 0) return undefined;
  if (!sharedTail) return urls[urls.length - 1][0];
  return new Set(urls.map((m) => m[0])).size === 1 ? urls[0][0] : undefined;
}

export function bashActions(
  command: string,
  result: string | undefined,
  isError: boolean,
  inBackground = false,
  cwd?: string,
): ForgeAction[] {
  type Pending = Partial & {
    sha?: string;
    subject?: string;
    exitShown?: boolean;
    sharedTail?: boolean;
    otherOutput?: boolean;
  };
  const pending: Pending[] = [];
  const segs = chainSegments(command);
  // Every merge command in order (an auto-merge one has no action), for per-block attribution.
  const mergeSegs: Array<Pending | null> = [];
  // F1: where each segment ran — the call's own cwd, moved by each literal `cd`/`pushd`/`popd`.
  // With no cwd recorded and no absolute move, segments carry no `dir` (the legacy reading).
  const start = cwd ? normalizeAbsolute(cwd) : null;
  const where: DirState = { dir: start ?? undefined, lost: false, stack: [] };
  // S2: inside a subshell, brace group, loop or conditional a directory change has a scope this
  // parser does not follow — any `cd`/`pushd`/`popd` in such a command loses the directory.
  const compound = hasCompound(segs);
  const vars = new Map<string, string>();
  const blocked = new Set<string>();
  const env = new Map<string, string | null>();
  segs.forEach((seg, i) => {
    const words = substituteVars(shellWords(seg.text), vars);
    foldAssignments(words, vars, blocked);
    trackForgeEnv(words, env);
    const pa = programAndArgs(words[0] === "builtin" ? words.slice(1) : words);
    if (pa && DIR_WORDS.has(pa.program) && !compound) {
      moveDir(where, pa.program, pa.args);
      return;
    }
    // A directory word anywhere else (`{ cd x`, `do cd x`, `xargs cd`) is a move this parser cannot place.
    if (words.some((w) => DIR_WORDS.has(w.replace(/^[({]+/, "")))) where.lost = true;
    const a = segmentAction(seg.text, vars, env) as Pending | null;
    if (isMergeCommand(seg.text)) mergeSegs.push(a?.verb === "merged" ? a : null);
    if (!a) return;
    const gitMove = pa?.program === "git" ? gitDirMove(pa.args) : { moved: false };
    if (gitMove.moved) {
      const next = gitMove.target === undefined ? null : resolveTarget(gitMove.target, where);
      if (next === null || next.dir === undefined) a.dirLost = true;
      else a.dir = next.dir;
    } else if (where.lost) a.dirLost = true;
    else if (where.dir !== undefined) a.dir = where.dir;
    // The call's exit status is this segment's own when it always runs (not after `||`)
    // and only `&&` follows it: a clean exit then proves the segment succeeded.
    // A backgrounded segment (`… &`, or the call's `run_in_background`) has not exited at all.
    a.exitShown =
      !inBackground &&
      !backgrounded(seg.text) &&
      seg.before !== "||" &&
      segs.slice(i).every((s) => s.after === null || s.after === "&&");
    // A later segment not piped from this one prints its own output after this one's.
    a.sharedTail = segs.slice(i + 1).some((s) => s.before !== "|");
    // R3-B1: any other segment, before or after, that may print makes no output line provably this one's.
    a.otherOutput = segs.some((s, j) => j !== i && !silentSegment(s.text));
    pending.push(a);
  });

  // The result only ENRICHES (or disproves) what the command's own segments
  // asked for: a `[branch sha]` line fills a commit, a `->` line fills a push,
  // a URL fills a create. It never adds an action — a `git pull`, a `git
  // fetch --prune` or a `cat` of a file that happens to print those shapes
  // proves nothing was delivered (F1).
  if (result !== undefined) {
    const commits = parseCommitResults(result);
    for (const p of pending) {
      if (commits.length === 0) break;
      if (p.refKind !== "commit" || p.sha || (p.verb !== "committed" && p.verb !== "rewrote")) continue;
      const c = commits.shift();
      if (!c) break;
      p.sha = c.sha;
      p.branch = c.branch;
      // `commit --amend` prints the same line: the new sha belongs to the rewrite, not a fresh
      // delivery, and its subject is the amended commit's — never the command text (C-7).
      p.subject = c.subject;
      p.proven = true;
    }

    const pushes = pending.filter((p) => p.fromPush);
    if (pushes.length > 0) {
      const push = parsePushResult(result);
      const del = pushes.find((p) => p.verb === "closed");
      if (push.deleted && del) {
        del.proven = true;
        del.ref = del.ref ?? push.deleted;
        del.branch = del.branch ?? push.deleted;
      }
      if (push.pushed) {
        const target = pushes.find((p) => p.verb === "pushed" || p.verb === "rewrote");
        if (target) {
          target.proven = true;
          if (push.branch) {
            target.branch = push.branch;
            if (target.verb === "pushed") target.ref = push.branch;
          }
        }
      } else if (push.rejected) {
        // The result itself disproves the push (`! [rejected]`, `failed to push`)
        // even when the harness did not flag the call as an error.
        for (let i = pending.length - 1; i >= 0; i--) {
          const p = pending[i];
          if (p.fromPush && (p.verb === "pushed" || p.verb === "rewrote") && !p.proven) pending.splice(i, 1);
        }
      }
    }

    const created = pending.find((p) => p.verb === "opened_mr");
    if (created) {
      const url = createdItemUrl(result, created.sharedTail === true);
      const parsed = url ? parseForgeUrl(url) : null;
      if (parsed?.ref) {
        created.url = parsed.url;
        created.ref = parsed.ref;
        created.refKind = parsed.refKind;
        created.proven = true;
      }
      // glab prints `!17201 <title> (<source branch>)` above the URL.
      created.branch = created.branch ?? GLAB_CREATED_LINE.exec(result)?.[1];
      // `git push -u origin feat && gh pr create …`: the MR's head is the branch just pushed.
      if (!created.branch) {
        const idx = pending.indexOf(created);
        const push = pending.slice(0, idx).find((p) => p.verb === "pushed" && p.proven && p.branch);
        if (push) created.branch = push.branch;
      }
    }
    // An issue create names its item only through its OWN result line (the URL fallback's rule,
    // R2-S1): one issue URL there, and no other segment that may print. Otherwise it is dropped.
    for (const p of pending) {
      if (p.verb !== "opened" || p.otherOutput) continue;
      const found = new Map<string, UrlRef>();
      for (const raw of ownResultUrls(result, false)) {
        const u = parseForgeUrl(raw);
        if (u?.ref && u.refKind === "issue") found.set(u.url.toLowerCase(), u);
      }
      if (found.size !== 1) continue;
      const [u] = [...found.values()];
      p.ref = u.ref;
      p.url = u.url;
      p.proven = true;
    }
    viewStates(pending, result);
    checkoutBranch(pending, result);
    // A clean exit the call reports as this segment's own, with no failure or
    // "queued" text in the output. gh prints nothing on a non-TTY merge (B1).
    const cleanExit = (p: Pending) =>
      !isError &&
      p.exitShown === true &&
      !BACKGROUND_RESULT.test(result) &&
      !MERGE_PENDING.test(result) &&
      !FORGE_FAILED.test(result);
    const mergeBlocks = mergeOutputBlocks(mergeSegs, result);
    for (const p of pending) {
      // An affirmative merge line, or a clean exit of a non-auto merge; auto-merge queued is not a merge (F4).
      // With several merge commands in one call, a pending/failure line is judged against the
      // output block of the merge that printed it, never the whole output (Q2).
      const own = p.verb === "merged" ? mergeBlocks.get(p) : undefined;
      if (
        p.verb === "merged" &&
        (own !== undefined
          ? MERGED_LINE.test(own) && !MERGE_PENDING.test(own) && !FORGE_FAILED.test(own)
          : !MERGE_PENDING.test(result) && (MERGED_LINE.test(result) || cleanExit(p)))
      ) {
        p.state = "merged";
        p.proven = true;
      }
      if (p.verb === "closed" && p.refKind !== "branch" && CLOSED_LINE.test(result)) {
        p.state = "closed";
        p.proven = true;
      }
      if (p.verb === "reopened" && (REOPENED_LINE.test(result) || cleanExit(p))) {
        p.state = "opened";
        p.proven = true;
      }
    }
  }

  confirmPlainCheckout(pending, result);
  for (const p of pending) {
    settleRepo(p, result);
    withKnownHost(p, result);
  }

  const kept = pending.filter((p) => {
    // A failed tool call did not observably do anything the result does not itself prove.
    if (isError && !p.proven) return false;
    // A commit counts when its call returned without error — even `git commit -q`,
    // which prints no sha — but not when it never returned (no result), recorded
    // nothing (`nothing to commit`), or printed a git failure (F2).
    if (p.verb === "committed" && !p.proven) {
      if (result === undefined) return false;
      if (NOTHING_COMMITTED.test(result) || GIT_FAILED.test(result)) return false;
    }
    // An issue create counts only once its own result line named the new issue.
    if (p.verb === "opened" && !p.proven) return false;
    // Merge, close and reopen of a forge item need the forge's own confirmation (F4).
    if ((p.verb === "merged" || p.verb === "reopened" || (p.verb === "closed" && p.refKind !== "branch")) && !p.proven)
      return false;
    return true;
  });
  return kept.map((p) => finish(p, "cli"));
}
