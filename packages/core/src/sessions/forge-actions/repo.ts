export const SHELL_EXPANSION = /[$`~*?]/;

export const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/** Replace `$NAME` / `${NAME}` inside each word with a literal value this command assigned. */
export function substituteVars(words: string[], vars?: ReadonlyMap<string, string>): string[] {
  if (!vars || vars.size === 0) return words;
  return words.map((w) =>
    w.includes("$")
      ? w.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => vars.get(a ?? b) ?? all)
      : w,
  );
}

// Environment variables that retarget a forge CLI away from the directory's repo.
// `GH_REPO` is gh's `-R`; a host override (`GH_HOST`, `GITLAB_HOST`) leaves the
// repo unreadable here. A value this module cannot read is recorded as null.
const GH_ENV = ["GH_REPO", "GH_HOST"];
const GLAB_ENV = ["GITLAB_HOST", "GL_HOST"];
export const FORGE_ENV = new Set([...GH_ENV, ...GLAB_ENV]);

/** The inline `NAME=value` prefixes of a segment (`GH_REPO=x gh …`, `env GH_REPO=x gh …`). */
export function inlineEnv(words: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const w of words) {
    if (w === "env" || w === "time" || w === "nice" || w === "command" || w === "exec" || w === "sudo") continue;
    const m = ASSIGNMENT_WORD.exec(w);
    if (!m) break;
    if (FORGE_ENV.has(m[1])) out.set(m[1], m[2] && !SHELL_EXPANSION.test(m[2]) ? m[2] : null);
  }
  return out;
}

/**
 * The repo override a gh/glab segment gets from its environment, as a
 * `--repo=` argument: a readable `GH_REPO`, else a marker no repo parser
 * accepts (an unreadable `GH_REPO`, or a host override) so the action reads
 * as an unreadable `-R`. Undefined when nothing retargets it or the segment
 * already names `-R/--repo` (the flag wins, as in gh itself).
 */
export function envRepoArg(
  program: string,
  args: string[],
  inline: ReadonlyMap<string, string | null>,
  env: ReadonlyMap<string, string | null>,
): string | undefined {
  if (program !== "gh" && program !== "glab") return undefined;
  if (args.some((a) => a === "-R" || a === "--repo" || a.startsWith("-R=") || a.startsWith("--repo=")))
    return undefined;
  const get = (name: string) => (inline.has(name) ? inline.get(name) : env.get(name));
  const has = (name: string) => inline.has(name) || env.has(name);
  if (program === "gh") {
    if (has("GH_REPO")) return `--repo=${get("GH_REPO") ?? "$GH_REPO"}`;
    if (has("GH_HOST")) return "--repo=$GH_HOST";
    return undefined;
  }
  return GLAB_ENV.some(has) ? "--repo=$GITLAB_HOST" : undefined;
}

// The lines a gh/glab command prints as its OWN result's URL (R2-S1): a `url:`
// field (view header, `--json`-less non-TTY output), glab/gh's trailing
// "View this … on …: <url>" line, or — for a command that prints no body
// (close, merge, comment, create) — a line that is only the URL. A view's
// body and comments are other people's text: a fork or a moved issue there
// links the same number in another repo, so no URL in them is evidence.
const URL_FIELD_LINE = /^url:\s*(https?:\/\/\S+)$/i;
const VIEW_THIS_LINE = /^View this (?:issue|pull request|merge request) on [^:]+:\s*(https?:\/\/\S+)$/i;
const WHOLE_URL_LINE = /^(https?:\/\/\S+)$/;

/** The URLs a command's result states as its own (see above); a `--json` result gives only its top-level `url`. */
export function ownResultUrls(result: string, view: boolean): string[] {
  const trimmed = result.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed) as unknown;
      const url =
        json && typeof json === "object" && !Array.isArray(json) ? (json as { url?: unknown }).url : undefined;
      return typeof url === "string" ? [url] : [];
    } catch {
      return [];
    }
  }
  const out: string[] = [];
  for (const raw of result.split(/\r?\n/)) {
    const line = raw.trim();
    // A view's `--` separates its own header from the body: nothing after it is the command's.
    if (line === "--") break;
    const m = URL_FIELD_LINE.exec(line) ?? VIEW_THIS_LINE.exec(line) ?? (view ? null : WHOLE_URL_LINE.exec(line));
    if (m) out.push(m[1]);
  }
  return out;
}
