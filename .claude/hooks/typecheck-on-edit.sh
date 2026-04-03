#!/usr/bin/env bash
# PostToolUse hook: run tsc --noEmit after editing TypeScript files
# Returns additionalContext with type errors so the model sees them immediately

file_path=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')

# Only run for TypeScript files
if ! echo "$file_path" | grep -qE '\.tsx?$'; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 0

output=$(bunx tsc --noEmit 2>&1)
rc=$?

if [ $rc -ne 0 ]; then
  # Escape the output for JSON embedding
  escaped=$(echo "$output" | jq -Rs .)
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"TypeScript errors after edit:\\n%s"}}' "$escaped"
  # Exit 2 to trigger asyncRewake — surfaces errors to the model
  exit 2
fi
