#!/usr/bin/env bash
# Shared logic: read tracked project roots from a state file, run full tsc
# in each one. Used by both Stop and SubagentStop hooks.
#
# Usage: typecheck-tracked-roots.sh <state_file> <hook_event_name>
# Reads JSON input from stdin (for cwd fallback).
# Exits 2 if any root has type errors. Cleans up state file on success.

state_file="$1"
hook_event="$2"

# Read stdin for cwd fallback
INPUT=$(cat)
cwd=$(echo "$INPUT" | jq -r '.cwd // empty')

# Collect unique project roots from state file
if [ -f "$state_file" ]; then
  roots=$(sort -u "$state_file")
else
  roots=""
fi

# Fallback: if no tracked roots, use cwd or CLAUDE_PROJECT_DIR
if [ -z "$roots" ]; then
  roots="${cwd:-$CLAUDE_PROJECT_DIR}"
fi

# Check each root
all_errors=""
total_count=0
failed_roots=()

for root in $roots; do
  [ -d "$root" ] || continue
  [ -f "$root/tsconfig.json" ] || continue

  cd "$root" || continue
  output=$(bunx tsc 2>&1)
  if [ $? -ne 0 ]; then
    count=$(echo "$output" | grep -c '): error TS')
    total_count=$((total_count + count))
    failed_roots+=("$root")
    # Prepend root header to errors for clarity
    all_errors="${all_errors}${all_errors:+\n\n}=== $root ===\n$output"
  fi
done

if [ ${#failed_roots[@]} -gt 0 ]; then
  errors_preview=$(printf '%b' "$all_errors" | head -60 | jq -Rs .)
  jq -n --argjson preview "$errors_preview" --arg count "$total_count" --arg event "$hook_event" \
    '{hookSpecificOutput: {hookEventName: $event, additionalContext: ("TypeScript errors must be fixed before completing:\n" + $preview + "\n\nTotal: " + $count + " error(s). Fix all type errors before returning.")}}'
  exit 2
fi

# All checks passed — clean up state file
rm -f "$state_file"
exit 0
