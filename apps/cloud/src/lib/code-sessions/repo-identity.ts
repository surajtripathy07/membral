// Repo-identity normalization — the CodeProject clustering key (ADR 0021 Q4).
//
// Precedence:
//   1. git remote URL, normalized to `host/owner/repo` (strip scheme,
//      credentials, trailing `.git`) — survives clones/moves/branch
//      switches; the durable key.
//   2. else a normalized absolute repo-root path (repos with no remote).
//   3. else (no cwd/path/remote at all) the per-user fallback bucket
//      `code-project:unassigned`.
//
// NOTE on division of labor (ADR Q4): Claude Code transcripts record `cwd`
// but never the git remote, so the CLI resolves the RAW remote URL locally
// by reading the cwd's `.git/config` where the repo actually exists — the
// cloud has no filesystem access to do that. This module only normalizes
// whatever `repo.remoteUrl` / `repo.path` the payload already carries into
// the canonical clustering key; it never touches a filesystem or network.

export interface RepoRef {
  path?: string | null;
  remoteUrl?: string | null;
}

export const UNASSIGNED_REPO_IDENTITY = "code-project:unassigned";

export function normalizeRepoIdentity(repo: RepoRef | null | undefined): string {
  const fromRemote = normalizeRemoteUrl(repo?.remoteUrl);
  if (fromRemote) return fromRemote;
  const fromPath = normalizePath(repo?.path);
  if (fromPath) return fromPath;
  return UNASSIGNED_REPO_IDENTITY;
}

/**
 * Normalize ONE caller-supplied repo string (the preamble hook's `repo`, a
 * tool's `project`) that may be either a remote URL or an absolute path.
 * An absolute path is always a path: passing it through normalizeRepoIdentity
 * as `remoteUrl` would parse "/private/tmp/x/notes" as "https:///private/..."
 * — host "private", identity "private/tmp/x/notes" — which never equals the
 * stored path identity "/private/tmp/x/notes" (e2e C-1: every non-git folder's
 * preamble said "No prior sessions recorded yet."). Import is unaffected: it
 * gets the remote and the path as separate fields.
 */
export function normalizeRepoArgument(arg: string | null | undefined): string {
  if (typeof arg === "string" && isAbsolutePath(arg.trim())) return normalizePath(arg) ?? UNASSIGNED_REPO_IDENTITY;
  return normalizeRepoIdentity({ remoteUrl: arg, path: arg });
}

/** True for a POSIX (`/x`) or Windows drive (`C:\x`, `C:/x`) absolute path. */
export function isAbsolutePath(s: string): boolean {
  return s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s);
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// scp-like ssh shorthand: [user@]host:owner/repo(.git)? — no scheme, a colon
// separates host from path. Excludes Windows drive-letter paths ("C:\...")
// by requiring the segment before the colon to contain no path separators.
const SCP_LIKE_RE = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/;

// Strip embedded credentials from a remote URL before it is stored at rest.
// `.git/config` remotes routinely embed `user:token@host` — the identity key
// already drops them (url.hostname/pathname exclude credentials), but the
// display column must too, or a share surface (/code view, scoped MCP) would
// exfiltrate the user's own git token.
export function sanitizeRemoteUrl(remoteUrl: string | null | undefined): string | null {
  if (typeof remoteUrl !== "string") return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  if (!SCHEME_RE.test(trimmed)) {
    // scp-like `user@host:path` — the `user@` here is an ssh login (usually
    // literal "git"), not a secret; only a password-bearing `user:pass@`
    // would be sensitive, and that form requires a scheme. Keep as-is.
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    // Unparseable with a scheme present — refuse to store what we can't vet.
    return null;
  }
}

function normalizeRemoteUrl(remoteUrl: string | null | undefined): string | null {
  if (typeof remoteUrl !== "string") return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  if (!SCHEME_RE.test(trimmed)) {
    const scpMatch = trimmed.match(SCP_LIKE_RE);
    if (scpMatch) {
      return buildIdentity(scpMatch[1], scpMatch[2]);
    }
  }

  try {
    const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    // url.hostname/pathname already exclude any `user:pass@` credentials.
    return buildIdentity(url.hostname, url.pathname);
  } catch {
    return null;
  }
}

function buildIdentity(host: string, rawPath: string): string | null {
  if (!host) return null;
  const path = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!path) return null;
  return `${host.toLowerCase()}/${path}`;
}

function normalizePath(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed) return null;

  if (!isAbsolutePath(trimmed)) return null; // relative path is not a stable key

  const slashed = trimmed.replace(/\\/g, "/");
  const collapsed = slashed.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return collapsed || "/";
}
