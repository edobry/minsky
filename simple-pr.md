Complete audit and fix of all git execAsync timeout issues.

This PR fixes 32 unsafe git operations by replacing execAsync with execGitWithTimeout, preventing hanging git commands that blocked task #280.

## What Changed
- Fixed 32 unsafe execAsync patterns across 8 files
- Enhanced ESLint rule to catch all git operations
- Added comprehensive timeout protection

## Files Modified
- src/domain/git.ts (10 patterns)
- src/domain/localGitBackend.ts (2 patterns) 
- src/domain/git/conflict-analysis-operations.ts (5 patterns)
- src/domain/repository/ files (9 patterns)
- src/domain/git/commands/ files (2 patterns)
- Enhanced ESLint rule and config

Resolves git hanging issues and provides comprehensive timeout protection.
