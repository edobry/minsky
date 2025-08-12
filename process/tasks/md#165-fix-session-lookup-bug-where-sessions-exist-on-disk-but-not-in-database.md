# Fix Session Lookup Bug Where Sessions Exist on Disk But Not in Database

## Problem Description

Sessions created with `minsky session start <name>` are not properly registered in the session database, causing lookup failures when using session commands like `minsky session pr`.

**Current Symptoms:**

- `minsky session start error-message-improvements` succeeds and creates session directory
- `minsky session pr --title "..."` fails with "Session 'error-message-improvements' not found"
- Session directory exists at `~/.local/state/minsky/git/*/sessions/error-message-improvements`
- Session is not returned by `minsky sessions list`

## Root Cause Analysis

The issue appears to be a disconnect between:

1. Session creation (`minsky session start`) - creates file system directories
2. Session database registration - should register session metadata for lookups

This suggests the session start command is not properly calling the database registration step, or there's an error in the registration that's being silently ignored.

## Expected Behavior

When `minsky session start <name>` completes successfully:

1. Session directory should be created on disk ✅ (working)
2. Session metadata should be registered in database ❌ (broken)
3. `minsky sessions list` should show the session ❌ (broken)
4. `minsky session pr` should find the session ❌ (broken)

## Technical Investigation Required

1. **Trace session start workflow**:

   - Check `startSessionFromParams` in `src/domain/session.ts`
   - Verify `sessionDB.addSession()` is being called
   - Check for silent failures in database operations

2. **Check database backends**:

   - Verify both JSON file and new adapter backends register sessions correctly
   - Test session creation with different backend configurations

3. **Validate session lookup chain**:
   - Verify `getSession()` method works correctly
   - Check if database file permissions/paths are correct
   - Ensure session records have required fields

## Acceptance Criteria

- [ ] Sessions created with `minsky session start` appear in `minsky sessions list`
- [ ] Session PR commands work immediately after session creation
- [ ] Both JSON file and adapter backends register sessions correctly
- [ ] Existing broken sessions can be recovered (import functionality)
- [ ] Add test coverage for session creation → database registration flow
- [ ] Error handling: if database registration fails, session creation should fail

## Reproduction Steps

1. `minsky session start test-session`
2. `minsky sessions list` (should show test-session but doesn't)
3. `minsky session pr --title "test"` (should work but fails with session not found)

## Files to Investigate

- `src/domain/session.ts` - `startSessionFromParams` function
- `src/domain/session/session-db.ts` - database operations
- `src/domain/session/session-db-adapter.ts` - new backend
- `src/adapters/shared/commands/session.ts` - CLI command handlers

## Priority

High - This breaks the core session workflow and forces users to work around fundamental functionality.
