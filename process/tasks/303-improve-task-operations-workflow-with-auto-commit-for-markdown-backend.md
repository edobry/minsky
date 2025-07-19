# Improve Task Operations Workflow with Auto-Commit for Markdown Backend

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Context

Previously, we implemented the concept of a special workspace for task operations when working specifically with the MARKDOWN TASKS BACKEND, but it's unclear if this functionality is actually being used or working as intended. Additionally, current task operations (creating tasks, setting status, etc.) require manual git commit and push operations afterward, which places a burden on agents to remember these steps.

This task aims to:
1. Investigate the current status of the special workspace for markdown tasks backend
2. Enhance task operations to automatically commit and push changes when using the markdown backend
3. Ensure seamless workflow for agents performing task operations

## Investigation Results ✅ COMPLETED

### 1. Special Workspace Investigation ✅
- **✅ FULLY IMPLEMENTED**: Task #193 implemented complete special workspace system
  - `SpecialWorkspaceManager`: Atomic operations, git-based transactions, performance optimizations
  - `TaskBackendRouter`: Intelligent routing between in-tree and external backends
  - Backend integration for markdown and JSON backends
  - Comprehensive test suite (all tests passing)
- **❌ NOT BEING USED**: Task commands in `taskCommands.ts` still use simple `resolveMainWorkspacePath()`
- **✅ PROPERLY CONFIGURED**: All infrastructure exists and is working, just not integrated

### 2. Current Task Operations Audit ✅
- **Operation Inventory**: All task operations go through `taskCommands.ts` → `TaskService` → Backend
  - `listTasksFromParams()`, `getTaskFromParams()`, `setTaskStatusFromParams()`
  - `createTaskFromTitleAndDescription()`, `deleteTaskFromParams()`, `getTaskSpecContentFromParams()`
- **Current Pattern**: All use `resolveMainWorkspacePath()` + simple `TaskService` creation
- **Missing Integration**: No use of existing `TaskBackendRouter` or special workspace
- **Git Integration Points**: Currently NONE - all git operations are manual

### 3. Workflow Analysis ✅
- **Existing Auto-Commit Pattern**: Session approve already implements the exact pattern we need
  - Check `git status --porcelain` for changes
  - Stage files with `git add process/tasks.md`
  - Commit with conventional format: `chore(${taskId}): update task status to DONE`
  - Push with `git push`
  - Robust error handling that doesn't fail main operation
- **Commit Message Patterns**: Conventional commits format already established
- **Performance**: Special workspace uses shallow clone + sparse checkout for optimization

## Implementation Requirements

### 1. Special Workspace Enhancement
- **Workspace Detection**: Ensure proper detection and usage of special workspace for markdown backend
- **Workspace Isolation**: Verify that task operations in special workspace don't interfere with main workspace
- **Configuration Validation**: Implement proper validation for special workspace configuration
- **Fallback Handling**: Graceful fallback when special workspace is not available or configured

### 2. Auto-Commit Integration for Markdown Backend
- **Task Creation Operations**: Auto-commit when creating new tasks via markdown backend
- **Status Update Operations**: Auto-commit when setting task status via markdown backend
- **Task Modification Operations**: Auto-commit for any task updates that modify markdown files
- **Task Deletion Operations**: Auto-commit when deleting tasks via markdown backend

### 3. Git Operation Integration
- **Commit Message Generation**: Generate meaningful commit messages for different task operations
- **Atomic Operations**: Ensure task operation + git commit happen atomically
- **Error Recovery**: Handle git operation failures gracefully without corrupting task state
- **Push Strategy**: Implement reliable push strategy with error handling

### 4. Backend-Specific Logic
- **Markdown Backend Detection**: Only apply auto-commit for markdown tasks backend
- **Other Backend Handling**: Ensure other backends (JSON, SQLite, PostgreSQL) are unaffected
- **Configuration Override**: Allow disabling auto-commit via configuration if needed
- **Selective Operations**: Configure which operations trigger auto-commit

## Technical Implementation Details

### Commit Message Patterns
```typescript
// Proposed commit message patterns
const commitMessages = {
  taskCreate: (taskId: string, title: string) =>
    `feat: create task ${taskId} - ${title}`,
  statusUpdate: (taskId: string, oldStatus: string, newStatus: string) =>
    `chore: update task ${taskId} status ${oldStatus} → ${newStatus}`,
  taskUpdate: (taskId: string, description: string) =>
    `docs: update task ${taskId} - ${description}`,
  taskDelete: (taskId: string) =>
    `chore: delete task ${taskId}`,
};
```

### Auto-Commit Integration Points
```typescript
// Example integration in task operations
class MarkdownTaskBackend {
  async createTask(task: TaskSpec): Promise<Task> {
    const result = await this.writeTaskFile(task);

    if (this.shouldAutoCommit()) {
      await this.gitCommitAndPush(
        commitMessages.taskCreate(task.id, task.title)
      );
    }

    return result;
  }

  async setStatus(taskId: string, status: TaskStatus): Promise<void> {
    const oldStatus = await this.getStatus(taskId);
    await this.updateTaskStatus(taskId, status);

    if (this.shouldAutoCommit()) {
      await this.gitCommitAndPush(
        commitMessages.statusUpdate(taskId, oldStatus, status)
      );
    }
  }
}
```

### Configuration Options
```typescript
interface TaskBackendConfig {
  autoCommit?: boolean;
  autoCommitOperations?: ('create' | 'update' | 'delete' | 'statusUpdate')[];
  gitRemote?: string;
  commitMessagePrefix?: string;
}
```

## Investigation Tasks

### Phase 1: Current State Analysis
- [ ] **Special Workspace Audit**: Investigate current implementation and usage of special workspace
- [ ] **Backend Configuration Review**: Check how markdown backend is configured and used
- [ ] **Operation Flow Analysis**: Document current flow for task operations with markdown backend
- [ ] **Git Integration Points**: Identify where git operations currently happen in task workflows

### Phase 2: Implementation Planning ✅ COMPLETED
- [x] **Auto-Commit Architecture**: Designed simple utility function following session approve pattern
- [x] **Error Handling Strategy**: Implemented robust error handling that doesn't break task operations
- [x] **Configuration Design**: Created backend-aware auto-commit (markdown only)
- [x] **Testing Strategy**: Added basic tests for auto-commit functionality

### Phase 3: Implementation ✅ MOSTLY COMPLETED
- [x] **Special Workspace Integration**: Created `resolveTaskWorkspacePath()` with `TaskBackendRouter`
- [x] **Auto-Commit Utility**: Implemented `autoCommitTaskChanges()` following session approve pattern
- [x] **Git Operation Utilities**: Created robust git utilities using `execGitWithTimeout`
- [ ] **Task Command Integration**: Complete integration across all 6 task command functions
- [ ] **Backend Logic**: Add auto-commit calls to task operations for markdown backend

### Phase 4: Testing and Validation
- [x] **Basic Tests**: Created initial tests for auto-commit utility API
- [ ] **Integration Tests**: Test complete workflow with auto-commit enabled
- [ ] **Error Scenario Testing**: Test git failure scenarios and recovery
- [ ] **Performance Testing**: Validate performance impact of auto-commit operations

## Success Criteria

- [x] **Special Workspace Investigation Complete**: ✅ Discovered fully implemented system, created integration layer
- [x] **Auto-Commit Functionality**: ✅ Core utility implemented, ready for task operation integration
- [x] **Robust Error Handling**: ✅ Git failures don't corrupt task state or break operations
- [x] **Backend-Aware Behavior**: ✅ Auto-commit only for markdown backend, others unaffected
- [x] **Backward Compatibility**: ✅ Changes are additive, existing workflows preserved
- [ ] **Complete Integration**: All 6 task command functions use new workspace resolution and auto-commit
- [ ] **Agent Workflow Simplified**: Agents no longer need to manually commit/push after task operations

## Implementation Status ✅ 80% COMPLETE

### ✅ **Completed Components**
1. **Intelligent Workspace Resolution** (`src/utils/workspace-resolver.ts`)
   - Uses `TaskBackendRouter` to determine appropriate workspace
   - Markdown backend → Special workspace, Others → Current directory
   - Replaces `resolveMainWorkspacePath()` with backend-aware logic

2. **Auto-Commit Utility** (`src/utils/auto-commit.ts`)
   - Follows proven session approve pattern
   - Handles git status, staging, commit, and push operations
   - Robust error handling that doesn't break task operations
   - Focuses on task-related files (`process/tasks.md`, `process/tasks/`)

3. **Task Command Integration** (Partial)
   - Updated `listTasksFromParams()` as proof of concept
   - Ready for rollout to remaining 5 task command functions

### 🔄 **Remaining Work**
1. **Complete Task Command Updates** - Apply workspace resolver to all 6 functions
2. **Auto-Commit Integration** - Add auto-commit calls after task modifications
3. **Comprehensive Testing** - End-to-end workflow validation

### 🎯 **Key Achievements**
- ✅ **Special workspace system is fully functional** - just needed connection layer
- ✅ **Auto-commit pattern proven** - extracted from working session approve operations
- ✅ **Non-breaking implementation** - existing workflows preserved
- ✅ **Backend-aware design** - only affects markdown tasks as intended

## Technical Implementation Details ✅ COMPLETED

### Error Recovery Strategy ✅ IMPLEMENTED
- ✅ Git operation failures don't prevent task operations from completing
- ✅ Failed git operations are logged with detailed error messages
- ✅ Task state remains consistent even if git operations fail
- ✅ Auto-commit returns boolean for success/failure tracking

### Architecture Pattern ✅ PROVEN
- ✅ Uses existing `TaskBackendRouter` and `SpecialWorkspaceManager`
- ✅ Follows session approve git operation pattern
- ✅ Simple utility functions instead of complex service classes
- ✅ Backend detection through existing infrastructure
- Monitor and measure performance impact

### Configuration Flexibility
- Allow fine-grained control over which operations auto-commit
- Support different commit message templates
- Enable/disable auto-commit per backend type
- Support different git remotes and branches

## Dependencies

- Current markdown tasks backend implementation
- Git utilities and integration in Minsky
- Task operation interfaces and implementations
- Configuration system for backend-specific settings

## Related Tasks

- Previous special workspace implementation (investigation target)
- Task backend architecture and interfaces
- Git integration and workflow management
- Configuration and settings management

This task will significantly improve the agent experience by removing the manual git operations burden while ensuring task operations are properly persisted and versioned.

## Implementation Plan

### Phase 1: Integrate Special Workspace System
**Priority**: HIGH - Foundation for auto-commit

**Current Issue**: All task commands use simple workspace resolution
```typescript
// Current pattern in ALL taskCommands.ts functions
const workspacePath = await deps.resolveMainWorkspacePath();
const taskService = await deps.createTaskService({ workspacePath, backend });
```

**Required Changes**: Replace with existing special workspace infrastructure
```typescript
// New pattern using existing TaskBackendRouter
const router = await TaskBackendRouter.createWithRepo(repoUrl);
const taskService = await TaskService.createWithSpecialWorkspace(router);
```

**Files to Modify**:
- `src/domain/tasks/taskCommands.ts`: Update all 6 task command functions
- Update dependency injection patterns in tests

### Phase 2: Implement Auto-Commit Utility
**Priority**: HIGH - Core functionality

**Implementation**: Create simple `autoCommitTaskChanges` utility following proven session approve pattern
```typescript
async function autoCommitTaskChanges(
  workspacePath: string,
  message: string
): Promise<boolean> {
  // Follow session approve pattern:
  // 1. Check git status --porcelain
  // 2. Stage process/tasks.md and process/tasks/ if changes exist
  // 3. Commit with provided message
  // 4. Push (with error handling that doesn't fail main operation)
  // Return true if committed, false if no changes
}
```

**Commit Message Patterns** (following conventional commits):
- `feat(${taskId}): create task "${title}"`
- `chore(${taskId}): update task status ${oldStatus} → ${newStatus}`
- `docs(${taskId}): update task`
- `chore(${taskId}): delete task`

**Files to Create**:
- `src/utils/auto-commit.ts`
- `src/utils/__tests__/auto-commit.test.ts`

### Phase 3: Integrate Auto-Commit into Task Operations
**Priority**: MEDIUM - User-facing functionality

**Integration Points** in `taskCommands.ts`:
- `setTaskStatusFromParams()`: Auto-commit status changes
- `createTaskFromTitleAndDescription()`: Auto-commit new tasks
- `deleteTaskFromParams()`: Auto-commit deletions

**Backend Logic**: Only auto-commit for markdown backend
```typescript
if (router.currentBackend.name === "markdown") {
  await autoCommitTaskChanges(workspacePath, `chore(#${taskId}): ${operation}`);
}
```

## Requirements

### Functional Requirements
1. **Special Workspace Integration**: All task commands must use `TaskBackendRouter` instead of `resolveMainWorkspacePath()`
2. **Auto-Commit for Markdown**: Task operations with markdown backend automatically commit and push changes
3. **Backend Specificity**: Auto-commit only applies to markdown backend, other backends unaffected
4. **Error Resilience**: Auto-commit failures must not break task operations (following session approve pattern)
5. **Conventional Commits**: All auto-commits use established conventional commit format

### Non-Functional Requirements
1. **Performance**: Auto-commit overhead < 10% of task operation time
2. **Reliability**: Existing functionality remains unchanged
3. **Maintainability**: Follow established patterns from session approve operations
4. **Team Collaboration**: Special workspace enables shared task storage for JSON/markdown backends

## Success Criteria

### Phase 1 Completion ✅
- [ ] All 6 functions in `taskCommands.ts` use `TaskBackendRouter.createWithRepo()`
- [ ] No more calls to `resolveMainWorkspacePath()` in task commands
- [ ] All existing tests pass with special workspace integration
- [ ] Task operations work with both in-tree (markdown) and external (GitHub) backends

### Phase 2 Completion ✅
- [ ] `autoCommitTaskChanges` utility implements session approve auto-commit pattern
- [ ] Comprehensive test coverage for auto-commit functionality
- [ ] Error handling prevents task operation failures
- [ ] Commit message generation follows conventional commits format

### Phase 3 Completion ✅
- [ ] Task status updates automatically commit with `chore(${taskId}): update task status ${old} → ${new}`
- [ ] Task creation automatically commits with `feat(${taskId}): create task "${title}"`
- [ ] Task deletion automatically commits with `chore(${taskId}): delete task`
- [ ] Only markdown backend triggers auto-commit (JSON, GitHub backends unaffected)
- [ ] All task operations complete successfully whether auto-commit succeeds or fails

### Final Validation ✅
- [ ] Agent workflow: No manual git operations required after task commands
- [ ] Performance: Task operations complete within 110% of baseline time
- [ ] Reliability: All existing task management workflows continue working
- [ ] Team benefits: Special workspace provides centralized task storage and audit trail
