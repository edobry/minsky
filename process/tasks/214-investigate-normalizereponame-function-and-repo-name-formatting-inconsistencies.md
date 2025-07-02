# Investigate and Fix normalizeRepoName function and repo name formatting inconsistencies

## Status

IN-PROGRESS

## Priority

MEDIUM

## Description

Investigate the normalizeRepoName function and its impact on repo name formatting stored in the session database, then implement fixes for the identified inconsistencies. This task consolidates the investigation of repo name formatting issues with fixing specific path resolution problems in session PR commands.

## Problem Statement

The normalizeRepoName function appears to be producing repo names in formats like 'local/minsky' and 'local-minsky' which may not be consistent or correct for Minsky's design and workflows. This inconsistency is causing specific issues:

1. **Session PR Path Resolution Issue**: Session pr command tries to access wrong directory path (without local- prefix). The command looks for `/Users/user/.local/state/minsky/git/minsky/sessions/task#X` but actual path is `/Users/user/.local/state/minsky/git/local-minsky/sessions/task#X`. This causes git operations to fail.

2. **General Repo Name Inconsistencies**: Multiple formats being used across different scenarios, creating potential conflicts and maintenance issues.

## Phase 1: Investigation

### ✅ Investigation Results

#### 1. Root Cause Identified

The issue stems from **two different normalization strategies** being applied at different points in the codebase:

**Source of Inconsistency:**

- **normalizeRepoName/normalizeRepositoryURI** (in `src/domain/repository-uri.ts`): Returns `local/minsky` (forward slash)
- **GitService methods** (in `src/domain/git.ts`): Convert `local/minsky` → `local-minsky` (hyphen) for filesystem paths

**Evidence from Investigation:**

```bash
# Session list shows:
task#214 (#214) - local/minsky

# Actual directory path:
/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#214
```

#### 2. Code Analysis

**Key Functions Involved:**

1. **normalizeRepoName() → `local/minsky`**

   ```typescript
   // src/domain/repository-uri.ts:250
   export function normalizeRepoName(repoUrl: string): string {
     return normalizeRepositoryURI(repoUrl);
   }

   // For local paths like "/Users/edobry/Projects/minsky"
   // Returns: "local/minsky"
   ```

2. **GitService.clone() → `local-minsky`**

   ```typescript
   // src/domain/git.ts:265-276
   if (repoName.startsWith("local/")) {
     const parts = repoName.split("/");
     if (parts.length > 1) {
       normalizedRepoName = `${parts[0]}-${parts.slice(1).join("-")}`;
     }
   }
   // Converts "local/minsky" → "local-minsky"
   ```

3. **GitService.getSessionWorkdir() → `local-minsky`**

   ```typescript
   // src/domain/git.ts:254-258
   const normalizedRepoName = repoName.includes("/")
     ? repoName.replace(/[^a-zA-Z0-9-_]/g, "-")
     : repoName;
   // Converts "local/minsky" → "local-minsky"
   ```

4. **getRepoPathFn() → tries to use `local/minsky`**
   ```typescript
   // src/domain/session/session-db.ts:118-125
   const repoName = normalizeRepoName(record.repoName || record.repoUrl);
   return join(state.baseDir, repoName, "sessions", record.session);
   // Uses original "local/minsky", creating path mismatch
   ```

#### 3. Impact Analysis

**Affected Areas:**

- ✅ Session creation (works - uses GitService normalization)
- ❌ Session directory resolution (fails - uses original normalization)
- ❌ Session PR commands (fails - can't find correct directory)
- ❌ Any operation that uses getRepoPathFn()

**Session List Evidence:**

```bash
task#168 (task#168) - local-minsky  # ← Older session shows hyphen format
task#214 (#214) - local/minsky      # ← Newer session shows slash format
```

#### 4. Design Intent vs Implementation

**Intended Design:** Single consistent repo name format throughout system
**Actual Implementation:** Two different formats depending on code path

### ✅ Migration Strategy Defined

**Approach:** Standardize on filesystem-safe format (`local-minsky`) throughout the system.

**Reasoning:**

1. Directory paths must be filesystem-safe (no slashes in directory names)
2. GitService already creates directories with hyphen format
3. Changing existing directory structure would be more disruptive
4. Hyphen format is more consistent with filesystem conventions

## Phase 2: Implementation

### 1. Fix normalizeRepoName Function

- [ ] Update normalizeRepositoryURI to return filesystem-safe names for local repos
- [ ] Change `local/minsky` → `local-minsky` in the core normalization logic
- [ ] Ensure consistency across all repo name generation

### 2. Fix Session Database Path Resolution

- [ ] Update getRepoPathFn to use consistent repo name format
- [ ] Ensure session workdir resolution uses same normalization
- [ ] Test session operations with corrected paths

### 3. Update All Dependent Code

- [ ] Review and update any code that expects `local/` format
- [ ] Ensure GitService methods use consistent normalization
- [ ] Update tests to expect new format

### 4. Migration for Existing Data

- [ ] Update session records to use consistent repo name format
- [ ] Handle backward compatibility during transition
- [ ] Add migration logic for existing sessions

### 5. Testing

- [ ] Add comprehensive tests for normalizeRepoName function
- [ ] Test session PR path resolution with various repo name formats
- [ ] End-to-end testing of session workflows

## Requirements

1. **Investigation Deliverables** ✅ COMPLETE

   - [x] normalizeRepoName function behavior fully documented
   - [x] All inconsistencies identified and catalogued
   - [x] Root cause of path resolution issues identified
   - [x] Migration strategy defined

2. **Implementation Requirements**

   - [ ] Fix normalizeRepoName function to produce consistent output
   - [ ] Fix session PR command path resolution issues
   - [ ] Ensure all session commands work with corrected paths
   - [ ] Maintain backward compatibility where possible

3. **Testing Requirements**
   - [ ] Unit tests for normalizeRepoName function
   - [ ] Integration tests for session PR commands
   - [ ] End-to-end tests covering various repository types

## Success Criteria

1. **Investigation Phase Complete** ✅ DONE

   - [x] normalizeRepoName function behavior fully documented
   - [x] All inconsistencies identified and catalogued
   - [x] Root cause of path resolution issues identified
   - [x] Migration strategy defined (if needed)

2. **Implementation Phase Complete**

   - [ ] Session PR commands work correctly with all repository types
   - [ ] No more path resolution failures due to missing prefixes
   - [ ] Consistent repo name format used throughout the system
   - [ ] All existing sessions continue to work (backward compatibility)
   - [ ] Comprehensive test coverage for repo name handling

3. **Verification**
   - [ ] All session commands (start, pr, update, etc.) work correctly
   - [ ] No regression in existing functionality
   - [ ] Clean test suite with no path-related failures

## Work Log

### Investigation Phase (Complete)

- ✅ Reproduced the issue: Session shows `local/minsky` but actual path is `local-minsky`
- ✅ Identified root cause in GitService normalization logic
- ✅ Analyzed all functions involved in repo name handling
- ✅ Documented the inconsistency between storage and filesystem paths
- ✅ Defined migration strategy

### Next Steps

- [ ] Implement the fix in normalizeRepositoryURI function
- [ ] Update session database path resolution
- [ ] Add comprehensive tests
- [ ] Test with real session workflows

## Notes

This task consolidates the investigation from task #214 with the specific fix requirements from task #212. The investigation phase is complete and has revealed a clear path forward for implementation.
