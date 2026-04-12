#!/usr/bin/env bash
# PostToolUse hook: INFORMATIONAL type checking after editing TypeScript files
#
# Two responsibilities:
#   1. Track which project root was edited (state file for Stop/SubagentStop hooks)
#   2. Run incremental tsc in that root, show smart-filtered errors as context
#
# Does NOT block — Stop/SubagentStop hooks enforce correctness at turn end.

# Read stdin once
INPUT=$(cat)

# Extract fields
file_path=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .tool_response.filePath // empty')
session_id=$(echo "$INPUT" | jq -r '.session_id // "default"')
agent_id=$(echo "$INPUT" | jq -r '.agent_id // empty')

# Only run for TypeScript files
if ! echo "$file_path" | grep -qE '\.tsx?$'; then
  exit 0
fi

# Determine the right project root to run tsc from.
# If the file is in a Minsky session dir, use that session's root.
# Otherwise, use the main project dir.
SESSIONS_DIR="$HOME/.local/state/minsky/sessions"
if echo "$file_path" | grep -q "^$SESSIONS_DIR/"; then
  project_root=$(echo "$file_path" | sed "s|^\($SESSIONS_DIR/[^/]*\)/.*|\1|")
else
  project_root="$CLAUDE_PROJECT_DIR"
fi

# Track this project root for Stop/SubagentStop to find later.
# State file is keyed by session_id and (if subagent) agent_id.
if [ -n "$agent_id" ]; then
  state_file="/tmp/claude-typecheck-roots-${session_id}-${agent_id}.txt"
else
  state_file="/tmp/claude-typecheck-roots-${session_id}-main.txt"
fi
echo "$project_root" >> "$state_file"

# Run tsc with --incremental for fast feedback
cd "$project_root" || exit 0
output=$(bunx tsc --incremental 2>&1)
rc=$?

if [ $rc -ne 0 ]; then
  # Compute relative path from project root for matching tsc output
  rel_path="${file_path#${project_root}/}"

  # Filter: errors in the edited file vs cascade errors in other files
  file_errors=$(echo "$output" | grep "^${rel_path}(")
  total_error_count=$(echo "$output" | grep -c '): error TS')

  if [ -n "$file_errors" ]; then
    file_error_count=$(echo "$file_errors" | wc -l | tr -d ' ')
    cascade_count=$((total_error_count - file_error_count))
    file_errors_preview=$(echo "$file_errors" | head -10 | jq -Rs .)
    if [ "$cascade_count" -gt 0 ]; then
      jq -n --argjson errors "$file_errors_preview" --arg cascade "$cascade_count" \
        '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("TypeScript errors in edited file:\n" + $errors + "\n(+ " + $cascade + " cascade error(s) in other files)")}}'
    else
      jq -n --argjson errors "$file_errors_preview" \
        '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("TypeScript errors in edited file:\n" + $errors)}}'
    fi
  else
    # Only cascade errors in other files — just summarize
    jq -n --arg count "$total_error_count" \
      '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("TypeScript: " + $count + " error(s) in other files (cascade from ongoing edits, checked at turn end)")}}'
  fi
fi

# Always exit 0 — informational only.
exit 0
