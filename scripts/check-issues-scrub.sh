#!/usr/bin/env bash
set -euo pipefail

# GitHub-issue scrub guard (W5 backlog prune, 2026-09-12).
#
# Exports every issue in every state (title, body, comments) via `gh issue
# list` and greps each active term from the gitignored .claude/scrub-list.txt
# across titles, bodies and comment bodies, case-insensitively, as a fixed
# string per line.
#
# Redaction contract: this script's own output must never contain a full
# scrub-list term — a hit is reported as "#<issue>: <first 3 chars>…" only.
#
# Scrub-list format (matches scripts/check-scrub.sh):
#   - lines starting with '#'  -> comments / audit trail (ignored)
#   - lines starting with '!'  -> legacy known-contaminated path prefixes (ignored)
#   - anything else (non-empty) -> an active forbidden string
#
# If the scrub list is absent, exit 0 (nothing to check against).

REPO_ROOT="$(git rev-parse --show-toplevel)"
SCRUB_LIST="${REPO_ROOT}/.claude/scrub-list.txt"

if [ ! -f "$SCRUB_LIST" ]; then
  echo "check-issues-scrub: no scrub list at ${SCRUB_LIST} — nothing to check, OK"
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "check-issues-scrub: gh CLI not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "check-issues-scrub: jq not found" >&2; exit 1; }

ISSUES_JSON="$(gh issue list --state all --limit 300 --json number,title,body,comments)"
issue_count="$(printf '%s' "$ISSUES_JSON" | jq 'length')"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# One file per issue, named by issue number, containing title+body+all comment bodies.
printf '%s' "$ISSUES_JSON" | jq -r '.[] | "\(.number)"' | while IFS= read -r num; do
  printf '%s' "$ISSUES_JSON" | jq -r --arg n "$num" \
    '.[] | select((.number|tostring) == $n) | "\(.title)\n\(.body // "")\n" + ((.comments // []) | map(.body // "") | join("\n"))' \
    > "$WORKDIR/issue_${num}.txt"
done

status=0
while IFS= read -r term || [ -n "$term" ]; do
  case "$term" in
    ''|'#'*|'!'*) continue ;;
  esac
  hint="$(printf '%s' "$term" | cut -c1-3)…"

  for f in "$WORKDIR"/issue_*.txt; do
    [ -f "$f" ] || continue
    num="$(basename "$f" .txt | sed 's/^issue_//')"
    if grep -qiF -- "$term" "$f"; then
      echo "#${num}: ${hint}"
      status=1
    fi
  done
done < "$SCRUB_LIST"

if [ "$status" -ne 0 ]; then
  echo "check-issues-scrub: FAIL — forbidden content found (terms identified by line number in .claude/scrub-list.txt; hints truncated to 3 chars above)" >&2
  exit 1
fi

echo "check-issues-scrub: OK (${issue_count} issues)"
exit 0
