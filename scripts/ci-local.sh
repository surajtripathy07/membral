#!/usr/bin/env bash
# scripts/ci-local.sh — the CI gate, run locally (D-060).
#
# Runs the `gate` job of .github/workflows/ci.yml with the same commands in
# the same order (scripts/check-ci-local-sync.mjs asserts every gate `run:`
# command appears verbatim here, and runs first). Every step runs even when
# an earlier one fails; the script exits 1 if any failed.
#
#   --quick                        skip the coverage ratchet
#   --pure-move <base-sha>         also run the two label-gated checks
#   --labels a,b                   PR labels for check-pure-move (default: pure-move)
#   --smoke                        append the `smoke` job (starts Supabase if needed)
#
# `npm ci` (the job's install step) is not repeated: it wipes node_modules.
# If node_modules is missing entirely, the script exits 2 before any step
# runs (no receipt written) naming the npm version to install with, read
# from package.json's "packageManager".
# PR_BODY (env) feeds the move-coverage check, as in ci.yml. Steps are
# functions so multi-line `run:` blocks stay verbatim for the sync check.
#
# Receipt: .ci-local/<HEAD sha>.txt (gitignored); the `turbo build test lint
# typecheck` step's line is followed by a `turbo   N/M cached` line so a
# green step is not mistaken for a fresh (uncached) run.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT" || exit 1

# root node_modules is checked only: npm workspaces hoist deps here, so
# apps/cloud resolves against it too (verified: `next` resolves from
# apps/cloud via the root node_modules, no separate copy needed).
if [ ! -d node_modules ]; then
  PKG_VER="$(sed -n 's/.*"packageManager": *"npm@\([0-9.]*\)".*/\1/p' package.json | head -1)"
  PKG_VER="${PKG_VER:-11.19.0}"
  echo "ci-local: node_modules missing — run: npx -y npm@${PKG_VER} ci   (package.json packageManager)" >&2
  echo "ci-local: exiting before any step; no receipt written." >&2
  exit 2
fi

QUICK=0
SMOKE=0
BASE_SHA=""
PR_LABELS="pure-move"
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --smoke) SMOKE=1 ;;
    --pure-move) BASE_SHA="${2:?--pure-move needs a base sha}"; shift ;;
    --labels) PR_LABELS="${2:?--labels needs a value}"; shift ;;
    *) echo "ci-local: unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done

# Same job env as ci.yml (#184): mock the Google Fonts fetch in `next build`.
export NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$REPO_ROOT/apps/cloud/test/next-font-google-mock.cjs"

STEPS=()
FAILED=0
TURBO_LOG="$(mktemp)"
trap 'rm -f "$TURBO_LOG"' EXIT

step() {
  local name="$1"; shift
  echo "== $name"
  ( "$@" )
  local code=$?
  echo "== $name exit=$code"
  STEPS+=("$code  $name")
  [ "$code" -eq 0 ] || FAILED=1
}

# --- gate job (ci.yml `gate`, same order, same commands) --------------------
# Streams to the terminal as before (tee), while also keeping a copy to
# grep turbo's own "Cached: N cached, N total" summary line out of after
# the run, for the receipt's cache-hit line.
gate_turbo() { npx turbo run build test lint typecheck 2>&1 | tee "$TURBO_LOG"; }
gate_db_pglite() { MEMBRAL_TEST_STORE=pglite npm run test:db --workspace=@membral/cloud; }
gate_mock_paths() { npm run check:mock-paths; }
gate_ratchets() { npm run check:ratchets; }
gate_script_tests() { bash scripts/__tests__/run.sh; }
gate_doc_paths() { npm run check:doc-paths; }
gate_vercel_functions() { npm run check:vercel-functions; }
gate_coverage() { npm run coverage; }
gate_pure_move() {
  node scripts/check-pure-move.mjs "$BASE_SHA" --labels "$PR_LABELS" --explain
}
gate_move_coverage() {
  PR_BODY="${PR_BODY:-}"
  PR_BODY_FILE="$(mktemp)"
  printf '%s' "$PR_BODY" > "$PR_BODY_FILE"
  node scripts/check-move-coverage.mjs "$BASE_SHA" --pr-body-file "$PR_BODY_FILE"
}

step "ci-local sync" npm run check:ci-local-sync
step "turbo build test lint typecheck" gate_turbo
step "DB tests on the embedded store (pglite)" gate_db_pglite
step "Mock-path guard (G6)" gate_mock_paths
step "Ratchets (G1–G5)" gate_ratchets
step "Script tests" gate_script_tests
step "Doc paths" gate_doc_paths
step "Vercel functions globs match" gate_vercel_functions
if [ "$QUICK" -eq 0 ]; then
  step "Coverage ratchet" gate_coverage
fi
if [ -n "$BASE_SHA" ]; then
  step "Pure-move check (P1, P9)" gate_pure_move
  step "Move coverage check (0.9)" gate_move_coverage
fi

# --- smoke job (ci.yml `smoke`) --------------------------------------------
smoke_supabase_start() {
  cd apps/cloud || return 1
  supabase status >/dev/null 2>&1 && return 0
  supabase start -x studio,imgproxy,logflare,vector,edge-runtime,mailpit
}
smoke_db_types() {
  cd apps/cloud || return 1
  npm run db:types:check
}
smoke_write_env() {
  cd apps/cloud || return 1
  STATUS_ENV="$(supabase status -o env)"
  ANON_KEY="$(echo "$STATUS_ENV" | grep '^ANON_KEY=' | cut -d'"' -f2)"
  SERVICE_ROLE_KEY="$(echo "$STATUS_ENV" | grep '^SERVICE_ROLE_KEY=' | cut -d'"' -f2)"
  API_URL="$(echo "$STATUS_ENV" | grep '^API_URL=' | cut -d'"' -f2)"
  {
    echo "NEXT_PUBLIC_SUPABASE_URL=${API_URL}"
    echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}"
    echo "SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}"
    echo "NEXT_PUBLIC_APP_URL=http://localhost:3001"
  } > .env.local
}
smoke_db_postgrest() {
  cd apps/cloud || return 1
  STATUS_ENV="$(supabase status -o env)"
  export MEMBRAL_TEST_STORE=postgrest
  export SUPABASE_URL="$(echo "$STATUS_ENV" | grep '^API_URL=' | cut -d'"' -f2)"
  export SUPABASE_ANON_KEY="$(echo "$STATUS_ENV" | grep '^ANON_KEY=' | cut -d'"' -f2)"
  export SUPABASE_SERVICE_ROLE_KEY="$(echo "$STATUS_ENV" | grep '^SERVICE_ROLE_KEY=' | cut -d'"' -f2)"
  export SUPABASE_DB_URL="$(echo "$STATUS_ENV" | grep '^DB_URL=' | cut -d'"' -f2)"
  export SUPABASE_JWT_SECRET="$(echo "$STATUS_ENV" | grep '^JWT_SECRET=' | cut -d'"' -f2)"
  npm run test:db
}
smoke_build() { npx turbo build; }
smoke_playwright() { npx playwright install --with-deps chromium; }
smoke_run() { SMOKE_MODE=start npm run smoke; }

if [ "$SMOKE" -eq 1 ]; then
  step "Start local Supabase" smoke_supabase_start
  step "Check generated DB types are up to date" smoke_db_types
  step "Write apps/cloud/.env.local from supabase status" smoke_write_env
  # ci.yml appends .env.local to $GITHUB_ENV (F9); locally: export it.
  if [ -f apps/cloud/.env.local ]; then
    set -a; . apps/cloud/.env.local; set +a
  fi
  step "Build (with the local Supabase env)" smoke_build
  step "DB tests on real PostgREST" smoke_db_postgrest
  step "Playwright chromium" smoke_playwright
  step "Smoke" smoke_run
fi

# --- receipt ----------------------------------------------------------------
HEAD_SHA="$(git rev-parse HEAD)"
RECEIPT_DIR="$REPO_ROOT/.ci-local"
RECEIPT="$RECEIPT_DIR/$HEAD_SHA.txt"
mkdir -p "$RECEIPT_DIR"
{
  echo "ci-local receipt"
  echo "time    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "branch  $(git rev-parse --abbrev-ref HEAD)"
  echo "head    $HEAD_SHA"
  echo "dirty   $([ -n "$(git status --porcelain)" ] && echo yes || echo no)"
  echo "flags   quick=$QUICK smoke=$SMOKE pure-move=${BASE_SHA:-none}"
  echo "steps   (exit  name)"
  for s in "${STEPS[@]}"; do echo "  $s"; done
  TURBO_CACHE="$(grep -E '^ *Cached:' "$TURBO_LOG" 2>/dev/null | tail -1 | sed -E 's/^ *Cached: *([0-9]+) cached, ([0-9]+) total.*/\1\/\2/')"
  if [ -n "$TURBO_CACHE" ]; then echo "turbo   $TURBO_CACHE cached"; fi
  if [ "$FAILED" -eq 0 ]; then echo "RESULT PASS"; else echo "RESULT FAIL"; fi
} > "$RECEIPT"

cat "$RECEIPT"
echo "receipt: $RECEIPT"
exit "$FAILED"
