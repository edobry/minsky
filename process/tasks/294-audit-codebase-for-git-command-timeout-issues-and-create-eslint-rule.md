# Audit codebase for git command timeout issues and create ESLint rule

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Problem

The session PR command was hanging indefinitely due to git commands using basic `execAsync` without timeout handling. While we fixed the immediate issue in `prepare-pr-operations.ts`, this suggests a broader pattern that needs investigation.

## Scope

**Phase 1: Codebase Audit**
1. **Search for hanging-prone patterns:**
   - `execAsync` calls with git commands
   - Direct `exec` calls to git 
   - Any git operations without timeout handling
   - Focus on network operations: `push`, `pull`, `fetch`, `clone`, `ls-remote`

2. **Inventory all git command execution points:**
   - `src/domain/git/` - All git operation modules
   - `src/domain/repository/` - Repository backend implementations  
   - `src/utils/` - Utility functions using git
   - Any other files executing git commands

3. **Categorize by risk level:**
   - **HIGH**: Network operations (push, pull, fetch, clone) 
   - **MEDIUM**: Remote queries (ls-remote, rev-parse with remotes)
   - **LOW**: Local operations (status, branch, log)

**Phase 2: ESLint Rule Development**
1. **Create custom ESLint rule: `no-unsafe-git-exec`**
   - Detect `execAsync` calls with git commands
   - Suggest using timeout-aware alternatives
   - Allow exceptions for local-only operations
   - Provide auto-fix suggestions

2. **Rule implementation details:**
   ```javascript
   // FORBIDDEN patterns:
   execAsync(`git push ...`)
   execAsync(`git pull ...`) 
   execAsync(`git fetch ...`)
   execAsync(`git clone ...`)
   
   // ALLOWED alternatives:
   gitPushWithTimeout(...)
   gitFetchWithTimeout(...)
   execGitWithTimeout("push", ...)
   ```

3. **Integration:**
   - Add to `.eslintrc.json`
   - Run on entire codebase
   - Fix all violations
   - Add to CI/CD pipeline

## Root Cause Analysis

**Key insight:** Even with local git repos (same machine), timeouts are essential because:
- Git lock files can cause blocking
- File system I/O can hang
- Process synchronization issues
- Resource contention

## Deliverables

1. **Audit Report:**
   - Complete inventory of git command execution points
   - Risk assessment for each location
   - Recommended fixes with priority levels

2. **ESLint Rule:**
   - Working rule that catches unsafe patterns
   - Auto-fix capabilities where possible
   - Documentation and examples

3. **Codebase Fixes:**
   - All high-risk locations converted to timeout-aware utilities
   - Medium-risk locations evaluated and fixed as needed
   - Test coverage for timeout scenarios

4. **Prevention Strategy:**
   - ESLint rule prevents future violations
   - Documentation on proper git command patterns
   - Guidelines for new git operations

## Implementation Notes

- Build on existing timeout utilities in `src/utils/git-exec-enhanced.ts`
- Consider adding more specific timeout values for different operations
- May need to enhance existing utilities for additional git commands
- Should include logging/telemetry for timeout events

## Success Criteria

- Zero hanging git operations in codebase
- ESLint rule catches 100% of problematic patterns  
- All developers can confidently add new git operations
- Clear error messages when timeouts occur
- No more "mysterious hangs" in Minsky workflows

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
