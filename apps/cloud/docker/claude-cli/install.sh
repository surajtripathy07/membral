#!/bin/sh
# Downloads the pinned Claude Code CLI from npm into /claude-cli (a named
# volume on the app service) for the local-only claude-code provider. The
# image itself carries no Claude Code: it is Anthropic's software under
# Anthropic's terms, fetched unmodified onto the user's own machine.
#
# Prints the binary's path on stdout only when a complete, working install is
# there; all messages go to stderr. Exits 0 on success and on failure (a
# failed download turns the provider off and the app boots anyway); only a
# signal ends it otherwise (143 for TERM, 130 for INT).
#
# `npm ci` installs exactly package-lock.json (integrity-checked tarballs)
# with --ignore-scripts, so no package script runs. The wrapper's postinstall
# would only copy the platform binary over a stub; the binary is used in
# place instead, from the platform's optional dependency. That package name
# is the glibc one (claude-code-linux-<arch>), hard-coded because the image
# is Debian bookworm; a musl (Alpine) base would need the -musl package.
#
# The pinned version is read from the lock, the one source of truth.
# MEMBRAL_CLAUDE_CLI_DIR, MEMBRAL_CLAUDE_CLI_SRC and MEMBRAL_CLAUDE_CLI_TIMEOUT_S
# exist for the tests.

DIR="${MEMBRAL_CLAUDE_CLI_DIR:-/claude-cli}"
SRC="${MEMBRAL_CLAUDE_CLI_SRC:-/app/docker/claude-cli}"
# Under the 300 s `membral local up` waits for the app, so a stuck download
# falls through to the failure path and the app still answers in time.
TIMEOUT_S="${MEMBRAL_CLAUDE_CLI_TIMEOUT_S:-240}"
RETRY="docker restart membral-app-1"
HOST="$(hostname 2>/dev/null || echo unknown)"

say() { echo "membral-entrypoint: $*" >&2; }
off() {
  say "Claude Code could not be downloaded from npm: $1. Extraction with the claude-code provider is off; use Ollama or your own key, or retry: ${RETRY}"
  exit 0
}
# Runs a command with only PATH and HOME (no app secret reaches it).
clean_env() { env -i PATH="$PATH" HOME="${DIR}/.npm-home" DISABLE_AUTOUPDATER=1 "$@"; }

VERSION="$(node -p "require('${SRC}/package-lock.json').packages['node_modules/@anthropic-ai/claude-code'].version" 2>/dev/null)"
[ -n "$VERSION" ] || off "the pinned version could not be read from ${SRC}/package-lock.json"

arch="$(node -p process.arch)"
pkg="@anthropic-ai/claude-code-linux-${arch}"
bin="${DIR}/node_modules/${pkg}/claude"

# .installed is written last, after the binary ran; a partial tree has none.
if [ -x "$bin" ] && [ "$(cat "${DIR}/.installed" 2>/dev/null)" = "$VERSION" ]; then
  echo "$bin"
  exit 0
fi

mkdir -p "$DIR" 2>/dev/null
[ -w "$DIR" ] || off "${DIR} is not writable"

# One installer at a time. The lock records its owner ("pid host"). It is
# stale when that owner is on this host and no longer running (a container
# restarted after a kill keeps its hostname), or, failing that, after 15 minutes.
lock="${DIR}/.lock"
if [ -d "$lock" ]; then
  owner_pid="" owner_host=""
  read -r owner_pid owner_host 2>/dev/null <"${lock}/owner"
  if [ "$owner_host" = "$HOST" ] && [ -n "$owner_pid" ] \
    && { [ "$owner_pid" = "$$" ] || ! kill -0 "$owner_pid" 2>/dev/null; }; then
    rm -rf "$lock"
  elif [ -n "$(find "$lock" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
    rm -rf "$lock"
  fi
fi
mkdir "$lock" 2>/dev/null || off "another install is running (remove ${lock} if none is)"
echo "$$ $HOST" >"${lock}/owner"

npm_pid=""
watchdog_pid=""
cleanup() {
  [ -n "$watchdog_pid" ] && kill "$watchdog_pid" 2>/dev/null
  rm -rf "$lock" "${DIR}/.npm-home"
}
on_signal() {
  [ -n "$npm_pid" ] && kill -TERM "$npm_pid" 2>/dev/null && wait "$npm_pid" 2>/dev/null
  rm -rf "${DIR}/node_modules" "${DIR}/.installed.tmp"
  cleanup
  trap - EXIT
  exit "$1"
}
trap cleanup EXIT
trap 'on_signal 143' TERM
trap 'on_signal 130' INT

say "downloading Claude Code ${VERSION} from npm (first start only)"
rm -rf "${DIR}/node_modules" "${DIR}/.installed" "${DIR}/.installed.tmp" "${DIR}/.npm-home" "${DIR}/.npmrc"
mkdir -p "${DIR}/.npm-home"
# Empty user and global configs (npm refuses the same file, /dev/null, for both).
: >"${DIR}/.npm-home/user-npmrc"
: >"${DIR}/.npm-home/global-npmrc"
cp "${SRC}/package.json" "${SRC}/package-lock.json" "$DIR/" 2>/dev/null || off "the pinned package files are missing from ${SRC}"
log="${DIR}/install.log"

# A minimal environment: the app's secrets never reach npm, and no .npmrc
# (user, global, or a project one in the volume, removed above) changes the
# registry or the install.
# npm warns EBADENGINE (the wrapper asks for node >= 22, the image has 20);
# that is expected and harmless, because the native binary is run directly
# and the wrapper's JavaScript never runs.
# npm runs in the background so a signal reaches this script (and is passed
# on), and a watchdog stops it after TIMEOUT_S.
rm -f "${DIR}/.timed-out"
clean_env npm ci --prefix "$DIR" --ignore-scripts --no-audit --no-fund \
  --registry=https://registry.npmjs.org/ \
  --userconfig="${DIR}/.npm-home/user-npmrc" --globalconfig="${DIR}/.npm-home/global-npmrc" \
  --engine-strict=false --cache "${DIR}/.npm-home/cache" \
  --fetch-retries 1 --fetch-retry-mintimeout 2000 --fetch-retry-maxtimeout 5000 >"$log" 2>&1 </dev/null &
npm_pid=$!
# The watchdog's stdio is detached so a leftover `sleep` never holds the caller's pipe open.
(sleep "$TIMEOUT_S" && : >"${DIR}/.timed-out" && kill -TERM "$npm_pid") >/dev/null 2>&1 </dev/null &
watchdog_pid=$!
wait "$npm_pid"
npm_rc=$?
npm_pid=""
kill "$watchdog_pid" 2>/dev/null
watchdog_pid=""

if [ -f "${DIR}/.timed-out" ]; then
  rm -f "${DIR}/.timed-out"
  rm -rf "${DIR}/node_modules"
  off "the download did not finish within ${TIMEOUT_S} s"
fi
if [ "$npm_rc" -eq 0 ]; then
  if [ -x "$bin" ] && clean_env "$bin" --version >/dev/null 2>&1; then
    echo "$VERSION" >"${DIR}/.installed.tmp" && mv "${DIR}/.installed.tmp" "${DIR}/.installed"
    say "Claude Code ${VERSION} is ready"
    echo "$bin"
    exit 0
  fi
  rm -rf "${DIR}/node_modules"
  off "${pkg} ${VERSION} did not install a working binary (see ${log})"
fi
rm -rf "${DIR}/node_modules"
# npm's own words: the network reason when there is one, else its first error lines.
reason="$(sed -n 's/^npm error .* failed, reason: //p' "$log" | head -n 1)"
[ -n "$reason" ] || reason="$(sed -n 's/^npm error //p' "$log" | grep -v '^A complete log' | head -n 2 | tr '\n' ' ' | sed 's/ $//')"
[ -n "$reason" ] || reason="npm ci failed (see ${log})"
off "$reason"
