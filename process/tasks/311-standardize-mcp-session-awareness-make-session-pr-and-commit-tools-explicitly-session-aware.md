# Standardize MCP session-awareness: Make session PR and commit tools explicitly session-aware

## Context

## Problem
The MCP interface has inconsistent session-awareness patterns that create UX confusion:

**Session-Aware Tools (Require explicit `session` parameter):**
- File operations: `session_read_file`, `session_write_file`, `session_list_directory`, `session_file_exists`, `session_delete_file`, `session_create_directory`
- Workspace tools: `session_grep_search`
- Editing tools: `session_edit_file`, `session_search_replace`

**Non-Session-Aware Tools (Use optional parameters + auto-detection):**
- Session management: `session.list`, `session.get`, `session.start`, `session.delete`, `session.dir`, `session.update`, `session.approve`, `session.pr`, `session.inspect`, `session.commit`

## Issue Details
This inconsistency means:
1. To read a file in a session, you must explicitly specify which session: `session_read_file(session="my-session", path="file.ts")`
2. To create a PR for a session, the tool tries to auto-detect: `session.pr(title="My PR")` 

This creates cognitive overhead and potential for errors when the auto-detection fails or operates on the wrong session.

## Solution
Create session-aware versions of key session operations that require explicit session identification:

1. **`session_pr`** - Create PR for specific session (similar to existing session file tools)
2. **`session_commit`** - Commit and push changes for specific session

These should follow the same pattern as existing session-aware tools:
- Require mandatory `session` parameter
- Use `SessionPathResolver` for workspace isolation
- Provide clear error messages when session not found
- Maintain security boundaries between sessions

## Benefits
- **Consistency**: All session operations follow the same explicit identification pattern
- **Clarity**: No ambiguity about which session is being operated on
- **Security**: Explicit session boundaries prevent accidental cross-session operations
- **Reliability**: No dependency on auto-detection that might fail

## Implementation Notes
- Keep existing `session.pr` and `session.commit` for CLI compatibility
- Add new `session_pr` and `session_commit` tools alongside existing session file tools
- Use same parameter patterns as `session_edit_file` and other session tools
- Consider deprecating auto-detection in favor of explicit session identification

## Priority
High - This affects the core UX of session-based development workflows and creates unnecessary cognitive overhead for users working with multiple sessions.

## Requirements

## Solution

## Notes
