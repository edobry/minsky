# fix(#117): Fix Session Update Command Implementation

## Summary

This PR fixes issues with the `minsky session update` command. It addresses return value inconsistency, parameter naming, and force option implementation, ensuring the command works correctly across all interfaces.

## Changes

### Fixed

- Fixed return value inconsistency in `updateSessionFromParams` function to properly return session object
- Updated dirty workspace detection to use `execInRepository` to check for uncommitted changes
- Implemented proper handling of the `--force` option to allow updating sessions with uncommitted changes
- Added `--no-stash` and `--no-push` CLI options for better control over the update process
- Updated CLI, shared, and MCP adapters to handle the returned session information consistently
- Improved error messages when workspace has uncommitted changes

### Added

- Added comprehensive tests for the session update functionality with coverage for all options

## Testing

- Added unit tests in `src/domain/__tests__/session-update.test.ts` to verify:
  - Return value is correct and contains all necessary session information
  - Force option properly overrides uncommitted changes detection
  - noStash and noPush options work as expected
  - Error handling for various scenarios (validation errors, resource not found, etc.)
- Manually tested the command with and without force flag using a dirty workspace
- Verified the correct output formatting in CLI and MCP

## Base Branch: main
## PR Branch: 117
