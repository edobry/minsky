# Task 193: Implement Special Workspace for Task Operations

## Status

IN-PROGRESS

## Priority

HIGH

## Category

ENHANCEMENT

## Implementation Progress

### ✅ Phase 1: Core Architecture - COMPLETED

1. **SpecialWorkspaceManager** - `src/domain/workspace/special-workspace-manager.ts`
   - ✅ Persistent workspace at `~/.local/state/minsky/task-operations/`
   - ✅ Git-synchronized operations (clone, pull, commit, push)
   - ✅ Atomic operations with proper locking and rollback
   - ✅ Performance optimizations (shallow clone, single branch)
   - ✅ Error handling and workspace repair functionality
   - ✅ Configurable base directory, workspace name, and timeouts

2. **TaskBackendRouter** - `src/domain/tasks/task-backend-router.ts`
   - ✅ Intelligent routing between in-tree vs external backends
   - ✅ Auto-detection with manual override capability
   - ✅ Strategy pattern for flexible workspace path resolution
   - ✅ Factory methods for different routing scenarios
   - ✅ InTreeBackendCapable interface for type-safe detection

3. **Backend Interface Extensions** - COMPLETED
   - ✅ JsonFileTaskBackend.isInTreeBackend() → true
   - ✅ MarkdownTaskBackend.isInTreeBackend() → true
   - ✅ Both backends properly identify as in-tree

### 🚧 Phase 2: Integration - IN PROGRESS

4. **TaskService Integration** - `src/domain/tasks/taskService.ts`
   - ✅ Async factory pattern started
   - ✅ Backend router initialization logic
   - ✅ Workspace path resolution per backend type
   - 🚧 API refinement needed
   - 🚧 Linter issues to resolve

### 📋 Phase 3: Remaining Work

5. **JSON Backend Storage Integration**
   - 🔲 Update JsonFileTaskBackend to use special workspace storage location
   - 🔲 Change default JSON path to `{special-workspace}/process/tasks.json`
   - 🔲 Ensure JSON database is committed to git

6. **Testing and Validation**
   - 🔲 Unit tests for SpecialWorkspaceManager
   - 🔲 Unit tests for TaskBackendRouter
   - 🔲 Integration tests with real workflows
   - 🔲 End-to-end testing across different contexts

## Problem Statement

Task operations performed in session workspaces currently operate on local copies of task files, causing synchronization issues. While Task #182 provides an immediate fix by redirecting task operations to the main workspace, a more robust long-term solution is needed to ensure task operations are isolated, atomic, and consistent across all contexts.

The solution is to implement a **special internal workspace dedicated exclusively to task operations**, ensuring all task modifications happen in a controlled, synchronized environment.

## Background

Investigation completed in the original phase of this task revealed:

- Root cause: `resolveWorkspacePath()` returns current directory for all operations
- Multiple synchronization failure scenarios documented
- Trade-off analysis showed a special workspace approach provides the best balance

## Proposed Solution: Special Task Operations Workspace

### Architecture Overview

```
Task Command → TaskService → Special Workspace Manager → Task Operations Workspace
                                      ↓
                               [Update from main]
                                      ↓
                               [Perform operation]
                                      ↓
                               [Commit & push to main]
```

### Implementation Approach

**Persistent Special Workspace** with the following characteristics:

1. **Location**: `~/.local/state/minsky/task-operations/`
2. **Optimized Repository**:
   - **Shallow clone**: `--depth=1` (no git history, only latest commit)
   - **Sparse checkout**: Only `process/` directory (ignore src/, docs/, etc.)
   - **Minimal footprint**: ~5-10MB instead of full repo size
3. **Lifecycle**:
   - Created on first task operation (lazy initialization)
   - Persists between operations
   - Auto-cleanup: remove .git/objects older than 7 days
4. **Synchronization Strategy**:
   - **Read operations**: Use workspace as-is (zero overhead)
   - **Write operations**:
     - `git fetch --depth=1 origin main` (fetch only latest)
     - `git reset --hard origin/main`
     - Perform task operation
     - `git add process/ && git commit && git push` (only push task changes)
5. **Error Handling**:
   - Rollback on operation failure
   - Automatic recovery if workspace corrupted
   - Re-clone from scratch if repair fails

## Requirements

### 1. Special Workspace Manager

Create a new module responsible for:

- Initializing the special workspace
- Ensuring it's up-to-date before write operations
- Managing the workspace lifecycle
- Handling errors and recovery

### 2. Task Service Integration

- Modify TaskService to use Special Workspace Manager
- Route all task operations through the special workspace
- Maintain backward compatibility with existing API

### 3. Atomic Operations

- Each task operation must be atomic
- Use git for transactional guarantees
- Implement proper locking to prevent concurrent modifications

### 4. Performance Optimization

- **Repository Optimization**:
  - Shallow clones: `--depth=1` eliminates git history (saves ~80% space)
  - Sparse checkout: Only checkout `process/` directory (saves ~90% disk space)
  - Blob filters: `--filter=blob:none` for even more space savings
- **Operation Optimization**:
  - Read operations: Zero overhead (use workspace as-is)
  - Write operations: Only fetch/push what's needed
  - Background cleanup: Periodic `git gc --aggressive` during idle time

### 5. Error Recovery

- Detect corrupted workspace states
- Automatic cleanup and re-initialization
- Graceful fallback mechanisms

## Implementation Steps

### Phase 1: Create Special Workspace Manager

1. **Create `SpecialWorkspaceManager` class**:

   - Initialize optimized workspace: `git clone --depth=1 --filter=blob:none <repo>`
   - Configure sparse checkout: `git sparse-checkout set process/`
   - Implement workspace health checks
   - Add recovery mechanisms for corrupted states

2. **Implement Synchronization Methods**:

   - `ensureUpToDate()`: `git fetch --depth=1 && git reset --hard origin/main`
   - `commitAndPush()`: `git add process/ && git commit && git push`
   - `rollback()`: `git reset --hard HEAD~1`
   - `repair()`: Re-clone with optimizations if corruption detected

3. **Add Locking Mechanism**:
   - Implement file-based locking (`/tmp/minsky-task-operations.lock`)
   - Prevent concurrent task operations
   - Handle stale locks gracefully (auto-expire after 5 minutes)

### Phase 2: Integrate with TaskService

1. **Update TaskService Constructor**:

   - Accept SpecialWorkspaceManager as dependency
   - Initialize manager on first use

2. **Modify Task Operation Methods**:

   - Route all operations through special workspace
   - Maintain existing method signatures
   - Add operation logging for debugging

3. **Optimize Read Operations**:
   - Skip synchronization for read-only operations
   - Cache frequently accessed data
   - Monitor performance metrics

### Phase 3: Testing and Validation

1. **Unit Tests**:

   - Test SpecialWorkspaceManager in isolation
   - Mock git operations for speed
   - Cover error scenarios

2. **Integration Tests**:

   - Test full task operation flow
   - Simulate concurrent operations
   - Verify rollback mechanisms

3. **Performance Tests**:
   - Measure operation latency
   - Test under high concurrency
   - Validate optimization effectiveness

## Acceptance Criteria

- [ ] **Special Workspace Manager Implemented**: Complete module with all required functionality
- [ ] **TaskService Integration Complete**: All task operations use special workspace
- [ ] **Atomic Operations**: Each operation is fully atomic with proper rollback
- [ ] **Performance Targets Met**:
  - Read operations: <10ms overhead
  - Write operations: <500ms overhead
- [ ] **Error Recovery Working**: Automatic recovery from corrupted states
- [ ] **Concurrent Access Handled**: Proper locking prevents race conditions
- [ ] **Backward Compatibility**: Existing API unchanged
- [ ] **Comprehensive Tests**: >90% code coverage with all scenarios tested
- [ ] **Documentation Complete**: Architecture, API, and usage documented

## Success Metrics

1. **Zero Synchronization Failures**: No divergent task states across workspaces
2. **Performance Maintained**: No noticeable degradation for end users
3. **Reliability**: 99.9% success rate for task operations
4. **Maintainability**: Clean architecture that's easy to debug and extend

## Technical Considerations

- Use native git commands for reliability
- Consider using a git library (like isomorphic-git) for better control
- Implement proper cleanup to prevent disk space issues
- Add telemetry for monitoring operation success rates
- Consider adding a "repair" command for manual recovery

## Dependencies

- Completion of Task #182 (immediate fix)
- Git command availability
- File system access for special workspace
- Existing TaskService architecture

## Notes

This approach eliminates synchronization issues by ensuring all task operations happen in a single, controlled location. The persistent workspace provides excellent performance for read operations while maintaining consistency for writes. The solution is simpler than trying to synchronize multiple workspaces and provides a solid foundation for future enhancements.
