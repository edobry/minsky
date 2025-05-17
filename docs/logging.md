# Structured Logging System

## Overview

Minsky uses a centralized logging system built on Winston to provide consistent, configurable logging across the codebase. The system provides separate streams for structured machine-readable logs and human-readable output.

## Key Components

- **Agent Logger**: Outputs structured JSON to stdout, intended for machine consumption and debugging
- **Program Logger**: Outputs human-readable text to stderr, intended for CLI user feedback
- **Environment Configuration**: Log levels configurable via the `LOG_LEVEL` environment variable

## When to Use Each Logger

### Agent Logger (`log.debug`, `log.info`, `log.warn`, `log.error`, `log.agent`)

Use the agent logger for:
- Internal system events
- Structured data that may need to be parsed
- Debug information
- Application errors and warnings
- Any output intended for machine consumption

Agent logs are formatted as JSON and sent to stdout.

### Program Logger (`log.cli`, `log.cliWarn`, `log.cliError`)

Use the program logger for:
- User-facing messages
- Command output and status updates
- Progress indicators
- Error messages displayed to the user
- Any output intended for human consumption

Program logs are formatted as human-readable text and sent to stderr.

## API Reference

### Agent Logging Methods

```typescript
// Standard logging levels
log.debug(message: string, context?: LogContext): void
log.info(message: string, context?: LogContext): void  // Alias: log.agent()
log.warn(message: string, context?: LogContext): void
log.error(message: string, context?: LogContext | Error): void

// Direct JSON output
log.agent(message: string, context?: LogContext): void  // Alias for log.info()
```

### Program Logging Methods

```typescript
log.cli(message: string, ...args: any[]): void       // Goes to stderr
log.cliWarn(message: string, ...args: any[]): void   // Goes to stderr
log.cliError(message: string, ...args: any[]): void  // Goes to stderr
```

### LogContext Type

```typescript
interface LogContext {
  [key: string]: any;
}
```

## Best Practices

### Command Implementation Pattern

Commands should follow this pattern:

```typescript
// For user-facing output
log.cli("Starting process...");

try {
  // Business logic here
  
  // For structured JSON output (when using --json option)
  if (options.json) {
    log.agent(JSON.stringify(result));
  } else {
    // For human-readable output
    log.cli(`Success: ${result.message}`);
  }
} catch (error) {
  // Error handling
  log.error("Command failed", error);
  
  if (options.json) {
    log.agent(JSON.stringify({ success: false, error: error.message }));
  } else {
    log.cliError(`Error: ${error.message}`);
  }
  process.exit(1);
}
```

### Error Handling

When logging errors, prefer passing the Error object as context rather than just the message:

```typescript
// GOOD
try {
  // code that might throw
} catch (error) {
  log.error("Operation failed", error);
}

// AVOID
try {
  // code that might throw
} catch (error) {
  log.error(`Operation failed: ${error.message}`);  // Loses stack trace!
}
```

### Context Objects

Include relevant context with logs to aid debugging:

```typescript
log.debug("Processing task", { 
  taskId: task.id,
  operation: "update",
  user: currentUser
});
```

### JSON Output

For commands that support the `--json` option:

```typescript
if (options.json) {
  // Machine-readable output to stdout
  log.agent(JSON.stringify(result));
} else {
  // Human-readable output to stderr
  log.cli("Operation completed successfully");
}
```

## Log Levels

The logging system supports the following levels (from highest to lowest priority):
- error
- warn
- info (default)
- http
- verbose
- debug
- silly

By default, only logs of level `info` and higher are displayed. For debug logs, you must explicitly set the `LOG_LEVEL` environment variable:

```bash
# To see debug logs
LOG_LEVEL=debug minsky command

# To see only errors and warnings
LOG_LEVEL=warn minsky command
```

## Testing Code That Uses Logging

Use the `LogCapture` utility from `src/utils/test-utils/log-capture.ts` to capture and verify logs in tests:

```typescript
import { withLogCapture } from "../utils/test-utils/log-capture";

test("my function logs correctly", async () => {
  const result = await withLogCapture(async (capture) => {
    // Call code that uses logger
    await myFunction();
    return capture;
  });
  
  // Check agent logs (JSON to stdout)
  expect(result.agentLogs).toContainEqual(
    expect.objectContaining({ 
      level: "info",
      message: "Operation completed" 
    })
  );
  
  // Check program logs (text to stderr)
  expect(result.cliLogs).toContain("Starting operation");
});
```

## Migration Guidelines

When migrating from `console.*` calls to the structured logger:

1. Replace `console.log` with:
   - `log.cli` for user-facing output
   - `log.agent` for structured data (especially with --json option)
   - `log.debug` for debugging information

2. Replace `console.error` with:
   - `log.cliError` for user-facing errors
   - `log.error` for internal error logging

3. Replace `console.warn` with:
   - `log.cliWarn` for user-facing warnings
   - `log.warn` for internal warning logging

## Environment Variable Configuration

- `LOG_LEVEL`: Sets the minimum log level to display (default: "info")
- `RUN_LOGGER_TEST`: Set to "true" to run the built-in logger test

## Implementation Details

The logging system is implemented in `src/utils/logger.ts` using Winston. It creates two separate loggers:

1. `agentLogger`: Outputs structured JSON to stdout
2. `programLogger`: Outputs human-readable text to stderr

Both loggers handle uncaught exceptions and unhandled promise rejections.

```typescript
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

- `LOG_LEVEL`: Sets the minimum log level to display (default: 'info')
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
