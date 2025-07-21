# Audit codebase for concurrency issues and create comprehensive prevention rules

## Status

BACKLOG

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

## Comprehensive Scope

**Phase 1: Git Command Timeout Audit**
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

**Phase 2: File System Race Condition Audit**
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
1. **Rule: `no-unsafe-git-exec`**
   ```javascript
   // FORBIDDEN:
   execAsync(`git push ...`)
   execAsync(`git merge ...`)

   // REQUIRED:
   execGitWithTimeout("push", ...)
   gitMergeWithTimeout(...)
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

1. **Comprehensive Audit Report:**
   - Complete inventory of all concurrency issues
   - Risk assessment with concrete examples
   - Prioritized fix recommendations

2. **ESLint Rule Suite:**
   - Multiple rules covering different concurrency patterns
   - Auto-fix capabilities where possible
   - Comprehensive test coverage

3. **Codebase Fixes:**
   - All high-risk locations converted to safe patterns
   - Proper synchronization mechanisms implemented
   - Timeout handling for all external operations

4. **Architectural Guidelines:**
   - Concurrency best practices documentation
   - Workflow coordination patterns
   - Debugging guides for concurrency issues

## Success Criteria

- Zero hanging operations in any Minsky workflow
- ESLint rules prevent 100% of unsafe concurrency patterns
- Clear error messages when timeouts/conflicts occur
- All developers can safely implement concurrent operations
- Session PR workflow works reliably under all conditions

## Requirements

[To be filled in]
