# Session-Aware Tools Guide for AI Agents

This guide provides comprehensive documentation for AI agents using Minsky's session-aware tools, which provide Cursor-compatible functionality with session workspace isolation.

## Overview

Minsky implements session-aware versions of critical Cursor built-in tools that enforce workspace boundaries while maintaining exact interface compatibility. All tools operate within isolated session workspaces to prevent cross-session contamination and ensure proper task isolation.

## Tool Categories

### Phase 1: File Operations

#### `session_edit_file`
**Purpose**: Edit files using pattern-based editing with support for partial modifications.

**Parameters**:
- `session` (string): Session identifier (name or task ID)
- `path` (string): Path to file within session workspace
- `instructions` (string): Description of the edit to make
- `content` (string): Edit content with `// ... existing code ...` markers
- `createDirs` (boolean, optional): Create parent directories if needed (default: true)

**Usage Patterns**:

1. **New File Creation**:
```typescript
await session_edit_file({
  session: "task-123",
  path: "src/utils/helper.ts",
  instructions: "Create new utility helper function",
  content: `export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}`
});
```

2. **Partial File Modification**:
```typescript
await session_edit_file({
  session: "task-123", 
  path: "src/main.ts",
  instructions: "Add new import and function call",
  content: `import { formatDate } from './utils/helper.js';
// ... existing code ...
  const formatted = formatDate(new Date());
  console.log(formatted);
// ... existing code ...`
});
```

**Key Features**:
- Supports `// ... existing code ...` markers for partial edits
- Automatic directory creation
- Validates file exists when using existing code markers
- Session workspace boundary enforcement

#### `session_search_replace`
**Purpose**: Replace single occurrences of text with validation for uniqueness.

**Parameters**:
- `session` (string): Session identifier
- `path` (string): Path to file within session workspace  
- `search` (string): Text to search for (must be unique)
- `replace` (string): Replacement text

**Usage Example**:
```typescript
await session_search_replace({
  session: "task-123",
  path: "src/config.ts", 
  search: "const API_URL = 'localhost:3000';",
  replace: "const API_URL = process.env.API_URL || 'localhost:3000';"
});
```

**Important Notes**:
- Search text must appear exactly once in the file
- Provides helpful error messages for ambiguous matches
- Atomic read-modify-write operations

### Phase 2: Search Operations

#### `session_grep_search`
**Purpose**: Fast regex pattern matching within session workspace using ripgrep.

**Parameters**:
- `session` (string): Session identifier
- `query` (string): Search pattern (supports regex)
- `case_sensitive` (boolean, optional): Case sensitivity (default: false)
- `include_pattern` (string, optional): Glob pattern for files to include
- `exclude_pattern` (string, optional): Glob pattern for files to exclude

**Usage Examples**:

1. **Basic Text Search**:
```typescript
await session_grep_search({
  session: "task-123",
  query: "TODO",
  case_sensitive: false
});
```

2. **Regex with File Filtering**:
```typescript
await session_grep_search({
  session: "task-123",
  query: "function\\s+\\w+\\(",
  include_pattern: "*.ts",
  exclude_pattern: "*.test.ts"
});
```

**Features**:
- Results limited to 50 matches per file
- Supports full regex patterns
- Fast performance using ripgrep
- File inclusion/exclusion patterns

#### `session_file_search`
**Purpose**: Fuzzy file name searching within session workspace.

**Parameters**:
- `session` (string): Session identifier
- `query` (string): File name or partial path to search

**Usage Example**:
```typescript
await session_file_search({
  session: "task-123",
  query: "helper"
}); // Finds files like "helper.ts", "test-helper.js", etc.
```

**Features**:
- Returns up to 10 most relevant results
- Fuzzy matching algorithm with relevance scoring
- Shows total match count
- Optimized for large codebases

#### `session_codebase_search`
**Purpose**: Semantic search with query expansion and context snippets.

**Parameters**:
- `session` (string): Session identifier
- `query` (string): Semantic search query
- `target_directories` (string[], optional): Directories to search within

**Usage Example**:
```typescript
await session_codebase_search({
  session: "task-123",
  query: "error handling authentication",
  target_directories: ["src/auth", "src/middleware"]
});
```

**Features**:
- Semantic query expansion for programming concepts
- Context snippets around matches
- Directory filtering with glob patterns
- Grouped results by file

### Phase 3: Command Execution

#### `session_run_command`
**Purpose**: Execute shell commands within session workspace with isolation.

**Parameters**:
- `session` (string): Session identifier
- `command` (string): Shell command to execute
- `is_background` (boolean, optional): Run in background (default: false)

**Usage Examples**:

1. **Basic Command**:
```typescript
await session_run_command({
  session: "task-123",
  command: "npm test"
});
```

2. **Background Process**:
```typescript
await session_run_command({
  session: "task-123", 
  command: "npm run dev",
  is_background: true
});
```

**Features**:
- Commands execute in session workspace directory
- 30-second timeout protection
- Background process support
- Environment variable inheritance
- Exact Cursor output formatting

#### `session_list_dir`
**Purpose**: List directory contents with metadata in Cursor-compatible format.

**Parameters**:
- `session` (string): Session identifier
- `relative_workspace_path` (string): Directory path relative to session workspace

**Usage Example**:
```typescript
await session_list_dir({
  session: "task-123",
  relative_workspace_path: "src/components"
});
```

**Output Format**:
```
Contents of directory:

[dir]  shared/ (12 items)
[file] Button.tsx (2.3KB, 67 lines)
[file] Input.tsx (1.8KB, 45 lines)
```

**Features**:
- File size formatting (B, KB, MB, GB)
- Line counting for all files
- Directory item counting
- Permission-safe error handling

#### `session_read_file`
**Purpose**: Read file contents with optional line range support.

**Parameters**:
- `session` (string): Session identifier
- `target_file` (string): File path relative to session workspace
- `should_read_entire_file` (boolean): Whether to read complete file
- `start_line_one_indexed` (number): Starting line number (1-based)
- `end_line_one_indexed_inclusive` (number): Ending line number (inclusive)

**Usage Examples**:

1. **Read Entire File**:
```typescript
await session_read_file({
  session: "task-123",
  target_file: "src/main.ts",
  should_read_entire_file: true,
  start_line_one_indexed: 1,
  end_line_one_indexed_inclusive: 100
});
```

2. **Read Line Range**:
```typescript
await session_read_file({
  session: "task-123",
  target_file: "src/large-file.ts", 
  should_read_entire_file: false,
  start_line_one_indexed: 50,
  end_line_one_indexed_inclusive: 75
});
```

**Features**:
- Intelligent truncation with summaries
- Line range selection
- Large file handling
- Context preservation

## Security and Isolation

### Session Workspace Boundaries
All tools enforce strict session workspace isolation:

- **Path Validation**: All file paths validated against session boundaries
- **Traversal Prevention**: Path traversal attacks (`../`, `..\\`) blocked
- **Workspace Confinement**: Operations limited to session directory tree
- **Error Handling**: Clear error messages for boundary violations

### Command Execution Security
- **Working Directory**: Commands execute in session workspace
- **Environment Isolation**: Each session has isolated environment context
- **Timeout Protection**: 30-second timeout prevents runaway processes
- **Resource Limits**: Process spawning controlled and monitored

## Error Handling Patterns

### Common Error Types
1. **Session Not Found**: Invalid session identifier provided
2. **Path Outside Workspace**: Attempt to access files outside session
3. **File Not Found**: Target file doesn't exist
4. **Permission Denied**: Insufficient permissions for operation
5. **Command Failed**: Shell command execution failure

### Error Response Format
All tools return consistent error responses:
```typescript
{
  success: false,
  error: "Descriptive error message",
  session: "task-123",
  // ... tool-specific context
}
```

## Performance Considerations

### File Operations
- **Atomic Operations**: Read-modify-write operations are atomic
- **Directory Creation**: Recursive directory creation with caching
- **Large Files**: Streaming support for files >10MB

### Search Operations
- **Result Limiting**: Configurable result limits prevent memory issues
- **Index Caching**: File metadata cached for repeated searches
- **Parallel Processing**: Multiple search operations can run concurrently

### Command Execution
- **Process Pooling**: Reuse shell processes when possible
- **Background Jobs**: Non-blocking background process execution
- **Resource Monitoring**: CPU and memory usage tracking

## Best Practices for AI Agents

### 1. Session Management
- Always include valid session identifier in all tool calls
- Use task IDs as session identifiers for consistency
- Handle session creation/cleanup appropriately

### 2. Error Handling
- Check `success` field in all tool responses
- Provide meaningful error messages to users
- Implement retry logic for transient failures

### 3. File Operations
- Use `session_file_search` to locate files before editing
- Validate file existence before complex operations
- Use relative paths within session workspace

### 4. Search Efficiency
- Use appropriate search tool for use case:
  - `session_grep_search`: Pattern matching, code search
  - `session_file_search`: File discovery, navigation
  - `session_codebase_search`: Semantic understanding, concept search

### 5. Command Execution
- Validate commands before execution
- Use background execution for long-running processes
- Monitor command output for errors and completion

## Integration Examples

### Typical AI Agent Workflow
```typescript
// 1. Discover relevant files
const searchResults = await session_file_search({
  session: "task-123",
  query: "auth"
});

// 2. Read file to understand current implementation  
const fileContent = await session_read_file({
  session: "task-123",
  target_file: "src/auth/login.ts",
  should_read_entire_file: true,
  start_line_one_indexed: 1,
  end_line_one_indexed_inclusive: 100
});

// 3. Search for specific patterns
const patterns = await session_grep_search({
  session: "task-123", 
  query: "TODO|FIXME",
  include_pattern: "*.ts"
});

// 4. Make targeted edits
const editResult = await session_edit_file({
  session: "task-123",
  path: "src/auth/login.ts",
  instructions: "Add error handling for failed login",
  content: `// ... existing code ...
  } catch (error) {
    console.error('Login failed:', error);
    throw new Error('Authentication failed');
  }
// ... existing code ...`
});

// 5. Run tests to validate changes
const testResult = await session_run_command({
  session: "task-123",
  command: "npm test -- auth"
});
```

## Troubleshooting

### Common Issues and Solutions

1. **"Session not found" errors**
   - Verify session identifier is correct
   - Ensure session has been properly created
   - Check session naming conventions

2. **"Path outside workspace" errors**
   - Use relative paths within session workspace
   - Avoid `../` path traversal attempts
   - Verify file paths are correct

3. **"Search text not found" in `session_search_replace`**
   - Include more context in search string
   - Verify exact text including whitespace
   - Use `session_grep_search` to locate text first

4. **Command execution timeouts**
   - Use background execution for long-running commands
   - Break complex commands into smaller steps
   - Check for infinite loops or blocking operations

5. **Performance issues**
   - Limit search result sets appropriately
   - Use file filtering patterns effectively
   - Consider caching for repeated operations

## Migration from Cursor Tools

For AI agents currently using Cursor's built-in tools, migration involves:

1. **Add Session Parameter**: Include session identifier in all tool calls
2. **Update Tool Names**: Prefix all tool names with `session_`
3. **Path Handling**: Ensure all paths are relative to session workspace
4. **Error Handling**: Update error handling for new response format

### Migration Mapping
| Cursor Tool | Session-Aware Tool | Changes Required |
|-------------|-------------------|------------------|
| `edit_file` | `session_edit_file` | Add session parameter |
| `search_replace` | `session_search_replace` | Add session parameter |
| `grep_search` | `session_grep_search` | Add session parameter |
| `file_search` | `session_file_search` | Add session parameter |
| `codebase_search` | `session_codebase_search` | Add session parameter |
| `run_terminal_cmd` | `session_run_command` | Add session parameter |
| `list_dir` | `session_list_dir` | Add session parameter |
| `read_file` | `session_read_file` | Add session parameter |

The interface compatibility ensures minimal changes required for migration while providing enhanced security and isolation. 
