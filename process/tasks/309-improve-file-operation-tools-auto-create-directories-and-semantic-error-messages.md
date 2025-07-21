# Improve file operation tools: auto-create directories and semantic error messages

## Context

Enhance file operation tools to be more AI-agent friendly by:

## 1. Auto-Create Directory Support
- Add automatic directory creation to `edit_file` tool (like session tools already have)
- Default to `createDirs: true` with option to disable
- Follow pattern from `mcp_minsky-server_session_write_file` which already has this

## 2. Semantic Error Messages
Replace low-level filesystem errors with agent-actionable messages:

### Current Problem
```json
{"success":false,"error":"ENOENT: no such file or directory"}
```

### Better Design
```json
{
  "success": false,
  "error": "Cannot create file - parent directory does not exist",
  "reason": "DIRECTORY_NOT_FOUND", 
  "solutions": [
    "Set createDirs: true to auto-create directories",
    "Create directory first using create_directory tool"
  ],
  "retryable": true
}
```

### Error Categories to Implement
- `FILE_NOT_FOUND` instead of ENOENT
- `DIRECTORY_NOT_FOUND` instead of ENOENT  
- `PERMISSION_DENIED` instead of EACCES
- `PATH_ALREADY_EXISTS` instead of EEXIST
- `SESSION_NOT_FOUND` for session-specific errors
- `GIT_BRANCH_CONFLICT` for git-related issues

## Benefits
- Faster agent recovery from errors
- Reduced trial-and-error debugging
- Better developer experience
- Context-aware error handling

## Scope
- Update `edit_file`, `read_file`, `delete_file` tools
- Update all session file operation tools
- Update git and session management error handling
- Create consistent error response schema

## Requirements

## Solution

## Notes
