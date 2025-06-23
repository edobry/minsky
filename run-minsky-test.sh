#!/bin/bash

# Minsky SQLite Backend Test Script
# This script runs minsky commands in an isolated test environment

set -e

# Test environment paths
TEST_BASE="/tmp/minsky-sqlite-test"
TEST_CONFIG_DIR="$TEST_BASE/test-config"
TEST_SESSIONS_DIR="$TEST_BASE/test-sessions"

# Environment variables for isolated testing
export HOME="$TEST_CONFIG_DIR"
export XDG_STATE_HOME="$TEST_SESSIONS_DIR"
export XDG_CONFIG_HOME="$TEST_CONFIG_DIR/.config"

# SQLite-specific environment variables
export MINSKY_SESSIONDB_BACKEND="sqlite"
export MINSKY_SQLITE_PATH="$TEST_SESSIONS_DIR/minsky/sessions.db"

# Ensure test directories exist
mkdir -p "$TEST_CONFIG_DIR/.config/minsky"
mkdir -p "$TEST_SESSIONS_DIR/minsky"

# Copy the main minsky repo to test config for configuration
if [ ! -d "$TEST_CONFIG_DIR/.config/minsky" ]; then
    mkdir -p "$TEST_CONFIG_DIR/.config/minsky"
fi

# Set minsky CLI path
MINSKY_CLI="bun run src/cli.ts"

echo "🧪 Running Minsky CLI with SQLite backend test environment"
echo "   Config dir: $TEST_CONFIG_DIR"
echo "   Sessions dir: $TEST_SESSIONS_DIR"
echo "   SQLite path: $MINSKY_SQLITE_PATH"
echo "   Backend: $MINSKY_SESSIONDB_BACKEND"
echo ""

# Execute the minsky command with all arguments passed through
exec $MINSKY_CLI "$@"
