import type { Partial } from "./git.js";
import { parseForgeUrl, qualifyNumber, urlHost } from "./refs.js";
import { ASSIGNMENT_WORD, FORGE_ENV, ownResultUrls, SHELL_EXPANSION } from "./repo.js";
import { shellWords } from "./shell.js";
import type { ForgeRefKind } from "./types.js";

// --- which repo a segment ran in (D-051 F1) ---------------------------------
//
// A forge action's repo is, in order: an explicit readable `-R/--repo` (or
// `GH_REPO`); else the repo of the directory the segment ran in; else the
// command's own result URL for the same item; else unknown. The directory is
// tracked here from the call's own cwd through literal `cd`/`pushd`/`popd`/
// `git -C`; turning a directory into a repo needs the filesystem, so it is
// left to the importer (`settleActionDir`), which resolves it the same way the
// session's own project is resolved. A directory change this module cannot
// follow (an expansion, a subshell or loop, `cd -`) makes the directory
// unknown, and the action keeps a repo only through `-R` or its result URL.

/** Collapse `.`/`..`/duplicate slashes of an absolute POSIX path; null when not absolute or `..` climbs above `/`. */
export function normalizeAbsolute(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** `cd "$(git rev-parse --show-toplevel)"`: the top of the repo the shell is already in — same repo, so the same directory for repo purposes. */
const TOPLEVEL_TARGET = /^(?:\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)|`\s*git\s+rev-parse\s+--show-toplevel\s*`)$/;

export const DIR_WORDS = new Set(["cd", "pushd", "popd"]);
/** Words that open or close a compound command: a `cd` inside one has a scope this module does not follow. */
const COMPOUND_WORDS = new Set([
  "{",
  "}",
  "(",
  ")",
  "do",
  "done",
  "then",
  "else",
  "elif",
  "fi",
  "if",
  "for",
  "while",
  "until",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  "!",
]);

/** The command has a compound part (subshell, brace group, loop, conditional): a directory change's scope is then unknown. */
export function hasCompound(segs: ReadonlyArray<{ text: string }>): boolean {
  return segs.some(({ text }) => {
    const t = text.trim();
    if (/^[({]/.test(t) || /[)}]$/.test(t)) return true;
    const first = shellWords(t)[0];
    return first !== undefined && COMPOUND_WORDS.has(first);
  });
}

/** The first non-flag argument of `cd`/`pushd` (`cd -P -- dir` → `dir`); undefined for none. */
function dirTarget(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return args[i + 1];
    if (a === "-") return a;
    if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/** Where the shell is: a known absolute directory, or lost (a change this module could not follow). */
export interface DirState {
  dir?: string;
  lost: boolean;
  /** `pushd` history, for a literal `popd`. */
  stack: Array<{ dir?: string; lost: boolean }>;
}

/** Resolve a `cd`/`pushd`/`git -C` target against the current state; null when it cannot be followed. */
export function resolveTarget(target: string | undefined, from: DirState): { dir?: string } | null {
  if (!target || target === "-") return null;
  if (TOPLEVEL_TARGET.test(target.trim())) return from.lost ? null : { dir: from.dir };
  if (SHELL_EXPANSION.test(target)) return null;
  if (target.startsWith("/")) {
    const d = normalizeAbsolute(target);
    return d === null ? null : { dir: d };
  }
  if (from.lost || !from.dir) return null;
  const d = normalizeAbsolute(`${from.dir}/${target}`);
  return d === null ? null : { dir: d };
}

/** A segment that prints nothing on success: `cd`, a bare assignment, `export`/`unset`. */
export function silentSegment(text: string): boolean {
  const words = shellWords(text);
  if (words.length === 0) return true;
  const first = words[0] === "builtin" ? words[1] : words[0];
  if (first === "cd" || first === "export" || first === "unset" || first === "true") return true;
  return words.every((w) => ASSIGNMENT_WORD.test(w));
}

/** Apply one plain `cd`/`pushd`/`popd` segment to the state. */
export function moveDir(state: DirState, program: string, args: string[]): void {
  if (program === "popd") {
    const prev = state.stack.pop();
    if (prev) {
      state.dir = prev.dir;
      state.lost = prev.lost;
    } else state.lost = true;
    return;
  }
  const target = dirTarget(args);
  if (program === "pushd") state.stack.push({ dir: state.dir, lost: state.lost });
  const next = resolveTarget(target, state);
  if (next === null) state.lost = true;
  else {
    state.dir = next.dir;
    state.lost = false;
  }
}

/** `git -C <dir>` / `--git-dir` / `--work-tree` before the subcommand: where git ran, when it moved. */
export function gitDirMove(args: string[]): { moved: boolean; target?: string } {
  for (let i = 0; i < args.length && args[i].startsWith("-"); i++) {
    const a = args[i];
    if (a === "-C") return { moved: true, target: args[i + 1] };
    if (a === "--git-dir" || a === "--work-tree" || a.startsWith("--git-dir=") || a.startsWith("--work-tree="))
      return { moved: true };
    if (a === "-c") i++;
  }
  return { moved: false };
}

/**
 * Shell variables a segment assigns on its own (`R=owner/repo`, `export R=…`),
 * folded into `vars` in command order. Only a literal value is kept: a value
 * with an expansion, or a name assigned twice, is unreadable and removed for
 * good, so `-R $R` then reads as an unreadable repo flag rather than a guess.
 */
export function foldAssignments(words: string[], vars: Map<string, string>, blocked: Set<string>): void {
  let list = words;
  if (list[0] === "export" || list[0] === "readonly" || list[0] === "local" || list[0] === "declare")
    list = list.slice(1);
  if (list.length === 0 || !list.every((w) => ASSIGNMENT_WORD.test(w))) return;
  for (const w of list) {
    const m = ASSIGNMENT_WORD.exec(w);
    if (!m) continue;
    const [, name, value] = m;
    if (blocked.has(name) || vars.has(name) || SHELL_EXPANSION.test(value) || !value) {
      vars.delete(name);
      blocked.add(name);
      continue;
    }
    vars.set(name, value);
  }
}

/**
 * Track `export GH_REPO=…` (and friends) across a command's segments. A plain
 * `GH_REPO=x` with no export may or may not reach gh (it depends on whether
 * the variable was already exported), so it is unreadable, as is any value
 * with an expansion or a second assignment.
 */
export function trackForgeEnv(words: string[], env: Map<string, string | null>): void {
  if (words[0] === "unset") {
    for (const w of words.slice(1)) env.delete(w);
    return;
  }
  const exported = words[0] === "export";
  const list = exported ? words.slice(1) : words;
  if (list.length === 0 || (!exported && !list.every((w) => ASSIGNMENT_WORD.test(w)))) return;
  for (const w of list) {
    const m = ASSIGNMENT_WORD.exec(w);
    const name = m ? m[1] : w;
    if (!FORGE_ENV.has(name)) continue;
    // `export GH_REPO` alone re-exports what is already there: nothing new to read.
    if (!m) continue;
    const value = m[2];
    const readable = exported && !env.has(name) && !!value && !SHELL_EXPANSION.test(value);
    env.set(name, readable ? value : null);
  }
}

export const BARE_ITEM_REF = /^([#!])(\d+)$/;

/**
 * The repo the command's OWN result shows for this item: a URL on one of its
 * own result lines (never body text) naming the same kind and number. One
 * distinct repo only; none or several leave the repo unknown.
 */
function projectFromResultUrl(
  result: string | undefined,
  kind: ForgeRefKind,
  n: string,
  view: boolean,
): { project: string; url: string } | undefined {
  if (!result) return undefined;
  const found = new Map<string, string>();
  for (const m of ownResultUrls(result, view)) {
    const u = parseForgeUrl(m);
    if (!u?.project || !u.ref || u.refKind !== kind) continue;
    const tail = /[#!](\d+)$/.exec(u.ref);
    if (tail?.[1] !== n) continue;
    const key = u.project.toLowerCase();
    if (!found.has(key)) found.set(key, u.url);
  }
  if (found.size !== 1) return undefined;
  const [[, url]] = [...found];
  const parsed = parseForgeUrl(url);
  return parsed?.project ? { project: parsed.project, url } : undefined;
}

/**
 * F1 verdict for one action once the result (if any) is in. An item ref that
 * already names its repo (`-R`, `GH_REPO`, a created item's URL) is settled.
 * An unreadable `-R`/`GH_REPO`, or a directory this module lost, leaves only
 * the result URL; failing that the action is `repoUnknown`. A known directory
 * is kept for the importer (`dir`), with the result URL's repo as the
 * fallback (`shownRepo`) should the directory resolve to no repo.
 */
export function settleRepo(p: Partial & { otherOutput?: boolean }, result: string | undefined): void {
  const item = p.refKind === "issue" || p.refKind === "merge_request";
  const bare = item && p.ref ? BARE_ITEM_REF.exec(p.ref) : null;
  if (item && p.ref && !bare) {
    delete p.dir;
    return;
  }
  // Another segment printing before or after this one could supply the URL: then no line is provably this command's.
  const shown =
    bare && !p.otherOutput
      ? projectFromResultUrl(result, p.refKind as ForgeRefKind, bare[2], p.verb === "viewed")
      : undefined;
  if (p.repoUnread || p.dirLost) {
    delete p.dir;
    if (bare && shown) {
      p.ref = qualifyNumber(p.refKind as ForgeRefKind, bare[2], shown.project);
      p.url = p.url ?? shown.url;
      return;
    }
    p.repoUnknown = true;
    return;
  }
  if (p.dir !== undefined && shown) {
    const h = urlHost(shown.url);
    p.shownRepo = h ? `${h}/${shown.project}` : shown.project;
  }
}
