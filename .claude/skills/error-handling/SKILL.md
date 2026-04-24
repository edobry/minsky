---
name: error-handling
description: >-
  Error handling guidance: type-safe errors, structured error objects, graceful
  degradation, context preservation, resource cleanup, timeouts, and user-friendly
  error messages. Use when handling errors, designing error strategies, or implementing error recovery.
user-invocable: true
---

# Error Handling

Guidance for implementing robust error handling with type safety, context preservation, graceful degradation, and user-friendly error messages.

## Arguments

Optional: description of the error handling scenario (e.g., `/error-handling async API call with retries`).

## Scenario guide

| Scenario               | Approach                                            |
| ---------------------- | --------------------------------------------------- |
| General error handling | Type-safe errors with `{ cause: err }` for context  |
| API/network errors     | Timeouts + retry logic + structured error responses |
| Filesystem errors      | try/finally for cleanup, graceful fallbacks         |
| CLI error presentation | User-friendly messages with action steps            |
| MCP tool errors        | Structured error objects with diagnostic info       |

## Principles

### 1. Always check for errors

- Never ignore errors from any operation
- Handle all error cases explicitly
- Provide fallbacks or graceful degradation where appropriate

### 2. Type-safe error handling

Ensure errors maintain their proper types to preserve stack traces and error details:

```typescript
// AVOID
catch (err) {
  console.error(`Error: ${err}`); // Converts Error object to string, losing the stack trace
}

// PREFER
catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error(`Error: ${error.message}`);
  // log error.stack when needed
}
```

### 3. Structured error objects

Use structured error objects rather than error strings:

```typescript
// For function results that may contain errors
interface OperationResult {
  success: boolean;
  error?: Error;
  message?: string;
}

// For specialized error types
class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}
```

### 4. Preserve error context

Use `{ cause: err }` when re-throwing to maintain the chain, and add contextual information when propagating:

```typescript
// AVOID
throw new Error(`Failed: ${err instanceof Error ? err.message : String(err)}`);

// PREFER
try {
  await processFile(filePath);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`Failed to process file ${filePath}: ${message}`, { cause: err });
}
```

### 5. Graceful degradation

Handle errors in a way that allows the application to continue running if possible:

```typescript
async function checkStatus() {
  try {
    // Core functionality
  } catch (err) {
    logger.error(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
    // Return a default or fallback state
    return { status: "unknown", error: err };
  }
}
```

### 6. Ensure resource cleanup

Use try/finally to guarantee cleanup even when errors occur:

```typescript
let resource;
try {
  resource = acquireResource();
  return useResource(resource);
} finally {
  if (resource) {
    releaseResource(resource);
  }
}
```

### 7. Set timeouts for async operations

Prevent hanging operations with proper timeouts:

```typescript
// Set up a timeout with proper cleanup
const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => {
    reject(new Error(`Operation timed out after ${timeoutMs}ms`));
  }, timeoutMs);
});

// Race the operation against the timeout
return Promise.race([operation(), timeoutPromise]);
```

### 8. ALL errors are blockers

See the `dont-ignore-errors` rule (`.minsky/rules/dont-ignore-errors.mdc`) for the hard policy: all errors must be fixed before task completion.

## User-facing error messages

Transform technical errors into helpful, actionable guidance that empowers users to resolve issues quickly.

### Message structure

Every user-facing error should answer:

- **What** went wrong (specific, not generic)
- **Why** it happened (context when helpful)
- **How** to fix it (actionable steps with exact commands)
- **How** to continue (next step after fixing)

**Template pattern**:

```typescript
throw new MinskyError(
  `
🚫 [Clear problem statement]

[Specific context about current state]

To fix this, run one of the following:

📝 [Primary solution with command]:
   [exact command to run]

📦 [Alternative solution]:
   [exact command to run]

💡 Then try again:
   [original command to retry]

Need help? [Additional guidance or resources]
`.trim()
);
```

### Show specific context, not generic messages

```typescript
// AVOID
throw new Error(
  "Cannot create PR with uncommitted changes. Please commit or stash your changes first."
);

// PREFER — show actual uncommitted files categorized by type
const status = await gitService.getStatus(currentDir);
const changes = [];
if (status.modified.length > 0) {
  changes.push(`📝 Modified files (${status.modified.length}):`);
  status.modified.forEach((file) => changes.push(`   ${file}`));
}
// ... include actionable steps
```

### Use progressive information disclosure

- **Essential info first**: Problem and immediate action
- **Details second**: Current state, file lists, etc.
- **Debug info last**: Technical details only in debug mode

### Common error patterns

**Authentication errors**:

```typescript
// AVOID
throw new Error("Git authentication failed. Check your credentials or SSH key.");

// PREFER
throw new MinskyError(
  `
🔐 Git authentication failed

Your Git credentials are not working for this repository.

Common solutions:
📝 For HTTPS repositories:
   git config credential.helper store
   git pull  # Enter username/token when prompted

🔑 For SSH repositories:
   ssh-add ~/.ssh/id_rsa
   ssh -T git@github.com  # Test SSH connection

💡 For GitHub, use a personal access token instead of password:
   https://github.com/settings/tokens

Repository: ${repoUrl}
`.trim()
);
```

**Missing parameters**:

```typescript
// AVOID
throw new Error("Either 'session', 'taskId', or 'repoPath' must be provided to create a PR.");

// PREFER
throw new MinskyError(
  `
🎯 Session not specified

To create a PR, specify which session to use:

📂 Use current session (auto-detected):
   minsky session pr create --title "your title" --type feat

🏷️  Use specific session name:
   minsky session pr create --session my-session --title "your title" --type feat

🎫 Use task ID to find session:
   minsky session pr create --task 123 --title "your title" --type feat

💡 List available sessions:
   minsky session list
`.trim()
);
```

**File system errors**:

```typescript
// AVOID
throw new FileSystemError("Permission denied", filePath);

// PREFER
throw new FileSystemError(
  `
📁 Cannot access file

Permission denied accessing: ${filePath}

To fix this:
📝 Check file permissions:
   ls -la ${filePath}

🔧 Fix permissions:
   chmod 644 ${filePath}

💡 Or run with appropriate permissions:
   sudo minsky [your command]
`.trim(),
  filePath
);
```

**Network/service errors**:

```typescript
// AVOID
throw new ServiceUnavailableError("Service unavailable", "github");

// PREFER
throw new ServiceUnavailableError(
  `
🌐 Cannot connect to GitHub

GitHub API is not responding. This might be temporary.

Solutions to try:
📝 Check GitHub status:
   https://www.githubstatus.com/

⏱️  Wait and try again:
   minsky [your command]  # in a few minutes

🔧 Check your internet connection:
   ping github.com
`.trim(),
  "github"
);
```

**Validation errors**:

```typescript
// AVOID
throw new ValidationError("Invalid task ID format");

// PREFER
throw new ValidationError(
  `
🎫 Invalid task ID format

Received: "${taskId}"
Expected: A number (e.g., "123") or prefixed format (e.g., "#123", "task#123")

Valid examples:
✅ minsky tasks get 123
✅ minsky tasks get "#123"
✅ minsky tasks get "task#123"

💡 List available tasks:
   minsky tasks list
`.trim()
);
```

### Emoji conventions

- 🚫 Problems/blocks
- ✅ Success states
- 📝 Actions to take
- 📦 Alternative actions
- 💡 Tips and next steps
- 🔐 Authentication issues
- 🎯 Missing requirements
- ⚠️ Warnings

### When to apply user-friendly messages

**Do apply for**:

- All user-facing error messages in CLI commands
- MCP tool error responses that users will see
- Validation errors from user input
- File system and network errors users can act on

**Don't apply for**:

- Internal debug logging
- Stack traces (preserve technical details)
- Errors meant for developers only

### Verification checklist

Before submitting user-facing error messages:

- [ ] Message shows specific context (files, values, state)
- [ ] Includes exact commands user can run
- [ ] Provides multiple solution paths when applicable
- [ ] Uses consistent emoji and formatting
- [ ] Tested the suggested commands actually work
- [ ] Appropriate level of detail for the user's context

## Anti-patterns to avoid

- **Swallowing errors silently**: Never catch errors without proper handling or logging
- **String concatenation for error messages**: Use template literals, not `+`
- **Generic error messages**: Messages should be specific about what failed and why
- **Untyped error handling**: Always handle the fact that errors might not be `Error` instances

## Related rule

- `dont-ignore-errors` — all errors are blockers; never proceed with errors unresolved
