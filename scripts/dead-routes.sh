#!/usr/bin/env bash
# dead-routes.sh — lists API routes under apps/cloud/src/app/api/ whose URL
# path is referenced nowhere else in the code this repo controls (the
# cloud app itself, the CLI, the extension). Written for the 2026-09-12
# refocus goal's kill list (W2): after deleting the bridge and /api/spike,
# find anything else orphaned the same way.
#
# Method: for each route.ts, derive its URL path from the file path
# (stripping the apps/cloud/src/app prefix and /route.ts suffix). A dynamic
# `[param]` segment becomes a `/` prefix match up to and including the
# static segment before it — e.g. `/api/keys/devices/[id]/route.ts` is
# checked as a reference to `/api/keys/devices/` (since the concrete id is
# only ever known at runtime, never spelled out in a caller's source). Then
# grep every OTHER TypeScript file in apps/cloud/src, packages/cli/src, and
# packages/extension/src for that path string, excluding the route file
# itself and any __tests__ directory (a route calling itself in its own
# test doesn't make it reachable from the product).
#
# Routes that are entry points BY DESIGN — nothing in this repo's source
# ever needs to spell out their path because an external caller (a
# webhook, a cron scheduler, a browser typing a URL) hits them directly —
# are allow-listed below with a comment naming that caller. Everything
# else with zero references prints as dead.
#
# Deliberately bash 3.2-compatible (no associative arrays, no mapfile) —
# macOS ships bash 3.2 as /bin/bash and this script is meant to be run
# with the plain `bash` on the maintainer's own machine, not a Homebrew
# bash 4+/5.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

API_ROOT="apps/cloud/src/app/api"

# --- Allow-list: routes that are reachable with no in-repo string
# reference to their path, because the caller is external or the path is
# assembled/dispatched a way grep can't see. Each entry names the caller.
is_allowlisted() {
  case "$1" in
    # The MCP HTTP endpoint itself — external MCP clients (Claude Desktop,
    # Cursor, Claude Code) call this directly using the URL from Settings ->
    # MCP config (components/mcp-config.tsx), not a fetch() in this repo.
    "/api/mcp") return 0 ;;
    # A manual uptime/liveness probe — hit by an operator's curl or an
    # external monitor, never fetched from within the app itself.
    "/api/health") return 0 ;;
    *) return 1 ;;
  esac
}

find "$API_ROOT" -name 'route.ts' | sort | while IFS= read -r route_file; do
  # URL path: strip the app-router prefix and /route.ts suffix.
  url_path="${route_file#"$API_ROOT"}"
  url_path="${url_path%/route.ts}"
  url_path="/api${url_path}"

  if is_allowlisted "$url_path"; then
    continue
  fi

  # Build the search pattern: for a dynamic `[param]` segment, only check
  # the literal prefix up to (and including) the "/" right before it — a
  # caller can never spell out the concrete value in source.
  search_path="$url_path"
  case "$search_path" in
    *"["*) search_path="${search_path%%\[*}" ;;
  esac

  found=0
  for dir in apps/cloud/src packages/cli/src packages/extension/src; do
    [[ -d "$dir" ]] || continue
    if grep -rl --include='*.ts' --include='*.tsx' -F -- "$search_path" "$dir" 2>/dev/null \
        | grep -v -- "$route_file" \
        | grep -v '/__tests__/' \
        | grep -q .; then
      found=1
      break
    fi
  done

  if [[ "$found" -eq 0 ]]; then
    echo "$url_path  (from $route_file)"
  fi
done
