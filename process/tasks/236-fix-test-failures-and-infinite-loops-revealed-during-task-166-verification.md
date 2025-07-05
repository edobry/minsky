# Fix test failures and infinite loops revealed during Task #166 verification

## Status

BACKLOG

## Priority

MEDIUM

## Description

Critical issues discovered during TypeScript error verification:

1. **Infinite Loop Issues (314 failed tests)**
   - Many tests running for 4+ billion milliseconds indicating infinite loops
   - GitHubIssuesTaskBackend constructor failing with undefined workspacePath
   - SessionPathResolver tests timing out

2. **Property Naming Mismatches**
   - Tests expecting _title, _status, _session but getting title, status, session
   - filterTasks function expects filter.status but tests pass _status
   - parseTaskSpecFromMarkdown returns title but tests expect _title
   - Systematic mismatch between interface definitions and test expectations

3. **Variable Naming Protocol Violations**
   - Previous variable naming fixes may have incorrectly removed underscores from intentionally prefixed parameters
   - Need to distinguish between unused parameters (should have _) and API parameters (should not have _)

4. **Critical Regressions**
   - 314 out of 916 tests failing (34% failure rate)
   - Core functionality broken including task filtering, spec parsing, and backend initialization

This task should:
- Investigate and fix infinite loop root causes
- Restore correct property naming conventions
- Fix GitHubIssuesTaskBackend constructor issues
- Ensure all 916 tests pass
- Verify no performance regressions

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
