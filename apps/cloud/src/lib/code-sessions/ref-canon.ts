// One issue or merge request, one identity (e2e A-B2, D-052 "identity is (kind, ref)").
//
// The same MR reached `code_session_issues` three ways in one e2e run:
// `codehub.example/acme/billing#17049` (the profile's observed row),
// `acme/billing!17049` (the extractor copying a slash line) and
// `acme/billing/-/merge_requests/17049` (the extractor copying a URL path with
// no scheme). Each landed as its own row, so the Issues tab showed one MR as
// three. Pure; no I/O; never throws.
//
//   canonicalItemRef  write time: any written form -> the stored shape
//                     `host/owner/repo#N` (both kinds use `#`, as before) plus
//                     the kind the SYNTAX says (`!N` and `/merge_requests/N`
//                     are merge requests, `/issues/N` an issue) — the caller's
//                     kind only decides where the syntax is silent (`#N`,
//                     which GitHub uses for pull requests too).
//   (identity)        which spellings are ONE item — the key every write and
//                     read path uses — is lib/domain/ref-identity.ts (D-064).
//   preferredRef      which stored spelling a merged row shows: the one with a
//                     host and `#` (the canonical shape), so the forge link works.
//
// A written ref counts only when it IS ref syntax (e2e A-B3): `#N`, `!N`,
// `owner/repo#N`, `owner/repo!N`, a forge URL or URL path naming an item. A
// file name such as `review-17049.md` or a bare word with digits is not a ref.
// Bare digits (`17049`) are accepted only as the extractor's shorthand — the
// grounding gate (hasExplicitRefSyntax over the quote) decides whether they
// stand.

export type ItemKind = "issue" | "merge_request";

export interface CanonicalItemRef {
  ref: string;
  number: number;
  kind: ItemKind;
}

const MR_SEGMENTS = new Set(["merge_requests", "pull", "pulls", "pull-requests"]);
const ISSUE_SEGMENTS = new Set(["issues", "issue"]);
const BARE_NUMBER = /^(\d+)$/;
const MARKED = /^(.*?)([#!])(\d+)$/;
/** A forge host segment (`github.com`, `codehub.example:8443`). Shared with lib/domain/ref-identity.ts. */
export const HOSTLIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i;

function safeNumber(s: string): number | null {
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * A host as item identity reads it (driver ruling on R3 ADV findings 1-2): lower-cased, the port and a
 * leading `www.` dropped — `www.github.com` is github.com and `codehub.example:8443` is codehub.example,
 * so one item never splits by how its URL was spelled. Links therefore go to the port-less host.
 */
export function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
}

/**
 * `host/owner/repo...` with its host normalised (`normalizeHost`); any other shape unchanged. Also the
 * canonical form of a project `repo_identity` for comparisons (a stored `www.github.com/acme/api` is
 * `github.com/acme/api`).
 */
export function normalizeHostPrefix(path: string): string {
  const segs = path.split("/");
  if (segs.length < 3 || !HOSTLIKE.test(segs[0])) return path;
  return [normalizeHost(segs[0]), ...segs.slice(1)].join("/");
}

function projectFor(prefix: string, projectIdentity: string | null): string {
  const p = normalizeHostPrefix(prefix.replace(/\/+$/, "").replace(/^\/+/, ""));
  if (!p) return projectIdentity ?? "";
  if (!projectIdentity) return p;
  const lp = p.toLowerCase();
  const id = projectIdentity.toLowerCase();
  if (lp === id || id.endsWith(`/${lp}`)) return projectIdentity;
  const segs = p.split("/");
  if (segs.length >= 2 && HOSTLIKE.test(segs[0])) return `${segs[0].toLowerCase()}/${segs.slice(1).join("/")}`;
  return p;
}

/** A URL (with or without scheme) whose path names an item: `[host/]owner/repo[/-]/merge_requests|issues|pull/N`. */
function fromItemPath(
  written: string,
  projectIdentity: string | null,
): { project: string; number: number; kind: ItemKind } | null {
  let host = "";
  let path = written;
  const scheme = /^https?:\/\//i.exec(written);
  if (scheme) {
    try {
      const u = new URL(written);
      host = normalizeHost(u.host);
      path = u.pathname;
    } catch {
      return null;
    }
  } else {
    path = written.split(/[?#]/)[0];
  }
  const segs = path.split("/").filter(Boolean);
  for (let i = segs.length - 2; i >= 1; i--) {
    const seg = segs[i].toLowerCase();
    const isMr = MR_SEGMENTS.has(seg);
    if (!isMr && !ISSUE_SEGMENTS.has(seg)) continue;
    const number = /^\d+$/.test(segs[i + 1]) ? safeNumber(segs[i + 1]) : null;
    if (number === null) continue;
    const project = segs.slice(0, i).filter((s) => s !== "-");
    if (project.length === 0) return null;
    const prefix = host ? `${host}/${project.join("/")}` : project.join("/");
    return { project: projectFor(prefix, projectIdentity), number, kind: isMr ? "merge_request" : "issue" };
  }
  return null;
}

/** The last path segment of a `[host/]owner/repo` identity, lower-cased. */
function repoNameOf(projectIdentity: string): string {
  const segs = projectIdentity.replace(/\/+$/, "").split("/");
  return (segs[segs.length - 1] ?? "").toLowerCase();
}

/** True when `prefix` is a single segment (no owner) equal to the project repo's own name. */
function bareNamesProject(prefix: string, projectIdentity: string | null): boolean {
  if (!projectIdentity || !/^[\w.-]+$/.test(prefix)) return false;
  if (!projectIdentity.includes("/")) return false;
  return prefix.toLowerCase() === repoNameOf(projectIdentity);
}

/**
 * Read-time qualification of an already-stored bare `repo#N` / `repo!N` (a
 * repo NAME with no owner): rewritten to `<projectIdentity>#N` only when the
 * name equals the session's project repo's name. Any other ref — qualified,
 * bare `#N`, or a bare name of some other repo — comes back unchanged, so it
 * stays its own group rather than being guessed into this project.
 */
export function qualifyBareRepoRef(ref: string, projectIdentity: string | null | undefined): string {
  const m = /^([\w.-]+)([#!])(\d+)$/.exec(ref.trim());
  if (!m || !projectIdentity || !bareNamesProject(m[1], projectIdentity)) return ref;
  return `${projectIdentity}#${m[3]}`;
}

/**
 * The stored shape of a written ref, or null when `written` is not ref syntax.
 * `projectIdentity` (code_projects.repo_identity) qualifies a bare `#N`/`!N`/`N`
 * and an `owner/repo` naming the session's own project; pass null at read time.
 */
export function canonicalItemRef(
  written: string,
  projectIdentity: string | null,
  kindHint: ItemKind = "issue",
): CanonicalItemRef | null {
  const trimmed = written.trim().replace(/[.,;:)\]]+$/, "");
  if (!trimmed || /\s/.test(trimmed)) return null;
  projectIdentity = projectIdentity ? normalizeHostPrefix(projectIdentity.trim()) : projectIdentity;
  const path = fromItemPath(trimmed, projectIdentity);
  if (path) return { ref: `${path.project}#${path.number}`, number: path.number, kind: path.kind };
  if (/^https?:\/\//i.test(trimmed)) return null;
  const bare = BARE_NUMBER.exec(trimmed);
  if (bare) {
    const number = safeNumber(bare[1]);
    if (number === null || !projectIdentity) return null;
    return { ref: `${projectIdentity}#${number}`, number, kind: kindHint };
  }
  const m = MARKED.exec(trimmed);
  if (!m) return null;
  const number = safeNumber(m[3]);
  if (number === null) return null;
  const prefix = m[1];
  // `owner/repo#N` only: a prefix that is not a project path (`review-`, `PR`) is prose, not a ref.
  // UX W6: the one exception is a bare repo NAME equal to the session's own
  // project repo's name (`membral-personal#118` in a session on
  // `github.com/o/membral-personal`), qualified to that project.
  // A host may carry a port (`codehub.example:8443/acme/api#5`); projectFor drops it (normalizeHost).
  if (prefix && !/^[\w.-]+(:\d+)?(\/[\w.-]+)+$/.test(prefix) && !bareNamesProject(prefix, projectIdentity)) return null;
  const project = projectFor(prefix, projectIdentity);
  if (!project) return null;
  const kind: ItemKind = m[2] === "!" ? "merge_request" : kindHint;
  return { ref: `${project}#${number}`, number, kind };
}

// Item identity — `itemReadKey`, `itemKeyResolver`, `githubItemKey`, `foldDiscussedKinds` — lives in
// lib/domain/ref-identity.ts (D-064): one key function for the write path and every read path. That
// module imports this file's parser (`canonicalItemRef`, `HOSTLIKE`); this file imports nothing back.

/** Rank of a stored spelling for display: `host/owner/repo#N` beats `owner/repo!N` beats a URL path. */
function spellingRank(ref: string): number {
  const t = ref.trim();
  const m = /^([^/\s#!]+)\/.+#\d+$/.exec(t);
  if (m && HOSTLIKE.test(m[1])) return 3;
  if (/[#!]\d+$/.test(t)) return 2;
  return 1;
}

/** Of two stored spellings of one item, the one to show (canonical shape first, then the first seen). */
export function preferredRef(current: string, candidate: string): string {
  return spellingRank(candidate) > spellingRank(current) ? candidate : current;
}

/**
 * Does `text` name item `number` in explicit ref syntax — `#N`, `!N`, or an
 * item URL path `/issues/N`, `/merge_requests/N`, `/pull/N`? A number inside a
 * file name (`review-17049.md`), a branch (`17049-docs`) or prose ("17049")
 * does not (e2e A-B3).
 */
export function hasExplicitRefSyntax(text: string, number: number): boolean {
  const n = String(number);
  // `#N` / `!N` standing alone, or right after an `owner/repo` path (`acme/billing!17049`).
  if (new RegExp(`(?:^|[^&\\w]|[\\w.-]/[\\w.-]+)[#!]${n}(?!\\d)`).test(text)) return true;
  return new RegExp(`/(?:-/)?(?:issues|issue|merge_requests|pull|pulls|pull-requests)/${n}(?!\\d)`, "i").test(text);
}

/** A `gh issue|pr` command in a receipt, and whether it retargets its host (GH_HOST). */
const GH_COMMAND = /(?:^|[\s;&|(])gh\s+(?:issue|pr)\s/;
const GLAB_COMMAND = /(?:^|[\s;&|(])glab\s+(?:issue|mr)\s/;
const GH_HOST_ENV = /\bGH_HOST=/;
const URL_IN_RECEIPT = /https?:\/\/[^\s"'<>)\]]+/g;
const REPO_FLAG_WITH_HOST = /(?:^|\s)(?:-R|--repo)[=\s]+([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/([\w.-]+(?:\/[\w.-]+)+)/gi;

/**
 * v3 item 6 (d) + review B1, read time: a stored host-less `owner/repo#N` (written before refs
 * kept their host) gets a host only from evidence, strongest first:
 *   1. the row's own receipt: an item URL for this owner/repo + number, or `-R HOST/owner/repo`
 *      (one host only — two different hosts give none);
 *   2. the user's projects: exactly ONE `repo_identity` on this owner/repo (several hosts → none);
 *   3. the tool default: a `gh issue|pr` receipt with no GH_HOST → github.com.
 * A receipt's forge CLI must agree with a project host (gh with a github.com project, glab with a
 * non-github.com one); a conflict leaves the ref host-less (no link) — never a guessed forge.
 * Hosted refs, bare `#N` and non-ref text come back unchanged. Pure.
 */
export function hostlessRefQualifier(
  repoIdentities: Iterable<string | null | undefined>,
): (ref: string, evidenceQuote?: string | null) => string {
  const hostsByRepo = new Map<string, Set<string>>();
  for (const id of repoIdentities) {
    if (!id) continue;
    const segs = id.trim().replace(/\/+$/, "").split("/").filter(Boolean);
    if (segs.length < 3 || !HOSTLIKE.test(segs[0])) continue;
    const repo = segs.slice(1).join("/").toLowerCase();
    const set = hostsByRepo.get(repo) ?? new Set<string>();
    set.add(segs[0].toLowerCase());
    hostsByRepo.set(repo, set);
  }
  return (ref, evidenceQuote) => {
    const m = MARKED.exec(ref.trim());
    if (!m || !/^[\w.-]+(\/[\w.-]+)+$/.test(m[1])) return ref;
    if (HOSTLIKE.test(m[1].split("/")[0])) return ref;
    const repo = m[1].toLowerCase();
    const number = Number(m[3]);
    const receipt = evidenceQuote ?? "";
    const qualified = (host: string) => `${host}/${ref.trim()}`;

    // 1. The receipt's own host evidence for this item.
    const seen = new Set<string>();
    for (const u of receipt.match(URL_IN_RECEIPT) ?? []) {
      const c = canonicalItemRef(u, null);
      if (!c || c.number !== number) continue;
      const segs = c.ref.slice(0, c.ref.lastIndexOf("#")).split("/");
      if (segs.length >= 3 && HOSTLIKE.test(segs[0]) && segs.slice(1).join("/").toLowerCase() === repo)
        seen.add(segs[0].toLowerCase());
    }
    for (const f of receipt.matchAll(REPO_FLAG_WITH_HOST))
      if (f[2].toLowerCase() === repo) seen.add(f[1].toLowerCase());
    if (seen.size > 1) return ref;
    if (seen.size === 1) return qualified([...seen][0]);

    // 2. Exactly one of the user's projects on this owner/repo, agreeing with the receipt's CLI.
    const gh = GH_COMMAND.test(receipt);
    const glab = GLAB_COMMAND.test(receipt);
    const hosts = hostsByRepo.get(repo);
    if (hosts) {
      if (hosts.size !== 1) return ref;
      const host = [...hosts][0];
      const onGithub = host === "github.com";
      if ((gh && !onGithub && !GH_HOST_ENV.test(receipt)) || (glab && onGithub)) return ref;
      return qualified(host);
    }
    // 3. gh's default host.
    if (gh && !GH_HOST_ENV.test(receipt)) return qualified("github.com");
    return ref;
  };
}
