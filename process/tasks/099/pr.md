# feat(#99): Implement Environment-Aware Logging

## Summary

This PR implements an environment-aware logging system that adjusts its output format based on the execution context, providing appropriate log formats for different environments (terminal/CI/automation).

## Changes

### Added

- Added `LogMode` enum with `HUMAN` and `STRUCTURED` modes in logger.ts
- Implemented auto-detection of terminal environments to set appropriate logging mode
- Added `MINSKY_LOG_MODE` environment variable for explicit mode control
- Added `ENABLE_AGENT_LOGS` flag to enable JSON logs in HUMAN mode if needed
- Created comprehensive documentation in docs/logging.md
- Added tests for logging mode detection logic

### Changed

- Modified agentLogger to only output when in STRUCTURED mode or explicitly enabled
- Updated error-handler.ts to use the appropriate logging methods based on current mode
- Updated outputResult utility to handle JSON output based on mode
- Improved CLI adapters to use mode-aware logging
- Updated README.md with logging information

### Fixed

- Fixed double-logging of errors in terminal environments
- Improved user experience in terminal by suppressing verbose JSON output
- Fixed presentation of error messages to be cleaner and more user-friendly

## Testing

The changes were tested with the following:

- Unit tests for mode detection logic
- Manual testing with different environment configurations:
  - HUMAN mode (default for terminal)
  - STRUCTURED mode (for CI/CD)
  - HUMAN mode with ENABLE_AGENT_LOGS=true

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated 
