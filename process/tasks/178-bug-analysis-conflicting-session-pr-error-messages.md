# Bug Analysis: Conflicting Session PR Error Messages

## Issue Summary

The Minsky CLI gives conflicting error messages when attempting to create a pull request via the `session pr` command, creating confusion and preventing users from successfully completing the workflow.

## Contradictory Error Messages

**Error Message 1** (from `src/domain/git.ts:1372`):
```
⚠️  Note: Session PR commands must be run from the main workspace, not from within the session directory.
```

**Error Message 2** (from `src/domain/session.ts:1050`):
```
session pr command must be run from within a session workspace. Use 'minsky session start' first.
```

## Root Cause

There are **two different execution paths** for session PR creation with **contradictory workspace requirements**:

### Path 1: `sessionPrFromParams` (requires session workspace)
- **Location**: `src/domain/session.ts:1042-1055`
- **Requirement**: Must be run **FROM WITHIN** session workspace
- **Check**: `currentDir.includes("/sessions/")`
- **Used by**: `minsky session pr` command

### Path 2: `GitService.preparePr` (recommends main workspace)  
- **Location**: `src/domain/git.ts:1350-1375`
- **Requirement**: Recommends running **FROM MAIN** workspace  
- **Error context**: Session not found in database
- **Used by**: Called internally by `sessionPrFromParams`

## Detailed Flow Analysis

1. **User runs `minsky session pr` from session workspace**
   → `sessionPrFromParams` validates workspace ✅
   → Calls `preparePrFromParams` → `GitService.preparePr`
   → `GitService.preparePr` can't find session in database ❌
   → Returns error suggesting to run from main workspace

2. **User runs `minsky session pr` from main workspace**  
   → `sessionPrFromParams` rejects immediately ❌
   → Returns error requiring session workspace

## Architecture Problems

### 1. **Inconsistent Workspace Requirements**
- `sessionPrFromParams`: Requires session workspace context
- `GitService.preparePr`: Expects session to be registered in database

### 2. **Session Database Sync Issues**
- Sessions exist on filesystem but not in database
- No automatic session registration/import mechanism
- Database and filesystem state can diverge

### 3. **Poor Error Message Coordination**
- Each layer provides context-specific advice
- No coordination between error messages
- User gets contradictory instructions

## Proposed Solutions

### Solution 1: Fix Session Database Sync (Immediate)
- Implement automatic session registration when sessions exist on disk
- Add session import/sync command for manual recovery
- Ensure database stays in sync with filesystem

### Solution 2: Unified Workspace Detection (Medium-term)
- Create single source of truth for workspace requirements
- Implement intelligent workspace detection that works from both contexts
- Consolidate error messaging strategy

### Solution 3: Improve Error Messages (Quick Fix)
- Coordinate error messages between layers
- Provide clear, non-contradictory guidance
- Include automatic recovery suggestions

## Impact Assessment

**Severity**: High - Blocks core workflow functionality
**Frequency**: Occurs whenever session database is out of sync
**User Impact**: Complete workflow blockage with confusing error messages

## Recommended Next Steps

1. **Create task** to fix session database sync issues
2. **Implement unified error messaging** strategy  
3. **Add session workspace detection** that works from both contexts
4. **Improve documentation** with clear troubleshooting steps

## Related Issues

- Session database sync problems
- Workspace detection inconsistencies  
- Error message coordination
- PR workflow documentation gaps

## Test Cases Needed

1. Session exists on disk but not in database
2. Running session pr from session workspace  
3. Running session pr from main workspace
4. Session database corruption/missing scenarios
5. Manual session recovery workflows 
