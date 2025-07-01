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

### Phase 3: Data Migration (ADDED)

**3.1 Migration Strategy for Existing Sessions**
- **Current Challenge**: Existing sessions in `/git/{repo}/sessions/{id}/` need migration to `/sessions/{id}/`
- **Migration Approach**: Implement safe, incremental migration with rollback capability
- **Session Database Updates**: Update session records to reflect new path structure
- **Backward Compatibility**: Ensure sessions work during migration period

**3.2 Migration Implementation Plan**
```typescript
// Migration utility functions needed:
// 1. Detect legacy session directories
// 2. Move session directories to new structure  
// 3. Update session database records
// 4. Verify migration success
// 5. Provide rollback capability

async function migrateLegacySessions() {
  const legacyBasePath = join(baseDir, "git");
  const newBasePath = join(baseDir, "sessions");
  
  // Scan for legacy sessions in git/{repo}/sessions/
  // Move to sessions/{id}/
  // Update database records
}
```

**3.3 Migration Safety Requirements**
- **Pre-Migration Backup**: Create backup of existing session directories
- **Incremental Migration**: Migrate one session at a time with verification
- **Rollback Support**: Ability to restore original structure if needed
- **Migration Logging**: Detailed logging of migration progress and any issues
- **Verification**: Post-migration verification that all sessions still work

### Phase 4: Test Updates (ADDED)

**4.1 Core Test Updates** ✅ COMPLETE
- ✅ session-db.test.ts updated for new path structure
- ✅ All 19 core tests passing with simplified paths

**4.2 Integration Test Updates** 🔄 REQUIRED
- **GitService Tests**: Update tests that call `getSessionWorkdir(repo, session)` 
- **Repository Backend Tests**: Update path expectations in local/remote/github backend tests
- **Workspace Detection Tests**: Update tests that expect old path parsing logic
- **Session Management Tests**: Update integration tests for session operations
- **CLI Command Tests**: Update tests for session commands that rely on paths

**4.3 Test Categories Requiring Updates**
```typescript
// Tests expecting old signature:
getSessionWorkdir(repoName, session) // → getSessionWorkdir(session)

// Tests expecting old paths:
/git/local-minsky/sessions/task#214/ // → /sessions/task#214/

// Tests with repository path parsing:
// Complex path parsing logic → Simple basename extraction
```

**4.4 Mock and Fixture Updates**
- **Test Mocks**: Update dependency mocks to use new interface signatures
- **Test Fixtures**: Update test data to reflect new path structure
- **Integration Test Data**: Update end-to-end test scenarios

### Phase 5: Command Interface Updates (UPDATED)

**5.1 New Session Metadata Commands**
```bash
# Show repository for current or specified session
minsky session repo [sessionId]

# Show detailed session information including repository
minsky session info <sessionId>

# List sessions filtered by repository
minsky sessions list --repo <repoPath|repoUrl>

# NEW: Migration command
minsky session migrate [--dry-run] [--rollback]
```

**5.2 Migration Command Implementation**
- **Dry Run Mode**: Show what would be migrated without making changes
- **Progressive Migration**: Migrate sessions incrementally with progress reporting
- **Rollback Support**: Restore original structure if migration fails
- **Status Reporting**: Show migration progress and session status

## Testing Strategy

### **Critical Test Areas**

**1. Path Resolution Tests**
- Verify all `getSessionWorkdir` calls work with single parameter
- Test session directory creation with new structure
- Validate workspace detection with simplified paths

**2. Migration Tests**
- Test migration of various session types (local, remote, github)
- Verify session functionality after migration
- Test rollback capability
- Test partial migration scenarios

**3. Integration Tests**
- End-to-end session creation workflow
- Session PR generation with new paths
- Session update and deletion operations
- Cross-session operations and workspace detection

**4. Backward Compatibility Tests**
- Verify graceful handling of legacy path references
- Test migration detection and automatic migration triggers
- Ensure no data loss during migration process

## Migration Strategy Details

### **Migration Phases**

**Phase A: Detection and Planning**
```typescript
// 1. Scan for legacy sessions
const legacySessions = await detectLegacySessions();

// 2. Plan migration order (handle dependencies)
const migrationPlan = createMigrationPlan(legacySessions);

// 3. Create backup of current state
await createMigrationBackup();
```

**Phase B: Incremental Migration**  
```typescript
// 4. Migrate sessions one by one
for (const session of migrationPlan) {
  await migrateSession(session);
  await verifySessionMigration(session);
}

// 5. Update session database records
await updateSessionDatabase();
```

**Phase C: Verification and Cleanup**
```typescript
// 6. Verify all sessions work with new structure
await verifyAllSessions();

// 7. Clean up legacy directories (optional)
await cleanupLegacyDirectories();
```

### **Migration Safety Measures**

**1. Backup Strategy**
- Create timestamped backup of entire session structure
- Store backup metadata for rollback reference
- Verify backup integrity before starting migration

**2. Rollback Capability**
```typescript
async function rollbackMigration(backupId: string) {
  // Restore from backup
  // Revert database changes  
  // Verify rollback success
}
```

**3. Migration Validation**
- Test each migrated session before proceeding
- Verify git operations work in new location
- Confirm session database consistency
- Validate workspace detection still works

### **Implementation Priority**

**High Priority (Blocking):**
1. Fix remaining GitService call sites with parameter mismatches
2. Update repository backend implementations
3. Implement basic migration utility

**Medium Priority (Important):**
4. Update integration tests for new path structure
5. Implement migration command in CLI
6. Add migration safety features (backup/rollback)

**Lower Priority (Polish):**
7. Update all remaining test suites
8. Add migration status reporting
9. Implement automatic migration detection

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
