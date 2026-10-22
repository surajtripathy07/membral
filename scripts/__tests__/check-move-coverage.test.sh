#!/usr/bin/env bash
# Runs scripts/check-move-coverage.mjs --self-test (incl. import-only diff -> 0 branches, #195).
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node "$repo_root/scripts/check-move-coverage.mjs" --self-test
node "$repo_root/scripts/check-pure-move.mjs" --self-test
