# Task 157 Investigation: Task Operations Synchronization Across Workspaces

## Executive Summary

This investigation analyzes the current task operations workflow and evaluates approaches to eliminate synchronization issues between main and session workspaces. The analysis reveals fundamental architectural gaps in how task state is managed across distributed workspace contexts.

## Current State Analysis

### How Task Operations Currently Work

#### 1. Task Storage Architecture

- **Primary Storage**: Markdown files in `process/tasks.md` (main list) and `process/tasks/<id>-<title>.md` (specifications)
- **Backend System**: Multiple backends (markdown, json-file, github-issues) with MarkdownTaskBackend as default
- **File Location**: All task files are stored in the workspace where the command is executed

#### 2. Task Operation Data Flow

```
Task Command Execution:
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ CLI Command     │───▶│ TaskService      │───▶│ TaskBackend     │
│ (any workspace) │    │ (current CWD)    │    │ (file I/O)      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │                        │
                                ▼                        ▼
                       ┌──────────────────┐    ┌─────────────────┐
                       │ Workspace Path   │    │ process/tasks.md│
                       │ Resolution       │    │ (local to CWD)  │
                       └──────────────────┘    └─────────────────┘
```

#### 3. Critical Discovery: Workspace Path Resolution

**Current Behavior** (from `src/domain/workspace.ts:resolveWorkspacePath`):

```typescript
// Modified to use the current working directory when in a session workspace
// This ensures operations use the local rules directory in session workspaces
export async function resolveWorkspacePath(
  options?: WorkspaceResolutionOptions,
  deps: TestDependencies = {}
): Promise<string> {
  // ...
  // Note: We're no longer redirecting to the upstream repository path when in a session
  // This allows rules commands to operate on the current directory's rules
  return checkPath; // Returns current directory!
}
```

**This is the root cause of synchronization issues!**

### Points Where Task State Can Be Modified

1. **Direct CLI Commands**:

   - `minsky tasks status set <id> <status>`
   - `minsky tasks create <spec>`
   - `minsky session pr` (auto-updates to IN-REVIEW)

2. **File Operations** (MarkdownTaskBackend):

   - Direct editing of `process/tasks.md`
   - Modifying task specification files
   - Git operations that change task files

3. **Session Lifecycle Events**:

   - PR creation automatically sets status to IN-REVIEW
   - Session completion workflows

4. **MCP Server Operations**:
   - Task management through MCP interface
   - File modification through MCP tools

### Synchronization Failure Scenarios

#### Scenario A: Session Status Updates Not Visible in Main

```
1. User in main workspace: Task #157 shows "TODO"
2. User creates session for #157
3. In session: `minsky tasks status set 157 IN-PROGRESS`
4. Session modifies its local copy of process/tasks.md
5. Main workspace still shows "TODO" - NO SYNCHRONIZATION
```

#### Scenario B: Concurrent Session Conflicts

```
1. Session A updates #157 to "IN-PROGRESS"
2. Session B updates #157 to "IN-REVIEW"
3. Both sessions have different views of task state
4. Last session to push overwrites previous changes
```

#### Scenario C: Lost Updates on Session Cleanup

```
1. Session updates task status
2. Session workspace gets deleted/cleaned
3. Updates are lost if not propagated back to main workspace
```

#### Scenario D: Stale Main Workspace Views

```
1. Main workspace shows cached/stale task information
2. Multiple sessions have updated tasks independently
3. Main workspace user makes decisions based on incorrect state
```

## Architecture Evaluation

### Approach A: Centralized Task Operations

**Concept**: All task operations execute in a dedicated "task management session" or service.

**Implementation Strategy**:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Session/Main WS │───▶│ Task Coordinator │───▶│ Main Workspace  │
│ (Request)       │    │ (Centralized)    │    │ (Single Source) │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │ Event Broadcast  │
                       │ to All Workspaces│
                       └──────────────────┘
```

**Pros**:

- Single source of truth for all task operations
- Eliminates race conditions at the source
- Centralized validation and business logic
- Easy to audit and log all task changes

**Cons**:

- Requires persistent task management service/daemon
- Complex IPC mechanism between workspaces and coordinator
- Single point of failure
- Performance overhead for all task operations
- Difficult to implement with current CLI-based architecture

**Complexity**: High
**Reliability**: High (if implemented correctly)
**Performance Impact**: Medium-High

### Approach B: Special Repository Copy

**Concept**: Task operations work on a special copy of the repository with git-based synchronization.

**Implementation Strategy**:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Task Operation  │───▶│ Special Task Repo│───▶│ All Workspaces  │
│ (Any workspace) │    │ (Dedicated Copy) │    │ (Git Sync)      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │ Git Push/Pull    │
                       │ Synchronization  │
                       └──────────────────┘
```

**Pros**:

- Leverages existing git infrastructure
- Natural conflict resolution through git
- Maintains audit trail through git history
- Atomic operations through git commits
- Can use git hooks for automation

**Cons**:

- Requires git synchronization strategy between workspaces
- Potential merge conflicts need resolution
- May create complex branching scenarios
- Git overhead for simple task updates
- Workspace must handle git state management

**Complexity**: Medium-High
**Reliability**: Medium (depends on git sync strategy)
**Performance Impact**: Medium

### Approach C: Event-Based Synchronization

**Concept**: Task operations emit events that propagate to all active workspaces.

**Implementation Strategy**:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Task Operation  │───▶│ Event Bus        │───▶│ Workspace N     │
│ (Workspace 1)   │    │ (File/Socket)    │    │ (Event Handler) │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │
                                ├─────────────────────────────────┐
                                ▼                                 ▼
                       ┌──────────────────┐          ┌─────────────────┐
                       │ Workspace 2      │          │ Main Workspace  │
                       │ (Event Handler)  │          │ (Event Handler) │
                       └──────────────────┘          └─────────────────┘
```

**Pros**:

- Decoupled architecture
- Real-time synchronization
- Extensible to other event types
- Workspace can choose how to handle events
- Good performance characteristics

**Cons**:

- Requires reliable event delivery mechanism
- Complex event ordering and consistency issues
- Event handling code in every workspace
- Potential for event loss or duplication
- Debugging complexity

**Complexity**: Medium
**Reliability**: Medium (depends on event system reliability)
**Performance Impact**: Low-Medium

### Approach D: File Watching + Lock Coordination

**Concept**: Use file watchers to detect task file changes with locking to prevent concurrent modifications.

**Implementation Strategy**:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Task Operation  │───▶│ File Lock        │───▶│ process/tasks.md│
│ (Any workspace) │    │ (Cross-process)  │    │ (Main/Canonical)│
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │                        │
                                ▼                        ▼
                       ┌──────────────────┐    ┌─────────────────┐
                       │ All Workspaces   │    │ File Watchers   │
                       │ (Wait for lock)  │    │ (Detect Changes)│
                       └──────────────────┘    └─────────────────┘
```

**Pros**:

- Simple conceptual model
- Uses existing file system primitives
- Cross-platform file locking available
- Immediate consistency through locking
- File watching provides real-time updates

**Cons**:

- File locking can be unreliable across platforms
- File watchers can miss events or fire duplicates
- Deadlock potential with multiple lock acquisitions
- Handling lock timeouts and failures
- Still requires workspace synchronization logic

**Complexity**: Medium
**Reliability**: Medium-Low (file system dependencies)
**Performance Impact**: Low

## Detailed Trade-off Analysis

| Factor                           | Approach A (Centralized) | Approach B (Git Copy) | Approach C (Events) | Approach D (File Watch) |
| -------------------------------- | ------------------------ | --------------------- | ------------------- | ----------------------- |
| **Implementation Complexity**    | Very High                | High                  | Medium              | Medium                  |
| **Runtime Performance**          | Medium                   | Low                   | High                | High                    |
| **Reliability**                  | High                     | Medium                | Medium              | Medium-Low              |
| **Consistency Guarantees**       | Strong                   | Medium                | Weak                | Medium                  |
| **Cross-platform Compatibility** | High                     | High                  | Medium              | Medium                  |
| **Integration Complexity**       | High                     | Medium                | Medium              | Low                     |
| **User Experience Impact**       | Low                      | Medium                | Low                 | Low                     |
| **Maintenance Overhead**         | High                     | Medium                | Medium              | Medium                  |
| **Failure Recovery**             | Complex                  | Good                  | Complex             | Simple                  |
| **Development Time**             | High                     | Medium                | Medium              | Low                     |

## Recommended Solution: Hybrid Approach (B + C)

Based on the analysis, I recommend a **hybrid approach combining git-based synchronization with selective event broadcasting**:

### Core Strategy

1. **Canonical Task Storage**: Always in main workspace repository
2. **Task Operations**: Always executed against main workspace files (even from sessions)
3. **Change Propagation**: Git-based synchronization with event notifications
4. **Conflict Resolution**: Git merge strategies with manual resolution fallback

### Implementation Plan

```
Phase 1: Fix Workspace Resolution
├── Update resolveWorkspacePath to always use main workspace for task operations
├── Modify TaskService to work with main workspace path regardless of execution context
└── Ensure session commands detect and use main workspace path

Phase 2: Implement Change Detection
├── Add file watching for task files in main workspace
├── Implement change events for task modifications
└── Add workspace notification system

Phase 3: Add Session Synchronization
├── Session workspaces subscribe to task change events
├── Implement git-based sync for session task file updates
└── Add conflict resolution for concurrent modifications
```

### Key Benefits

- **Immediate**: Fixes current synchronization issues by centralizing task storage
- **Reliable**: Uses git for atomic operations and conflict resolution
- **Performant**: Minimal overhead, leverages existing infrastructure
- **Maintainable**: Builds on current architecture without major rewrites
- **Extensible**: Can add more sophisticated synchronization later

## Next Steps

1. **Immediate Fix**: Modify `resolveWorkspacePath` to redirect task operations to main workspace
2. **Validation**: Add comprehensive tests for multi-workspace task operations
3. **Implementation**: Begin Phase 1 implementation
4. **Testing**: Create integration tests for session/main workspace synchronization scenarios

This approach provides the best balance of reliability, performance, and implementation feasibility while solving the immediate synchronization problems.
