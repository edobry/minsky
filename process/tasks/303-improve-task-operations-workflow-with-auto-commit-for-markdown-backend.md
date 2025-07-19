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

## Research Phase

### 1. Special Workspace Investigation
- **Current Implementation Status**: Investigate if the special workspace for markdown tasks backend is implemented and functioning
- **Usage Analysis**: Determine if this workspace is actually being used in practice
- **Code Audit**: Review the codebase to understand how the special workspace was intended to work
- **Configuration Check**: Verify if special workspace is properly configured and enabled

### 2. Current Task Operations Audit
- **Operation Inventory**: Catalog all task operations that modify files (create, status set, update, delete)
- **Backend Analysis**: Identify which operations specifically affect the markdown tasks backend
- **Git Integration Points**: Map where git operations could be integrated into task workflows
- **Current Pain Points**: Document where manual commit/push steps are currently required

### 3. Workflow Analysis
- **Agent Workflow Patterns**: Analyze how agents currently interact with task operations
- **Commit Message Patterns**: Review existing commit messages for task operations to establish patterns
- **Error Scenarios**: Identify potential failure modes for auto-commit functionality
- **Performance Considerations**: Assess impact of auto-commit on task operation performance

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

### Phase 2: Implementation Planning
- [ ] **Auto-Commit Architecture**: Design integration points for auto-commit functionality
- [ ] **Error Handling Strategy**: Plan robust error handling for git operations
- [ ] **Configuration Design**: Design configuration options for auto-commit behavior
- [ ] **Testing Strategy**: Plan comprehensive testing for auto-commit functionality

### Phase 3: Implementation
- [ ] **Special Workspace Fixes**: Address any issues with special workspace functionality
- [ ] **Auto-Commit Integration**: Implement auto-commit for task operations
- [ ] **Git Operation Utilities**: Create robust git utilities for task operations
- [ ] **Configuration Integration**: Add configuration options for auto-commit behavior

### Phase 4: Testing and Validation
- [ ] **Unit Tests**: Comprehensive tests for auto-commit functionality
- [ ] **Integration Tests**: Test complete workflow with auto-commit enabled
- [ ] **Error Scenario Testing**: Test git failure scenarios and recovery
- [ ] **Performance Testing**: Validate performance impact of auto-commit operations

## Success Criteria

- [ ] **Special Workspace Investigation Complete**: Clear understanding of current state and any issues
- [ ] **Auto-Commit Functionality**: All task operations with markdown backend auto-commit and push
- [ ] **Robust Error Handling**: Git failures don't corrupt task state or break operations
- [ ] **Configurable Behavior**: Auto-commit can be enabled/disabled and configured per operation type
- [ ] **Backward Compatibility**: Changes don't break existing task operation workflows
- [ ] **Performance Maintained**: Auto-commit doesn't significantly impact task operation performance
- [ ] **Agent Workflow Simplified**: Agents no longer need to manually commit/push after task operations

## Technical Considerations

### Error Recovery Strategy
- Git operation failures should not prevent task operations from completing
- Failed git operations should be logged and potentially retried
- Task state should remain consistent even if git operations fail
- Clear error messages for git-related failures

### Performance Optimization
- Batch multiple rapid task operations to avoid excessive commits
- Optimize git operations for speed (shallow operations where possible)
- Consider debouncing for rapid successive operations
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

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
