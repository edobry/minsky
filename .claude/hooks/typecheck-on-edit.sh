#!/usr/bin/env bash
# PostToolUse hook: run tsc --noEmit after editing TypeScript files
# Returns additionalContext with type errors so the model sees them immediately

# Extract file path — handles both direct tools (file_path) and MCP session tools (path)
file_path=$(jq -r '.tool_input.file_path // .tool_input.path // .tool_response.filePath // empty')

# Only run for TypeScript files
if ! echo "$file_path" | grep -qE '\.tsx?$'; then
  exit 0
fi

# Determine the right project root to run tsc from.
# If the file is in a Minsky session dir, use that session's root.
# Otherwise, use the main project dir.
SESSIONS_DIR="$HOME/.local/state/minsky/sessions"
if echo "$file_path" | grep -q "^$SESSIONS_DIR/"; then
  # Extract session root: ~/.local/state/minsky/sessions/<UUID>
  session_root=$(echo "$file_path" | sed "s|^\($SESSIONS_DIR/[^/]*\)/.*|\1|")
  cd "$session_root" || exit 0
else
  cd "$CLAUDE_PROJECT_DIR" || exit 0
fi

output=$(bunx tsc --noEmit 2>&1)
rc=$?

if [ $rc -ne 0 ]; then
  # Escape the output for JSON embedding
  escaped=$(echo "$output" | jq -Rs .)
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"TypeScript errors after edit:\\n%s"}}' "$escaped"
  # Exit 2 to trigger asyncRewake — surfaces errors to the model
  exit 2
fi
