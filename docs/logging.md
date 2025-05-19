# Minsky Logging System

Minsky uses a structured logging system that is environment-aware, providing appropriate log formats based on the execution context.

## Logging Modes

Minsky supports two primary logging modes:

- **HUMAN** (default for CLI usage): Clean, human-readable logs only
- **STRUCTURED** (for CI/CD, integrations): Full JSON logs for machine consumption

## Configuration

### Environment Variables

The logging system can be configured using these environment variables:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MINSKY_LOG_MODE` | Sets the logging mode | Auto-detected based on terminal presence | `MINSKY_LOG_MODE=HUMAN` |
| `LOG_LEVEL` | Sets the logging level | `info` | `LOG_LEVEL=debug` |
| `ENABLE_AGENT_LOGS` | Enables JSON logs in HUMAN mode | `false` | `ENABLE_AGENT_LOGS=true` |

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
log.debug("Debug information", { data: someObject });
log.warn("Warning condition", { code: 100 });
log.error("Error occurred", new Error("Something went wrong"));

// Program logs (plain text to stderr)
log.cli("User-facing message");
log.cliWarn("User-facing warning");
log.cliError("User-facing error");
log.cliDebug("Debug message for CLI");
```

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
   - Use agent logs for internal events and structured data
   - Use program logs for user-facing output

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
