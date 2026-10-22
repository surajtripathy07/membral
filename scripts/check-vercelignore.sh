#!/usr/bin/env bash
# check-vercelignore.sh — round-3 review HIGH 18.
#
# `vercel --prod` uploads the local working directory regardless of git
# tracking (unlike a git-push-triggered deploy), so .vercelignore has to
# independently exclude everything .gitignore excludes — a pattern present
# in .gitignore but missing from .vercelignore doesn't just skip a commit,
# it ships whatever matches that pattern (secrets, real corpus data, PII)
# straight into the Vercel build source. This script fails (non-zero exit)
# if any .gitignore pattern is missing from .vercelignore, so the two files
# cannot silently drift apart again the way they did before this fix (see
# .vercelignore's header for what actually leaked: spike-k89/output,
# prompt-lab/transcripts, handoff_6_april_5.txt, MEMBRAL.md).
#
# Usage: scripts/check-vercelignore.sh [-v]
#   -v   also print every pattern that IS covered (verbose/debug)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

GITIGNORE=".gitignore"
VERCELIGNORE=".vercelignore"
verbose=0
[[ "${1:-}" == "-v" ]] && verbose=1

if [[ ! -f "$GITIGNORE" ]]; then
  echo "check-vercelignore: $GITIGNORE not found" >&2
  exit 1
fi
if [[ ! -f "$VERCELIGNORE" ]]; then
  echo "check-vercelignore: $VERCELIGNORE not found" >&2
  exit 1
fi

missing=()
covered=0

# Every non-comment, non-blank line in .gitignore is a pattern (negations
# included — a negation missing from .vercelignore is still a semantic
# drift worth flagging, even though .vercelignore is free to choose not to
# preserve it; today's .vercelignore keeps it for fidelity).
while IFS= read -r pattern; do
  [[ -z "$pattern" ]] && continue
  if grep -qxF -- "$pattern" "$VERCELIGNORE"; then
    covered=$((covered + 1))
    [[ $verbose -eq 1 ]] && echo "  ok: $pattern"
  else
    missing+=("$pattern")
  fi
done < <(grep -vE '^[[:space:]]*(#.*)?$' "$GITIGNORE")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "check-vercelignore: FAILED — ${#missing[@]} .gitignore pattern(s) are missing from .vercelignore:" >&2
  for p in "${missing[@]}"; do
    echo "  MISSING: $p" >&2
  done
  echo "" >&2
  echo "Add the pattern(s) above to .vercelignore's verbatim-copy section (see its header comment)." >&2
  exit 1
fi

echo "check-vercelignore: OK — .vercelignore covers all $covered pattern(s) from .gitignore"
