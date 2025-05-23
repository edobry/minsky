#!/bin/bash

# Simple script to test if a test file is Bun-compatible
# Usage: ./scripts/migrate-test.sh <test-file-path>

TEST_FILE="$1"

if [[ -z "$TEST_FILE" ]]; then
  echo "Usage: $0 <test-file-path>"
  echo "Example: $0 src/utils/logger.test.ts"
  exit 1
fi

if [[ ! -f "$TEST_FILE" ]]; then
  echo "Error: Test file '$TEST_FILE' not found"
  exit 1
fi

echo "Testing $TEST_FILE with Bun..."

# Test the file with Bun
if bun test "$TEST_FILE" > /dev/null 2>&1; then
  echo "✅ Test passes with Bun - can be moved to 'bun_compatible'"
  echo "Add '$TEST_FILE' to the 'bun_compatible' array in test-categories.json"
else
  echo "❌ Test fails with Bun - should stay in 'needs_migration'"
  echo "Keep '$TEST_FILE' in the 'needs_migration' array in test-categories.json"
fi

echo ""
echo "To update test-categories.json, edit the file manually and:"
echo "1. Add working tests to the 'bun_compatible' array"
echo "2. Keep failing tests in the 'needs_migration' array" 
