// Goal 2026-09-26 W2 (P0b): the web page an issue/MR chip links to, derived
// from the qualified ref `code_session_issues.ref` stores ("host/owner/repo#N",
// see extract.ts's qualifyIssueRef) plus its `kind`. Pure — no I/O, never
// throws; null means "no page we can name", and the caller keeps the chip as
// plain text.
//
// Host shapes. Only two forge URL grammars exist in this product's world:
//   GitHub family (github.com, *.github.*): owner/repo/issues/N, owner/repo/pull/N
//   glab family (gitlab.com and every self-hosted forge such as
//   codehub.example): group/.../project/-/issues/N, /-/merge_requests/N
// "merge_request", `!N`, `glab` and the `/-/` separator are glab vocabulary,
// so a host that is not GitHub is shaped as glab — unless the caller knows
// the forge (a project's stored forge kind, `opts.family`), which then wins:
// a GitHub Enterprise host such as `git.acme.corp` is only GitHub-shaped when
// someone says so (review F17). No project stores a forge kind today, so
// every caller passes none and the host rule stands. A ref that carries no host
// at all ("#12", "owner/repo#12", "acme/billing!17049" — the extractor could
// not qualify it) is an unknown host: there is no page to link, so null.

export type ForgeRefKind = "issue" | "merge_request";
export type ForgeFamily = "github" | "gitlab";

const QUALIFIED_REF = /^([^\s/#!]+)\/(.+?)[#!](\d+)$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/i;
const GITHUB_HOST = /^(www\.)?github\.[a-z0-9.-]+$|(^|\.)github\.com$/i;

/** GitHub-shaped or glab-shaped, by host name alone; null when `host` is not a hostname. */
export function forgeFamilyOf(host: string): ForgeFamily | null {
  if (!HOSTNAME.test(host)) return null;
  return GITHUB_HOST.test(host) ? "github" : "gitlab";
}

/**
 * `refToUrl("codehub.example/acme/billing#17049", "merge_request")`
 *   → "https://codehub.example/acme/billing/-/merge_requests/17049"
 * `refToUrl("github.com/acme/billing#12", "issue")`
 *   → "https://github.com/acme/billing/issues/12"
 * A ref that is already an http(s) URL is returned as written. Anything without
 * a resolvable host → null.
 */
export function refToUrl(ref: string, kind: ForgeRefKind, opts: { family?: ForgeFamily | null } = {}): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }
  const m = trimmed.match(QUALIFIED_REF);
  if (!m) return null;
  const [, host, project, number] = m;
  const byHost = forgeFamilyOf(host);
  if (!byHost) return null;
  const family = opts.family ?? byHost;
  const path = project
    .split("/")
    .filter((seg) => seg && seg !== "-")
    .map(encodeURIComponent)
    .join("/");
  if (!path) return null;
  const item =
    family === "github"
      ? kind === "merge_request"
        ? `pull/${number}`
        : `issues/${number}`
      : kind === "merge_request"
        ? `-/merge_requests/${number}`
        : `-/issues/${number}`;
  return `https://${host.toLowerCase()}/${path}/${item}`;
}
