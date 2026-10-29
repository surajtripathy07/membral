#!/usr/bin/env bash
# Runs the pure-function tests for scripts/local/build-server.mjs --pack (node:test, no build needed).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
node --test scripts/local/__tests__/
