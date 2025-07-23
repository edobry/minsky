# Task #309: Improve file operation tools: auto-create directories and semantic error messages

## Problem Statement

File operation tools currently have poor UX for AI agents:

1. **No auto-directory creation** - `edit_file` fails with "ENOENT" when parent directories don't exist
2. **Cryptic error messages** - Low-level filesystem errors like "ENOENT" provide no guidance for recovery

## Experienced Issues

In Task #308, encountered:

```json
{ "success": false, "error": "ENOENT: no such file or directory, open '/path/file.ts'" }
```

**Problems:**

- AI agents must decode filesystem errors
- No guidance on how to fix the issue
- Forces manual directory creation before file operations
- Inconsistent behavior (session tools auto-create, regular tools don't)

## Solution

### 1. Auto-Create Directory Support

Update `edit_file` tool to match session tools:

```typescript
// Current session tool behavior (works well)
mcp_minsky -
  server_session_write_file({
    createDirs: true, // default
  });

// Proposed: same for regular tools
edit_file(path, content, {
  createDirs: true, // new default
});
```

### 2. Semantic Error Messages

Replace cryptic filesystem errors with actionable messages:

**Before:**

```json
{ "success": false, "error": "ENOENT: no such file or directory" }
```

**After:**

```json
{
  "success": false,
  "error": "Cannot create file - parent directory does not exist",
  "errorCode": "DIRECTORY_NOT_FOUND",
  "solutions": [
    "Set createDirs: true to auto-create directories",
    "Create directory first using create_directory tool",
    "Use an existing directory path"
  ],
  "retryable": true,
  "relatedTools": ["create_directory"]
}
```

### Error Code Mapping

| Filesystem Error | Semantic Error        | Agent Guidance                              |
| ---------------- | --------------------- | ------------------------------------------- |
| ENOENT (file)    | `FILE_NOT_FOUND`      | Check file path, use file_search            |
| ENOENT (dir)     | `DIRECTORY_NOT_FOUND` | Set createDirs or use create_directory      |
| EACCES           | `PERMISSION_DENIED`   | Check file permissions, use different path  |
| EEXIST           | `PATH_ALREADY_EXISTS` | Use force flag or different name            |
| EINVAL           | `INVALID_PATH`        | Check path format, avoid special characters |

### Session-Specific Errors

| Current Error       | Semantic Error              | Recovery Guidance                        |
| ------------------- | --------------------------- | ---------------------------------------- |
| "Session not found" | `SESSION_NOT_FOUND`         | Use session_list, verify name/ID         |
| Git conflicts       | `GIT_BRANCH_CONFLICT`       | Use conflict resolution flags            |
| Missing workspace   | `SESSION_WORKSPACE_INVALID` | Check session status, recreate if needed |

## Implementation Scope

**Tools to Update:**

- `edit_file` - add createDirs support + semantic errors
- `read_file` - semantic error messages
- `delete_file` - semantic error messages
- All `session_*` file tools - consistent error format
- Git operation tools - semantic git errors
- Session management tools - semantic session errors

**Error Response Schema:**

```typescript
interface ToolErrorResponse {
  success: false;
  error: string; // Human-readable message
  errorCode: string; // Semantic error type
  reason?: string; // Technical details
  solutions: string[]; // Actionable recovery steps
  retryable: boolean; // Can operation be retried
  relatedTools?: string[]; // Tools that might help
}
```

## Benefits

1. **Faster AI agent recovery** - clear next steps in errors
2. **Reduced debugging time** - no need to interpret filesystem codes
3. **Better developer experience** - tools "just work" with auto-directory creation
4. **Consistent behavior** - all file tools behave similarly
5. **Context-aware errors** - domain-specific guidance instead of generic messages

## Acceptance Criteria

- [ ] `edit_file` auto-creates parent directories by default
- [ ] All file tools return semantic error codes instead of filesystem errors
- [ ] Error messages include actionable recovery suggestions
- [ ] Session tools have consistent error format
- [ ] Git tools provide semantic conflict/auth error messages
- [ ] Error schema is documented and implemented consistently
- [ ] Backward compatibility maintained (tools still work the same way for happy path)

## Example Before/After

**Before (Task #308 experience):**

```bash
edit_file(src/domain/session/validation/__tests__/file.ts)
# Error: ENOENT: no such file or directory
# Agent must manually: mkdir -p src/domain/session/validation/__tests__
# Then retry: edit_file(...)
```

**After:**

```bash
edit_file(src/domain/session/validation/__tests__/file.ts)
# Works automatically - creates directories and file
# Or if createDirs: false, gives clear semantic error with recovery steps
```

This improves the fundamental developer experience for AI agents using Minsky tools.
