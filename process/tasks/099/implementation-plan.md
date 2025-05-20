# Task #99: Implementation Plan for Environment-Aware Logging

## Understanding the Current System

From my analysis of the codebase, the current logging system:

1. Uses Winston for structured logging
2. Has two logger instances:
   - `agentLogger`: Structured JSON logs to stdout
   - `programLogger`: Human-readable text logs to stderr
3. Provides a simple wrapper (`log` object) with convenience functions
4. Outputs both log formats simultaneously in all environments

## Implementation Strategy

### 1. Environment Detection and Configuration

1. Modify `src/utils/logger.ts` to:
   - Add environment variable support for `MINSKY_LOG_MODE`
   - Add logic to read and validate the log mode
   - Configure Winston transports based on the detected mode
   - Add helper functions to check the current mode

### 2. Mode Configuration

1. Implement the modes specified in the requirements:
   - `STRUCTURED`: Enable full JSON logs to stdout (for machine consumption)
   - `HUMAN`: Enable only human-readable logs to stderr (for CLI usage)
   - Add auto-detection of terminal environment to default to `HUMAN` mode
   - Support explicit override through environment variables

### 3. Prevent Double-Logging

1. Modify error handling in CLI adapters:
   - Review and refactor `handleCliError` utility in `src/adapters/cli/utils/error-handler.ts`
   - Ensure errors are only logged once
   - Properly format error messages based on log mode

### 4. CLI Adapter Updates

1. Update CLI adapters to:
   - Use `log.cliError()` consistently for user-facing error messages
   - Set proper exit codes for error cases
   - Ensure consistent error handling across all commands

### 5. Documentation

1. Update documentation to reflect the new logging system:
   - Add information about the environment variables and modes
   - Document how to configure logging behavior
   - Provide examples of how to use the logging system

## Implementation Steps

1. **Modify Logger Implementation**

   - Add `MINSKY_LOG_MODE` environment variable support
   - Implement functions to detect current mode
   - Configure Winston transports based on mode
   - Update `log` wrapper to handle mode-specific behavior

2. **Update Error Handling**

   - Refactor error handler to prevent double-logging
   - Ensure proper error formatting based on log mode
   - Add consistent exit codes for error cases

3. **Update CLI Adapters**

   - Ensure consistent error handling across all CLI commands
   - Use appropriate log functions based on context

4. **Add Documentation**

   - Update README.md with logging mode information
   - Create docs/logging.md with detailed documentation
   - Add examples of how to use the logging system

5. **Testing**
   - Test the logging system in different modes
   - Verify error handling behavior
   - Ensure backward compatibility

## Technical Considerations

1. **Mode Detection Logic**

   - Default to `HUMAN` mode when running in a terminal
   - Default to `STRUCTURED` mode when not in a terminal
   - Allow explicit override through environment variables

2. **Transport Configuration**

   - In `HUMAN` mode: Disable JSON logs unless explicitly enabled
   - In `STRUCTURED` mode: Output both JSON and minimal CLI feedback

3. **Error Handling Flow**
   - Determine where errors are being double-logged currently
   - Fix error propagation to prevent duplicate logging
   - Ensure proper error capture in all scenarios
