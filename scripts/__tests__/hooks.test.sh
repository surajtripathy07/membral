#!/usr/bin/env bash
# scripts/__tests__/hooks.test.sh — G4 4.2 (D3).
#
# Exercises .githooks/pre-commit's handoff-shrink guard and
# .githooks/commit-msg's subject-length guard inside a scratch git repo, so
# the assertions never touch this repo's real history or docs/HANDOFF.md.
#
# The scrub guard in both hooks no-ops when .claude/scrub-list.txt is
# missing (see the hooks' own headers and scripts/check-scrub.sh) — the
# scratch repo deliberately has no .claude/ dir, so that guard is inert here
# without needing a fixture list.
set -euo pipefail

# Hooks (and any git command a hook runs) inherit these from the invoking
# git process; left set, a `git init`/`git commit` inside the scratch repo
# would silently operate on THIS repo instead.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_REPO="$(mktemp -d)"
trap 'rm -rf "$TMP_REPO"' EXIT

fail() {
  echo "FAIL hooks.test.sh: $1" >&2
  exit 1
}

cd "$TMP_REPO"
git init -q -b main
git config user.name "Hook Test"
git config user.email "hook-test@example.com"

cp -R "$REPO_ROOT/.githooks" .githooks
chmod +x .githooks/pre-commit .githooks/commit-msg
git config core.hooksPath .githooks

mk_lines() {
  # mk_lines <prefix> <count> -> N distinct lines, one per line
  local prefix="$1" count="$2" i
  for ((i = 1; i <= count; i++)); do
    echo "${prefix} ${i}"
  done
}

# --- (a) a normal commit passes ---
echo "hello" > README.md
git add README.md
git commit -q -m "docs: add readme" \
  || fail "(a) a normal commit was blocked"
echo "PASS (a) normal commit"

# --- (b) HANDOFF.md shrink >50% right after a HANDOFF commit is blocked ---
mk_lines "old line" 20 > docs_HANDOFF_tmp
mkdir -p docs
mv docs_HANDOFF_tmp docs/HANDOFF.md
git add docs/HANDOFF.md
git commit -q -m "docs: seed handoff" \
  || fail "(b) seeding docs/HANDOFF.md was blocked"

mk_lines "new line" 5 > docs/HANDOFF.md
git add docs/HANDOFF.md
set +e
out_b="$(git commit -m "docs: overwrite handoff" 2>&1)"
status_b=$?
set -e
[ "$status_b" -ne 0 ] || fail "(b) shrink commit was NOT blocked"
echo "$out_b" | grep -qi "shrink" || fail "(b) block message did not mention 'shrink': $out_b"
echo "PASS (b) shrink within 24h is blocked"

# --- (c) same shrink, bypassed with HANDOFF_OVERWRITE=1, passes ---
HANDOFF_OVERWRITE=1 git commit -q -m "docs: overwrite handoff (bypass)" \
  || fail "(c) HANDOFF_OVERWRITE=1 did not allow the shrink"
echo "PASS (c) HANDOFF_OVERWRITE=1 bypass"

# --- (d) shrink is allowed when the previous HANDOFF commit is >24h old ---
mk_lines "old-again line" 15 >> docs/HANDOFF.md   # append only: no deletions
git add docs/HANDOFF.md
two_days_ago_epoch="$(( $(date +%s) - 2 * 86400 ))"
GIT_COMMITTER_DATE="@${two_days_ago_epoch} +0000" \
  git commit -q -m "docs: grow handoff (old)" \
  || fail "(d) seeding the old handoff commit was blocked"

mk_lines "final line" 3 > docs/HANDOFF.md
git add docs/HANDOFF.md
git commit -q -m "docs: shrink stale handoff" \
  || fail "(d) shrink after a >24h-old handoff commit was blocked"
echo "PASS (d) shrink after a stale handoff commit is allowed"

# --- (e) commit subject length guard ---
echo "e" >> README.md
git add README.md
subj73="$(printf 'x%.0s' $(seq 1 73))"
set +e
out_e1="$(git commit -m "$subj73" 2>&1)"
status_e1=$?
set -e
[ "$status_e1" -ne 0 ] || fail "(e) a 73-char subject was NOT blocked"
echo "$out_e1" | grep -q "73" || fail "(e) block message did not report length 73: $out_e1"
echo "PASS (e1) 73-char subject blocked"

subj72="$(printf 'x%.0s' $(seq 1 72))"
git commit -q -m "$subj72" \
  || fail "(e) a 72-char subject was blocked"
echo "PASS (e2) 72-char subject passes"

echo "f" >> README.md
git add README.md
COMMIT_SUBJECT_OK=1 git commit -q -m "$subj73" \
  || fail "(e) COMMIT_SUBJECT_OK=1 did not allow a 73-char subject"
echo "PASS (e3) COMMIT_SUBJECT_OK=1 bypass"

# --- (e4) merge commits are exempt from the subject length guard ---
# Long branch name so git's default merge subject ("Merge branch '<name>'
# into main") is itself over 72 chars, like the real-world
# "Merge remote-tracking branch 'origin/...' into ..." case this guards.
long_branch="feature-branch-with-a-very-long-name-to-push-the-subject-past-72-chars"
git branch "$long_branch"
git checkout -q "$long_branch"
echo "feature" > feature-file.txt
git add feature-file.txt
git commit -q -m "docs: feature change" \
  || fail "(e4) seeding the feature branch commit was blocked"
git checkout -q main

echo "main-side" > main-side-file.txt
git add main-side-file.txt
git commit -q -m "docs: main-side change" \
  || fail "(e4) seeding the main-side commit was blocked"

git merge --no-edit "$long_branch" \
  || fail "(e4) merge commit was blocked despite the exempt default subject"
git rev-parse -q --verify HEAD^2 >/dev/null \
  || fail "(e4) merge commit does not exist (HEAD^2 missing)"
echo "PASS (e4) merge commit exempt"

echo "PASS hooks.test.sh"
