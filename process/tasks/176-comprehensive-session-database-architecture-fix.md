# Task 176: Comprehensive Session Database Architecture Fix

**Status:** TODO
**Priority:** CRITICAL
**Assignee:** edobry
**Created:** 2025-01-28

## Critical Issue Summary

The session database architecture has fundamental flaws that are causing multiple operational issues:

1. **CRITICAL**: Multiple session databases exist instead of one system-wide database
2. **Architecture**: Inconsistent adapter delegation and interface implementation
3. **User Experience**: Conflicting error messages preventing successful workflow completion

This task consolidates the investigation and fixes for all session database architecture issues.

## Root Cause: Multiple Database Architecture Flaw

**Primary Issue**: Multiple session databases exist instead of one system-wide database

- Session workspaces appear to have their own .minsky/config.yaml
- Different Minsky invocations may be using different database instances
- This violates the core principle that there should be ONE session database system-wide

**Impact**: This fundamental flaw is the root cause of:

- Session not found errors when sessions clearly exist
- Conflicting error messages in session PR workflow
- Database inconsistencies and sync problems
- Session detection failures across different working directories

## Secondary Issues (Architecture & UX)

### Conflicting Session PR Error Messages

**Error Message 1** (from `src/domain/git.ts:1372`):

```
⚠️  Note: Session PR commands must be run from the main workspace, not from within the session directory.
```

**Error Message 2** (from `src/domain/session.ts:1050`):

```
session pr command must be run from within a session workspace. Use 'minsky session start' first.
```

**Root Cause**: Two different execution paths with contradictory workspace requirements caused by database sync issues.

### Backend Architecture Inconsistencies

After adding SQLite/PostgreSQL support, there are concerns about:

- Adapter pattern delegation issues
- Interface/logic inconsistencies between backends
- Potential architectural issues introduced during backend expansion
- Session lookup and management reliability concerns

## Comprehensive Investigation Areas

### 1. **CRITICAL: Database Location & Consolidation**

- [ ] **Map all session database locations** currently in use
- [ ] **Identify the intended single database location** for system-wide use
- [ ] **Review createSessionProvider() architecture** and workingDir parameter usage
- [ ] **Design migration plan** to consolidate multiple databases into one
- [ ] **Implement single source of truth** for session records
- [ ] **Remove workspace-specific database creation** logic

### 2. **Configuration Architecture Review**

- [ ] **Analyze current configuration hierarchy** (global vs workspace)
- [ ] **Determine what session workspaces should inherit** vs configure independently
- [ ] **Review .minsky/config.yaml** proliferation in session workspaces
- [ ] **Design proper configuration architecture** that doesn't create multiple databases
- [ ] **Implement configuration validation** and error handling

### 3. **Session Detection & Workspace Logic**

- [ ] **Fix session detection to work from any working directory** without multiple databases
- [ ] **Review sessionPrFromParams vs GitService.preparePr** workspace requirements
- [ ] **Implement unified workspace detection** that works from both session and main workspace
- [ ] **Consolidate error messaging strategy** to eliminate contradictions
- [ ] **Add automatic session registration** when sessions exist on disk but not in database

### 4. **Adapter Pattern & Backend Analysis**

- [ ] **Review SessionProviderInterface implementation** across all backends
- [ ] **Verify proper delegation** in adapter classes
- [ ] **Check for missing or incomplete method implementations**
- [ ] **Analyze interface consistency** between backends
- [ ] **Review adapter factory logic** and backend selection
- [ ] **Validate database initialization** and migration logic

### 5. **Session Database Logic Review**

- [ ] **Examine session creation, retrieval, and deletion flows** with single database
- [ ] **Verify session-to-task ID mapping consistency** across all operations
- [ ] **Check session directory management logic** for proper synchronization
- [ ] **Review session record validation** and normalization
- [ ] **Implement proper session lifecycle management** with unified database

### 6. **Backend-Specific Issues**

- [ ] **JSON File Backend**: File I/O, concurrency, data integrity with single database
- [ ] **SQLite Backend**: Connection management, schema consistency, transactions
- [ ] **PostgreSQL Backend**: Connection pooling, migration handling, performance
- [ ] **Cross-backend compatibility** and data migration strategies
- [ ] **Database path resolution consistency** across environments

### 7. **Concurrency and Race Conditions**

- [ ] **Analyze concurrent session operations** with unified database
- [ ] **Check for file locking issues** (JSON backend)
- [ ] **Review database connection management** (SQL backends)
- [ ] **Implement proper transaction handling** for session operations

## Error Message Coordination & UX Fixes

### 1. **Unified Error Messaging**

- [ ] **Coordinate error messages** between sessionPrFromParams and GitService layers
- [ ] **Implement single source of truth** for workspace requirements
- [ ] **Provide clear, non-contradictory guidance** for users
- [ ] **Include automatic recovery suggestions** in error messages

### 2. **Session Database Sync**

- [ ] **Implement automatic session registration** when sessions exist on disk
- [ ] **Add session import/sync command** for manual recovery
- [ ] **Ensure database stays in sync** with filesystem
- [ ] **Add validation checks** for database consistency

### 3. **Workflow Integration**

- [ ] **Fix session PR workflow** to work with unified database
- [ ] **Implement intelligent workspace detection** for all session commands
- [ ] **Add proper error recovery paths** for common scenarios

## Testing Strategy

### 1. **Critical Path Testing**

- [ ] **Test single database consolidation** migration
- [ ] **Verify session detection** from different working directories
- [ ] **Test session PR workflow** from both session and main workspace
- [ ] **Validate error message consistency** across all scenarios

### 2. **Backend Compatibility Tests**

- [ ] **Create comprehensive test suite** for each backend with unified database
- [ ] **Test data migration** between backends
- [ ] **Verify identical behavior** across implementations
- [ ] **Test database consolidation** from multiple databases to single database

### 3. **Edge Case Testing**

- [ ] **Test session creation** with invalid data
- [ ] **Test concurrent session operations** with unified database
- [ ] **Test database corruption recovery**
- [ ] **Test session workspace detection** edge cases
- [ ] **Test configuration hierarchy** validation

### 4. **Performance Analysis**

- [ ] **Benchmark session operations** across backends with unified database
- [ ] **Identify performance bottlenecks** in consolidated architecture
- [ ] **Test with large numbers of sessions** in single database

## Specific Test Cases for Error Scenarios

1. **Session exists on disk but not in database** (auto-registration)
2. **Running session pr from session workspace** (unified detection)
3. **Running session pr from main workspace** (unified detection)
4. **Session database corruption/missing scenarios** (recovery)
5. **Manual session recovery workflows** (import/sync)
6. **Multiple database migration scenarios** (consolidation)
7. **Configuration validation** edge cases

## Deliverables

### 1. **Architecture Fix Implementation**

- [ ] **Single system-wide session database** implementation
- [ ] **Unified session detection** that works from any directory
- [ ] **Consolidated configuration architecture** without multiple databases
- [ ] **Fixed session PR workflow** with consistent error messages
- [ ] **Automatic session registration/sync** functionality

### 2. **Migration & Recovery Tools**

- [ ] **Database consolidation script** for existing multiple databases
- [ ] **Session import/sync command** for manual recovery
- [ ] **Configuration migration** for workspace configs
- [ ] **Validation tools** for database consistency

### 3. **Testing & Documentation**

- [ ] **Comprehensive test suite** for unified architecture
- [ ] **Backend compatibility tests** with single database
- [ ] **Error scenario test coverage** for all edge cases
- [ ] **Performance benchmarks** for consolidated architecture
- [ ] **Clear architectural documentation** of session database system
- [ ] **Migration guide** for existing installations

### 4. **Analysis Reports**

- [ ] **Root cause analysis document** with findings
- [ ] **Migration impact assessment** for existing users
- [ ] **Performance analysis** of unified vs multiple database architecture
- [ ] **Recommendations** for ongoing maintenance

## Success Criteria

- [ ] **Only ONE session database exists system-wide**
- [ ] **Session commands work from any directory** without database confusion
- [ ] **No conflicting error messages** in session workflows
- [ ] **All session database backends work consistently** with unified architecture
- [ ] **Proper adapter delegation** and interface compliance
- [ ] **Comprehensive test coverage** for all backends and scenarios
- [ ] **Clear architectural documentation** with migration path
- [ ] **No session lookup or management reliability issues**
- [ ] **Automatic session registration** when filesystem/database out of sync

## Priority: CRITICAL

This is a fundamental architectural issue that affects all session functionality and blocks core user workflows.

## Estimated Effort

8-12 hours (increased from original estimates due to comprehensive scope)

## Related Tasks

- **Task #165**: Revealed database issues during session PR command investigation
- **Task #168**: May be related to session lookup bugs
- **Task #174**: Session PR Workflow Architecture (separate workflow design task)
- **Task #177**: Session Update Command Design (separate workflow design task)
- **Task #172**: Boolean Flag Parsing Issue (dependency for some workflow fixes)

## Implementation Notes

### Migration Strategy

1. **Phase 1**: Implement unified database architecture
2. **Phase 2**: Create migration tools for existing installations
3. **Phase 3**: Update all session commands to use unified database
4. **Phase 4**: Remove old multiple database logic
5. **Phase 5**: Comprehensive testing and documentation

### Coordination with Other Tasks

- **Task #174** (Session PR Workflow): Will benefit from unified database but focuses on workflow design
- **Task #177** (Session Update Command): Depends on boolean flag parsing fix but addresses command design
- This task provides the **foundation** for reliable session operations that other workflow tasks depend on

## Risk Assessment

**High Risk**: This is a fundamental architectural change that affects all session functionality
**Mitigation**: Comprehensive testing, phased rollout, and migration tools for existing installations

**Impact**: Fixes multiple critical user-blocking issues but requires careful implementation to avoid breaking existing workflows.
