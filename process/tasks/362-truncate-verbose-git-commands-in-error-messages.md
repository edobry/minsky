# Truncate Verbose Git Commands in Error Messages

## Context

Git commands in error messages can become extremely verbose, making error messages difficult to read and debug. This is particularly problematic with:

- Long session workspace paths (e.g., `/Users/edobry/.local/state/minsky/sessions/task362/some/deep/path/to/file.ts`)
- Complex git commands with multiple arguments and flags
- Clone URLs with authentication tokens or long repository names

**Current Examples of Verbose Error Messages:**
```
Git clone failed: Command failed with exit code 128

Command: git -C /Users/edobry/.local/state/minsky/sessions/task362/very/long/workspace/path clone https://github.com/very-long-org-name/very-long-repository-name-with-many-words.git /Users/edobry/.local/state/minsky/sessions/task362/very/long/workspace/path/destination
Working directory: /Users/edobry/.local/state/minsky/sessions/task362/very/long/workspace/path
Execution time: 5432ms
```

## Problem

The current git error handling in several places includes full commands without truncation:

1. **`src/utils/git-exec.ts:115`** - Direct error message construction with `Command: ${fullCommand}`
2. **`src/utils/git-exec.ts:80,105`** - Context passed to enhanced error templates includes full command
3. **Enhanced error templates** - May suggest verbose retry commands

This makes error messages unwieldy and harder to parse, especially in development environments with long paths.

## Solution

Implement a command truncation utility that:

1. **Truncates long paths** to show only relevant parts (e.g., `...sessions/task362/src/file.ts`)
2. **Limits overall command length** with intelligent truncation
3. **Preserves essential information** (operation, key arguments, error details)
4. **Maintains readability** while providing enough context for debugging

## Implementation Plan

1. Create a `truncateGitCommand()` utility function
2. Apply truncation in `git-exec.ts` error handling
3. Update enhanced error templates to use truncated commands
4. Add tests to verify truncation behavior
5. Ensure important debugging information is preserved

## Acceptance Criteria

- [x] Git commands in error messages are truncated to reasonable length (≤150 chars)
- [x] Essential information (operation, key files, error type) is preserved
- [x] Long paths are intelligently shortened (show relevant parts)
- [x] Error messages remain actionable and debuggable
- [x] Tests verify truncation behavior with various command types
- [x] No regression in error message usefulness

## Implementation

### Changes Made

1. **Created `src/utils/command-truncation.ts`** - Core truncation utility
   - `truncateGitCommand()` - Main function for truncating git commands
   - `truncateWorkingDirectory()` - Specific function for path truncation
   - Intelligent session workspace path handling (`...sessions/taskXXX`)
   - File extension preservation
   - Configurable limits and ellipsis characters

2. **Updated `src/utils/git-exec.ts`** - Applied truncation to error handling
   - Import truncation utilities
   - Apply `truncateGitCommand()` to all command context labels
   - Apply `truncateWorkingDirectory()` to working directory paths
   - Preserves all existing functionality while reducing verbosity

3. **Added comprehensive tests** - `src/utils/command-truncation.test.ts`
   - 21 test cases covering various scenarios
   - Session workspace path truncation
   - File extension preservation
   - Custom configuration
   - Edge cases and error conditions

### Results

**Before:**
```
Command: git -C /Users/edobry/.local/state/minsky/sessions/task362/very/long/path/that/should/be/truncated/destination clone https://fake-repo.git
Working directory: /Users/edobry/.local/state/minsky/sessions/task362/very/long/path/that/should/be/truncated/destination
```

**After:**
```
Command: git -C .../sessions/task362/.../destination clone https://fake-repo.git
Working directory: .../sessions/task362
```

## Status

**COMPLETED** ✅ - Git command truncation implemented and tested.

All error messages now display truncated commands while preserving essential debugging information.
