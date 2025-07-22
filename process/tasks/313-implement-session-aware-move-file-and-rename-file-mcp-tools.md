# Implement session-aware move_file and rename_file MCP tools

## Context

# Task: Implement session-aware move_file and rename_file MCP tools

## Problem Statement

Currently, moving or renaming files in a session workspace requires two separate operations:
1. Writing the file content to the new location using `session_write_file`
2. Deleting the original file using `session_delete_file`

This two-step process is inefficient and error-prone:
- It creates unnecessary I/O operations
- If either operation fails, the system could be left in an inconsistent state
- It's more verbose and complex for tool users

## Example Use Case

When reorganizing PR reviews in task 309, we had to use:
```typescript
// Write file to new location
mcp_minsky-server_session_write_file({
  session: "task309",
  path: "process/tasks/309/pr-review-senior-engineer.md",
  content: fileContent,
  createDirs: true
});

// Delete file from old location
mcp_minsky-server_session_delete_file({
  session: "task309", 
  path: "process/review/task-309-pr-review-senior-engineer.md"
});
```

Instead of a simple move operation:
```typescript
// What we want:
mcp_minsky-server_session_move_file({
  session: "task309",
  sourcePath: "process/review/task-309-pr-review-senior-engineer.md",
  targetPath: "process/tasks/309/pr-review-senior-engineer.md",
  createDirs: true
});
```

## Solution

Implement two new MCP tools:

### 1. `session_move_file`
Moves a file from one location to another within the session workspace.

**Parameters**:
- `session`: Session identifier (name or task ID)
- `sourcePath`: Current file path within the session workspace
- `targetPath`: New file path within the session workspace
- `createDirs` (optional, default: true): Create parent directories if they don't exist
- `overwrite` (optional, default: false): Overwrite target if it exists

### 2. `session_rename_file`
Convenience wrapper around move_file for renaming files in the same directory.

**Parameters**:
- `session`: Session identifier (name or task ID)
- `path`: Current file path within the session workspace 
- `newName`: New filename (not full path)
- `overwrite` (optional, default: false): Overwrite target if it exists

## Implementation

1. Add new commands to the MCP command mapper in `src/adapters/mcp/session-files.ts`:
   ```typescript
   // Session move file tool
   commandMapper.addCommand({
     name: "session_move_file",
     description: "Move a file within a session workspace",
     parameters: z.object({
       session: z.string().describe("Session identifier (name or task ID)"),
       sourcePath: z.string().describe("Source path within the session workspace"),
       targetPath: z.string().describe("Target path within the session workspace"),
       createDirs: z.boolean().optional().default(true)
         .describe("Create parent directories if they don't exist"),
       overwrite: z.boolean().optional().default(false)
         .describe("Overwrite target if it exists")
     }),
     handler: async (args) => {
       // Implementation
     }
   });
   
   // Session rename file tool
   commandMapper.addCommand({
     name: "session_rename_file",
     description: "Rename a file within a session workspace",
     parameters: z.object({
       session: z.string().describe("Session identifier (name or task ID)"),
       path: z.string().describe("File path within the session workspace"),
       newName: z.string().describe("New filename (not full path)"),
       overwrite: z.boolean().optional().default(false)
         .describe("Overwrite target if it exists")
     }),
     handler: async (args) => {
       // Implementation
     }
   });
   ```

2. Implement the handlers using Node.js `fs/promises` rename function, with proper path resolution and validation.

3. Integrate with the existing semantic error handling from Task #309.

## Benefits

- **Efficiency**: Single atomic operation instead of two separate operations
- **Correctness**: Prevents inconsistent states if one operation fails
- **Usability**: More intuitive and simpler API for tool users
- **Performance**: File system move operations are typically more efficient than copy+delete

## Acceptance Criteria

- [ ] `session_move_file` tool implemented and registered with MCP
- [ ] `session_rename_file` tool implemented and registered with MCP
- [ ] Tools enforce workspace boundaries like other session file operations
- [ ] Proper error handling for common scenarios:
  - Source file doesn't exist
  - Target already exists (with overwrite option)
  - Target directory doesn't exist (with createDirs option)
  - Permission issues
- [ ] Integration with the semantic error handling from Task #309
- [ ] Unit tests for both tools
- [ ] Integration tests with actual file operations
- [ ] Documentation in code comments

## Related Work

- Task #309: Semantic error handling for file operations
- The existing session file operation tools in `src/adapters/mcp/session-files.ts`

## Requirements

## Solution

## Notes
