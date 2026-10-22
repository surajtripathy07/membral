// UX audit B0 (docs section 4, B1 "drop the github.com/ prefix and show
// owner/repo#n"): the page a compact ref renders to, once the host prefix is
// no longer shown on screen. Reuses `canonicalItemRef` (ref-canon.ts) for the
// ref SHAPE — no new ref regex — and adds only the narrow "which host may we
// link to, and in which URL grammar" decision on top.
//
// The forge FAMILY of a host is taken from data, never from its name alone:
//
//   - `github.com/owner/repo#N` -> a GitHub issues URL. GitHub redirects
//     issues/N to pull/N when N is a pull request, so `issues/` is always safe.
//   - A glab-family host (hosted or self-hosted) -> `/-/merge_requests/N` or
//     `/-/issues/N` under the full group path. A host is glab-family when:
//       * the caller says so (`family`, e.g. a Thread's `forge_family`), or
//       * it is in `glabHosts` — hosts the user's own data shows are glab-family
//         (`glabHostsFrom`: an observed URL in the `/-/merge_requests/N` or
//         `/-/issues/N` grammar, or a lone `glab` command run against that host).
//     A nested-group path alone is NOT enough: a host-less glab ref whose top
//     group is dotted (`some.org/sub/repo!5`) reads exactly like a host.
//   - Any other host (unknown family), and a host-less ref ("owner/repo#N",
//     "!5") -> null, so the caller renders plain text instead of a guessed,
//     broken, or wrong-repo link. `!N` alone is not glab evidence: the parser
//     writes a GitHub pull request as `owner/repo!N` too.
//
// Hosts are compared normalised (`normalizeHost`: no port, no leading `www.`),
// as item identity is (R3 ADV, driver ruling). The LINK keeps the port the ref
// itself spells: `codehub.example:8443/o/r!5` links to
// `https://codehub.example:8443/o/r/-/merge_requests/5`.
//
// The public hosted forges count by name, no data needed: github.com, and the
// glab family's own hosted .com (`GLAB_HOSTED`). Self-hosted glab forges still
// need proof (`family` / `glabHosts`).
import { canonicalItemRef, normalizeHost } from "@/lib/code-sessions/ref-canon";
import type { ForgeFamily, ForgeRefKind } from "@/lib/forge/ref-url";

const GITHUB_HOST = /^github\.com$/i;
/** The glab family's public hosted forge: glab-family by name, like github.com (maintainer, R3 3.4). */
const GLAB_HOSTED = /^gitlab\.com$/i;
const HOSTLIKE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/i;
/** glab-family web URL grammar: `https://<host>/<group/.../project>/-/(merge_requests|issues)/N`. */
const GLAB_ITEM_URL = /https?:\/\/([^\s/?#]+)\/[^\s?#]+?\/-\/(?:merge_requests|issues)\/\d+/gi;
/** A redacted command digest (props.inputDigest) whose command is the glab CLI. */
const GLAB_COMMAND = /^\s*glab\s/;
/** Anything that chains or nests another command: then the digest's ref may come from gh/git, not glab. */
const CHAINED = /[;&|\n`]|\$\(/;
/** A bare `#N` / `!N` — the ref names no repo, so it is the session project's. */
const BARE_REF = /^[#!]\d+$/;

export interface ForgeUrlOptions {
  /** The item's kind; defaults to what the ref spelling says (`!N` → merge request, else issue). */
  kind?: ForgeRefKind | null;
  /** The forge family the caller already knows for this ref's host (from data). */
  family?: ForgeFamily | null;
  /** Hosts the user's own data shows are glab-family (`glabHostsFrom`). */
  glabHosts?: ReadonlySet<string> | readonly string[] | null;
}

/**
 * Lower-cased host of a host-qualified ref or repo identity, spelled the way
 * core writes one: `host/owner/repo...` (three or more segments). A two-segment
 * `some.org/repo!5` is a dotted OWNER, not a host — null.
 */
export function hostOf(refOrIdentity: string | null | undefined): string | null {
  if (!refOrIdentity) return null;
  const segs = refOrIdentity.trim().split("/");
  if (segs.length < 3 || !HOSTLIKE.test(segs[0])) return null;
  return normalizeHost(segs[0]);
}

function hasHost(set: ForgeUrlOptions["glabHosts"], host: string): boolean {
  if (!set) return false;
  // Hosts compare normalised (no port, no `www.`), as item identity does.
  for (const h of set as Iterable<string>) if (normalizeHost(h) === host) return true;
  return false;
}

/** A ref split the way the link and the label both read it (canonical shape, no new ref regex). */
export interface ForgeRefParts {
  /** Lower-cased, normalised host (no port, no `www.`), or null when the spelling carries none. */
  host: string | null;
  /** The host as the link writes it: the ref's own spelling, port kept (`www.` dropped). */
  linkHost: string | null;
  /** `owner/repo` (or `group/sub/project`) as stored, host and `-` dropped. */
  path: string[];
  number: number;
  kind: ForgeRefKind;
}

export function forgeRefParts(ref: string, opts: Pick<ForgeUrlOptions, "kind"> = {}): ForgeRefParts | null {
  const canonical = canonicalItemRef(ref, null, opts.kind ?? "issue");
  if (!canonical) return null;
  const at = canonical.ref.lastIndexOf("#");
  const segments = canonical.ref
    .slice(0, at)
    .split("/")
    .filter((s) => s && s !== "-");
  const host = segments.length >= 3 && HOSTLIKE.test(segments[0]) ? normalizeHost(segments[0]) : null;
  const spelled = spelledHost(ref);
  return {
    host,
    linkHost: host && spelled && normalizeHost(spelled) === host ? spelled.replace(/^www\./, "") : host,
    path: host ? segments.slice(1) : segments,
    number: canonical.number,
    kind: opts.kind ?? canonical.kind,
  };
}

/** The host a ref spells, lower-cased with its port (a URL's default port is dropped by URL). */
function spelledHost(ref: string): string | null {
  const t = ref.trim();
  if (/^https?:\/\//i.test(t)) {
    try {
      return new URL(t).host.toLowerCase();
    } catch {
      return null;
    }
  }
  const segs = t.split("/");
  return segs.length >= 3 && HOSTLIKE.test(segs[0]) ? segs[0].toLowerCase() : null;
}

/**
 * The forge grammar a host earns — the ONE host check the link (`forgeUrl`) and
 * the label (`refLabel`, D-065) share: "github" for github.com, "glab" for the
 * glab family's hosted .com or a self-hosted glab-family host the data proves
 * (`family` or `glabHosts`), else null (unknown
 * family: no link, qualified label). A host-less ref is always null.
 */
export function linkFamilyOf(
  host: string | null,
  opts: Pick<ForgeUrlOptions, "family" | "glabHosts"> = {},
): "github" | "glab" | null {
  if (!host) return null;
  if (GITHUB_HOST.test(host)) return "github";
  if (GLAB_HOSTED.test(host) || opts.family === "gitlab" || hasHost(opts.glabHosts, host)) return "glab";
  return null;
}

export function forgeUrl(ref: string, opts: ForgeUrlOptions = {}): string | null {
  const parts = forgeRefParts(ref, opts);
  if (!parts) return null;
  // No host, no link: a host-less "owner/repo#N" may name a repo on a forge
  // we can't see (or a fictional one), and a link to someone else's repo is a
  // wrong link. Callers pass the host-qualified ref when they have it.
  if (!parts.host) return null;
  const path = parts.path.map(encodeURIComponent).join("/");
  if (!path) return null;

  const family = linkFamilyOf(parts.host, opts);
  if (family === "github") return `https://${parts.linkHost}/${path}/issues/${parts.number}`;
  if (family !== "glab") return null;
  const item = parts.kind === "merge_request" ? "merge_requests" : "issues";
  return `https://${parts.linkHost}/${path}/-/${item}/${parts.number}`;
}

/** One piece of observed data that may show a host's forge family. */
export interface ForgeEvidence {
  /** Free text that may hold a forge web URL: an action's `url`, an issue row's evidence quote. */
  text?: string | null;
  /** The turn's redacted command digest (props.inputDigest). */
  digest?: string | null;
  /** The action's ref, when host-qualified — the host a glab command acted on. */
  ref?: string | null;
  /** The session's project repo_identity — the host a glab command ran against when the ref names none. */
  identity?: string | null;
  /** The parser could not tell which repo the action hit (props action `repoUnknown`): the project host is not evidence. */
  repoUnknown?: boolean;
}

/**
 * Hosts the data shows are glab-family: the host of any observed URL in the
 * glab item grammar, and the host a LONE `glab` command (nothing chained)
 * acted on — its host-qualified ref's host, or the session project's host
 * when the ref is a bare `#N`/`!N` whose repo the parser knew. A ref naming
 * another repo host-less (`glab ... -R other/repo`) credits nothing. Never
 * github.com. Pure.
 */
export function glabHostsFrom(evidence: Iterable<ForgeEvidence>): Set<string> {
  const out = new Set<string>();
  for (const e of evidence) {
    if (e.text) {
      for (const m of e.text.matchAll(GLAB_ITEM_URL)) {
        const host = normalizeHost(m[1]);
        if (HOSTLIKE.test(host) && !GITHUB_HOST.test(host)) out.add(host);
      }
    }
    if (e.digest && GLAB_COMMAND.test(e.digest) && !CHAINED.test(e.digest.trim()) && e.ref) {
      const ref = e.ref.trim();
      const host = BARE_REF.test(ref) ? (e.repoUnknown ? null : hostOf(e.identity)) : hostOf(ref);
      if (host && !GITHUB_HOST.test(host)) out.add(host);
    }
  }
  return out;
}

/** "gitlab" (the glab family) when `ref`'s host is the glab hosted .com or in `glabHosts`, else null. */
export function glabFamilyOf(ref: string, glabHosts: ReadonlySet<string>): ForgeFamily | null {
  const host = hostOf(ref);
  return host && (GLAB_HOSTED.test(host) || hasHost(glabHosts, host)) ? "gitlab" : null;
}

/** The ForgeEvidence of a turn's jsonb props: each observed action's url/ref plus the turn's digest (no action, no evidence). */
export function turnPropsEvidence(
  props: Record<string, unknown> | null | undefined,
  identity: string | null | undefined,
): ForgeEvidence[] {
  if (!props || typeof props !== "object") return [];
  const digest = typeof props.inputDigest === "string" ? props.inputDigest : null;
  const list = Array.isArray(props.actions) ? props.actions : props.action ? [props.action] : [];
  const out: ForgeEvidence[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    out.push({
      text: typeof r.url === "string" ? r.url : null,
      ref: typeof r.ref === "string" ? r.ref : null,
      digest,
      identity: identity ?? null,
      repoUnknown: r.repoUnknown === true,
    });
  }
  return out;
}
