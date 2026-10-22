import type { Partial } from "./git.js";
import { gitAction } from "./git.js";
import { HOSTLIKE_SEGMENT, hostFromRepoFlag, parseForgeUrl, projectFromRepoFlag, qualifyNumber } from "./refs.js";
import { envRepoArg, inlineEnv, substituteVars } from "./repo.js";
import { AUTO_MERGE_FLAG } from "./results.js";
import { programAndArgs, shellWords } from "./shell.js";
import type { ForgeRefKind } from "./types.js";
import { TEST_SEGMENT } from "./types.js";

// --- gh / glab -----------------------------------------------------------

// Flags that take a value as the NEXT token (so it is not mistaken for the
// item positional). `--flag=value` needs no entry.
const VALUE_FLAGS = new Set([
  "-R",
  "--repo",
  "-b",
  "--body",
  "-t",
  "--title",
  "-F",
  "--body-file",
  "-d",
  "--description",
  "-l",
  "--label",
  "--add-label",
  "--remove-label",
  "--unlabel",
  "-a",
  "--assignee",
  "--add-assignee",
  "--remove-assignee",
  "--unassign",
  "-m",
  "--milestone",
  "--message",
  "-r",
  "--reviewer",
  "--add-reviewer",
  "--remove-reviewer",
  "-B",
  "--base",
  "-H",
  "--head",
  "--target-branch",
  "-s",
  "--source-branch",
  "--subject",
  "-p",
  "--project",
  "--add-project",
  "--remove-project",
  "-f",
  "--field",
  "-q",
  "--jq",
  "--json",
  "--template",
  "-M",
  "--match-author",
  "-o",
  "--output",
  "-P",
  "--per-page",
]);

const TRIAGE_FLAG =
  /^(-l|-a|--label|--add-label|--remove-label|--unlabel|--assignee|--add-assignee|--remove-assignee|--unassign|--milestone|-M)(=|$)/;
const TRIAGE_FLAG_MILESTONE_SHORT = "-m"; // glab issue update -m <milestone>

interface ForgeCliArgs {
  item?: string; // first positional after the action
  project?: string; // from -R/--repo
  /** The host `-R/--repo` named (`HOST/OWNER/REPO` or a URL), when it did. */
  repoHost?: string;
  /** `-R/--repo` appeared at all (its value may still be unreadable). */
  repoFlag?: boolean;
  flags: string[];
}

// `gh pr review`: `-r` is --request-changes and `-a` is --approve, both
// boolean there (elsewhere they are --reviewer / --assignee with a value).
const GH_REVIEW_BOOLEAN_FLAGS = new Set(["-r", "-a", "-c"]);

function parseForgeCliArgs(args: string[], booleanFlags?: Set<string>): ForgeCliArgs {
  const flags: string[] = [];
  let item: string | undefined;
  let project: string | undefined;
  let repoHost: string | undefined;
  let repoFlag = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      flags.push(a);
      const eq = a.indexOf("=");
      if (eq !== -1) {
        if (a.slice(0, eq) === "--repo" || a.slice(0, eq) === "-R") {
          repoFlag = true;
          project = projectFromRepoFlag(a.slice(eq + 1));
          repoHost = hostFromRepoFlag(a.slice(eq + 1));
        }
        continue;
      }
      if (a === "-R" || a === "--repo") repoFlag = true;
      if (VALUE_FLAGS.has(a) && !booleanFlags?.has(a) && i + 1 < args.length && !args[i + 1].startsWith("-")) {
        if (a === "-R" || a === "--repo") {
          project = projectFromRepoFlag(args[i + 1]);
          repoHost = hostFromRepoFlag(args[i + 1]);
        }
        i++;
      }
      continue;
    }
    if (item === undefined) item = a;
  }
  return { item, project, repoHost, repoFlag, flags };
}

/** Resolve the item positional (`17`, `#17`, `!17`, a URL, or a branch) into ref/url/branch. */
function itemRef(kind: ForgeRefKind, cli: ForgeCliArgs): Partial {
  const out: Partial = { verb: "navigated", refKind: kind };
  if (cli.repoFlag && !cli.project) out.repoUnread = true;
  if (cli.repoHost) out.repoHost = cli.repoHost;
  const item = cli.item;
  if (!item) return out;
  const num = /^[#!]?(\d+)$/.exec(item);
  if (num) {
    out.ref = qualifyNumber(kind, num[1], cli.project);
    return out;
  }
  if (/^https?:\/\//i.test(item)) {
    const parsed = parseForgeUrl(item);
    if (parsed?.ref) {
      out.ref = parsed.ref;
      out.url = parsed.url;
      out.refKind = parsed.refKind;
    }
    return out;
  }
  // gh/glab accept a branch name in place of a number.
  out.branch = item;
  return out;
}

/** The value of the first of `names` in `args` (`--head x`, `--head=x`, `-H x`), else undefined. */
function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const n of names) {
      if (a === n && i + 1 < args.length && !args[i + 1].startsWith("-")) return args[i + 1];
      if (n.startsWith("--") && a.startsWith(`${n}=`)) return a.slice(n.length + 1) || undefined;
    }
  }
  return undefined;
}

/**
 * `gh pr create --head owner:branch` → `branch`: the creator's own local branch, pushed to
 * their fork. A VIEW's `owner:branch` head is someone else's fork (L1) — see `viewHeadBranch`.
 */
function headBranch(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const b = value.includes(":") ? value.slice(value.indexOf(":") + 1) : value;
  return b || undefined;
}

/** A view's `head:` field; none for the `owner:branch` fork form (L1: that branch is not this repo's). */
function hasTriageFlag(cli: ForgeCliArgs, allowShortM: boolean): boolean {
  return cli.flags.some((f) => TRIAGE_FLAG.test(f) || (allowShortM && f === TRIAGE_FLAG_MILESTONE_SHORT));
}

function ghAction(args: string[]): Partial | null {
  const [resource, action, ...rest] = args;
  if (!resource || !action) return null;
  const kind: ForgeRefKind | null =
    resource === "pr" || resource === "prs" || resource === "pull-request"
      ? "merge_request"
      : resource === "issue" || resource === "issues"
        ? "issue"
        : null;
  if (!kind) return null;
  const cli = parseForgeCliArgs(rest, action === "review" ? GH_REVIEW_BOOLEAN_FLAGS : undefined);
  const base = itemRef(kind, cli);

  switch (action) {
    case "view":
    case "diff":
    case "checks":
      return { ...base, verb: "viewed" };
    case "checkout":
      return kind === "merge_request" ? { ...base, verb: "checked_out" } : null;
    case "comment":
      return { ...base, verb: "commented" };
    case "review":
      if (kind !== "merge_request") return null;
      return { ...base, verb: cli.flags.some((f) => f === "-a" || f === "--approve") ? "approved" : "commented" };
    case "merge":
      if (kind !== "merge_request" || cli.flags.some((f) => AUTO_MERGE_FLAG.test(f))) return null;
      return { ...base, verb: "merged" };
    case "close":
      return { ...base, verb: "closed" };
    case "reopen":
      return { ...base, verb: "reopened" };
    case "edit":
      return hasTriageFlag(cli, false) ? { ...base, verb: "triaged" } : null;
    case "create":
      return kind === "merge_request"
        ? { verb: "opened_mr", refKind: kind, ref: undefined, branch: headBranch(flagValue(rest, ["--head", "-H"])) }
        : { verb: "opened", refKind: kind, ref: undefined };
    default:
      return null;
  }
}

function glabAction(args: string[]): Partial | null {
  const [resource, action, ...rest] = args;
  if (!resource || !action) return null;
  const kind: ForgeRefKind | null =
    resource === "mr" || resource === "merge-request"
      ? "merge_request"
      : resource === "issue" || resource === "issues"
        ? "issue"
        : null;
  if (!kind) return null;
  const cli = parseForgeCliArgs(rest);
  const base = itemRef(kind, cli);

  switch (action) {
    case "view":
    case "diff":
      return { ...base, verb: "viewed" };
    case "checkout":
      return kind === "merge_request" ? { ...base, verb: "checked_out" } : null;
    case "note":
    case "comment":
      return { ...base, verb: "commented" };
    case "approve":
      return kind === "merge_request" ? { ...base, verb: "approved" } : null;
    case "merge":
      if (kind !== "merge_request" || cli.flags.some((f) => AUTO_MERGE_FLAG.test(f))) return null;
      return { ...base, verb: "merged" };
    case "close":
      return { ...base, verb: "closed" };
    case "reopen":
      return { ...base, verb: "reopened" };
    case "update":
      return hasTriageFlag(cli, true) ? { ...base, verb: "triaged" } : null;
    case "create":
      return kind === "merge_request"
        ? { verb: "opened_mr", refKind: kind, branch: flagValue(rest, ["--source-branch", "-s"]) }
        : { verb: "opened", refKind: kind };
    default:
      return null;
  }
}

export function segmentAction(
  segment: string,
  vars?: ReadonlyMap<string, string>,
  env?: ReadonlyMap<string, string | null>,
): Partial | null {
  const words = substituteVars(shellWords(segment), vars);
  const pa = programAndArgs(words);
  if (!pa) return null;
  const { program } = pa;
  // S1: `GH_REPO` is gh's `-R`; a host override leaves the repo unreadable.
  const inline = inlineEnv(words);
  const envArg = envRepoArg(program, pa.args, inline, env ?? new Map());
  const args = envArg ? [...pa.args, envArg] : pa.args;
  // v3 item 6: the host this forge CLI talks to — gh's github.com unless GH_HOST retargets it
  // (then its value, when readable), glab's readable GITLAB_HOST/GL_HOST, else none.
  const envVal = (name: string) => (inline.has(name) ? inline.get(name) : env?.get(name));
  const envHas = (name: string) => inline.has(name) || !!env?.has(name);
  const readableHost = (v: string | null | undefined) => (v && HOSTLIKE_SEGMENT.test(v) ? v.toLowerCase() : undefined);
  switch (program) {
    case "git":
      return gitAction(args);
    case "gh": {
      const a = ghAction(args);
      if (a) a.toolHost = envHas("GH_HOST") ? readableHost(envVal("GH_HOST")) : "github.com";
      return a;
    }
    case "glab": {
      const a = glabAction(args);
      if (a) a.toolHost = readableHost(envVal("GITLAB_HOST")) ?? readableHost(envVal("GL_HOST"));
      return a;
    }
    default:
      return TEST_SEGMENT.test([program, ...args].join(" ")) ? { verb: "tested" } : null;
  }
}
