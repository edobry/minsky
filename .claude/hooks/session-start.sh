#!/bin/bash
set -euo pipefail

# Only run in remote (web) sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install dependencies if node_modules is missing or incomplete
# Uses bun install (not bun install --frozen-lockfile) to leverage cached container state
if [ ! -d "node_modules" ] || [ ! -d "node_modules/winston" ]; then
  bun install
fi
