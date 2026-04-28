#!/usr/bin/env bash
#
# regen-lock-linux.sh — regenerate package-lock.json with Linux-x64 native
# binaries in scope.
#
# Background:
#   npm on Windows omits foreign-platform optionalDependencies from the
#   lockfile by default. After bumping next, tailwindcss, or lightningcss
#   on a Windows dev machine, the CI build on Ubuntu fails with
#   "Cannot find module ../lightningcss.linux-x64-gnu.node" or similar.
#
#   This script runs `npm install --package-lock-only` inside a Linux
#   Docker container so the resulting lock has every platform npm would
#   ever resolve. The contract test
#   `tests/contract/lock-native-binaries.test.ts` enforces this on CI.
#
# Usage:
#   bash scripts/regen-lock-linux.sh
#
# Requirements:
#   - Docker Desktop (Windows/macOS) or docker (Linux) on PATH
#   - Run from the repo root
#
# What this does:
#   1. Mounts the repo into a node:22 container
#   2. Runs `npm install --package-lock-only --include=optional`
#   3. The host's package-lock.json is updated in place
#
# Verify after running:
#   npx vitest run tests/contract/lock-native-binaries.test.ts
#   git diff package-lock.json   # should show added Linux entries
#
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ Docker is required. Install Docker Desktop and try again."
  echo "  Alternative: run \`npm install --package-lock-only\` directly on a Linux/macOS machine."
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
NODE_IMAGE="node:22-slim"

echo "→ Pulling $NODE_IMAGE if needed..."
docker pull "$NODE_IMAGE" >/dev/null

echo "→ Regenerating package-lock.json inside Linux container..."
# --user passes the host UID/GID so the regenerated package-lock.json
# stays owned by the dev user, not root. On Windows Git Bash `id -u`
# returns 0 (no native UID concept) — Docker Desktop handles file
# ownership transparently in that case, so passing 0:0 is harmless.
HOST_UID="$(id -u 2>/dev/null || echo 0)"
HOST_GID="$(id -g 2>/dev/null || echo 0)"
docker run --rm \
  --user "${HOST_UID}:${HOST_GID}" \
  -v "$REPO_ROOT":/app \
  -w /app \
  "$NODE_IMAGE" \
  npm install --package-lock-only --include=optional

echo ""
echo "✓ package-lock.json regenerated."
echo ""
echo "Next steps:"
echo "  1. npx vitest run tests/contract/lock-native-binaries.test.ts"
echo "  2. git diff package-lock.json   # review changes"
echo "  3. git add package-lock.json && git commit -m 'chore: regen lock with Linux binaries'"
