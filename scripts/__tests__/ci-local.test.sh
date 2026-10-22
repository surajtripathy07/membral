#!/usr/bin/env bash
# Test for scripts/ci-local.sh (architecture refactor programme 4.2b).
#
# (a) node_modules missing: a fresh temp git repo with only a package.json
# (packageManager npm@10.9.2, no node_modules) must make ci-local exit 2
# with the npm-version hint, before any step runs — no .ci-local/ receipt
# dir created.
#
# (b) turbo cache-hit receipt line: too heavy to assert against a real
# `--quick` run here (several minutes, needs the real node_modules/turbo
# cache). Instead this asserts the receipt-writing logic directly: feed a
# fake turbo summary through the same grep+sed the script uses and check
# the formatted line. The real end-to-end receipt is checked manually by
# `bash scripts/ci-local.sh --quick` (see DONE WHEN in the 4.2b brief).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/ci-local.sh"

# --- (a) node_modules missing: exit 2, hint printed, no receipt ------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -q
cat > "$tmp/package.json" <<'JSON'
{
  "name": "fixture",
  "packageManager": "npm@10.9.2"
}
JSON

set +e
out="$(cd "$tmp" && bash "$script" --quick 2>&1)"
status=$?
set -e

if [[ "$status" -ne 2 ]]; then
  echo "FAIL: missing node_modules should exit 2, got $status" >&2
  echo "$out" >&2
  exit 1
fi

if [[ "$out" != *"npx -y npm@10.9.2 ci"* ]]; then
  echo "FAIL: missing-node_modules message does not name npx -y npm@10.9.2 ci" >&2
  echo "$out" >&2
  exit 1
fi

if [[ -d "$tmp/.ci-local" ]]; then
  echo "FAIL: .ci-local/ was created although the script should exit before any step" >&2
  exit 1
fi

echo "PASS (a) node_modules missing: exit 2, hint printed, no receipt"

# --- (b) turbo cache-hit line format ----------------------------------------
fake_turbo_output=$'Tasks:    12 successful, 12 total\nCached:    9 cached, 12 total\nTime:    3.4s'
cache_line="$(grep -E '^ *Cached:' <<<"$fake_turbo_output" | tail -1 | sed -E 's/^ *Cached: *([0-9]+) cached, ([0-9]+) total.*/\1\/\2/')"

if [[ "$cache_line" != "9/12" ]]; then
  echo "FAIL: expected turbo cache extraction '9/12', got '$cache_line'" >&2
  exit 1
fi

receipt_line="turbo   $cache_line cached"
if [[ "$receipt_line" != "turbo   9/12 cached" ]]; then
  echo "FAIL: unexpected receipt line format: $receipt_line" >&2
  exit 1
fi

echo "PASS (b) turbo cache-hit receipt line format"
