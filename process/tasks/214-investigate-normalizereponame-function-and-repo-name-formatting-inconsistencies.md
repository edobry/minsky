# Investigate and Fix normalizeRepoName function and repo name formatting inconsistencies

## Status

BACKLOG

## Priority

MEDIUM

## Description

Investigate the normalizeRepoName function and its impact on repo name formatting stored in the session database, then implement fixes for the identified inconsistencies. This task consolidates the investigation of repo name formatting issues with fixing specific path resolution problems in session PR commands.

## Problem Statement

The normalizeRepoName function appears to be producing repo names in formats like 'local/minsky' and 'local-minsky' which may not be consistent or correct for Minsky's design and workflows. This inconsistency is causing specific issues:

1. **Session PR Path Resolution Issue**: Session pr command tries to access wrong directory path (without local- prefix). The command looks for `/Users/user/.local/state/minsky/git/minsky/sessions/task#X` but actual path is `/Users/user/.local/state/minsky/git/local-minsky/sessions/task#X`. This causes git operations to fail.

2. **General Repo Name Inconsistencies**: Multiple formats being used across different scenarios, creating potential conflicts and maintenance issues.

## Phase 1: Investigation

### 1. Function Analysis

- Examine the normalizeRepoName function implementation
- Understand its purpose and intended behavior
- Document the transformation logic and rules applied
- Identify where the inconsistent formats ('local/minsky' vs 'local-minsky') are generated

### 2. Session Database Impact

- Analyze how normalized repo names are stored in the session database
- Identify inconsistencies in naming formats across different scenarios
- Check for potential conflicts or ambiguities in stored names
- Document current session directory structure vs expected structure

### 3. Backend Compatibility

- Investigate how normalized names interact with different repo backends:
  - Local repositories
  - GitHub repositories
  - Other potential backends
- Ensure consistent behavior across all backend types

### 4. Workflow Integration

- Examine how normalized repo names are used throughout Minsky workflows
- Check session management, task creation, and other core operations
- Identify any breaking changes or unexpected behaviors
- Focus on session PR command path resolution specifically

### 5. Design Intent vs Implementation

- Determine if current behavior aligns with intended design
- Identify any gaps between expected and actual functionality
- Document the correct path structure that should be used

## Phase 2: Implementation

### 1. Fix normalizeRepoName Function
- [x] Update normalizeRepositoryURI to return filesystem-safe names for local repos
- [x] Change `local/minsky` → `local-minsky` in the core normalization logic
- [x] Ensure consistency across all repo name generation

### 2. Fix Session Database Path Resolution
- [ ] Update getRepoPathFn to use consistent repo name format
- [ ] Ensure session workdir resolution uses same normalization
- [ ] Test session operations with corrected paths

### 3. Update All Dependent Code
- [x] Review and update any code that expects `local/` format
- [x] Ensure GitService methods use consistent normalization
- [x] Update tests to expect new format

### 4. Migration for Existing Data
- [ ] Update session records to use consistent repo name format
- [ ] Handle backward compatibility during transition
- [ ] Add migration logic for existing sessions

### 5. Testing
- [x] Add comprehensive tests for normalizeRepoName function
- [ ] Test session PR path resolution with various repo name formats
- [ ] End-to-end testing of session workflows

## Requirements

1. **Investigation Deliverables**

   - Comprehensive analysis of normalizeRepoName function
   - Documentation of current behavior vs intended behavior
   - Identification of all bugs or inconsistencies
   - Root cause analysis of path resolution failures

2. **Implementation Requirements**

   - Fix normalizeRepoName function to produce consistent output
   - Fix session PR command path resolution issues
   - Ensure all session commands work with corrected paths
   - Maintain backward compatibility where possible

3. **Testing Requirements**
   - Unit tests for normalizeRepoName function
   - Integration tests for session PR commands
   - End-to-end tests covering various repository types

## Success Criteria

1. **Investigation Phase Complete**

   - [ ] normalizeRepoName function behavior fully documented
   - [ ] All inconsistencies identified and catalogued
   - [ ] Root cause of path resolution issues identified
   - [ ] Migration strategy defined (if needed)

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

## Notes

This task consolidates the investigation from task #214 with the specific fix requirements from task #212. The investigation phase is complete and has revealed a clear path forward for implementation.

## Work Log

### Investigation Phase (Complete) ✅
- ✅ Reproduced the issue: Session shows `local/minsky` but actual path is `local-minsky`
- ✅ Identified root cause in GitService normalization logic
- ✅ Analyzed all functions involved in repo name handling
- ✅ Documented the inconsistency between storage and filesystem paths
- ✅ Defined migration strategy

### Implementation Phase (In Progress) 🔄
- ✅ **Core Fix Implemented**: Updated normalizeRepositoryUri to use filesystem-safe format
  - Changed `local/${basename}` → `local-${basename}` in both file:// and path handlers
  - Updated fallback normalization in normalizeRepositoryURI
  - Updated tests to expect new format
  - Verified fix works: `local-minsky` format now consistent throughout
- ✅ **Testing**: Basic unit tests updated and passing
- ❌ **Remaining**: Session database path resolution updates needed
- ❌ **Remaining**: End-to-end session workflow testing

### Next Steps
- [ ] Update getRepoPathFn in session-db.ts to handle both formats during transition
- [ ] Test actual session PR commands with the fix
- [ ] Add migration logic for existing sessions if needed
- [ ] Complete end-to-end testing
