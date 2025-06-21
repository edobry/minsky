# Session File Tools - MCP Integration

## Overview

The Session File Tools provide secure, session-scoped file operations for AI agents through the MCP (Model Context Protocol) server. These tools ensure that all file operations are properly isolated within session workspaces, preventing accidental modifications to the main workspace.

## Available Tools

### 1. `session.read_file`

Read a file from the current session workspace.

**Parameters:**
- `path` (string): Relative path to the file within the session workspace
- `session` (string, optional): Session ID (defaults to current session)

**Example Response:**
```json
{
  "success": true,
  "content": "File content here...",
  "path": "src/example.ts",
  "absolutePath": "/path/to/session/workspace/src/example.ts",
  "session": "task#123"
}
```

### 2. `session.write_file`

Write content to a file in the current session workspace.

**Parameters:**
- `path` (string): Relative path to the file within the session workspace
- `content` (string): Content to write to the file
- `createDirectories` (boolean, optional): Create parent directories if needed (default: true)
- `session` (string, optional): Session ID (defaults to current session)

**Example Response:**
```json
{
  "success": true,
  "path": "src/new-file.ts",
  "absolutePath": "/path/to/session/workspace/src/new-file.ts",
  "session": "task#123",
  "bytesWritten": 1024
}
```

### 3. `session.list_directory`

List contents of a directory in the current session workspace.

**Parameters:**
- `path` (string, optional): Relative path to directory (default: ".")
- `session` (string, optional): Session ID (defaults to current session)

**Example Response:**
```json
{
  "success": true,
  "path": "src",
  "absolutePath": "/path/to/session/workspace/src",
  "session": "task#123",
  "items": [
    {
      "name": "file.ts",
      "type": "file",
      "size": 1024,
      "lastModified": "2024-01-01T12:00:00.000Z"
    },
    {
      "name": "subdir",
      "type": "directory",
      "size": 4096,
      "lastModified": "2024-01-01T12:00:00.000Z"
    }
  ]
}
```

### 4. `session.file_exists`

Check if a file or directory exists in the current session workspace.

**Parameters:**
- `path` (string): Relative path to check within the session workspace
- `session` (string, optional): Session ID (defaults to current session)

**Example Response (file exists):**
```json
{
  "success": true,
  "exists": true,
  "path": "src/file.ts",
  "absolutePath": "/path/to/session/workspace/src/file.ts",
  "session": "task#123",
  "type": "file",
  "size": 1024,
  "lastModified": "2024-01-01T12:00:00.000Z"
}
```

**Example Response (file doesn't exist):**
```json
{
  "success": true,
  "exists": false,
  "path": "src/missing.ts",
  "absolutePath": "/path/to/session/workspace/src/missing.ts",
  "session": "task#123"
}
```

## Security Features

### Path Validation
All tools enforce strict path validation to prevent directory traversal attacks:
- Paths like `../../../etc/passwd` are blocked
- Absolute paths are blocked
- All operations are confined to the session workspace

### Session Isolation
- Each session has its own isolated workspace
- Operations cannot access files from other sessions
- Main workspace is protected from accidental modifications

## Usage with AI Agents

AI agents can use these tools instead of standard file operation tools when working within session workspaces:

```javascript
// Instead of: edit_file
// Use: session.write_file

// Instead of: read_file  
// Use: session.read_file

// Instead of: list_dir
// Use: session.list_directory
```

## Error Handling

All tools return structured error responses:

```json
{
  "success": false,
  "error": "Path '../outside' resolves outside session workspace...",
  "path": "../outside",
  "session": "task#123"
}
```

## Implementation Details

- Built on the MCP (Model Context Protocol) framework
- Uses FastMCP for tool registration and execution
- Implements `SessionPathResolver` for secure path validation
- Supports dependency injection for testing
- Comprehensive test suite with security validation

## Integration

The session file tools are automatically registered with the MCP server when it starts. No additional configuration is required - they are available immediately when using the Minsky MCP server within a session workspace. 
