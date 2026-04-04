#!/usr/bin/env bash
# PostToolUse hook: run tsc --noEmit after editing TypeScript files
# Returns additionalContext with type errors so the model sees them immediately

# Extract file path — handles both direct tools (file_path) and MCP session tools (path)
file_path=$(jq -r '.tool_input.file_path // .tool_input.path // .tool_response.filePath // empty')

# Only run for TypeScript files
if ! echo "$file_path" | grep -qE '\.tsx?$'; then
  exit 0
fi

# For MCP session tools, the project dir is the session workspace.
# But tsc should run from the project root where tsconfig.json lives.
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
