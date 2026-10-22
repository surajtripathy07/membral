#!/usr/bin/env bash
# Test for scripts/check-doc-paths.mjs (architecture refactor programme 4.3b).
#
# Builds a tiny fixture tree + fixture doc in a temp dir and drives the
# checker through --root against it.
#
# (a) intentionally absent: the checker's verdict on the real docs is the
# gate's own "Doc paths" step. Asserting it here too made a real violation
# fail two steps (4.1c).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
checker="$repo_root/scripts/check-doc-paths.mjs"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/a"
echo "export const b = 1;" > "$tmp/a/b.ts"

doc="$tmp/doc.md"
cat > "$doc" <<'MD'
# Fixture doc

Real path: `a/b.ts`.

Missing path: `a/missing.ts`.

A URL, never checked: `http://x/y.ts`.

A TS alias, never checked: `@/lib/x.ts`.

A path with a line suffix, must resolve without it: `a/b.ts:12`.

<!-- doc-paths-ignore: z/ignored.md -->

An allowlisted path that does not exist: `z/ignored.md`.
MD

# (b) exactly one MISS, naming the missing path, exit 1.
set +e
out="$(node "$checker" --root "$tmp" "$doc" 2>&1)"
status=$?
set -e

if [[ "$status" -ne 1 ]]; then
  echo "FAIL: fixture with a missing path should exit 1, got $status" >&2
  echo "$out" >&2
  exit 1
fi

miss_count="$(grep -c '^MISS ' <<<"$out" || true)"
if [[ "$miss_count" -ne 1 ]]; then
  echo "FAIL: expected exactly one MISS line, got $miss_count" >&2
  echo "$out" >&2
  exit 1
fi
if [[ "$out" != *"MISS "*"a/missing.ts"* ]]; then
  echo "FAIL: MISS line does not name a/missing.ts" >&2
  echo "$out" >&2
  exit 1
fi
if [[ "$out" == *"z/ignored.md"*"MISS"* || "$out" == *"MISS"*"z/ignored.md"* ]]; then
  echo "FAIL: allowlisted path z/ignored.md should not be reported as a MISS" >&2
  echo "$out" >&2
  exit 1
fi
if [[ "$out" == *"y.ts"* || "$out" == *"x.ts"* ]]; then
  echo "FAIL: URL or TS-alias token should never have been checked" >&2
  echo "$out" >&2
  exit 1
fi

# (c) remove the missing reference; the fixture doc is clean.
sed -i.bak '/a\/missing\.ts/d' "$doc"
rm -f "$doc.bak"

if ! node "$checker" --root "$tmp" "$doc" >/dev/null; then
  echo "FAIL: fixture should exit 0 once the missing path is gone" >&2
  exit 1
fi

echo "PASS check-doc-paths.test.sh"
