# Improve session PR conflict resolution workflow with auto-resolution and better UX

## Status

BACKLOG

## Priority

MEDIUM

## Description



## Problem
The current session PR command detects merge conflicts correctly but provides poor user experience for resolution:

1. **Vague error messages**: Tell users conflicts exist but don't guide them through resolution steps
2. **No auto-resolution**: Simple conflicts like task status changes require manual intervention  
3. **Confusing workflow**: Users get stuck not knowing what to do next
4. **No continuation guidance**: After manual resolution, unclear how to proceed

## Evidence
During task #231, the session PR command failed with conflicts, but the error messages led to confusion and multiple failed attempts before finding the right solution.

## Current Error Message Issues
- Says 'Look for conflict markers' but doesn't explain the workflow
- Doesn't mention git status, git add, git commit sequence
- No guidance on how to continue after resolution
- Doesn't distinguish between simple and complex conflicts

## Proposed Solutions

### 1. Auto-resolve Simple Conflicts
- Task status changes: [-] vs [+] → auto-resolve to [+]
- File deletions in main branch → auto-accept deletion
- Add --auto-resolve-simple flag

### 2. Interactive Conflict Resolution
- Prompt: 'Found task status conflict. Auto-resolve? (Y/n)'
- Guide through each conflict file
- Show preview of resolution

### 3. Improved Error Messages
- Step-by-step resolution instructions
- Clear workflow: git status → edit files → git add → git commit → retry PR
- Specific commands to run

### 4. Better Integration
- After manual resolution, automatically continue with PR creation
- Detect when conflicts are resolved and prompt to continue
- Clear success/failure feedback

## Acceptance Criteria
- [ ] Auto-resolve task status conflicts with user confirmation
- [ ] Provide step-by-step conflict resolution guidance
- [ ] Clear error messages with specific commands to run
- [ ] Seamless continuation after conflict resolution
- [ ] Add integration tests for conflict scenarios


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
