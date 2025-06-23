# Session Workspace Tools

## Overview

The Session Workspace Tools provide secure, session-scoped workspace operations for AI agents working within Minsky session workspaces. These tools enforce workspace isolation by automatically validating and restricting all workspace operations to the appropriate session directory, preventing accidental modifications to the main workspace or other sessions.

## Core Concepts

### Session Workspace Isolation
Every Minsky session operates within its own isolated workspace directory. The session workspace tools ensure that:
- All workspace paths are resolved within the session workspace boundary
- Operations cannot escape the session directory (no `../` traversal attacks)
- Each session's workspace remains completely isolated from other sessions and the main workspace

### Path Resolution
The `SessionPathResolver` class provides robust path validation:
- Converts relative paths to absolute paths within the session workspace
- Validates that all resolved paths remain within session boundaries
- Handles edge cases like symlinks, special characters, and complex path structures
- Provides clear error messages for invalid path attempts

## Available Tools

### 1. session_read_file

Reads the contents of a file within the session workspace.

**Parameters:**
- `session` (string, required): Session identifier (e.g., "task#049")
- `path` (string, required): File path relative to session workspace or absolute within session

**Response:**
```json
{
  "success": true,
  "content": "file contents...",
  "path": "relative/path/to/file.ts",
  "session": "task#049",
  "encoding": "utf8",
  "size": 1234
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "File not found: /path/to/file.ts",
  "path": "relative/path/to/file.ts",
  "session": "task#049"
}
```

### 2. session_write_file

Writes content to a file within the session workspace, creating directories as needed.

**Parameters:**
- `session` (string, required): Session identifier
- `path` (string, required): File path within session workspace
- `content` (string, required): Content to write to the file

**Response:**
```json
{
  "success": true,
  "path": "src/components/NewComponent.tsx",
  "session": "task#049",
  "bytesWritten": 1234,
  "created": true
}
```

### 3. session_list_directory

Lists the contents of a directory within the session workspace.

**Parameters:**
- `session` (string, required): Session identifier
- `path` (string, optional): Directory path (defaults to session root)

**Response:**
```json
{
  "success": true,
  "path": "src/components",
  "session": "task#049",
  "items": [
    {
      "name": "Button.tsx",
      "type": "file",
      "size": 2048,
      "modified": "2024-01-15T10:30:00Z"
    },
    {
      "name": "utils",
      "type": "directory",
      "modified": "2024-01-15T09:15:00Z"
    }
  ]
}
```

### 4. session_file_exists

Checks if a file or directory exists within the session workspace.

**Parameters:**
- `session` (string, required): Session identifier
- `path` (string, required): Path to check

**Response:**
```json
{
  "success": true,
  "exists": true,
  "path": "src/utils/helper.ts",
  "session": "task#049",
  "type": "file"
}
```

### 5. session_delete_file

Deletes a file within the session workspace.

**Parameters:**
- `session` (string, required): Session identifier
- `path` (string, required): File path to delete

**Response:**
```json
{
  "success": true,
  "path": "temp/cache.json",
  "session": "task#049",
  "deleted": true
}
```

### 6. session_create_directory

Creates a directory (and parent directories) within the session workspace.

**Parameters:**
- `session` (string, required): Session identifier
- `path` (string, required): Directory path to create

**Response:**
```json
{
  "success": true,
  "path": "src/new-feature/components",
  "session": "task#049",
  "created": true,
  "recursive": true
}
```

## Security Features

### Path Validation
- **Boundary Enforcement**: All paths are validated to ensure they remain within the session workspace
- **Traversal Prevention**: `../` sequences and other traversal attempts are blocked
- **Absolute Path Handling**: Absolute paths are only allowed if they point within the session workspace
- **Symlink Resolution**: Symlinks are resolved and validated to prevent escaping session boundaries

### Error Handling
- **Clear Error Messages**: Detailed error descriptions help identify and resolve issues
- **Security Violation Reporting**: Attempted boundary violations are clearly flagged
- **Path Information**: Error messages include both the attempted path and the resolved path for debugging

### Session Validation
- **Session Existence**: Verifies that the specified session exists before performing operations
- **Workspace Path Resolution**: Automatically resolves session workspace paths from the session database
- **Context Isolation**: Each operation is scoped to a specific session context

## Usage Examples

### Reading a Configuration File
```javascript
// Read package.json from session workspace
const result = await session_read_file({
  session: "task#049",
  path: "package.json"
});

if (result.success) {
  const packageData = JSON.parse(result.content);
  console.log("Package name:", packageData.name);
}
```

### Creating a New Component
```javascript
// Create a new React component
const componentCode = `
import React from 'react';

export const NewFeature: React.FC = () => {
  return <div>New Feature Component</div>;
};
`;

await session_write_file({
  session: "task#049",
  path: "src/components/NewFeature.tsx",
  content: componentCode
});
```

### Listing Project Files
```javascript
// List all TypeScript files in src/
const result = await session_list_directory({
  session: "task#049",
  path: "src"
});

if (result.success) {
  const tsFiles = result.items
    .filter(item => item.type === "file" && item.name.endsWith(".ts"))
    .map(item => item.name);
  console.log("TypeScript files:", tsFiles);
}
```

### Safe File Operations
```javascript
// Check if file exists before reading
const exists = await session_file_exists({
  session: "task#049",
  path: "src/config/settings.json"
});

if (exists.success && exists.exists) {
  const config = await session_read_file({
    session: "task#049",
    path: "src/config/settings.json"
  });
  // Process config...
}
```

## Integration with AI Agents

### Cursor Configuration

To prioritize session file tools in Cursor, add this to your MCP configuration:

```json
{
  "mcpServers": {
    "minsky": {
      "command": "minsky",
      "args": ["mcp", "start"],
      "preferredTools": [
        "session_read_file",
        "session_write_file",
        "session_list_directory",
        "session_file_exists",
        "session_delete_file",
        "session_create_directory"
      ]
    }
  }
}
```

### Best Practices for AI Agents

1. **Always Use Session Tools**: When working in a Minsky session, use `session_*` tools instead of built-in workspace operations
2. **Explicit Session Context**: Always provide the session identifier explicitly
3. **Error Handling**: Check the `success` field in responses before using results
4. **Path Consistency**: Use consistent path formats (preferably relative to session root)

### Migration from Built-in Tools

Replace built-in workspace operations with session-aware equivalents:

```javascript
// ❌ DON'T: Use built-in tools in sessions
await edit_file({
  target_file: "src/component.tsx",
  code_edit: "// changes"
});

// ✅ DO: Use session tools
await session_write_file({
  session: "task#049",
  path: "src/component.tsx", 
  content: updatedContent
});
```

## Error Handling

### Common Error Types

1. **Session Not Found**
   ```json
   {
     "success": false,
     "error": "Session 'invalid-session' not found",
     "session": "invalid-session"
   }
   ```

2. **Path Outside Session**
   ```json
   {
     "success": false,
     "error": "Path '../../../etc/passwd' resolves outside session workspace",
     "path": "../../../etc/passwd",
     "session": "task#049"
   }
   ```

3. **File Not Found**
   ```json
   {
     "success": false,
     "error": "File not found: /session/path/missing.txt",
     "path": "missing.txt",
     "session": "task#049"
   }
   ```

4. **Permission Denied**
   ```json
   {
     "success": false,
     "error": "Permission denied: /session/path/readonly.txt",
     "path": "readonly.txt",
     "session": "task#049"
   }
   ```

### Error Recovery

- **Validate Paths**: Use `session_file_exists` to check paths before operations
- **Check Session**: Ensure session exists and is accessible
- **Handle Permissions**: Verify file/directory permissions before write operations
- **Graceful Degradation**: Provide fallback behavior for non-critical operations

## Architecture

### Components

1. **SessionPathResolver**: Core path validation and resolution
2. **Session Workspace Tools**: Individual MCP tool implementations
3. **MCP Integration**: Registration and command mapping
4. **Error Handling**: Structured error responses and logging

### Design Principles

- **Security First**: All operations validate workspace boundaries
- **Explicit Context**: Session information is always required
- **Clear Feedback**: Comprehensive success/error responses
- **Future Ready**: Designed for extensibility and additional session types

## Troubleshooting

### Common Issues

1. **"Session not found" errors**
   - Verify session name/ID is correct
   - Check that session exists: `minsky session list`
   - Ensure session is properly initialized

2. **"Path outside workspace" errors**
   - Avoid `../` in paths
   - Use relative paths from session root
   - Check for symlinks that might escape session boundary

3. **Permission errors**
   - Verify session workspace permissions
   - Check file/directory ownership
   - Ensure session has write access to target locations

4. **File not found errors**
   - Use `session_list_directory` to verify file structure
   - Check path spelling and case sensitivity
   - Verify the file exists in the session workspace

### Debug Mode

Enable debug logging for detailed path resolution information:

```bash
MINSKY_LOG_LEVEL=debug minsky mcp start
```

This will show detailed path resolution steps and security validation checks. 
