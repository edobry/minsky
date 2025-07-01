# Simplify Session Storage: Move from Repository-Based to Session-ID-Based Paths

## Status

IN-PROGRESS

## Priority

MEDIUM

## Description

**MAJOR DIRECTION CHANGE**: Through investigation of repository normalization issues, we discovered a much better architectural approach. Instead of solving repository identity problems, we should eliminate the need for repository identity in filesystem paths entirely by using session-ID-based storage.

## Problem Evolution

### Original Problem
Session PR command fails because it looks for `/git/minsky/sessions/` but actual path is `/git/local-minsky/sessions/` - inconsistent repository naming between storage and lookup.

### Initial Investigation Direction
Attempted to solve repository identity normalization:
- Standardize `local/` vs `local-` format inconsistencies
- Implement Git-native identity resolution (check remote origins)
- Handle cross-platform path issues

### Critical Insight Discovery
Through investigation, we realized the **fundamental question**: "Why do we need repository identity in filesystem paths at all?"

**Current Approach Problems**:
- Complex path encoding: `/git/local-minsky/sessions/task#214/`
- Repository normalization edge cases: Windows paths, remote origins, identity chains
- Architectural complexity: Multiple layers of path parsing and resolution
- Future brittleness: Adding new repo backends requires path encoding solutions

## New Architectural Direction

### Core Principle: Separate Storage from Metadata

**Current (Complex)**:
```
Filesystem Path: /git/{repoIdentity}/sessions/{sessionId}/
Metadata: Stored in path structure
```

**Proposed (Simple)**:
```
Filesystem Path: /sessions/{sessionId}/
Metadata: Stored in session record
```

### Motivating Principles

1. **Separation of Concerns**: Filesystem structure for storage, database for metadata
2. **Path Predictability**: Session path always `/sessions/{sessionId}/` 
3. **Metadata Centralization**: Repository information belongs in session records
4. **Future-Proof Design**: Works with any repository backend without encoding issues
5. **Simplicity Over Cleverness**: Eliminate complex normalization layers

### Architectural Benefits

**Code Simplification**:
- Eliminate entire repository normalization layer (`normalizeRepositoryURI` etc.)
- Remove complex path parsing logic (hundreds of lines in `workspace.ts`, `session-db.ts`)
- Simplify session directory resolution to trivial path join

**Operational Benefits**:
- Predictable session paths for debugging and tooling
- No repository identity conflicts or edge cases
- Simple session migration between environments
- Clear separation between storage and business logic

**Scalability Benefits**:
- Easy to add new repository backends without path encoding concerns
- Session IDs can be globally unique (UUIDs if needed)
- Database queries replace filesystem traversal for session discovery

## Implementation Plan

### Phase 1: Core Storage Refactoring

**1.1 Update Session Directory Resolution** ✅ COMPLETE
```typescript
// Before (complex)
getSessionWorkdir(repoName: string, session: string): string {
  const normalizedRepoName = normalizeRepoName(repoName);
  return join(this.baseDir, normalizedRepoName, "sessions", session);
}

// After (simple) - IMPLEMENTED
getSessionWorkdir(session: string): string {
  return join(this.baseDir, "sessions", session);
}
```

**1.2 Remove Repository Path Encoding** 🔄 IN-PROGRESS
- ✅ Core session-db.ts functions updated and tested (19/19 tests passing)
- ✅ GitService.getSessionWorkdir method simplified 
- ✅ Removed normalizeRepoName imports from core session functions
- 🔄 Fixing remaining GitService call sites that expect old signature
- 🔄 Update path resolution in related services

**1.3 Update Session Record Schema** ✅ VERIFIED
- ✅ Session records have `repoUrl` field populated 
- ✅ Repository metadata accessible via session records
- ✅ Schema supports new architecture (repository info stored in records, not paths)

### Phase 2: Path Resolution Updates (NEXT)

**2.1 Simplify Workspace Detection**
```typescript
// Before: Complex path parsing
const relativePath = gitRoot.substring(minskyPath.length + 1);
const pathParts = relativePath.split("/");
if (pathParts.length >= 3 && pathParts[1] === "sessions") {
  const sessionName = pathParts[2];
}

// After: Simple basename
const sessionName = basename(gitRoot);
```

**2.2 Update Session-to-Repository Resolution**
- Repository information comes from session record, not path
- Update `getSessionFromWorkspace` and related functions
- Simplify workspace/session detection logic

### Phase 3: Data Migration

**3.1 Session Directory Migration**
- Move existing sessions from `/git/{repo}/sessions/{id}/` to `/sessions/{id}/`
- Update session database references if needed
- Verify session record integrity (ensure all have `repoUrl`)

**3.2 Clean Up Legacy Structure**
- Remove empty repository directories
- Archive old structure for rollback if needed

### Phase 4: Command Interface Updates

**4.1 New Session Metadata Commands**
```bash
# Show repository for current or specified session
minsky session repo [sessionId]

# Show detailed session information including repository
minsky session info <sessionId>

# List sessions filtered by repository
minsky sessions list --repo <repoPath|repoUrl>
```

**4.2 Update Existing Commands**
- Ensure all session operations work with new path structure
- Update session creation, PR generation, workspace resolution
- Test cross-session operations

## Specific Changes Required

### Files to Modify

**Core Session Logic**:
- `src/domain/session/session-db.ts`: Simplify `getSessionWorkdir`
- `src/domain/git.ts`: Update `GitService.getSessionWorkdir`
- `src/domain/workspace.ts`: Simplify workspace detection logic

**Repository Backends**:
- `src/domain/repository/local.ts`: Remove repo path encoding
- `src/domain/repository/remote.ts`: Simplify session path resolution
- `src/domain/repository/github.ts`: Update path generation

**Session Management**:
- `src/domain/session/session-workspace-service.ts`: Update path resolution
- `src/domain/session/session-adapter.ts`: Simplify workdir calculation

### Functions to Remove/Simplify

**Remove Completely**:
- `normalizeRepositoryURI` and related normalization functions
- Complex path parsing in workspace utilities
- Repository identity resolution logic

**Simplify Significantly**:
- All `getSessionWorkdir` implementations
- Session-to-repository detection logic
- Workspace resolution functions

## Testing Strategy

**1. Migration Testing**:
- Verify existing sessions work after directory moves
- Test session database integrity
- Confirm workspace detection still works

**2. Path Resolution Testing**:
- Test session directory creation with new structure
- Verify session-to-repository mapping via database
- Test cross-session operations

**3. Command Interface Testing**:
- Test all session commands with new path structure
- Verify repository metadata commands work correctly
- Test session creation, PR generation, workspace operations

## Success Criteria

1. **Functional**: All existing session operations work with new storage structure
2. **Simple**: Session path resolution becomes trivial (`/sessions/{id}/`)
3. **Clean**: Repository normalization complexity eliminated
4. **Metadata**: Repository information accessible via session commands
5. **Future-Ready**: New repository backends don't require path encoding

## Notes

This represents a fundamental shift from "encode metadata in paths" to "paths for storage, database for metadata" - a much cleaner architectural approach that eliminates the entire class of repository identity problems we were trying to solve.

The original issue (session PR path resolution failure) gets solved as a side effect of this cleaner design, while simultaneously making the codebase more maintainable and extensible.

## Progress Log

### ✅ Completed (2025-01-06)

**Core Session-ID-Based Storage Implementation**:
- **Session Path Simplification**: Successfully changed from `/git/{repoName}/sessions/{sessionId}/` to `/sessions/{sessionId}/`
- **Base Directory Update**: Changed from `/minsky/git` to `/minsky` 
- **Repository Normalization Removal**: Eliminated `normalizeRepoName` dependencies in core session functions
- **GitService Interface Update**: Simplified `getSessionWorkdir(repoName, session)` to `getSessionWorkdir(session)`
- **Test Coverage**: All 19 session-db tests passing with new simplified architecture
- **Interface Updates**: Updated PrTestDependencies and ExtendedGitDependencies to use new signature

**Evidence of Success**:
```bash
# Before: Complex repo-based paths
/test/base/dir/local/minsky/sessions/test-session-1

# After: Simple session-ID-based paths  
/test/base/dir/sessions/test-session-1
```

### 🔄 In Progress

**GitService Call Site Updates**:
- Multiple locations still calling `getSessionWorkdir(repoName, session)` need updating
- Repository backend services need interface updates
- Dependency injection sites need parameter count fixes

### 📋 Next Steps

1. **Complete GitService Call Site Updates**
   - Fix remaining "Expected 1 arguments, but got 2" errors
   - Update all repository backend implementations
   - Update test mocks and dependency objects

2. **Update Workspace Detection Logic**
   - Implement basename-based session detection
   - Remove complex path parsing logic

3. **Test End-to-End Integration**
   - Verify session creation works with new paths
   - Test session PR commands with simplified architecture
   - Validate workspace detection
