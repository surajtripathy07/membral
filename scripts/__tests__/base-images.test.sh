#!/usr/bin/env bash
# Test for scripts/ci/base-images.sh `check`: a fixture tree whose
# Dockerfile and local-stack.ts use images, against a list that does and does
# not name them, and the permanent-error classification. No docker needed.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/ci/base-images.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.github" "$tmp/apps/cloud" "$tmp/packages/cli/src"
echo 'ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20' > "$tmp/apps/cloud/Dockerfile"
echo '  gateway: "public.ecr.aws/docker/library/caddy:2",' > "$tmp/packages/cli/src/local-stack.ts"

printf '%s\n' '# comment' \
  'node  public.ecr.aws/docker/library/node:20  docker.io/library/node:20' \
  'caddy public.ecr.aws/docker/library/caddy:2' > "$tmp/.github/base-images.txt"
BASE_IMAGES_ROOT="$tmp" bash "$script" check >/dev/null || { echo "check failed on a complete list"; exit 1; }

printf '%s\n' 'node public.ecr.aws/docker/library/node:20' > "$tmp/.github/base-images.txt"
if BASE_IMAGES_ROOT="$tmp" bash "$script" check 2>/dev/null; then
  echo "check passed with caddy missing from the list"
  exit 1
fi

# Permanent vs transient: network errors are retried, missing manifests are not.
for msg in \
  'dial tcp: lookup ghcr.io on 127.0.0.53:53: no such host' \
  'toomanyrequests: Data limit exceeded' \
  'net/http: TLS handshake timeout'; do
  if printf '%s\n' "$msg" | bash "$script" is-permanent; then
    echo "treated as permanent: $msg"
    exit 1
  fi
done
for msg in \
  'ERROR: docker.io/library/node:99-nope: not found' \
  'manifest unknown: manifest unknown' \
  'Error response from daemon: manifest for ghcr.io/x/y:1 not found: manifest unknown' \
  'denied: requested access to the resource is denied' \
  'unauthorized: authentication required'; do
  if ! printf '%s\n' "$msg" | bash "$script" is-permanent; then
    echo "treated as transient: $msg"
    exit 1
  fi
done
