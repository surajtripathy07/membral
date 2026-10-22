#!/usr/bin/env bash
# scripts/plugin/stage-public-repo.sh <outdir> — stages the public
# marketplace repo (surajtripathy07/membral-plugin): the marketplace
# manifest, the plugin, the bundled CLI, and LICENSE. Nothing else.
#
# It bundles the CLI first (scripts/plugin/bundle-cli.mjs, which also checks
# the bundle for local paths, key shapes and scrub-list terms), then copies an
# explicit allowlist. It refuses a non-empty <outdir> or one inside this repo,
# any symlink among the sources, and any file in plugins/membral outside the
# allowlist (.DS_Store aside), so a new file is never published (or silently
# dropped) without editing this list. LICENSE is the repo's MIT text with the
# copyright holder set to "The Membral authors".
# It never runs git and never pushes.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <outdir>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"

ALLOW=(
  ".claude-plugin/marketplace.json"
  "plugins/membral/.claude-plugin/plugin.json"
  "plugins/membral/.mcp.json"
  "plugins/membral/hooks/hooks.json"
  "plugins/membral/scripts/run.mjs"
  "plugins/membral/scripts/membral.mjs"
  "plugins/membral/README.md"
)
# Present in this private repo, never published.
IGNORED_LOCAL=("plugins/membral/scripts/.gitignore")

created=0
[ -e "$1" ] || created=1
mkdir -p "$1"
OUT="$(cd "$1" && pwd -P)"
case "$OUT/" in
  "$ROOT"/*)
    [ "$created" -eq 1 ] && rmdir "$OUT"
    echo "stage-public-repo: refusing — $OUT is inside this repo" >&2
    exit 1
    ;;
esac
if [ -n "$(ls -A "$OUT")" ]; then
  echo "stage-public-repo: refusing — $OUT is not empty" >&2
  exit 1
fi

node "$ROOT/scripts/plugin/bundle-cli.mjs"

if [ -n "$(find "$ROOT/plugins/membral" "$ROOT/.claude-plugin" -type l)" ]; then
  echo "stage-public-repo: refusing — symlink(s) under plugins/membral or .claude-plugin:" >&2
  find "$ROOT/plugins/membral" "$ROOT/.claude-plugin" -type l | sed "s|^$ROOT/|  |" >&2
  exit 1
fi

# Every file under plugins/membral must be allowlisted or explicitly local.
unexpected=0
while IFS= read -r f; do
  rel="${f#"$ROOT"/}"
  ok=0
  for a in "${ALLOW[@]}" "${IGNORED_LOCAL[@]}"; do
    if [ "$rel" = "$a" ]; then ok=1; break; fi
  done
  if [ "$ok" -eq 0 ]; then
    echo "stage-public-repo: refusing — $rel is not in the allowlist" >&2
    unexpected=1
  fi
done < <(find "$ROOT/plugins/membral" -type f ! -name .DS_Store | sort)
[ "$unexpected" -eq 0 ] || exit 1

for a in "${ALLOW[@]}"; do
  if [ ! -f "$ROOT/$a" ] || [ -L "$ROOT/$a" ]; then
    echo "stage-public-repo: missing or not a regular file: $a" >&2
    exit 1
  fi
  mkdir -p "$OUT/$(dirname "$a")"
  cp "$ROOT/$a" "$OUT/$a"
done

if [ -L "$ROOT/LICENSE" ] || ! grep -q '^Copyright (c) [0-9]\{4\} ' "$ROOT/LICENSE"; then
  echo "stage-public-repo: LICENSE is a symlink or has no 'Copyright (c) <year> ' line" >&2
  exit 1
fi
sed 's/^Copyright (c) \([0-9]\{4\}\) .*/Copyright (c) \1 The Membral authors/' "$ROOT/LICENSE" > "$OUT/LICENSE"

echo "stage-public-repo: staged $(find "$OUT" -type f | wc -l | tr -d ' ') files in $OUT"
(cd "$OUT" && find . -type f | sort)
