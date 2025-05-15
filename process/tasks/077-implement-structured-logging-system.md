# Task #077: Implement Structured Logging System

## Context

The current project uses various `console.log`, `console.error`, and `console.warn` calls for outputting information, debugging, and error reporting. This approach lacks consistency, structure, and doesn't support different log levels or multiple output destinations.

A proper logging system would provide:

1. Consistent log formatting across the codebase
2. Support for different log levels (debug, info, warn, error)
3. The ability to direct different types of logs to different outputs
4. Better control over what is logged in production vs development environments
5. Structured logging for easier parsing and analysis
6. Separation between "program messages" (user-facing output) and "agent events" (system logs)

## Requirements

1. **Logging Library Selection**

   - Select a popular, well-maintained logging library (like Winston, Pino, or similar)
   - The library should be lightweight and have TypeScript support
   - It should support multiple transports/outputs

2. **Logger Implementation**

   - Create a centralized logger module that wraps the chosen library
   - Implement standard log levels (debug, info, warn, error)
   - Support structured logging with metadata
   - Implement log formatting that is readable for humans but also parseable
   - Configure sensible defaults for development and production environments

3. **Multiple Output Types**

   - Support console output for all logs
   - Implement separation between "program messages" (user output) and "agent events" (system logs)
   - Allow for future extension to other outputs (files, remote services, etc.)

4. **Codebase Migration**

   - Replace all `console.log`, `console.error`, and `console.warn` calls with the new logger
   - Categorize logs appropriately based on their purpose and content
   - Apply appropriate log levels to existing log statements

5. **Testing**
   - Add tests for the logger functionality
   - Ensure log capture/mocking works correctly in tests

## Implementation Steps

1. **Library Research and Selection**

   - [ ] Research available logging libraries compatible with TypeScript and Bun
   - [ ] Evaluate based on: features, performance, maintenance status, compatibility with project
   - [ ] Select the most appropriate library

2. **Logger Implementation**

   - [ ] Create a new `src/utils/logger.ts` module
   - [ ] Setup the chosen logging library with appropriate configuration
   - [ ] Implement a clean API with standardized log levels
   - [ ] Add support for structured metadata
   - [ ] Create separate streams for program messages vs agent events

3. **Testing Infrastructure**

   - [ ] Create tests for the logger module
   - [ ] Implement utilities for capturing/verifying logs in tests
   - [ ] Update existing test mocks that capture console output

4. **Codebase Migration**

   - [ ] Replace console.log calls with appropriate logger calls in domain modules
   - [ ] Replace console.error calls with logger.error across the codebase
   - [ ] Identify and properly categorize logs as program messages or agent events
   - [ ] Ensure consistent log formatting and information across modules

5. **Documentation**
   - [ ] Update developer documentation explaining the logging system
   - [ ] Add examples of proper logging usage
   - [ ] Document the different log levels and when to use each

## Verification

- [ ] All console.log/error/warn calls have been replaced with the new logger
- [ ] Logs have consistent formatting
- [ ] Different types of logs are properly categorized
- [ ] Log levels are used appropriately
- [ ] Tests pass and properly capture logs
- [ ] Documentation is complete
- [ ] Both "program messages" and "agent events" are correctly handled

## Implementation Plan (Comprehensive)

**Overall Approach Priorities:**
The logging implementation will prioritize:

- **Good Developer Experience (DX):** Simple to use, clear separation of concerns.
- **Low Configuration Overhead:** Minimal boilerplate and easy initial setup.
- **Easy Debuggability:** Structured logs for agent events, plain text for direct CLI feedback.
- **Flexibility in Outputs:** Chosen library should allow easy extension to different transports later.
- **Minimal Initial Implementation:** Start with the essentials and avoid over-engineering.

**Phase 1: Foundation & Library Selection**

1.  **Research & Decision (Estimate: 1 hour - Shortened as decision made)**

    - Initial research considered Pino, Winston, and Bunyan.
    - **Decision: Winston** selected.
    - Rationale: Winston provides excellent flexibility in transports and formatting, which is beneficial for clearly separating `stdout` (structured JSON for agent events) and `stderr` (plain text for program messages). While Pino offers higher performance, Winston's slightly more straightforward configuration for this specific dual-stream/dual-format requirement, combined with its maturity and rich feature set for future expansion, makes it a good fit for the project's priorities, especially given that extreme log throughput is less critical for a CLI tool than for a high-traffic server. The focus is on DX and a minimal, easy-to-understand initial setup.

2.  **Minimal Basic Logger Setup (Estimate: 2 hours - Refined for minimality)**

    - Install Winston.
    - Create `src/utils/logger.ts`. This module will export configured logger instances: `agentLogger` and `programLogger`.
    - **`agentLogger` Configuration:**
      - Output: `process.stdout`.
      - Format: Structured JSON (using `winston.format.json()`), including timestamps and full error stack traces (`winston.format.errors({ stack: true })`).
      - Level: Configurable via `LOG_LEVEL` environment variable (defaults to `debug` in development, `info` in production).
      - Transports: A single `winston.transports.Console` directing to `stdout`.
      - Includes `handleExceptions` and `handleRejections` to capture uncaught issues.
    - **`programLogger` Configuration:**
      - Output: `process.stderr`.
      - Format: Simple plain text (e.g., using `winston.format.printf(info => info.message)`), colorized by level.
      - Level: Configurable via `LOG_LEVEL` (same as `agentLogger`).
      - Transports: A single `winston.transports.Console` with `stderrLevels: ['*']` to ensure all its output goes to `stderr`.
      - Includes `handleExceptions` and `handleRejections`.
    - **Wrapper:** Implement a simple `log` object with convenience functions (`log.debug`, `log.info`, `log.warn`, `log.error` for `agentLogger`; and `log.cli`, `log.cliWarn`, `log.cliError` for `programLogger`).
    - **Initial Focus:** The setup will be minimal. Features like development-specific pretty-printing for JSON logs or extensive default metadata (beyond basic error properties) will be deferred and can be added later if a strong need for DX improvement arises.

3.  **Distinguishing Program Messages vs. Agent Events (Estimate: 1 hour - Simplified due to logger setup)**
    - Define "Program Messages":
      - Handled by `programLogger`.
      - Intended for human-readable, non-structured messages directly to `stderr` (e.g., brief status updates for non-JSON command output, interactive prompt text, non-critical errors or warnings meant for immediate user attention without breaking structured output).
      - If a CLI command produces primary structured output (via `agentLogger` to `stdout`), `programLogger` (to `stderr`) can still be used for essential out-of-band status or error messages.
    - Define "Agent Events":
      - Handled by `agentLogger`.
      - Intended for structured (JSON by default in production, pretty-printed structured logs in development) internal system events, debug information, and critical errors.
      - Prioritized for `stdout`. This means if a command outputs primary data (especially JSON), it will be via this logger.
    - Configure the logger (or use two logger instances if necessary, e.g. `programLogger` and `agentLogger`) to handle these two distinct streams.
    - Ensure `agentLogger.error()` includes stack traces and that custom error properties (e.g., from `MinskyError`) are logged.
    - Suggest consistently including a `context` field (e.g., module name, function name, or a specific operation like `MinskyCLI:session_start`) in structured logs from `agentLogger`.

**Phase 2: Integration & Testing**

4.  **Testing Infrastructure for Logger -- REMOVED AS PER USER REQUEST**

    - (Helper functions for capturing general stdout/stderr in existing tests will still be necessary as `console.*` calls are migrated, but dedicated logger tests are removed.)

5.  **Initial Codebase Migration (Targeted) (Estimate: 4 hours)**
    - Identify a small, representative module or command (e.g., one CLI command and its associated domain logic).
    - Replace `console.*` calls with the new `programLogger` and `agentLogger` as appropriate.
    - Focus on differentiating user-facing output vs. internal logging.
    - Run existing tests for this module and update them to use the new log capturing mechanism. Add new tests for logging behavior if needed.
    - Manually test some CLI commands to observe log output in dev and simulated prod environments.
    - Ensure no sensitive information is logged by default at `info` level or above.
    - (Redaction considerations removed as per user request)

**Phase 3: Full Migration & Refinement**

6.  **Full Codebase Migration (Iterative) (Estimate: 8-12 hours, spread over multiple sessions if large)**

    - Systematically go through the codebase (`src/` directory).
    - Replace all `console.log`, `console.info`, `console.warn`, `console.error` calls.
    - Apply critical thinking to each call:
      - Is this a program message or an agent event?
      - What is the appropriate log level? (e.g., errors should be `logger.error`, verbose info `logger.debug`).
      - What metadata would be useful (e.g., function name, relevant IDs, input parameters)?
    - Update tests as migration progresses. This is a good opportunity to improve test coverage around error conditions and output.

7.  **Configuration Refinement (Estimate: 2 hours)**
    - Based on migration experience, refine logger configurations.
    - Finalize production vs. development settings (e.g., log level, output format, sampling for high-volume logs if applicable).
    - Consider adding a mechanism to enable/disable specific debug namespaces if the chosen library supports it (like `debug` npm package).

**Phase 4: Documentation & Review**

8.  **Documentation (Estimate: 2 hours)**

    - Update/create developer documentation (`docs/` or a dedicated `LOGGING.md`).
    - Explain:
      - The chosen logging library and why.
      - How to use `programLogger` vs. `agentLogger`.
      - Standard log levels and when to use them.
      - How to add structured metadata.
      - How logging works in development vs. production.
      - How to test code that uses the logger.
    - Provide clear examples.

9.  **Self-Review & Final Testing (Estimate: 2 hours)**
    - Review all changes against task requirements.
    - Run all tests, linters.
    - Manually test some CLI commands to observe log output in dev and simulated prod environments.
    - Ensure no sensitive information is logged by default at `info` level or above.
    - Review logged data, especially when logging complex objects, for any inadvertently included sensitive information (secrets, PII). Implement or plan for redaction mechanisms if necessary, particularly if logging full request/response objects in the future.

**Total Estimated Time: 28-32 hours** -- (Adjusted due to removal of dedicated logger testing; actual time may vary)

**Potential Challenges & Considerations:**

- **Performance:** Ensure the chosen library and configuration don't introduce significant performance overhead, especially for high-frequency CLI commands.
- **Async Logging:** If transports involve async operations (e.g., writing to a remote service later), ensure proper handling of application exit and buffer flushing. (Initially, focus on sync console transports).
- **Verbosity Control:** Provide ways to easily control log verbosity for debugging specific modules without flooding the console.
- **Circular Dependencies:** Ensure the logger module itself doesn't create circular dependencies.
- **Global Error Handling:** Integrate with global error handlers (e.g., `process.on('uncaughtException')`) to ensure unhandled errors are logged correctly.

## Implementation Worklog

### Work Completed

1. **Research & Library Selection**

   - Selected Winston as the logging library due to its flexibility in transports and formatting
   - Added Winston dependency to the project (`bun add winston @types/winston`)

2. **Logger Implementation**

   - Created `src/utils/logger.ts` with the following features:
     - Separate loggers for agent (structured JSON to stdout) and program (human-readable text to stderr)
     - Support for different log levels (debug, info, warn, error)
     - Proper error handling with stack traces
     - Global error handling for uncaught exceptions and rejections
     - Environment variable configuration for log levels
   - Implemented separate log functions for different use cases:
     - `log.debug`, `log.info`, `log.warn`, `log.error` for agent logs (JSON to stdout)
     - `log.cli`, `log.cliWarn`, `log.cliError` for program logs (text to stderr)
   - Added enhanced error handling to extract and properly format error information

3. **Initial Setup & Testing**
   - Added test mode triggered by environment variable (`RUN_LOGGER_TEST`)
   - Verified proper functioning of both loggers with various message types
   - Tested error object handling and stack trace preservation

### Remaining Work

1. **Codebase Migration**

   - Replace all `console.log`, `console.error`, and `console.warn` calls with the new logger
   - Identify and migrate all console output across the codebase (approximately 28 files)
   - Categorize each log statement as either agent or program output
   - Assess appropriate log levels for each statement (debug, info, warn, error)
   - Update error handling to use structured error logging capabilities

2. **Test Updates**

   - Update existing tests that capture console output to work with the new logging system
   - Add test utilities for capturing and verifying logs in test environments
   - Create dedicated tests for the logger functionality

3. **Documentation**

   - Document the logging system usage in project documentation
   - Create examples for different logging scenarios
   - Document how to control log levels via environment variables
   - Add guidelines for when to use each type of logger and log level

4. **Integration & Verification**
   - Verify consistent formatting across all logs
   - Ensure proper separation between stdout (agent logs) and stderr (program logs)
   - Test the system with various log levels to ensure proper filtering
   - Verify all error handling works correctly with the new logging system

### Next Steps

The next immediate actions required are:

1. Begin systematic migration of console output in domain modules:

   - Start with core files in `src/domain/`
   - Move to command modules in `src/commands/`
   - Update adapter modules in `src/adapters/`

2. Create test utilities for capturing and verifying logs in tests

3. Document logging system usage patterns for developers
