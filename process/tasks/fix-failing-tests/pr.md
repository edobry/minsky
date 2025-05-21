# fix: fix failing tests on main branch

## Summary

This PR fixes two critical issues that were causing tests to fail on the main branch:
1. The task ID filtering in `filterTasks` function was not correctly handling numeric ID comparison
2. Test failures were occurring due to unavailable `mock.fn` function in the test utilities

## Changes

### Fixed
- Fixed ID comparison in the `filterTasks` function to properly convert IDs to numbers before comparison
- Added a custom mock function implementation in test utilities that handles cases when `mock.fn` is undefined
- Updated CHANGELOG.md with the fixes

### Added
- Added proper TypeScript definitions for the mock function implementation

## Testing

- All tests that previously failed now pass successfully
- The `filterTasks` function correctly filters tasks by ID even when using numeric values

## Checklist

- [x] All requirements implemented
- [x] All tests pass 
- [x] Code quality is acceptable
- [x] Documentation is updated (CHANGELOG.md)
