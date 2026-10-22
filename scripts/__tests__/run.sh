#!/usr/bin/env bash
# scripts/__tests__/run.sh — runs every scripts/__tests__/*.test.sh and
# reports pass/fail per file. Exits 1 if any test script fails.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
overall=0

shopt -s nullglob
tests=("$DIR"/*.test.sh)
shopt -u nullglob

if [ "${#tests[@]}" -eq 0 ]; then
  echo "run.sh: no *.test.sh files found in $DIR"
  exit 0
fi

for t in "${tests[@]}"; do
  name="$(basename "$t")"
  if bash "$t"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    overall=1
  fi
done

exit "$overall"
