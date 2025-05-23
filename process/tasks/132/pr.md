# feat(#132): Fix session get command output format

## Summary

Fixed the issue where `minsky session get --task <id>` only displayed `success: true` instead of showing comprehensive session details. The command now displays human-readable session information by default, while preserving the `--json` flag for machine-readable output.

## Changes

### Added

- Enhanced default formatter in CLI bridge to properly handle session objects
- Added `formatSessionDetails()` method for human-readable session information display
- Added `formatSessionSummary()` method for session list views
- Specific handling for `session.get`, `session.dir`, and `session.list` command results

### Changed

- Improved CLI bridge default formatter to handle nested objects properly
- Session get command now shows comprehensive details without requiring `--json` flag

### Fixed

- Issue where session get command only showed `success: true` instead of full session details
- Generic object handling in CLI output formatter

## Testing

- Created and ran test script to verify session formatting works correctly
- All session-related tests pass (74 tests)
- Verified the fix displays proper session information:
  - Session name and ID
  - Task ID if associated
  - Repository name and path
  - Branch name
  - Creation date
  - Backend type

## Before/After

**Before:**
```
❯ minsky session get --task 079
success: true
```

**After:**
```
❯ minsky session get --task 079
Session: task#079
Task ID: #079
Repository: local-minsky
Session Path: /Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#079
Branch: task#079
Created: 2025-05-16T22:16:33.321Z
Backend: local
Repository URL: /Users/edobry/Projects/minsky
```

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated
- [x] Backward compatibility maintained (--json flag still works) 
