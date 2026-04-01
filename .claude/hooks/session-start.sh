#!/bin/bash
set -euo pipefail

# Only run in remote (web) sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install Node dependencies if node_modules is missing or incomplete
# Uses bun install (not bun install --frozen-lockfile) to leverage cached container state
if [ ! -d "node_modules" ] || [ ! -d "node_modules/winston" ]; then
  bun install
fi

# Install gitleaks for secret scanning (required by pre-commit hook)
if ! command -v gitleaks &>/dev/null; then
  GITLEAKS_VERSION="8.21.2"
  curl -sSL -o /tmp/gitleaks.tar.gz \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  tar xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks
  mv /tmp/gitleaks /usr/local/bin/gitleaks
  rm -f /tmp/gitleaks.tar.gz
fi
