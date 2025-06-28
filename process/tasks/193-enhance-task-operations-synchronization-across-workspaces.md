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
   - **JSON backend**: Uses `process/tasks.json` in special workspace (committed to git)
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

## Backend Categorization and Intelligent Routing

### Backend Types

The special workspace approach needs to intelligently handle different backend types:

#### 1. **In-tree Backends** (Use Special Workspace)

- **Markdown backend**: Stores in `process/tasks.md`
- **JSON backend**: Stores in `process/tasks.json`
- **Characteristics**: Store data in repository files, suffer from workspace synchronization issues

#### 2. **External Backends** (Use Normal Workspace Resolution)

- **GitHub Issues backend**: Stores data via GitHub API
- **SQLite backend**: Stores in database file (location configurable)
- **PostgreSQL backend**: Stores in remote database server
- **Characteristics**: Already centralized, no workspace synchronization issues

#### 3. **Hybrid Backends** (Context Dependent)

- **SQLite backend**: Could be in-tree (`process/tasks.db`) or external (`~/.local/state/minsky/tasks.db`)
- **Decision logic**: If storage location is within repository, use special workspace

### Intelligent Backend Routing

```typescript
interface BackendWorkspaceStrategy {
  /**
   * Determine if backend requires special workspace
   */
  requiresSpecialWorkspace(backend: TaskBackend): boolean;

  /**
   * Get appropriate workspace path for backend
   */
  getWorkspacePathForBackend(backend: TaskBackend): Promise<string>;
}

class TaskBackendRouter implements BackendWorkspaceStrategy {
  requiresSpecialWorkspace(backend: TaskBackend): boolean {
    // Check if backend stores data in repository files
    return backend.isInTreeBackend?.() ?? this.detectInTreeBackend(backend);
  }

  private detectInTreeBackend(backend: TaskBackend): boolean {
    // Auto-detect based on backend name or storage location
    const inTreeBackends = ["markdown", "json-file"];
    return inTreeBackends.includes(backend.name);
  }

  async getWorkspacePathForBackend(backend: TaskBackend): Promise<string> {
    if (this.requiresSpecialWorkspace(backend)) {
      return this.specialWorkspaceManager.getWorkspacePath();
    }
    return resolveWorkspacePath(); // Normal resolution
  }
}
```

### Backend Interface Extension

```typescript
interface TaskBackend {
  name: string;
  // ... existing methods ...

  /**
   * Indicates if this backend stores data in repository files
   * Optional: defaults to auto-detection based on backend name
   */
  isInTreeBackend?(): boolean;

  /**
   * Get storage location for this backend
   * Used to determine if special workspace is needed
   */
  getStorageLocation?(): string;
}
```

## Requirements

### 1. Special Workspace Manager

Create a new module responsible for:

- Initializing the special workspace
- Ensuring it's up-to-date before write operations
- Managing the workspace lifecycle
- Handling errors and recovery
- **Managing backend storage locations**

### 2. Task Service Integration

- **Implement TaskBackendRouter** for intelligent workspace path resolution
- Route **only in-tree backends** through special workspace
- **External backends** use normal workspace resolution
- Modify TaskService to use TaskBackendRouter
- Maintain backward compatibility with existing API
- **Auto-detection** of backend types with override capability

### 3. JSON Backend Storage Integration

- **Modify JsonFileTaskBackend** to store in special workspace when available
- **Default JSON storage location**: `{special-workspace}/process/tasks.json`
- **Team-shareable**: JSON database is now version-controlled and shared
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

### Phase 2: Implement Intelligent Backend Routing

1. **Create TaskBackendRouter**:

   - Implement `BackendWorkspaceStrategy` interface
   - Auto-detect in-tree vs external backends
   - Allow manual override via `isInTreeBackend()` method
   - Route backends to appropriate workspace paths

2. **Update TaskService Constructor**:

   - Accept TaskBackendRouter as dependency
   - Initialize SpecialWorkspaceManager only when needed
   - **Pass appropriate workspace path to each backend individually**

3. **Backend-Specific Workspace Resolution**:

   - **In-tree backends**: Use special workspace path
   - **External backends**: Use normal workspace resolution
   - **Hybrid backends**: Determine based on storage location

4. **Update Existing Backends**:

   - **JsonFileTaskBackend**: Add `isInTreeBackend()` returning `true`
   - **MarkdownTaskBackend**: Add `isInTreeBackend()` returning `true`
   - **GitHubTaskBackend**: Add `isInTreeBackend()` returning `false`

5. **Modify Task Operation Methods**:

   - Route operations through TaskBackendRouter
   - Only use special workspace for in-tree backends
   - Maintain existing method signatures
   - Add operation logging for debugging

### Phase 3: JSON Backend Storage Integration

1. **Update JsonFileTaskBackend**:

   - **Modify constructor to prefer special workspace path**
   - **Default JSON storage**: `{specialWorkspace}/process/tasks.json`
   - **Add fallback logic** for backward compatibility
   - **Ensure JSON database is committed to git**

2. **Storage Location Priority**:

   - **Priority 1**: Special workspace (for in-tree backends)
   - **Priority 2**: Main workspace (if in session)
   - **Priority 3**: Current directory (fallback)

3. **JSON Backend Storage Logic**:

   ```typescript
   // NEW: Team-shareable, git-committed storage
   {
     specialWorkspace;
   }
   /process/aksst.json;

   // FALLBACK: Local storage (existing behavior)
   {
     workspace;
   }
   /.minsky/aksst.json;
   ```

### Phase 4: Testing and Validation

1. **Unit Tests**:

   - Test SpecialWorkspaceManager in isolation
   - Test TaskBackendRouter intelligent routing
   - Test backend categorization logic
   - Mock git operations for speed
   - Cover error scenarios

2. **Integration Tests**:

   - Test full task operation flow with both in-tree and external backends
   - Verify only in-tree backends use special workspace
   - Simulate concurrent operations
   - Verify rollback mechanisms
   - **Test team collaboration scenarios**

3. **Performance Tests**:
   - Measure operation latency for different backend types
   - Test under high concurrency
   - Validate optimization effectiveness

## Acceptance Criteria

- [ ] **Special Workspace Manager Implemented**: Complete module with all required functionality
- [ ] **TaskBackendRouter Implemented**: Intelligent routing for different backend types
- [ ] **In-tree Backend Detection**: Automatic detection with manual override capability
- [ ] **JSON Backend Storage Fixed**: JSON database stored in special workspace and team-shareable
- [ ] **External Backend Support**: GitHub/database backends work without special workspace
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

1. **Zero Synchronization Failures**: No divergent task states across workspaces for in-tree backends
2. **Team Collaboration**: JSON backend shared across all team members
3. **Backend Flexibility**: External backends work seamlessly without workspace overhead
4. **Performance Maintained**: No noticeable degradation for end users
5. **Reliability**: 99.9% success rate for task operations
6. **Maintainability**: Clean architecture that's easy to debug and extend

## Technical Considerations

- Use native git commands for reliability
- Consider using a git library (like isomorphic-git) for better control
- Implement proper cleanup to prevent disk space issues
- Add telemetry for monitoring operation success rates
- Consider adding a "repair" command for manual recovery
- **Ensure JSON database is properly committed to git**
- **Add .gitignore rules for temporary files but not the JSON database**
- **Design backend interface to support future database backends**

## Dependencies

- Completion of Task #182 (immediate fix)
- Git command availability
- File system access for special workspace
- Existing TaskService architecture

## Notes

This approach eliminates synchronization issues by ensuring all in-tree task operations happen in a single, controlled location, while allowing external backends to operate normally. The persistent workspace provides excellent performance for read operations while maintaining consistency for writes. The intelligent routing system makes the solution extensible for future backend types.

**Key Innovation**: By categorizing backends and only applying special workspace to in-tree backends, we solve the synchronization problem without adding unnecessary overhead to external backends. The JSON database becomes version-controlled and automatically shared across team members.
