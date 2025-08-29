#!/usr/bin/env sh

echo "🔍 Testing ESLint hook logic..."

# Use JSON output for reliable parsing
LINT_JSON=$(bun run lint -- --format json 2>/dev/null || echo "[]")

# Extract total error and warning counts using simple arithmetic
ERROR_COUNT=$(echo "$LINT_JSON" | grep -o '"errorCount":[0-9]*' | cut -d: -f2 | awk '{sum+=$1} END {print sum+0}')
WARNING_COUNT=$(echo "$LINT_JSON" | grep -o '"warningCount":[0-9]*' | cut -d: -f2 | awk '{sum+=$1} END {print sum+0}')

# Log the current state
echo "📊 ESLint Results:"
echo "   Errors: $ERROR_COUNT"
echo "   Warnings: $WARNING_COUNT"

# Test the logic
if [ "$ERROR_COUNT" -gt 0 ]; then
  echo "❌ Would block: Found $ERROR_COUNT errors"
  exit 1
elif [ "$WARNING_COUNT" -gt 100 ]; then
  echo "⚠️ Would block: $WARNING_COUNT warnings (over 100 threshold)"
  exit 1
elif [ "$WARNING_COUNT" -eq 0 ]; then
  echo "✅ Perfect! Zero errors and zero warnings detected."
else
  echo "✅ Quality gate passed: $WARNING_COUNT warnings (under 100 threshold)."
fi
