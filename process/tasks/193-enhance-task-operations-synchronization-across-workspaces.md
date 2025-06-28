# Task 193: Implement Special Workspace for Task Operations

## Status

NEW

## Priority

HIGH

## Category

ENHANCEMENT

## Problem Statement

Task operations performed in session workspaces currently operate on local copies of task files, causing synchronization issues. While Task #182 provides an immediate fix by redirecting task operations to the main workspace, a more robust long-term solution is needed to ensure task operations are isolated, atomic, and consistent across all contexts.

**Additionally, the JSON task backend suffers from the same storage location issues** - it defaults to storing tasks in local directories (`{workspace}/.minsky/tasks.json`), making it non-shareable across team members and defeating the purpose of centralized task management.

The solution is to implement a **special internal workspace dedicated exclusively to task operations**, ensuring all task modifications happen in a controlled, synchronized environment that works for both markdown and JSON backends.

## Background

Investigation completed in the original phase of this task revealed:

- Root cause: `resolveWorkspacePath()` returns current directory for all operations
- Multiple synchronization failure scenarios documented
- **JSON backend storage location issue**: Each workspace gets its own JSON file, breaking team collaboration
- Trade-off analysis showed a special workspace approach provides the best balance

## Proposed Solution: Special Task Operations Workspace

### Architecture Overview

```
Task Command → TaskService → Special Workspace Manager → Task Operations Workspace
                                      ↓
                               [Update from main]
                                      ↓
                            [Perform operation (MD/JSON)]
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
3. **Unified Storage for All Backends**:
   - **Markdown backend**: Uses `process/tasks.md` in special workspace
   - **JSON backend**: Uses `process/.minsky/tasks.json` in special workspace (committed to git)
   - **Team-shareable**: JSON database is now version-controlled and shared
4. **Lifecycle**:
   - Created on first task operation (lazy initialization)
   - Persists between operations
   - Auto-cleanup: remove .git/objects older than 7 days
5. **Synchronization Strategy**:
   - **Read operations**: Use workspace as-is (zero overhead)
   - **Write operations**:
     - `git fetch --depth=1 origin main` (fetch only latest)
     - `git reset --hard origin/main`
     - Perform task operation
     - `git add process/ && git commit && git push` (push all task changes)
6. **Error Handling**:
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
- **Managing backend storage locations**

### 2. Task Service Integration

- Modify TaskService to use Special Workspace Manager
- Route all task operations through the special workspace
- **Update JSON backend to use special workspace path**
- Maintain backward compatibility with existing API

### 3. JSON Backend Storage Integration

- **Modify JsonFileTaskBackend** to store in special workspace when available
- **Default JSON storage location**: `{special-workspace}/process/.minsky/tasks.json`
- **Team-shareable**: JSON database is now committed to git and shared
- **Fallback logic**: Use existing behavior if special workspace not available

### 4. Atomic Operations

- Each task operation must be atomic
- Use git for transactional guarantees
- Implement proper locking to prevent concurrent modifications
- **Support both markdown and JSON backends atomically**

### 5. Performance Optimization

- **Repository Optimization**:
  - Shallow clones: `--depth=1` eliminates git history (saves ~80% space)
  - Sparse checkout: Only checkout `process/` directory (saves ~90% disk space)
  - Blob filters: `--filter=blob:none` for even more space savings
- **Operation Optimization**:
  - Read operations: Zero overhead (use workspace as-is)
  - Write operations: Only fetch/push what's needed
  - Background cleanup: Periodic `git gc --aggressive` during idle time

### 6. Error Recovery

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

### Phase 2: Integrate with TaskService and Backends

1. **Update TaskService Constructor**:

   - Accept SpecialWorkspaceManager as dependency
   - Initialize manager on first use
   - **Pass special workspace path to all backends**

2. **Modify Task Operation Methods**:

   - Route all operations through special workspace
   - Maintain existing method signatures
   - Add operation logging for debugging

3. **Update JsonFileTaskBackend**:

   - **Modify constructor to prefer special workspace path**
   - **Default JSON storage**: `{specialWorkspace}/process/.minsky/tasks.json`
   - **Add fallback logic** for backward compatibility
   - **Ensure JSON database is committed to git**

4. **Update MarkdownTaskBackend**:
   - Use special workspace path for task files
   - Maintain existing functionality

### Phase 3: Backend Storage Location Resolution

1. **Create Unified Storage Location Strategy**:

   ```typescript
   interface TaskStorageResolver {
     resolveStorageLocation(backend: string): string;
     isSpecialWorkspaceAvailable(): boolean;
     getSpecialWorkspacePath(): string;
   }
   ```

2. **Storage Location Priority**:

   - **Priority 1**: Special workspace (if available)
   - **Priority 2**: Main workspace (if in session)
   - **Priority 3**: Current directory (fallback)

3. **JSON Backend Storage Logic**:

   ```typescript
   // NEW: Team-shareable, git-committed storage
   {
     specialWorkspace;
   }
   /process/.minsky / tasks.json;

   // FALLBACK: Local storage (existing behavior)
   {
     workspace;
   }
   /.minsky/aksst.json;
   ```

### Phase 4: Testing and Validation

1. **Unit Tests**:

   - Test SpecialWorkspaceManager in isolation
   - Test JSON backend storage location resolution
   - Mock git operations for speed
   - Cover error scenarios

2. **Integration Tests**:

   - Test full task operation flow with both backends
   - Simulate concurrent operations
   - Verify rollback mechanisms
   - **Test team collaboration scenarios**

3. **Performance Tests**:
   - Measure operation latency
   - Test under high concurrency
   - Validate optimization effectiveness

## Acceptance Criteria

- [ ] **Special Workspace Manager Implemented**: Complete module with all required functionality
- [ ] **TaskService Integration Complete**: All task operations use special workspace
- [ ] **JSON Backend Storage Fixed**: JSON database stored in special workspace and team-shareable
- [ ] **Atomic Operations**: Each operation is fully atomic with proper rollback
- [ ] **Performance Targets Met**:
  - Read operations: <10ms overhead
  - Write operations: <500ms overhead
- [ ] **Error Recovery Working**: Automatic recovery from corrupted states
- [ ] **Concurrent Access Handled**: Proper locking prevents race conditions
- [ ] **Backward Compatibility**: Existing API unchanged
- [ ] **Team Collaboration**: JSON backend now shareable across developers
- [ ] **Comprehensive Tests**: >90% code coverage with all scenarios tested
- [ ] **Documentation Complete**: Architecture, API, and usage documented

## Success Metrics

1. **Zero Synchronization Failures**: No divergent task states across workspaces
2. **Team Collaboration**: JSON backend shared across all team members
3. **Performance Maintained**: No noticeable degradation for end users
4. **Reliability**: 99.9% success rate for task operations
5. **Maintainability**: Clean architecture that's easy to debug and extend

## Technical Considerations

- Use native git commands for reliability
- Consider using a git library (like isomorphic-git) for better control
- Implement proper cleanup to prevent disk space issues
- Add telemetry for monitoring operation success rates
- Consider adding a "repair" command for manual recovery
- **Ensure JSON database is properly committed to git**
- **Add .gitignore rules for temporary files but not the JSON database**

## Dependencies

- Completion of Task #182 (immediate fix)
- Git command availability
- File system access for special workspace
- Existing TaskService architecture

## Notes

This approach eliminates synchronization issues by ensuring all task operations happen in a single, controlled location, while also solving the JSON backend storage location problem. The persistent workspace provides excellent performance for read operations while maintaining consistency for writes. The solution is simpler than trying to synchronize multiple workspaces and provides a solid foundation for future enhancements.

**Key Innovation**: By storing the JSON database in the special workspace's `process/` directory, it becomes version-controlled and automatically shared across all team members, solving the team collaboration issue.
