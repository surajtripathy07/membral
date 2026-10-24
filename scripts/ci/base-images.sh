#!/usr/bin/env bash
# scripts/ci/base-images.sh — CI's access to the third-party images listed in
# .github/base-images.txt, without depending on anonymous registry quota.
#
#   mirror            copy each upstream (or a fallback) to its GHCR mirror;
#                     skips an image whose mirror already has the same digest
#   prepare [name..]  docker pull each image from its mirror, else upstream,
#                     else a fallback, and tag it as the upstream ref, so
#                     `docker compose up` (pull_policy: missing) uses it as is
#   resolve <name>    print the first reachable ref (mirror, then upstream) for
#                     a buildx build arg; prints the upstream ref if none is
#   check             fail when an image used in the Dockerfile or the CLI's
#                     local stack is missing from the list
#
# Retries: a transient failure (429, timeouts) is retried RETRY_ATTEMPTS times
# (default 3) with exponential sleep from RETRY_DELAY_S (default 15s). A
# permanent one (denied, unauthorized, not found) moves to the next source at
# once, so a fork PR that cannot read the mirror falls back without waiting.
set -euo pipefail

ROOT="${BASE_IMAGES_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LIST="$ROOT/.github/base-images.txt"
OWNER="${MIRROR_OWNER:-surajtripathy07}"
ATTEMPTS="${RETRY_ATTEMPTS:-3}"
DELAY="${RETRY_DELAY_S:-15}"
# Errors that mean "this source will not work": move on without retrying.
PERMANENT='denied|unauthorized|not found|manifest unknown|no such|invalid reference'

rows() { grep -vE '^[[:space:]]*(#|$)' "$LIST"; }

mirror_ref() { echo "ghcr.io/$OWNER/membral-mirror-$1:${2##*:}"; }

# try <cmd...>: run with retries on transient errors; output to stderr.
try() {
  local n=1 out d
  while :; do
    if out=$("$@" 2>&1); then
      return 0
    fi
    printf '%s\n' "$out" | tail -n 3 | sed 's/^/    /' >&2
    if grep -qiE "$PERMANENT" <<<"$out"; then
      return 1
    fi
    if ((n >= ATTEMPTS)); then return 1; fi
    d=$((DELAY * (1 << (n - 1))))
    echo "  attempt $n of $ATTEMPTS failed; retrying in ${d}s" >&2
    sleep "$d"
    n=$((n + 1))
  done
}

digest() {
  local raw
  raw=$(docker buildx imagetools inspect --raw "$1" 2>/dev/null) || return 1
  printf "%s" "$raw" | sha256sum | cut -d" " -f1
}

cmd_mirror() {
  local failed=0 name up rest dst src have want
  while read -r name up rest; do
    dst=$(mirror_ref "$name" "$up")
    have=$(digest "$dst" || true)
    want=""
    # shellcheck disable=SC2086
    for src in "$up" $rest; do
      want=$(digest "$src" || true)
      [[ -z "$want" ]] || break
    done
    if [[ -n "$have" && "$have" == "$want" ]]; then
      echo "= $dst is current"
      continue
    fi
    local ok=0
    # shellcheck disable=SC2086 # rest is a space-separated list of sources
    for src in "$up" $rest; do
      echo "> $src -> $dst"
      # GHCR answers a push to a package it is still creating with a transient
      # "denied", so only a missing source is permanent here.
      if PERMANENT='not found|manifest unknown|invalid reference' try docker buildx imagetools create -t "$dst" "$src"; then
        ok=1
        break
      fi
    done
    if ((ok == 0)); then
      echo "::error::could not mirror $name from any source"
      failed=1
    fi
  done < <(rows)
  return "$failed"
}

cmd_prepare() {
  local failed=0 name up rest src want=" $* "
  while read -r name up rest; do
    if (($# > 0)) && [[ "$want" != *" $name "* ]]; then continue; fi
    local got=""
    # shellcheck disable=SC2086
    for src in "$(mirror_ref "$name" "$up")" "$up" $rest; do
      echo "> pull $src"
      if try docker pull -q "$src"; then
        got="$src"
        break
      fi
    done
    if [[ -z "$got" ]]; then
      echo "::warning::could not pull $name from any source; compose will try $up itself"
      failed=1
      continue
    fi
    [[ "$got" == "$up" ]] || docker tag "$got" "$up"
    echo "  $name: $got"
  done < <(rows)
  # Never fatal: `local up` pulls whatever is still missing (with its own retries).
  ((failed == 0)) || true
}

cmd_resolve() {
  local name="${1:?resolve needs an image name}" n up rest src
  while read -r n up rest; do
    [[ "$n" == "$name" ]] || continue
    for src in "$(mirror_ref "$n" "$up")" "$up"; do
      if try docker buildx imagetools inspect "$src"; then
        echo "$src"
        return 0
      fi
    done
    echo "::warning::no source for $name answered; building from $up" >&2
    echo "$up"
    return 0
  done < <(rows)
  echo "unknown image name: $name" >&2
  return 1
}

cmd_check() {
  local listed used ref missing=0
  listed=$(rows | awk '{print $2}')
  used=$(
    {
      grep -oE 'public\.ecr\.aws/[^"[:space:]]+' "$ROOT/packages/cli/src/local-stack.ts"
      grep -oE '^ARG NODE_IMAGE=[^[:space:]]+' "$ROOT/apps/cloud/Dockerfile" | cut -d= -f2
    } | sort -u
  )
  for ref in $used; do
    if ! grep -qxF "$ref" <<<"$listed"; then
      echo "base-images: $ref is used but missing from .github/base-images.txt" >&2
      missing=1
    fi
  done
  ((missing == 0)) && echo "base-images: every used image is listed"
  return "$missing"
}

case "${1:-}" in
  mirror) cmd_mirror ;;
  prepare) shift; cmd_prepare "$@" ;;
  resolve) shift; cmd_resolve "$@" ;;
  check) cmd_check ;;
  *) echo "usage: $0 mirror | prepare [name...] | resolve <name> | check" >&2; exit 2 ;;
esac
