#!/usr/bin/env bash
# Test for scripts/check-ratchets.mjs (architecture refactor programme 4.1a).
#
# Builds a tiny fixture tree + fixture ratchets.json in a temp dir (cheaper
# and faster than copying the real repo subtree) and drives the checker
# through --config/--root against it, exercising both ratchet modes:
#   F1 "max" - a count ratchet, like G1/G2/G4/G5.
#   F2 "set" - an exact-file-set ratchet, like G3.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
checker="$repo_root/scripts/check-ratchets.mjs"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/src"
echo "nothing interesting here" > "$tmp/src/good.txt"
echo "this file carries a KEEP_TOKEN reference" > "$tmp/src/keep.txt"

config="$tmp/ratchets.json"
cat > "$config" <<'JSON'
{
  "baselineSha": "fixture",
  "ratchets": [
    {
      "id": "F1",
      "description": "no BAD_TOKEN under src",
      "root": "src",
      "extensions": [".txt"],
      "match": "BAD_TOKEN",
      "pathExcludes": [],
      "mode": "max",
      "baseline": 0
    },
    {
      "id": "F2",
      "description": "exact set of files carrying KEEP_TOKEN",
      "root": "src",
      "extensions": [".txt"],
      "match": "KEEP_TOKEN",
      "pathExcludes": [],
      "mode": "set",
      "baseline": ["src/keep.txt"]
    }
  ]
}
JSON

# (a) intentionally absent: the checker's verdict on the real repo tree is the gate's own
# "Ratchets (G1-G5)" step. Asserting it here too made a real violation fail two steps (4.1c).

# (b) the clean fixture exits 0.
if ! node "$checker" --config "$config" --root "$tmp" >/dev/null; then
  echo "FAIL: clean fixture should exit 0" >&2
  exit 1
fi

# (c) add a violating file for the "max" ratchet and a new file for the
# "set" ratchet; both violations must be reported and the exit must be 1.
echo "this one has a BAD_TOKEN in it" > "$tmp/src/new-bad.txt"
echo "another KEEP_TOKEN sighting" > "$tmp/src/extra.txt"

set +e
out="$(node "$checker" --config "$config" --root "$tmp" 2>&1)"
status=$?
set -e

if [[ "$status" -ne 1 ]]; then
  echo "FAIL: violating fixture should exit 1, got $status" >&2
  echo "$out" >&2
  exit 1
fi
if [[ "$out" != *"src/new-bad.txt"* ]]; then
  echo "FAIL: output does not name the offending max-ratchet file" >&2
  echo "$out" >&2
  exit 1
fi
if [[ "$out" != *"src/extra.txt"* ]]; then
  echo "FAIL: output does not name the new set-ratchet file" >&2
  echo "$out" >&2
  exit 1
fi

# (d) --update rewrites the baselines to match the current tree, and the
# JSON on disk actually changed.
before="$(cat "$config")"
if ! node "$checker" --config "$config" --root "$tmp" --update >/dev/null; then
  echo "FAIL: --update should exit 0" >&2
  exit 1
fi
after="$(cat "$config")"
if [[ "$before" == "$after" ]]; then
  echo "FAIL: --update did not change the config" >&2
  exit 1
fi

# (e) checking again after --update is clean.
if ! node "$checker" --config "$config" --root "$tmp" >/dev/null; then
  echo "FAIL: fixture should exit 0 again after --update" >&2
  exit 1
fi

echo "PASS check-ratchets.test.sh"
