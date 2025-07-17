# Fix Session PR Title Duplication Bug

## Status

IN-PROGRESS

## Priority

MEDIUM

## Description

Fix session PR title duplication issues in the session PR workflow where titles are incorrectly duplicated across different parts of the PR creation process.

## Problem Analysis

Based on investigation of the codebase and historical issues, there are several patterns of title duplication in the session PR workflow:

### Pattern 1: Title Duplication in Commit Messages
When using `extractPrDescription()` function to reuse existing PR descriptions, titles may be duplicated in the commit message format, leading to redundant title information.

### Pattern 2: Title Duplication in Body Content
During PR refresh functionality, titles may be incorrectly included in both the `--title` parameter and duplicated as the first line of the `--body` content.

### Pattern 3: File-Based Title Duplication
Historical issues with creating unnecessary `pr-title.txt` files that duplicate title information in the repository.

## Current Implementation Issues

### extractPrDescription Function
Located in multiple files:
- `src/domain/session.ts` (lines ~1066-1130)
- `src/domain/session/session-pr-operations.ts` 
- `src/domain/session/commands/pr-command.ts`

The function extracts commit messages and parses them into title/body, but may not properly handle:
- Commit messages that already contain formatted PR descriptions
- Separation between actual commit title and PR title content
- Proper parsing of multiline commit messages

### Session PR Refresh Logic
The refresh functionality allows reusing existing PR descriptions but may duplicate titles when:
- Extracting from existing commits that already have formatted titles
- Combining extracted titles with new title parameters
- Parsing commit messages that contain both commit info and PR description

## Requirements

### 1. Fix extractPrDescription Function
- [ ] Ensure proper parsing of commit messages to avoid title duplication
- [ ] Handle cases where commit messages already contain formatted PR titles
- [ ] Prevent duplication when extracting title/body from existing PR branches

### 2. Improve Session PR Refresh Logic
- [ ] Ensure clean separation between extracted titles and new titles
- [ ] Prevent title duplication in body content during refresh operations
- [ ] Add validation to detect and prevent title duplication patterns

### 3. Enhance Error Prevention
- [ ] Add validation to detect title duplication before PR creation
- [ ] Improve logging to help identify duplication issues
- [ ] Add safeguards against creating duplicate title content

### 4. Testing and Verification
- [ ] Create tests that reproduce title duplication scenarios
- [ ] Add regression tests to prevent future duplication issues
- [ ] Verify fixes work with both new PR creation and refresh workflows

## Technical Investigation Areas

### Files to Investigate
- `src/domain/session.ts` - Main sessionPrFromParams function
- `src/domain/session/session-pr-operations.ts` - PR operations implementation
- `src/domain/session/commands/pr-command.ts` - Command interface
- `src/schemas/session.ts` - Parameter validation schemas

### Specific Functions to Review
- `extractPrDescription()` - Title/body extraction logic
- `sessionPrFromParams()` - Main PR creation workflow  
- `sessionPrImpl()` - Implementation details
- `checkPrBranchExistsOptimized()` - Branch detection logic

## Success Criteria

1. **No Title Duplication**: PR creation and refresh should never duplicate titles
2. **Clean Separation**: Clear distinction between commit messages and PR descriptions
3. **Robust Parsing**: Handle various commit message formats without duplication
4. **Regression Prevention**: Tests prevent future duplication issues
5. **User Experience**: Clear, non-duplicated PR titles and descriptions

## Related Issues

- Task #231: Session PR refresh functionality (may have introduced duplication)
- Task #146: Session PR command import bug (pr-title.txt file issues)  
- Historical cursor rules mention title duplication as recurring problem

## Implementation Plan

1. **Investigation Phase**: Analyze current duplication patterns
2. **Fix Phase**: Implement fixes for identified issues
3. **Testing Phase**: Add comprehensive tests
4. **Verification Phase**: Manual testing of PR workflows
5. **Documentation Phase**: Update any relevant documentation 
