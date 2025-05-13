# PR Summary for Task #016: Enforce Task Operations in Main Workspace

## Overview

This PR implements automatic workspace detection for task operations. Now, when a task command is executed from a session repository, Minsky automatically detects this and performs the operation on the main workspace instead of the session-specific copy.

## Changes

1. Created a new workspace utility module (`src/domain/workspace.ts`) with functions to:

   - Detect if running in a session repository
   - Resolve the main workspace path from a session repository
   - Handle file:// URLs in workspace paths

2. Updated TaskService and TaskBackend interfaces to use workspace paths:

   - Changed constructor parameter from `repoPath` to `workspacePath`
   - Added `getWorkspacePath()` method to both interfaces
   - Updated implementations to use workspace paths

3. Modified all task commands to use workspace detection:

   - Added `--workspace` option to all task commands
   - Updated command handlers to resolve the main workspace path
   - Used detected workspace path for all task operations

4. Added comprehensive documentation in README.md

## Benefits

- Task operations are now consistent regardless of where they're executed from
- No manual directory changes are needed when working in session repositories
- Transparent to users - everything just works as expected

## Testing

Created a test script that demonstrates the functionality - changing task status from a session repository correctly updates the main workspace.

## Future Improvements

- Add caching for workspace path resolution
- Consider adding similar workspace detection for other command types
