# Enhanced Error Messages and Debugging

## Status

BACKLOG

## Priority

MEDIUM

## Description

Improve error messages based on specific failures encountered in Task 209: 1) 'Cannot run session pr from PR branch' should suggest switching to session branch, 2) Task ID parsing errors should show supported formats (numeric vs alphanumeric), 3) Variable naming errors should point to specific declaration vs usage mismatches, 4) Git command hanging should timeout with helpful messages, 5) Merge conflict errors should identify specific conflicting files and suggest resolution strategies, 6) Backend detection failures should show available backends and configuration requirements.

## Dependencies and Context

**High overlap with Task 169 (Error Message Deduplication):**

- Task 169 provides the error template infrastructure this task needs
- Task 169's template system includes `ErrorEmojis`, `buildErrorMessage`, and specialized error templates
- Task 169 created 9 template functions for common error patterns
- **Recommendation**: Complete Task 169's systematic refactoring first, then use the established template system for Task 223's specific improvements

**Complementary scope:**

- Task 169: Infrastructure and systematic deduplication across codebase
- Task 223: Specific error scenarios and user experience improvements from Task 209

## Requirements

1. **Session PR Branch Error**: Detect when user attempts `session pr` from PR branch and suggest switching to session branch
2. **Task ID Parsing**: Show supported formats (numeric vs alphanumeric) when parsing fails
3. **Variable Naming**: Point to specific declaration vs usage mismatches in error messages
4. **Git Command Timeouts**: Add timeout handling with helpful messages for hanging git commands
5. **Merge Conflict Details**: Identify specific conflicting files and suggest resolution strategies
6. **Backend Detection**: Show available backends and configuration requirements when detection fails

## Success Criteria

1. All 6 error scenarios from Task 209 have improved, actionable error messages
2. Error messages use Task 169's template system for consistency
3. Error messages include specific context and suggested actions
4. Timeout handling prevents hanging git operations
5. Users can quickly understand and resolve common errors
6. Error message improvements are covered by tests
