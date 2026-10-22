// Memory v1, step2d finding 2 (docs/goals/2026-09-13_memory-v1-build_goal.md;
// issue #151; maintainer reframe 2026-09-13: "why is home directory an issue
// anyway... isn't that just the path, and we anyway are gathering a lot of
// project info?"). `paths`/an outcome's `ref` are a CORRECTNESS concern, not
// a privacy one — `paths` is the record's repo-relative file list
// (design §2: `memory_search(path)`, the push's recently-edited-files
// overlap), and an absolute/off-repo path there is just noise in an indexed
// column, never a leak (`code_session_turns.file_path` already stores it
// verbatim for every turn). Shared by merge.ts (computePaths, the outcome
// `ref` relativizer) and scripts/memory/backfill.ts's `--repair-paths` (which
// rewrites already-stored rows the same way, with no LLM call).

/**
 * Repo-relative form of an absolute (or home-relative) `filePath` under
 * `repoPath` — `null` when `filePath` is empty, when it's outside
 * `repoPath` (or `repoPath` is unknown), or when it names the repo root
 * itself (not a useful "path"). An already-relative path is returned
 * unchanged. Used for `paths[]`, where an off-repo entry is DROPPED — it can
 * never match `memory_search(path)`'s repo-scoped lookup or the push's
 * recently-edited-files overlap, so keeping it is pure noise.
 */
export function toRepoRelativePath(filePath: string, repoPath: string | undefined): string | null {
  if (!filePath) return null;
  // Issue #161: a leading "./" is the same repo-relative path.
  if (filePath.startsWith("./")) return filePath.replace(/^(\.\/)+/, "") || null;
  if (!filePath.startsWith("/") && !filePath.startsWith("~")) return filePath;
  if (!repoPath) return null;
  if (filePath === repoPath) return null;
  if (filePath.startsWith(`${repoPath}/`)) return filePath.slice(repoPath.length + 1);
  return null;
}

/**
 * An outcome `ref` that is an absolute/home-relative path becomes
 * repo-relative when it's inside `repoPath`; one outside `repoPath` is kept
 * AS-IS — it is still a valid opener, just not this repo's own file
 * (step2d finding 2's reframe: an absolute path is not PII). A `ref` that
 * isn't path-shaped at all (a URL, a sha, an issue number, ...) is returned
 * unchanged.
 */
export function relativizeRefPath(ref: string, repoPath: string | undefined): string {
  if (ref.startsWith("./") && /^(\.\/)+[^\s/]/.test(ref) && !ref.includes("://")) return ref.replace(/^(\.\/)+/, "");
  if (!ref || (!ref.startsWith("/") && !ref.startsWith("~"))) return ref;
  if (repoPath && (ref === repoPath || ref.startsWith(`${repoPath}/`))) {
    const rel = ref.slice(repoPath.length).replace(/^\/+/, "");
    return rel || ref;
  }
  return ref;
}
