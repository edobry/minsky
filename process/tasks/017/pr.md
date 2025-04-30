# PR: Support both task ID formats (`000` and `#000`) in commands with `--task` option

## Summary
This PR adds support for consistent task ID normalization across all Minsky commands that accept task IDs as parameters or options. It introduces a utility function `normalizeTaskId` that ensures task IDs always have the leading hash symbol (`#`). This allows users to specify task IDs with or without the leading hash, providing a more flexible user experience.

## Changes
- Added `normalizeTaskId` utility function in `src/utils/task-utils.ts`
- Added unit tests for the utility function
- Updated commands that accept task IDs to use the normalization utility:
  - `session get` command with `--task` option
  - `session start` command with `--task` option
  - `tasks get` command (task ID argument)
  - `tasks status` commands (get and set)

## Testing
- Added comprehensive unit tests for the `normalizeTaskId` utility function
- Manually tested commands with and without leading hash in task IDs
- Verified proper error handling for invalid task IDs

## Implementation Notes
- Commands normalize task IDs at the command level, not in the domain layer
- The domain layer continues to store and handle task IDs in the standard format with leading hash
- Tasks with the leading hash and without it now work identically across all commands 
