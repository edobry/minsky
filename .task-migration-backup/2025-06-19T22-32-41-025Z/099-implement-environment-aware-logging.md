# Task #099: Implement Environment-Aware Logging

## Context

Task #077 added structured logging with a separation between agent logs (JSON to stdout) and program logs (text to stderr). Task #093 improved error handling across CLI commands. However, when running CLI commands in a terminal, both log formats are currently output simultaneously, creating a poor user experience with verbose JSON output alongside human-readable text.

Users have reported seeing dual-format logging when running commands, with errors being logged twice in different formats. This creates confusion and makes the CLI output difficult to read.

## Description

Currently, Minsky's logging system outputs both structured JSON logs and human-readable text logs simultaneously in all environments. This creates a poor user experience in terminal/CLI usage, with verbose JSON logs appearing alongside the intended user-facing output. Furthermore, errors are often logged twice - once in JSON format and once in plain text.

This task involves modifying the logging system to be environment-aware, outputting appropriate log formats based on the execution context.

## Requirements

1. **Environment Detection**

   - Add a `MINSKY_LOG_MODE` environment variable to control logging behavior
   - Support at least two modes:
     - `STRUCTURED`: Full JSON logs for machine consumption (for CI/CD, integrations)
     - `HUMAN`: Clean, human-readable logs only (default for CLI usage)

2. **Default Logging Behavior**

   - When running in a terminal without explicit configuration, default to `HUMAN` mode
   - In `HUMAN` mode, disable JSON logs to stdout unless explicitly enabled via `ENABLE_AGENT_LOGS=true`
   - In `STRUCTURED` mode, output both JSON logs and minimal CLI feedback

3. **Error Handling Improvements**

   - Fix double-logging of errors in CLI operations
   - Ensure errors thrown in domain logic are properly captured and formatted in CLI adapters
   - Provide consistent error output format across all commands

4. **CLI Adapter Updates**
   - Modify CLI adapters to handle errors consistently
   - Use `log.cliError()` for user-facing error messages instead of letting errors propagate to the top level
   - Add proper exit codes for error cases

## Implementation Strategy

1. Modify `src/utils/logger.ts` to:

   - Read the `MINSKY_LOG_MODE` environment variable
   - Configure winston transports based on the mode
   - Add helper constants/functions to check the current mode

2. Update CLI adapters to:

   - Catch and format errors consistently
   - Prevent double-logging
   - Provide user-friendly error messages

3. Update error handling in domain functions to:

   - Log errors without necessarily throwing them
   - Or, ensure errors are only logged once

4. Document the new environment variables and modes in:
   - README.md
   - docs/logging.md

## Acceptance Criteria

1. When running CLI commands in a terminal:

   - Only human-readable logs are displayed by default
   - No JSON logs appear in the console output
   - Error messages are displayed exactly once in a clean, readable format

2. When running in `STRUCTURED` mode:

   - Full JSON logs are output to stdout
   - Human-readable logs are still available for direct user interaction

3. All CLI commands handle errors consistently, with:

   - Proper exit codes
   - User-friendly error messages
   - No duplicate error output

4. Documentation is updated to explain the available logging modes and environment variables

## Notes

- This task builds on the work done in Task #077 (Implement Structured Logging System) and Task #093
- The changes should be backward compatible with existing code using the logger
- Consider adding a third mode like `DEBUG` that outputs both formats with maximum verbosity
