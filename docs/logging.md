# Minsky Logging System

Minsky uses a structured logging system that is environment-aware, providing appropriate log formats based on the execution context.

## Logging Modes

Minsky supports two primary logging modes:

- **HUMAN** (default for CLI usage): Clean, human-readable logs only
- **STRUCTURED** (for CI/CD, integrations): Full JSON logs for machine consumption

## Configuration

### Environment Variables

The logging system can be configured using these environment variables:

| Variable            | Description                     | Default                                  | Example                  |
| ------------------- | ------------------------------- | ---------------------------------------- | ------------------------ |
| `MINSKY_LOG_MODE`   | Sets the logging mode           | Auto-detected based on terminal presence | `MINSKY_LOG_MODE=HUMAN`  |
| `LOG_LEVEL`         | Sets the logging level          | `info`                                   | `LOG_LEVEL=debug`        |
| `ENABLE_AGENT_LOGS` | Enables JSON logs in HUMAN mode | `false`                                  | `ENABLE_AGENT_LOGS=true` |

### Auto-Detection

By default, Minsky auto-detects the appropriate logging mode:

- When running in a terminal (TTY): HUMAN mode
- When running in non-interactive environments (CI/CD, scripts): STRUCTURED mode

You can override this behavior by explicitly setting the `MINSKY_LOG_MODE` environment variable.

## Log Types

Minsky makes a distinction between two types of logs:

1. **Agent Logs** (JSON format to stdout):

   - Structured data for machine consumption
   - Detailed context and metadata
   - Used for system events, debug information, and machine-readable output
   - Disabled by default in HUMAN mode unless `ENABLE_AGENT_LOGS=true`

2. **Program Logs** (plain text to stderr):
   - Human-readable messages
   - Clean, concise output
   - Used for user-facing CLI feedback and error messages
   - Always enabled in both HUMAN and STRUCTURED modes

## Using the Logger

For developers, Minsky provides a consistent logging API through the `log` object:

```typescript
import { log } from "../../utils/logger.js";

// Agent logs (JSON to stdout)
log.agent("Operation completed", { userId: "123" }); // info level
log.debug("Debug information", { data: someObject }); // Silenced in HUMAN mode, enabled in STRUCTURED mode
log.warn("Warning condition", { code: 100 });
log.error("Error occurred", new Error("Something went wrong"));

// Program logs (plain text to stderr)
log.cli("User-facing message");
log.cliWarn("User-facing warning");
log.cliError("User-facing error");
log.cliDebug("Debug message for CLI"); // Only shown when LOG_LEVEL=debug
log.systemDebug("System debug message"); // Always shows in stderr when debug level is enabled, regardless of mode
```

### Mode-Aware Methods

- `log.debug()`: In HUMAN mode, this method is a no-op by default (unless `ENABLE_AGENT_LOGS=true`), which prevents "no transports" warnings. In STRUCTURED mode, it outputs debug logs to stdout as JSON.

- `log.systemDebug()`: This method always logs to stderr using programLogger regardless of the current mode. Use it for important system debugging information that should always be visible when debug level is enabled.

### Checking Current Mode

You can check the current logging mode using:

```typescript
import { isHumanMode, isStructuredMode } from "../../utils/logger.js";

if (isHumanMode()) {
  // Behavior specific to HUMAN mode
}

if (isStructuredMode()) {
  // Behavior specific to STRUCTURED mode
}
```

## Best Practices

1. **Choose the appropriate log type**:

   - Use agent logs (`log.agent`, `log.debug`, etc.) for internal events and structured data
   - Use program logs (`log.cli`, `log.cliDebug`, etc.) for user-facing output
   - Use `log.systemDebug` for critical system debugging in any mode

2. **Set appropriate log levels**:

   - Use `debug` for verbose information useful for debugging
   - Use `info` for standard operational information
   - Use `warn` for concerning but non-error conditions
   - Use `error` for failure conditions

3. **Provide context**:

   - Always add relevant context objects to agent logs
   - Keep human-readable messages concise but informative

4. **Handle errors properly**:

   - Use `log.cliError()` for user-facing error messages
   - Use `log.error()` for detailed error logging

5. **Test in both modes**:
   - Test your implementation in both HUMAN and STRUCTURED modes
   - Verify the output is appropriate for each context

## Debug Logging Guidelines

When adding debug logs, follow these guidelines:

1. For general system debugging that should be visible in both modes when debug is enabled:

   ```typescript
   log.systemDebug("Important system information", { context });
   ```

2. For detailed internal debugging that should only appear in STRUCTURED mode (or when explicitly enabled):

   ```typescript
   log.debug("Internal system event", { detailedContext });
   ```

3. For CLI-specific debugging that should always go to stderr:
   ```typescript
   log.cliDebug("CLI-related debug info");
   ```

This ensures that debug logs don't clutter terminal output but are available when needed for troubleshooting.
