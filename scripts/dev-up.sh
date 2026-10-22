#!/usr/bin/env bash
#
# dev-up.sh — idempotent local dev bring-up for a fresh clone of this repo.
# Checks prerequisites, starts the local Supabase stack, writes
# apps/cloud/.env.local from `supabase status` if it doesn't already exist,
# and prints next steps. Safe to re-run.
#
# This script NEVER calls `supabase db reset`, `supabase stop`, or anything
# destructive — it only starts things and reads status. If your local
# Supabase project already has data in it, running this again will not
# touch it.
#
# See docs/SELF-HOSTING.md for the full guide (extension, CLI, MCP, LLM
# pipeline) — this script only covers steps 1-4 of that guide (install,
# supabase start, .env.local, build).
#
# Usage: ./scripts/dev-up.sh [--port <cloud-app-port>]
#   --port   Port to write into .env.local's NEXT_PUBLIC_APP_URL and to
#            print in the "next steps" hint (default: 3001).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD_DIR="$REPO_ROOT/apps/cloud"
PORT=3001

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

log "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "Node.js not found — install Node 20 (https://nodejs.org)."
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  die "Node $NODE_MAJOR found — this repo needs Node 18+ (20 recommended). See docs/SELF-HOSTING.md."
elif [[ "$NODE_MAJOR" -lt 20 ]]; then
  warn "Node $NODE_MAJOR found — works, but Node 20 is recommended (matches CI)."
fi

command -v npm >/dev/null 2>&1 || die "npm not found — it ships with Node."

command -v docker >/dev/null 2>&1 || die "Docker not found — install Docker Desktop (or a compatible engine); the local Supabase stack runs as containers."
docker info >/dev/null 2>&1 || die "Docker is installed but not running — start Docker Desktop and re-run this script."

if ! npx --no-install supabase --version >/dev/null 2>&1 && ! command -v supabase >/dev/null 2>&1; then
  log "Supabase CLI not found as a dependency yet — 'npm install' below will fetch it (it's a devDependency of apps/cloud)."
fi

log "Installing workspace dependencies (npm install)"
cd "$REPO_ROOT"
npm install

log "Preparing apps/cloud/supabase/.env (local-dev URL defaults for config.toml)"
if [[ ! -f "$CLOUD_DIR/supabase/.env" ]]; then
  cp "$CLOUD_DIR/supabase/.env.example" "$CLOUD_DIR/supabase/.env"
  # round-3 review MED 28: .env.example hardcodes port 3000, but this
  # script's own --port default is 3001 — left un-synced, a fresh clone
  # gets an app on 3001 with Supabase's Site URL/redirect allow-list still
  # pointing at 3000, so every confirmation/password-reset link lands on a
  # dead port. Rewrite both URLs to the port this run actually uses.
  sed -i.bak \
    -e "s#^SUPABASE_SITE_URL=.*#SUPABASE_SITE_URL=http://127.0.0.1:${PORT}#" \
    -e "s#^SUPABASE_ADDITIONAL_REDIRECT_URL=.*#SUPABASE_ADDITIONAL_REDIRECT_URL=http://127.0.0.1:${PORT}#" \
    "$CLOUD_DIR/supabase/.env"
  rm -f "$CLOUD_DIR/supabase/.env.bak"
  log "Wrote apps/cloud/supabase/.env from .env.example (Site URL/redirect pinned to port ${PORT})"
else
  log "apps/cloud/supabase/.env already exists — leaving it alone"
fi

log "Installing git hooks (core.hooksPath -> .githooks)"
git config core.hooksPath .githooks
log "Hooks active — .githooks/pre-commit (scrub guard, no-op without .claude/scrub-list.txt) + .githooks/commit-msg"

log "Starting local Supabase (npx supabase start) — this is idempotent; if it's already running, it's a no-op"
cd "$CLOUD_DIR"
npx supabase start

log "Reading connection info (npx supabase status -o env)"
STATUS_ENV="$(npx supabase status -o env 2>/dev/null)"
ANON_KEY="$(echo "$STATUS_ENV" | grep '^ANON_KEY=' | cut -d'"' -f2)"
SERVICE_ROLE_KEY="$(echo "$STATUS_ENV" | grep '^SERVICE_ROLE_KEY=' | cut -d'"' -f2)"
API_URL="$(echo "$STATUS_ENV" | grep '^API_URL=' | cut -d'"' -f2)"

if [[ -z "$ANON_KEY" || -z "$SERVICE_ROLE_KEY" || -z "$API_URL" ]]; then
  die "Could not parse 'supabase status -o env' output — run 'npx supabase status -o env' yourself from apps/cloud and fill apps/cloud/.env.local by hand (see docs/SELF-HOSTING.md step 2/3)."
fi

if [[ -f "$CLOUD_DIR/.env.local" ]]; then
  log "apps/cloud/.env.local already exists — leaving it alone (delete it and re-run if you want it regenerated)"
else
  log "Writing apps/cloud/.env.local"
  cp "$CLOUD_DIR/.env.example" "$CLOUD_DIR/.env.local"
  # macOS/BSD sed and GNU sed both accept this form with a backup suffix arg.
  sed -i.bak \
    -e "s#^NEXT_PUBLIC_SUPABASE_URL=.*#NEXT_PUBLIC_SUPABASE_URL=${API_URL}#" \
    -e "s#^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*#NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}#" \
    -e "s#^SUPABASE_SERVICE_ROLE_KEY=.*#SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}#" \
    -e "s#^NEXT_PUBLIC_APP_URL=.*#NEXT_PUBLIC_APP_URL=http://localhost:${PORT}#" \
    "$CLOUD_DIR/.env.local"
  rm -f "$CLOUD_DIR/.env.local.bak"
  log "Wrote apps/cloud/.env.local (OPENAI_API_KEY left blank — see docs/SELF-HOSTING.md step 3 for what does/doesn't need it)"
fi

log "Building the workspace (npx turbo build)"
cd "$REPO_ROOT"
npx turbo build

cat <<EOF

──────────────────────────────────────────────────────────────────────────
Next steps
──────────────────────────────────────────────────────────────────────────
1. Start the cloud app:
     npm run dev --workspace=@membral/cloud -- -p ${PORT}

2. Sign up:
     open http://localhost:${PORT}/signup

3. (optional) Build + load the Chrome extension — see docs/SELF-HOSTING.md
   step 6 (it needs VITE_CLOUD_URL/VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY
   and a matching localhost host-permission).

4. (optional) Build + link the CLI:
     npx turbo build --filter=@membral/cli
     cd packages/cli && npm link
     membral setup --api-url http://localhost:${PORT}

Full guide, gotchas, and what needs an OpenAI key: docs/SELF-HOSTING.md
──────────────────────────────────────────────────────────────────────────
EOF
