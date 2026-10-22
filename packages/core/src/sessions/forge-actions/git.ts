import type { ForgeRefKind, ForgeVerb } from "./types.js";

// --- git --------------------------------------------------------------------

const REWRITE_RESET_FLAGS = new Set(["--hard", "--soft", "--mixed", "--keep", "--merge"]);
const COMMITISH = /^(HEAD[~^]|[0-9a-f]{7,40}$|@\{)/i;
const FORCE_PUSH = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes)$/;
const SHORT_FLAG_WITH_F = /^-[a-zA-Z]*f[a-zA-Z]*$/;

export interface Partial {
  verb: ForgeVerb;
  refKind?: ForgeRefKind;
  ref?: string;
  branch?: string;
  url?: string;
  state?: string;
  /** Set when the result text itself proved the action (a sha line, a `->` line, an item URL). */
  proven?: boolean;
  /** Produced by a `git push` segment — the only kind a push result may enrich. */
  fromPush?: boolean;
  /** The item's title read off an unambiguously-attributed view result (gh/glab `title:`/TTY header, or an MCP `get_*`'s JSON `title`). */
  title?: string;
  /** `-R/--repo` was given but its value could not be read (an unresolved `$VAR`, a bare name). */
  repoUnread?: boolean;
  /** The directory the segment ran in (see ForgeAction.dir). */
  dir?: string;
  /** A directory change this parser could not follow came before the segment. */
  dirLost?: boolean;
  /** See ForgeAction.shownRepo. */
  shownRepo?: string;
  /** Final verdict: the repo is not observable (see ForgeAction.repoUnknown). */
  repoUnknown?: boolean;
  /** v3 item 6, step 1: the host `-R HOST/owner/repo` named. */
  repoHost?: string;
  /** v3 item 6, step 4: the forge CLI's default host (gh: github.com unless GH_HOST; glab: GITLAB_HOST). */
  toolHost?: string;
  /**
   * W3 D9: a plain `git checkout|switch <name>` — the name may be a path or a sha. It names a branch only
   * when the result's `Switched to [a new] branch '<name>'` line says so (`confirmPlainCheckout`).
   */
  plainCheckout?: boolean;
  /** See ForgeAction.branchConfirmed. */
  branchConfirmed?: boolean;
}

export function positionals(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

export function gitAction(args: string[]): Partial | null {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C" || args[i] === "-c") i += 2;
    else i++;
  }
  const sub = args[i];
  if (!sub) return null;
  const rest = args.slice(i + 1);
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a));
  const pos = positionals(rest);

  switch (sub) {
    case "commit":
      return has("--amend") ? { verb: "rewrote", refKind: "commit" } : { verb: "committed", refKind: "commit" };
    case "cherry-pick":
    case "revert":
      if (has("--abort", "--continue", "--quit", "--skip")) return { verb: "navigated" };
      return { verb: "committed", refKind: "commit" };
    case "merge":
      if (has("--abort", "--continue", "--quit")) return { verb: "navigated" };
      return { verb: "committed", refKind: "commit" };
    case "push": {
      if (has("--delete", "-d")) {
        const name = pos[pos.length - 1];
        return { verb: "closed", refKind: "branch", ref: name, branch: name, fromPush: true };
      }
      const colonDelete = rest.find((a) => /^:\S+$/.test(a));
      if (colonDelete)
        return {
          verb: "closed",
          refKind: "branch",
          ref: colonDelete.slice(1),
          branch: colonDelete.slice(1),
          fromPush: true,
        };
      let branch = pos.length >= 2 ? pos[pos.length - 1] : undefined;
      // `git push origin +main` is a force push of main.
      const plusForce = branch?.startsWith("+") === true;
      if (plusForce) branch = branch?.slice(1);
      const force =
        plusForce || rest.some((a) => FORCE_PUSH.test(a) || (SHORT_FLAG_WITH_F.test(a) && !a.startsWith("--")));
      if (branch?.includes(":")) branch = branch.slice(branch.indexOf(":") + 1);
      branch = branch?.replace(/^refs\/heads\//, "") || undefined;
      return { verb: force ? "rewrote" : "pushed", refKind: "branch", ref: branch, branch, fromPush: true };
    }
    case "rebase":
    case "filter-repo":
      if (has("--abort", "--quit", "--skip")) return { verb: "navigated" };
      return { verb: "rewrote", refKind: "branch" };
    case "reset": {
      const rewrite = rest.some((a) => REWRITE_RESET_FLAGS.has(a) || COMMITISH.test(a));
      return rewrite ? { verb: "rewrote", refKind: "branch" } : { verb: "navigated" };
    }
    case "branch": {
      if (has("-d", "-D", "--delete")) {
        const name = pos[pos.length - 1];
        return { verb: "closed", refKind: "branch", ref: name, branch: name };
      }
      return { verb: "navigated" };
    }
    case "checkout":
    case "switch": {
      if (rest.includes("--")) return { verb: "navigated" };
      let branch: string | undefined;
      for (let j = 0; j < rest.length; j++) {
        if (["-b", "-B", "-c", "-C", "--orphan"].includes(rest[j])) {
          branch = rest[j + 1];
          break;
        }
      }
      if (branch) return { verb: "navigated", refKind: "branch", ref: branch, branch, branchConfirmed: true };
      branch = pos[0];
      return branch
        ? { verb: "navigated", refKind: "branch", ref: branch, branch, plainCheckout: true }
        : { verb: "navigated" };
    }
    case "worktree": {
      if (rest[0] === "add") {
        const wtArgs = rest.slice(1);
        let branch: string | undefined;
        for (let j = 0; j < wtArgs.length; j++) {
          if (wtArgs[j] === "-b" || wtArgs[j] === "-B") {
            branch = wtArgs[j + 1];
            break;
          }
        }
        const wtPos = positionals(wtArgs);
        if (branch) return { verb: "navigated", refKind: "branch", ref: branch, branch, branchConfirmed: true };
        branch = wtPos.length >= 2 ? wtPos[wtPos.length - 1] : undefined;
        return { verb: "navigated", refKind: branch ? "branch" : undefined, ref: branch, branch };
      }
      return { verb: "navigated" };
    }
    default:
      // status, log, diff, show, fetch, pull, stash, blame, tag, add, rev-parse,
      // remote, … — digest kept, no ladder verb (B14 navigation class).
      return { verb: "navigated" };
  }
}
