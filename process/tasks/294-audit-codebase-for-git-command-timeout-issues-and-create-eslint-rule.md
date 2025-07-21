# Audit codebase for concurrency issues and create comprehensive prevention rules

## Status

IN-PROGRESS (Phase 1 P0: 8 of 16+ critical violations fixed - 50% complete)

## Priority

HIGH (upgraded from MEDIUM due to session PR hanging analysis)

## Description

## Problem

The session PR command hanging investigation revealed multiple categories of concurrency and race condition issues that could cause deadlocks, infinite loops, and system instability across the Minsky codebase.

## Root Cause Analysis

**Critical Discovery**: Even with local git repos, multiple concurrency failure modes exist:
- Git operations without timeout handling
- File system operations without proper synchronization
- Git lock file race conditions between concurrent operations
- Process synchronization issues in complex workflows

**Phase 1 CRITICAL FINDING**: The codebase has excellent timeout infrastructure (`execGitWithTimeout`, `gitFetchWithTimeout`, etc.) with 30-second defaults, but many git operations bypass these protections by calling `execAsync` directly.

## Phase 1 Audit Results - Git Command Timeout Violations

### ✅ FIXED - Critical P0 Violations (8 completed)

**Repository Operations - COMPLETED ✅**
- ✅ `src/domain/repository/local.ts:91` - Fixed `execAsync('git clone ${this.repoUrl} ${workdir}')` → `gitCloneWithTimeout()`
- ✅ `src/domain/repository/remote.ts:314` - Fixed `execAsync('git -C ${workdir} push origin ${branch}')` → `gitPushWithTimeout()`  
- ✅ `src/domain/repository/remote.ts:392` - Fixed `execAsync('git -C ${workdir} pull origin ${branch}')` → `gitPullWithTimeout()`

**Session Operations - COMPLETED ✅**
- ✅ `src/domain/session/session-approve-operations.ts:286` - Fixed `execInRepository('git fetch origin')` → `gitFetchWithTimeout()`
- ✅ `src/domain/session/session-approve-operations.ts:331` - Fixed `execInRepository('git push origin ${baseBranch}')` → `gitPushWithTimeout()`
- ✅ `src/domain/session/session-approve-operations.ts:467` - Fixed `execInRepository('git push')` → `gitPushWithTimeout()`
- ✅ `src/domain/session/commands/approve-command.ts:107` - Fixed `execInRepository('git push origin --delete ${currentBranch}')` → `execGitWithTimeout()`
- ✅ `src/domain/session/commands/approve-command.ts:132` - Fixed `execInRepository('git push')` → `gitPushWithTimeout()`

### 🚨 REMAINING HIGH-RISK VIOLATIONS - In Progress

**Git Domain Operations (2 violations):**
- 🔄 `src/domain/git.ts:528` - `execAsync('git -C ${workdir} fetch ${remote}')`
- 🔄 `src/domain/git.ts:864` - `execAsync('git -C ${workdir} fetch ${remote}')`

**Session Operations (3 violations):**
- 📝 `src/domain/session/session-review-operations.ts:207` - `execInRepository('git fetch origin ${prBranchToUse}')`
- 📝 `src/domain/session/session-review-operations.ts:244` - `execInRepository('git fetch origin')`
- 📝 `src/domain/session/session-update-operations.ts:506` - `execInRepository('git fetch origin ${prBranch}')`

**Git Domain Conflict Detection (1 violation):**
- 📝 `src/domain/git/conflict-detection.ts:525` - `execAsync('git -C ${repoPath} fetch origin ${baseBranch}')`

**Remote Query Operations (2 violations):**
- 📝 `src/domain/session/session-approve-operations.ts:337` - `execAsync('git show-ref --verify --quiet refs/remotes/origin/${prBranch}')`
- 📝 `src/domain/session.ts:1603` - `execAsync('git show-ref --verify --quiet refs/remotes/origin/${prBranch}')`

### ✅ POSITIVE FINDING: Excellent Timeout Infrastructure Exists

**Available Protection Mechanisms:**
- `execGitWithTimeout(operation, command, options)` - 30s default timeout
- `gitCloneWithTimeout(repoUrl, targetDir, options)`
- `gitFetchWithTimeout(remote, branch, options)`
- `gitPushWithTimeout(remote, branch, options)`
- `gitPullWithTimeout(remote, branch, options)`
- `gitMergeWithTimeout(branch, options)`

**Good Examples Already Using Timeouts:**
- `src/domain/git/prepare-pr-operations.ts` - Uses timeout wrappers throughout
- `src/domain/workspace/special-workspace-manager.ts` - Proper timeout usage
- `src/utils/auto-commit.ts` - Full timeout protection

## Comprehensive Scope

**Phase 1: Git Command Timeout Audit** ✅ COMPLETED - 8/16+ violations fixed
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
   - **HIGH**: Network operations (push, pull, fetch, clone) - 8 of 16+ violations fixed
   - **MEDIUM**: Remote queries (ls-remote, rev-parse with remotes) - 2 violations identified
   - **LOW**: Local operations (status, branch, log) - No critical issues

**Phase 2: File System Race Condition Audit** 🔄 NEXT
1. **Concurrent file operations without synchronization:**
   - Multiple `writeFile` operations to same location
   - Missing `await` in async file operations
   - Directory creation + file write race conditions
   - Session workspace creation patterns

2. **Critical patterns to identify:**
   ```typescript
   // PROBLEMATIC:
   await Promise.all([writeFile(path1), writeFile(path2)]) // Same directory
   mkdir(dir); writeFile(`${dir}/file`) // Race condition

   // SAFE:
   await ensureDir(dir); await writeFile(`${dir}/file`)
   ```

**Phase 3: Git Lock File Race Condition Audit**
1. **Concurrent git operations:**
   - Multiple git commands in parallel workflows
   - Session operations + PR creation conflicts
   - Lock file detection and retry mechanisms

2. **Git coordination patterns:**
   - Sequential git operation queuing
   - Lock file awareness in workflows
   - Proper error handling for git lock conflicts

**Phase 4: Process Synchronization Audit**
1. **Complex workflow coordination:**
   - Session update + PR creation timing
   - Task operations + session state sync
   - Multi-step operations with failure recovery

2. **Deadlock prevention patterns:**
   - Resource acquisition ordering
   - Timeout mechanisms for multi-step operations
   - Proper cleanup in failure scenarios

**Phase 5: ESLint Rules Development**
1. **Rule: `no-unsafe-git-network-operations`** 🎯 PRIORITY
   ```javascript
   // FORBIDDEN:
   execAsync(`git push ...`)
   execAsync(`git pull ...`) 
   execAsync(`git fetch ...`)
   execAsync(`git clone ...`)

   // REQUIRED:
   gitPushWithTimeout(...)
   gitPullWithTimeout(...)
   gitFetchWithTimeout(...)
   gitCloneWithTimeout(...)
   ```

2. **Rule: `no-concurrent-file-operations`**
   ```javascript
   // FORBIDDEN:
   Promise.all([writeFile(a), writeFile(b)]) // Same dir

   // REQUIRED:
   await writeFileSync(a); await writeFileSync(b);
   ```

3. **Rule: `require-git-operation-sequencing`**
   ```javascript
   // FORBIDDEN:
   Promise.all([gitCheckout(), gitMerge()])

   // REQUIRED:
   await gitCheckout(); await gitMerge();
   ```

## Deliverables

1. **Comprehensive Audit Report:** ✅ Phase 1 Complete
   - Complete inventory of all concurrency issues
   - Risk assessment with concrete examples
   - Prioritized fix recommendations

2. **ESLint Rule Suite:** 🔄 In Progress
   - Multiple rules covering different concurrency patterns
   - Auto-fix capabilities where possible
   - Comprehensive test coverage

3. **Codebase Fixes:** 🔄 50% Complete (8 of 16+ P0 fixes done)
   - All high-risk locations converted to safe patterns
   - Proper synchronization mechanisms implemented
   - Timeout handling for all external operations

4. **Architectural Guidelines:**
   - Concurrency best practices documentation
   - Workflow coordination patterns
   - Debugging guides for concurrency issues

## Implementation Progress

### Priority 1 (P0) - Critical Network Operation Timeout Fixes - 50% COMPLETE ✅

1. **Repository Operations** (`src/domain/repository/`) - ✅ COMPLETED
   - ✅ Fixed: Replace direct execAsync calls with timeout wrappers in remote.ts
   - ✅ Fixed: Update local.ts clone implementation
   
2. **Session Operations** (`src/domain/session/`) - 🔄 IN PROGRESS  
   - ✅ Fixed: Convert session-approve-operations.ts git commands (3 violations)
   - ✅ Fixed: Update session/commands/approve-command.ts (2 violations)
   - 🔄 TODO: Fix session-review-operations.ts fetch operations (2 violations)
   - 🔄 TODO: Fix session-update-operations.ts git calls (1 violation)

3. **Git Domain Operations** (`src/domain/git/`) - 🔄 IN PROGRESS
   - 🔄 TODO: Update git.ts direct execAsync calls (2 violations)
   - 🔄 TODO: Fix conflict-detection.ts fetch operations (1 violation)

### Priority 2 (P1) - Remote Query Protections - 📝 PENDING
1. Add timeout wrappers for show-ref operations (2 violations)
2. Protect ls-remote and similar query commands

### Priority 3 (P2) - Preventive ESLint Rules - 📝 PENDING
1. Implement no-unsafe-git-network-operations rule
2. Add auto-fix capabilities where possible
3. Update CI/CD to enforce rules

## Success Criteria

- Zero hanging operations in any Minsky workflow
- ESLint rules prevent 100% of unsafe concurrency patterns
- Clear error messages when timeouts/conflicts occur
- All developers can safely implement concurrent operations
- Session PR workflow works reliably under all conditions

## Requirements

### Phase 1 Requirements ✅ COMPLETED
- [x] Identify all git command execution points in codebase
- [x] Categorize operations by risk level (HIGH/MEDIUM/LOW)
- [x] Document specific violation locations with line numbers
- [x] Verify timeout infrastructure capabilities
- [x] Create concrete examples of unsafe vs safe patterns
- [x] Implement 50% of critical P0 timeout fixes (8 of 16+ violations)

### Current Phase Requirements 🔄 IN PROGRESS  
- [x] Fix repository operation timeout violations (3/3 complete)
- [x] Fix critical session operation violations (5/8 complete)
- [ ] Fix remaining git domain operation violations (0/3 complete)
- [ ] Fix remaining session operation violations (0/3 complete)  
- [ ] Complete audit of remaining phases (file system, git locks, process sync)
- [ ] Create and test ESLint rule for unsafe git network operations
- [ ] Document architectural guidelines for safe concurrency patterns
- [ ] Validate all session PR workflow scenarios work without hanging

## Recent Progress Summary

**Commits:**
- `f0af4652` - Implemented timeout protection for 8 critical git network operations
- `155827e0` - Completed Phase 1 audit with 16+ violations identified

**Impact:** 
- **50% of P0 violations fixed** - Critical session approval, repository operations now timeout-protected
- **Zero hanging risk** for git clone, push, pull operations in core workflows
- **Proven solution pattern** established for remaining violations

**Next Steps:**
- Complete remaining 8 P0 violations in git.ts, session-review/update operations
- Implement ESLint rule to prevent future violations
- Begin Phase 2 file system race condition audit