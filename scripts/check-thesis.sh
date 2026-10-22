#!/usr/bin/env bash
# check-thesis.sh — one thesis, three surfaces.
#
# docs/PRODUCT.md is the source the README, the landing page and the CLI help
# all derive from. This script enforces the two mechanical parts of that:
#   1. the `Tagline: ...` line from PRODUCT.md appears verbatim on all three surfaces;
#   2. none of the retired vocabulary appears on any of them;
#   3. PRODUCT.md stays within its 150-line budget.
# Exits 0 and prints `check-thesis: OK` when everything passes.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

PRODUCT="docs/PRODUCT.md"
MAX_LINES=150
SURFACES=(
  "README.md"
  "apps/cloud/src/app/page.tsx"
  "packages/cli/src/help.ts"
)
FORBIDDEN=(
  "claim"
  "knowledge graph"
  "verified record"
  "coming soon"
  "second brain"
)

fail=0

if [ ! -f "$PRODUCT" ]; then
  if [ ! -d docs/design ] && [ ! -f docs/DECISIONS.md ]; then
    echo "check-thesis: SKIP — $PRODUCT is not in this tree (public mirror; the thesis source is private)."
    exit 0
  fi
  echo "check-thesis: FAIL — $PRODUCT does not exist (it is the source every surface derives from)."
  exit 1
fi

# --- 1. tagline extraction -------------------------------------------------
# The first line matching `Tagline: `; everything after that prefix is the tagline.
tagline="$(sed -n 's/^Tagline: //p' "$PRODUCT" | head -n 1)"
if [ -z "$tagline" ]; then
  echo "check-thesis: FAIL — $PRODUCT has no line starting with 'Tagline: '."
  echo "  Add one as the first line, e.g.: Tagline: <one sentence, <= 12 words>"
  exit 1
fi
echo "check-thesis: tagline from $PRODUCT:"
echo "  $tagline"

# --- 2. tagline appears verbatim on every surface --------------------------
for surface in "${SURFACES[@]}"; do
  if [ ! -f "$surface" ]; then
    echo "check-thesis: FAIL — surface $surface does not exist."
    fail=1
    continue
  fi
  if ! grep -qF -- "$tagline" "$surface"; then
    echo "check-thesis: FAIL — $surface does not contain the tagline verbatim."
    echo "  expected (fixed string): $tagline"
    echo "  fix: paste that exact line into $surface (it is the product's one-liner on every surface)."
    fail=1
  fi
done

# --- 3. retired vocabulary on the surfaces ---------------------------------
# Substring match, case-insensitive: `claim` must also catch `claims`, `Claims`.
for surface in "${SURFACES[@]}"; do
  [ -f "$surface" ] || continue
  for phrase in "${FORBIDDEN[@]}"; do
    hits="$(grep -in -- "$phrase" "$surface" || true)"
    if [ -n "$hits" ]; then
      echo "check-thesis: FAIL — forbidden phrase '$phrase' in $surface:"
      while IFS= read -r line; do
        echo "  $surface:$line"
      done <<< "$hits"
      fail=1
    fi
  done
done

# --- 4. PRODUCT.md length budget -------------------------------------------
lines="$(wc -l < "$PRODUCT" | tr -d ' ')"
if [ "$lines" -gt "$MAX_LINES" ]; then
  echo "check-thesis: FAIL — $PRODUCT is $lines lines, over the $MAX_LINES-line limit."
  fail=1
else
  echo "check-thesis: $PRODUCT is $lines lines (limit $MAX_LINES)."
fi

if [ "$fail" -ne 0 ]; then
  echo "check-thesis: FAILED"
  exit 1
fi

echo "check-thesis: OK"
