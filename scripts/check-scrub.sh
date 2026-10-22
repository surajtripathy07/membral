#!/usr/bin/env bash
set -euo pipefail

# Scrub guard (INV-9 equivalent) — local pre-commit defense for membral-608.
#
# Reads the UNTRACKED, gitignored string list at .claude/scrub-list.txt and
# blocks the commit if any active forbidden string appears in the staged index.
#
# Redaction contract: this script, its output, and the repo history must NEVER
# contain a forbidden string. Findings are reported by scrub-list LINE NUMBER
# and matching file paths only.
#
# Scrub-list format (see the file's own header):
#   - lines starting with '#'  -> comments / audit trail (ignored)
#   - lines starting with '!'  -> legacy known-contaminated path prefixes (ignored)
#   - anything else (non-empty) -> an active forbidden string
#
# If the scrub list is absent (fresh clone, CI), exit 0 silently: the guard is
# best-effort local defense for people who hold the list, not a contributor gate.

REPO_ROOT="$(git rev-parse --show-toplevel)"
SCRUB_LIST="${REPO_ROOT}/.claude/scrub-list.txt"

[ -f "$SCRUB_LIST" ] || exit 0

# Safety: the scrub list itself must never be tracked or staged.
if git ls-files --cached --error-unmatch ".claude/scrub-list.txt" >/dev/null 2>&1; then
  echo "scrub guard: FATAL — .claude/scrub-list.txt is tracked/staged. Unstage it (git rm --cached) before committing." >&2
  exit 1
fi

status=0
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  case "$line" in
    ''|'#'*|'!'*) continue ;;
  esac
  # Search the staged index (what this commit would contain), not the worktree.
  matches="$(git grep -I -l --cached --fixed-strings -e "$line" -- . 2>/dev/null || true)"
  if [ -n "$matches" ]; then
    echo "scrub guard: forbidden string (scrub-list line ${lineno}) found in staged content:" >&2
    printf '  %s\n' $matches >&2
    status=1
  fi
done < "$SCRUB_LIST"

if [ "$status" -ne 0 ]; then
  echo "scrub guard: commit blocked. Remove/redact the flagged content (strings are identified by line number in .claude/scrub-list.txt; never paste them into tracked files, commit messages, or this output)." >&2
fi
exit "$status"
