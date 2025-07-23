## Summary

This PR implements two new MCP tools for efficient file operations within session workspaces: `session_move_file` and `session_rename_file`. These tools address the inefficiency of requiring two separate operations (write + delete) for moving/renaming files by providing atomic operations that are safer and more efficient.

## Problem Statement

Currently, moving or renaming files in a session workspace requires two separate operations:

1. Writing the file content to the new location using `session_write_file`
2. Deleting the original file using `session_delete_file`

This two-step process is inefficient and error-prone:
- Creates unnecessary I/O operations
- If either operation fails, the system could be left in an inconsistent state
- More verbose and complex for tool users

## Solution

### New MCP Tools Implemented

#### 1. `session_move_file`
Moves a file from one location to another within the session workspace.

**Parameters:**
- `sessionName`: Session identifier (name or task ID)
- `sourcePath`: Current file path within the session workspace
- `targetPath`: New file path within the session workspace
- `createDirs` (optional, default: true): Create parent directories if they don't exist
- `overwrite` (optional, default: false): Overwrite target if it exists

#### 2. `session_rename_file`
Convenience wrapper around move_file for renaming files in the same directory.

**Parameters:**
- `sessionName`: Session identifier (name or task ID)
- `path`: Current file path within the session workspace
- `newName`: New filename (not full path)
- `overwrite` (optional, default: false): Overwrite target if it exists

## Changes

### Added
- `session_move_file` MCP tool with atomic file operations
- `session_rename_file` MCP tool as convenience wrapper
- Comprehensive unit tests covering success and error scenarios (7 tests)
- Integration with semantic error handling from Task #309
- Proper workspace boundary enforcement and path validation

### Modified
- `src/adapters/mcp/session-files.ts`: Added new MCP tools and imported `rename` from fs/promises
- Added comprehensive error handling for common scenarios:
  - Source file doesn't exist
  - Target already exists (with overwrite option)
  - Target directory doesn't exist (with createDirs option)
  - Permission issues
  - Workspace boundary violations

### Fixed
- ESLint rule syntax error in `no-unsafe-git-exec.js` that was blocking commits

## Benefits

- **Efficiency**: Single atomic operation instead of two separate operations
- **Correctness**: Prevents inconsistent states if one operation fails
- **Usability**: More intuitive and simpler API for tool users
- **Performance**: File system move operations are typically more efficient than copy+delete

## Example Usage

**Before (inefficient 2-step process):**
```typescript
// Write file to new location
await session_write_file({
  session: "task309",
  path: "process/tasks/309/pr-review-senior-engineer.md",
  content: fileContent,
  createDirs: true,
});

// Delete file from old location
await session_delete_file({
  session: "task309",
  path: "process/review/task-309-pr-review-senior-engineer.md",
});
```

**After (efficient atomic operation):**
```typescript
// Single atomic move operation
await session_move_file({
  session: "task309",
  sourcePath: "process/review/task-309-pr-review-senior-engineer.md",
  targetPath: "process/tasks/309/pr-review-senior-engineer.md",
  createDirs: true,
});
```

## Testing

- ✅ 7 comprehensive unit tests covering success scenarios, error cases, and parameter validation
- ✅ Integration test demonstrating both tools working correctly
- ✅ All tests passing
- ✅ Proper error handling validation
- ✅ Schema validation testing

## Related Work

- Task #309: Semantic error handling for file operations
- Existing session file operation tools in `src/adapters/mcp/session-files.ts`

## Checklist

- [x] `session_move_file` tool implemented and registered with MCP
- [x] `session_rename_file` tool implemented and registered with MCP
- [x] Tools enforce workspace boundaries like other session file operations
- [x] Proper error handling for common scenarios
- [x] Integration with semantic error handling from Task #309
- [x] Unit tests for both tools
- [x] Integration tests with actual file operations
- [x] Documentation in code comments