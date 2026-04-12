#!/usr/bin/env bash
# SubagentStop hook: full type check on all project roots edited by this subagent.
#
# Forces subagents to leave clean code before returning to the main agent.
# Reads tracked project roots from the subagent's per-agent state file.

# Read stdin to extract session_id and agent_id
INPUT=$(cat)
session_id=$(echo "$INPUT" | jq -r '.session_id // "default"')
agent_id=$(echo "$INPUT" | jq -r '.agent_id // empty')

# If for some reason agent_id is missing, fall back to main state file
if [ -n "$agent_id" ]; then
  state_file="/tmp/claude-typecheck-roots-${session_id}-${agent_id}.txt"
else
  state_file="/tmp/claude-typecheck-roots-${session_id}-main.txt"
fi

# Pipe input back into the shared script
echo "$INPUT" | "$CLAUDE_PROJECT_DIR/.claude/hooks/typecheck-tracked-roots.sh" "$state_file" "SubagentStop"
