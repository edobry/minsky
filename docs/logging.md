# Minsky Logging System

This document describes the structured logging system used throughout the Minsky codebase.

## Overview

Minsky uses a centralized logging system based on Winston to provide:

1. Consistent structured logging across the codebase
2. Separation of program messages (user-facing CLI output) and agent events (system logs)
3. Multiple log levels for different types of information
4. Structured context for debugging and analysis
5. Proper error handling with stack traces

## Logger Types

The system provides two main loggers:

### 1. Agent Logger (`agentLogger`)

- **Purpose**: System events, structured data, debug information
- **Output**: `stdout` as JSON (for machine consumption)
- **Use Cases**: JSON responses, structured data for debugging, system events

### 2. Program Logger (`programLogger`)

- **Purpose**: User-facing messages, CLI output
- **Output**: `stderr` as plain text
- **Use Cases**: CLI feedback, warnings, errors meant for human consumption

## Log Methods

The logging system provides a simplified interface via the `log` object:

### Agent Methods (to stdout)

- `log.debug(message, context?)` - Debug information with optional context object
- `log.info(message, context?)` - Informational messages
- `log.warn(message, context?)` - Warning messages
- `log.error(message, context?)` - Error messages with stack traces

### Program Methods (to stderr)

- `log.cli(message)` - Standard CLI output
- `log.cliWarn(message)` - Warning messages to CLI
- `log.cliError(message)` - Error messages to CLI

### Direct JSON Output

- `log.agent(jsonString)` - Outputs raw JSON to stdout (for structured responses)

## Usage Patterns

### Basic Usage

```typescript
import { log } from "../utils/logger";

// Debug information with context
log.debug("Processing file", { path: "/path/to/file.txt", size: 1024 });

// User-facing message
log.cli("File processed successfully");

// Warning with context
log.warn("File size exceeds recommended limit", { size: 1024, limit: 100 });

// Error with stack trace
try {
  // ... code that might throw
} catch (error) {
  log.error("Failed to process file", {
    path: "/path/to/file.txt",
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  
  // User-facing error message
  log.cliError(`Failed to process file: ${error instanceof Error ? error.message : String(error)}`);
}
```

### JSON Output Pattern

When implementing commands with `--json` option:

```typescript
if (options.json) {
  // Structured JSON output to stdout
  log.agent(JSON.stringify({
    success: true,
    data: result
  }));
} else {
  // Human-readable output to stderr
  log.cli(`Operation completed: ${result.summary}`);
}
```

### Error Handling Pattern

```typescript
try {
  // Attempt operation
} catch (error) {
  // Log structured error for debugging
  log.error("Operation failed", {
    params: { /* operation parameters */ },
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  
  // Provide appropriate user feedback based on output mode
  if (options.json) {
    log.agent(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }));
  } else {
    log.cliError(`Operation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  process.exit(1);
}
```

## Best Practices

1. **Use Appropriate Log Levels**
   - `debug`: Detailed information useful for debugging
   - `info`: General information about system operation
   - `warn`: Warning conditions
   - `error`: Error conditions

2. **Include Relevant Context**
   - Always include relevant context in structured logs
   - For domain operations, include operation name and input parameters
   - For CLI commands, include command name and options
   - For errors, include stack traces and related object IDs

3. **Separate User-Facing and System Messages**
   - Use `log.cli` and family for user-facing output
   - Use `log.debug`, `log.info`, etc. for system events

4. **Proper Error Handling**
   - Always include the original error message
   - Include stack traces for errors
   - Type-check errors: `error instanceof Error ? error.message : String(error)`

5. **JSON Output**
   - Use `log.agent()` for JSON responses
   - Always include a `success` boolean in the response
   - Include error details when `success` is `false`

## Environment Variables

The logging system can be configured with environment variables:

- `LOG_LEVEL`: Sets the minimum log level to display (default: 'debug' in development, 'info' in production)
- `NODE_ENV`: When set to 'production', reduces verbosity

## Testing with Logs

When writing tests that involve logs:

1. Avoid testing specific log output directly
2. Use mocks to verify logging calls if necessary
3. Focus tests on behavior, not implementation details

```typescript
// DON'T do this:
expect(console.log).toHaveBeenCalledWith("specific message");

// DO test the behavior that should result from the logging:
expect(result.success).toBe(true);
``` 
