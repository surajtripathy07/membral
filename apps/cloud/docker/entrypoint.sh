#!/bin/sh
# Container start for the Membral cloud image: swap the build-time sentinels
# for this install's NEXT_PUBLIC_* values, fetch Claude Code when the
# claude-code provider is chosen (never bundled; see claude-cli/install.sh),
# then run the Next.js server. MEMBRAL_DOCKER_DIR exists for the tests.
set -e
docker_dir="${MEMBRAL_DOCKER_DIR:-/app/docker}"
node "${docker_dir}/substitute-env.mjs"
if [ "${MEMBRAL_LLM_PROVIDER:-}" = "claude-code" ] && [ -z "${MEMBRAL_CLAUDE_BIN:-}" ]; then
  # In the background so a `docker stop` (SIGTERM to this PID 1) reaches the
  # installer, which cleans up its lock and partial tree.
  out="$(mktemp)"
  "${docker_dir}/claude-cli/install.sh" >"$out" &
  install_pid=$!
  trap 'kill -TERM "$install_pid" 2>/dev/null; wait "$install_pid" 2>/dev/null; rm -f "$out"; exit 143' TERM
  trap 'kill -INT "$install_pid" 2>/dev/null; wait "$install_pid" 2>/dev/null; rm -f "$out"; exit 130' INT
  wait "$install_pid" || true
  trap - TERM INT
  claude_bin="$(cat "$out")"
  rm -f "$out"
  if [ -n "$claude_bin" ]; then
    export MEMBRAL_CLAUDE_BIN="$claude_bin" DISABLE_AUTOUPDATER=1
  else
    # Read by the app (claude-code-provider.ts claudeCodeActivation): extraction
    # is off with a reason instead of every call failing on a missing binary.
    export MEMBRAL_CLAUDE_UNAVAILABLE=1
  fi
fi
exec "$@"
