#!/usr/bin/env bash
# Stop hook: full type check on all project roots edited during this turn.
#
# This is the correctness/truthfulness gate — Claude cannot stop with
# type errors. Exit 2 forces Claude to continue and fix the errors.
#
# Reads tracked project roots from the main agent's state file.

# Read stdin to extract session_id
INPUT=$(cat)
session_id=$(echo "$INPUT" | jq -r '.session_id // "default"')

state_file="/tmp/claude-typecheck-roots-${session_id}-main.txt"

# Pipe input back into the shared script
echo "$INPUT" | "$CLAUDE_PROJECT_DIR/.claude/hooks/typecheck-tracked-roots.sh" "$state_file" "Stop"
