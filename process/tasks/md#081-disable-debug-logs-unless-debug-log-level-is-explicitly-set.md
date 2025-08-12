# Disable Debug Logs Unless Debug Log Level is Explicitly Set

## Context

Currently, the logger utility in the Minsky project outputs debug logs by default, regardless of whether debug log level is explicitly requested. This is because the default log level is set to "debug" in `src/utils/logger.ts`.

While debug logs are useful during development, they can create unnecessary noise in production environments and may expose sensitive information. The current approach of having debug logs enabled by default is not following the best practice of having production-appropriate defaults.

## Requirements

1. **Logger Configuration**

   - Change the default log level from "debug" to "info"
   - Only output debug logs when LOG_LEVEL is explicitly set to "debug" or lower
   - Ensure all existing debug logging works correctly when LOG_LEVEL is set appropriately

2. **Interface Consistency**

   - Maintain the current logging API
   - No changes to log method signatures or behavior when debug is enabled

3. **Documentation**
   - Update relevant documentation to explain the new default log level
   - Document how to enable debug logging when needed

## Implementation Steps

1. [ ] Update the default log level in `src/utils/logger.ts`

   - [ ] Change the default log level from "debug" to "info"
   - [ ] Ensure LOG_LEVEL environment variable is still respected when set

2. [ ] Verify existing debug calls

   - [ ] Review and test to confirm debug log statements throughout the codebase
   - [ ] Ensure debug logs are suppressed when LOG_LEVEL is not set to "debug"
   - [ ] Verify debug logs are shown when LOG_LEVEL is explicitly set to "debug"

3. [ ] Test the changes

   - [ ] Add tests to verify the logger respects the new default log level
   - [ ] Add tests to verify explicit LOG_LEVEL settings work correctly

4. [ ] Update documentation
   - [ ] Update README or other relevant documentation to explain how logging works
   - [ ] Document how to enable debug logging when needed

## Verification

- [ ] The default log level is changed from "debug" to "info"
- [ ] No debug logs are output unless LOG_LEVEL is explicitly set to "debug"
- [ ] All log methods still work correctly
- [ ] Documentation is updated to reflect the changes
- [ ] Tests pass verifying both default and explicit log level settings
