---
name: error-handling
description: >-
  Error handling guidance: type-safe errors, structured error objects, graceful
  degradation, context preservation, resource cleanup, and timeouts.
  Use when handling errors, designing error strategies, or implementing error recovery.
user-invocable: true
---

# Error Handling

Guidance for implementing robust error handling with type safety, context preservation, and graceful degradation.

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

### 2. Preserve error context

- Use `{ cause: err }` when re-throwing to maintain the chain
- Add contextual information when propagating
- Use structured error objects, not string concatenation

```typescript
// AVOID
throw new Error(`Failed: ${err.message}`);

// PREFER
throw new Error("Failed to load config", { cause: err });
```

### 3. Use type-safe error handling

```typescript
// AVOID — untyped
catch (err) {
  console.log(err);
}

// PREFER — typed with proper handling
catch (err) {
  if (err instanceof ConfigError) {
    return fallbackConfig;
  }
  throw err;
}
```

### 4. Ensure resource cleanup

- Use try/finally to guarantee cleanup
- Close file handles, database connections, etc.
- Handle errors during cleanup itself

```typescript
const handle = await openFile(path);
try {
  await processFile(handle);
} finally {
  await handle.close();
}
```

### 5. Set timeouts for async operations

- Prevent hanging operations
- Handle timeout errors gracefully
- Provide meaningful timeout messages

### 6. ALL errors are blockers

Every error MUST be fixed before task completion — including warnings, linting errors, type errors, and build errors. If fixing requires scope expansion:

1. Acknowledge the error explicitly
2. Propose a plan for the fix
3. Ask for confirmation if the fix expands scope
4. Never mark a task complete while errors remain

## User-facing error messages

Transform technical errors into helpful guidance:

```typescript
// AVOID
throw new Error("ENOENT: no such file or directory");

// PREFER
throw new Error(
  "Configuration file not found at ~/.minsky/config.yaml\n" +
    "Run 'minsky init' to create a default configuration"
);
```

Every user-facing error should answer:

- **What** went wrong (specific context)
- **Why** it matters
- **How** to fix it (actionable steps)
- **How** to continue (next step after fixing)

## Related rules

- `robust-error-handling` — detailed patterns and code examples
- `dont-ignore-errors` — all errors are blockers, never proceed with errors
- `user-friendly-error-messages` — transforming technical errors into guidance
