# Pull Request: Add Task ID Support to Session Start Command

## Overview
This PR implements task #001, adding support for associating sessions with tasks in the `minsky session start` command. The implementation allows users to start a session with a task ID, which automatically names the session after the task and stores the task ID in the session record.

## Changes
1. Enhanced `session start` command:
   - Added `--task <task-id>` option
   - Task ID validation using TaskService
   - Session naming based on task ID (e.g., `task#001`)
   - Task ID stored in session record
   - Error handling for missing/duplicate tasks

2. Fixed test issues:
   - Improved git PR test reliability by adding better error handling and cleanup
   - Fixed timeout issues in git PR test
   - Added tests for task ID functionality

## Testing
- All tests passing
- Added new tests for task ID functionality
- Fixed reliability issues in git PR tests

## Documentation
- Updated README with task ID examples
- Updated CHANGELOG with new functionality

## Verification
- [x] Can start a session with a freeform name as before
- [x] Can start a session with `--task <task-id>`
- [x] Session is named after the task ID
- [x] Task ID is stored in session record
- [x] Errors out if task does not exist
- [x] Errors out if session for task already exists
- [x] All tests passing
- [x] Documentation updated

## Related Issues
- Closes #001 
