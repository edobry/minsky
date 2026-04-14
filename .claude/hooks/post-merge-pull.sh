#!/usr/bin/env bash
# Post-merge hook: pull latest main and warn if MCP server code changed
# Called by PostToolUse hook on session_pr_merge

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Record current HEAD before pull
BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# Pull latest main
git pull --ff-only origin main 2>/dev/null || true

# Record HEAD after pull
AFTER=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# If HEAD changed, check if src/ files were modified
if [ "$BEFORE" != "$AFTER" ] && [ "$BEFORE" != "unknown" ]; then
  CHANGED_SRC=$(git diff --name-only "$BEFORE" "$AFTER" -- src/ 2>/dev/null || true)
  if [ -n "$CHANGED_SRC" ]; then
    echo ""
    echo "⚠️  Minsky source code updated by this merge."
    echo "   The running MCP server is using stale code."
    echo "   Run: /mcp then reconnect minsky"
    echo ""
  fi
fi
