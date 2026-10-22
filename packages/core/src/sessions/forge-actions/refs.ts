import type { Partial } from "./git.js";
import { ownResultUrls } from "./repo.js";
import type { ForgeRefKind } from "./types.js";

// --- refs ----------------------------------------------------------------

const ITEM_SEGMENTS: Record<string, ForgeRefKind> = {
  issues: "issue",
  issue: "issue",
  pull: "merge_request",
  pulls: "merge_request",
  "pull-requests": "merge_request",
  merge_requests: "merge_request",
  commit: "commit",
  commits: "commit",
};

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g;

export interface UrlRef {
  ref?: string;
  refKind: ForgeRefKind;
  url: string;
  sha?: string;
  project?: string;
}

/** Parse one forge item URL (`…/owner/repo/-/merge_requests/17`, `…/owner/repo/pull/4`, `…/issues/9`, `…/commit/<sha>`). */
export function parseForgeUrl(raw: string): UrlRef | null {
  let url: URL;
  try {
    url = new URL(raw.replace(/[.,;:)\]]+$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const segs = url.pathname.split("/").filter(Boolean);
  for (let i = segs.length - 2; i >= 0; i--) {
    const kind = ITEM_SEGMENTS[segs[i].toLowerCase()];
    if (!kind) continue;
    const id = segs[i + 1];
    const project = segs
      .slice(0, i)
      .filter((s) => s !== "-")
      .join("/");
    const cleanUrl = `${url.origin}${url.pathname}`;
    if (kind === "commit") {
      if (!/^[0-9a-f]{7,40}$/i.test(id)) continue;
      return { refKind: "commit", sha: id.toLowerCase(), url: cleanUrl, project: project || undefined };
    }
    if (!/^\d+$/.test(id)) continue;
    const marker = kind === "merge_request" ? "!" : "#";
    return {
      ref: project ? `${project}${marker}${id}` : `${marker}${id}`,
      refKind: kind,
      url: cleanUrl,
      project: project || undefined,
    };
  }
  return null;
}

/** First forge item URL in free text, if any. */
export function findForgeUrl(text: string): UrlRef | null {
  for (const m of text.match(URL_IN_TEXT) ?? []) {
    const parsed = parseForgeUrl(m);
    if (parsed) return parsed;
  }
  return null;
}

export function qualifyNumber(kind: ForgeRefKind, n: string, project?: string): string {
  const marker = kind === "merge_request" ? "!" : "#";
  return project ? `${project}${marker}${n}` : `${marker}${n}`;
}

/** The host a `-R` value names (`HOST/OWNER/REPO` or a repo URL), lower-cased; undefined for `OWNER/REPO`. */
export function hostFromRepoFlag(value: string | undefined): string | undefined {
  if (!value || /[$`~]/.test(value)) return undefined;
  const url = /^https?:\/\/([^/]+)\//i.exec(value);
  if (url) return url[1].toLowerCase();
  const parts = value.split("/").filter(Boolean);
  return parts.length >= 3 && parts[0].includes(".") ? parts[0].toLowerCase() : undefined;
}

export const HOSTLIKE_SEGMENT = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i;

/** The host of an http(s) URL, lower-cased. */
export function urlHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * v3 item 6 (B1/B2 precedence): give a qualified, host-less item ref (`owner/repo#N`) the forge
 * host this action's OWN evidence shows, strongest first:
 *   1. an explicit host: `-R HOST/owner/repo` (or a host already in the ref);
 *   2. the host of the item's own URL — a URL positional, or the command's own result line
 *      naming the same owner/repo, kind and number (the URL-fallback rule, never body text);
 *   3. (a bare ref's directory remote — settled later by the importer, `settleActionDir`);
 *   4. the tool default: gh → github.com only when GH_HOST is unset (a readable GH_HOST is its
 *      host, an unreadable one none); glab → a readable GITLAB_HOST/GL_HOST, else none.
 * No evidence, no host: a missing link, never a wrong one.
 */
export function withKnownHost(p: Partial & { otherOutput?: boolean }, result: string | undefined): void {
  if (!p.ref || (p.refKind !== "issue" && p.refKind !== "merge_request")) return;
  const m = /^(.+?)([#!])(\d+)$/.exec(p.ref);
  if (!m || !m[1].includes("/")) return;
  if (HOSTLIKE_SEGMENT.test(m[1].split("/")[0])) return;
  const host = p.repoHost ?? ownUrlHost(p, m[1], m[3], result) ?? p.toolHost;
  if (host) p.ref = `${host}/${p.ref}`;
}

/** Step 2: the host of this item's own URL (the action's `url`, else its own result line), when it names the same repo. */
function ownUrlHost(
  p: Partial & { otherOutput?: boolean },
  project: string,
  n: string,
  result: string | undefined,
): string | undefined {
  const same = (u: UrlRef | null) =>
    !!u?.project &&
    u.project.toLowerCase() === project.toLowerCase() &&
    u.refKind === p.refKind &&
    /[#!](\d+)$/.exec(u.ref ?? "")?.[1] === n;
  if (p.url) {
    const u = parseForgeUrl(p.url);
    if (same(u)) return urlHost(p.url);
  }
  if (!result || p.otherOutput) return undefined;
  const hosts = new Set<string>();
  for (const raw of ownResultUrls(result, p.verb === "viewed")) {
    const u = parseForgeUrl(raw);
    const h = urlHost(raw);
    if (same(u) && h) hosts.add(h);
  }
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

/** `host/owner/repo` or `owner/repo` → lower-cased `owner/repo`. */
export function stripHost(repo: string): string {
  const segs = repo.split("/").filter(Boolean);
  if (segs.length >= 3 && HOSTLIKE_SEGMENT.test(segs[0])) segs.shift();
  return segs.join("/").toLowerCase();
}

/** `OWNER/REPO`, `HOST/OWNER/REPO` or a repo URL → `owner/repo` (host dropped). */
export function projectFromRepoFlag(value: string | undefined): string | undefined {
  if (!value || /[$`~]/.test(value)) return undefined;
  const v = value.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
  const parts = v.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0].includes(".")) return parts.slice(1).join("/");
  return parts.length >= 2 ? parts.join("/") : undefined;
}
