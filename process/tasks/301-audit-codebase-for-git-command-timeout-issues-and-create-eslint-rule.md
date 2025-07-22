# Audit codebase for git command timeout issues and create ESLint rule

## Status

BACKLOG

## Priority

MEDIUM

## Description

Conduct a comprehensive audit of the codebase to identify all instances where `execAsync` is used for git operations without proper timeout handling. Create or enhance ESLint rules to enforce the use of timeout-aware git utilities like `execGitWithTimeout`.

## Background
During task #280, we discovered that `execAsync` calls without timeouts in git operations (like in `prepare-pr-operations.ts`) can cause commands to hang indefinitely, leading to poor user experience and debugging difficulties.

## Scope
1. **Audit Phase**:
   - Search for all `execAsync` usage in git-related files
   - Identify patterns where git commands lack timeout protection
   - Document findings with risk assessment (network ops = high risk, local ops = medium risk)

2. **Rule Enhancement**:
   - Extend the existing `no-unsafe-git-exec.js` ESLint rule if needed
   - Ensure rule covers all git operation patterns
   - Add auto-fix suggestions where possible

3. **Remediation**:
   - Replace unsafe `execAsync` calls with `execGitWithTimeout`
   - Add timeout context for better debugging
   - Test that changes don't break existing functionality

## Priority
High - This prevents the type of hanging issues that blocked task #280 session PR creation

## Audit Findings

### ESLint Rule Status
- ✅ `no-unsafe-git-exec.js` rule exists and is properly configured
- ✅ Rule is enabled with error level in `eslint.config.js`
- ⚠️ Rule allows some local operations that could still benefit from timeout protection
- ⚠️ Rule configuration may need tightening to catch more patterns

### Timeout Utilities Available
- ✅ `execGitWithTimeout` - General git command execution with timeout
- ✅ `gitFetchWithTimeout` - Fetch operations with timeout
- ✅ `gitPushWithTimeout` - Push operations with timeout
- ✅ All utilities provide 30-second default timeout and contextual error messages

### Unsafe Patterns Identified

#### High Priority (Local Git Operations without Timeout)
**File: `src/domain/git.ts`**
- `execAsync('git -C ${workdir} diff --name-only')` (line 447)
- `execAsync('git -C ${workdir} ls-files --deleted')` (line 457)
- `execAsync('git -C ${workdir} add -A')` (line 465)
- `execAsync('git -C ${workdir} add .')` (line 470)
- `execAsync('git -C ${workdir} commit ${amendFlag} -m "${message}"')` (line 476)
- `execAsync('git -C ${workdir} status --porcelain')` (line 490)
- `execAsync('git -C ${workdir} stash push -u -m "minsky session update"')` (line 497)
- `execAsync('git -C ${workdir} stash list')` (line 507)
- `execAsync('git -C ${workdir} stash pop')` (line 514)
- `execAsync('git -C ${workdir} rev-parse HEAD')` (lines 524, 531)
- `execAsync('git -C ${repoPath} rev-parse --abbrev-ref HEAD')` (line 909)
- `execAsync('git -C ${repoPath} status --porcelain')` (line 917)

**File: `src/domain/localGitBackend.ts`**
- `execAsync(cmd, { cwd: cwd || this.localPath })` (line 65) - Generic git command execution
- `execAsync('git -C ${this.config.path} rev-parse --git-dir')` (line 206)

**File: `src/domain/git/conflict-analysis-operations.ts`**
- `execAsync('git -C ${repoPath} status --porcelain')` (line 22)
- `execAsync('git -C ${repoPath} log --oneline -1')` (line 91)
- `execAsync('git -C ${repoPath} show HEAD:${file.path}')` (line 120)
- `execAsync('git -C ${repoPath} log --oneline ${sessionBranch} ^${baseBranch}')` (line 165)
- `execAsync('git -C ${repoPath} rm "${file.path}"')` (line 208)

#### Medium Priority (Repository Operations)
**File: `src/domain/repository/remote.ts`**
- `execAsync('git -C ${workdir} checkout -b ${branch}')` (line 156)
- `execAsync('git -C ${workdir} status --porcelain')` (line 200)
- `execAsync('git -C ${workdir} remote')` (line 204)

**File: `src/domain/repository/local.ts`**
- `execAsync('git -C ${workdir} checkout -b ${branch}')` (line 114)
- `execAsync('git -C ${workdir} status --porcelain')` (line 150)
- `execAsync('git -C ${workdir} remote')` (line 160)

**File: `src/domain/repository/github.ts`**
- `execAsync('git -C ${workdir} checkout -b ${branch}')` (line 166)
- `execAsync('git -C ${workdir} remote -v')` (line 223)
- `execAsync('git -C ${workdir} checkout ${branch}')` (line 475)

#### Lower Priority (Git Commands in Specialized Operations)
**File: `src/domain/git/commands/checkout-command.ts`**
- `execAsync('git checkout ${params.branch}')` (line 57)

**File: `src/domain/git/commands/rebase-command.ts`**
- `execAsync('git rebase ${params.baseBranch}')` (line 88)

### Risk Assessment Summary
- **32 unsafe git operations** identified across 8 core files
- **Most network operations** (push, pull, fetch) already converted to timeout utilities
- **Local operations** (status, add, commit, stash) represent majority of remaining issues
- **Mixed usage patterns** in files - some operations use timeout utilities, others don't

## Requirements

### 1. ESLint Rule Enhancement
- [ ] Tighten `no-unsafe-git-exec.js` rule configuration to catch local git operations
- [ ] Remove or reduce `allowedLocalOperations` exceptions
- [ ] Add auto-fix suggestions for common patterns
- [ ] Ensure rule catches all identified unsafe patterns

### 2. Code Remediation Priority 1: Core Git Operations (`src/domain/git.ts`)
- [ ] Replace 12 `execAsync` calls with `execGitWithTimeout`
- [ ] Maintain existing function signatures and behavior
- [ ] Add appropriate timeout values for different operation types
- [ ] Test all modified operations for functionality

### 3. Code Remediation Priority 2: Backend and Analysis Operations
- [ ] Fix `src/domain/localGitBackend.ts` - 2 unsafe patterns
- [ ] Fix `src/domain/git/conflict-analysis-operations.ts` - 5 unsafe patterns
- [ ] Ensure error handling remains consistent

### 4. Code Remediation Priority 3: Repository Operations
- [ ] Fix repository classes: `remote.ts`, `local.ts`, `github.ts`
- [ ] Update 9 repository git operations to use timeout utilities
- [ ] Maintain repository interface consistency

### 5. Code Remediation Priority 4: Specialized Commands
- [ ] Fix git command implementations in `commands/` directory
- [ ] Update 2 command operations to use timeout utilities

### 6. Testing and Verification
- [ ] Run ESLint with enhanced rules to verify no violations
- [ ] Execute test suite to ensure no regressions
- [ ] Test timeout behavior with controlled scenarios
- [ ] Verify error messages provide helpful context

## Success Criteria

### Primary Goals
- [ ] **Zero ESLint violations**: No `no-unsafe-git-exec` rule violations in codebase
- [ ] **32 unsafe patterns fixed**: All identified `execAsync` git operations converted
- [ ] **Enhanced rule coverage**: ESLint rule catches all problematic patterns including local operations
- [ ] **No functional regressions**: All existing git functionality works as before

### Quality Assurance
- [ ] **Consistent timeout handling**: All git operations use appropriate timeout values
- [ ] **Improved error messages**: Timeout errors provide clear context and suggestions
- [ ] **Test coverage maintained**: All modified functions pass existing tests
- [ ] **Performance verified**: Operations complete within expected timeframes

### Documentation and Maintenance
- [ ] **Rule configuration documented**: ESLint rule settings clearly explained
- [ ] **Pattern guidelines established**: Clear guidance on when to use which git utility
- [ ] **Future prevention**: New git operations automatically caught by ESLint rule

### Verification Steps
1. **ESLint check**: `npm run lint` shows zero git exec violations
2. **Test execution**: `npm test` passes all git-related tests
3. **Manual verification**: Test git operations in development environment
4. **Timeout testing**: Verify appropriate timeout behavior in controlled scenarios
