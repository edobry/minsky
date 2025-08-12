# Audit and fix task backend consistency across session operations

## Context

Several session operations still use `new TaskService()` directly instead of `createConfiguredTaskService()`, causing inconsistent behavior where some operations respect configured backends (like GitHub Issues) while others default to markdown.

## Problem

After fixing the merge command to use configured task backends, other session operations still hardcode task service creation:

**Files needing updates:**

- `src/domain/session/session-review-operations.ts` (line 77)
- `src/domain/session/commands/review-command.ts` (line 43)
- `src/domain/session/session-pr-operations.ts` (line 240)
- `src/domain/session/commands/start-command.ts` (line 38)
- `src/domain/session/session-approve-operations.ts` (lines 145, 244)
- `src/domain/session.ts` (lines 1234, 1674)

## Requirements

1. **Replace hardcoded TaskService creation** with `createConfiguredTaskService()`
2. **Maintain dependency injection interface** for testability
3. **Follow same pattern as merge command** for consistency
4. **Ensure proper workspace path** is passed to task service
5. **Add proper error handling** for configuration failures
6. **Test each operation** to verify backend configuration is respected

## Success Criteria

- [ ] All session operations use `createConfiguredTaskService()`
- [ ] GitHub Issues backend works correctly with all session operations
- [ ] Existing tests continue to pass
- [ ] Dependency injection preserved for testing
- [ ] Configuration system properly consulted for backend selection

## Impact

**High Priority** - Ensures consistent behavior across all session operations, critical for GitHub Issues backend integration.

## Requirements

## Solution

## Notes
