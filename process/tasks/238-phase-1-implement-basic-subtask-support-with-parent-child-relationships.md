# Phase 1: Implement Basic Subtask Support with Parent-Child Relationships

## Status

BACKLOG

## Priority

MEDIUM

## Description

# Phase 1: Implement Basic Subtask Support with Parent-Child Relationships

Implement foundational subtask support in Minsky's task management system, enabling explicit parent-child task relationships while maintaining full backward compatibility with existing workflows.

## Parent Task

This is Phase 1 of Task #237: Implement Hierarchical Task System with Subtasks and Dependencies

## Objectives

1. **Extend Task Data Model**: Add parent/child relationship fields to TaskData
2. **Backend Support**: Update all task backends to handle hierarchical data
3. **CLI Commands**: Add subtask management commands
4. **Backward Compatibility**: Ensure existing workflows continue unchanged
5. **AI Integration**: Connect with Task #175 AI decomposition for automatic subtask creation

## Technical Requirements

### 1. Data Model Extension

```typescript
interface TaskData {
  // ... existing fields
  parentTaskId?: string; // Parent task ID (if this is a subtask)
  subtaskIds?: string[]; // Array of child task IDs
  taskLevel?: number; // Depth in hierarchy (0 = root task)
  hierarchyPath?: string; // Full path from root (e.g., '#001.#002.#003')
}
```

### 2. Backend Updates

- **MarkdownTaskBackend**: Support hierarchical task representation in tasks.md
- **JsonFileTaskBackend**: Store parent/child relationships in JSON structure
- **GitHubIssuesTaskBackend**: Use GitHub issue relationships for hierarchy

### 3. CLI Command Extensions

```bash
# Create subtask
minsky tasks create-subtask <parent-task-id> --title "Subtask Title" --description "..."

# List tasks with hierarchy
minsky tasks list --hierarchical
minsky tasks list --parent <task-id>   # Show subtasks of specific parent

# Task management
minsky tasks move <task-id> --parent <new-parent-id>
minsky tasks detach <task-id>          # Remove from parent (make root-level)
```

### 4. Enhanced Task Display

- Show task hierarchy in `tasks list` with indentation
- Include parent/child information in `tasks get` output
- Support filtering by hierarchy level

### 5. AI Integration (Building on Task #175)

- `minsky tasks decompose <task-id>` creates actual subtasks (not just suggestions)
- AI-generated subtasks maintain proper parent-child relationships
- Integration with existing AI estimation capabilities

## Implementation Steps

### Step 1: Data Model & Types

- [ ] Update TaskData interface with hierarchy fields
- [ ] Add validation for parent-child relationships
- [ ] Create utility functions for hierarchy operations
- [ ] Add hierarchy-specific error types

### Step 2: Backend Implementation

- [ ] Update MarkdownTaskBackend for hierarchical tasks
- [ ] Extend JsonFileTaskBackend with parent/child storage
- [ ] Implement hierarchy support in GitHubIssuesTaskBackend
- [ ] Add migration utilities for existing tasks

### Step 3: Core Domain Logic

- [ ] Implement hierarchy validation (prevent cycles, orphans)
- [ ] Add functions for hierarchy traversal and querying
- [ ] Create subtask creation/management logic
- [ ] Implement hierarchy-aware task status propagation

### Step 4: CLI Commands

- [ ] Add `create-subtask` command
- [ ] Extend `list` command with hierarchy options
- [ ] Update `get` command to show hierarchy information
- [ ] Add `move` and `detach` commands for hierarchy management

### Step 5: AI Integration

- [ ] Extend Task #175 decompose command to create actual subtasks
- [ ] Update AI prompts to understand task hierarchy context
- [ ] Add hierarchy-aware task analysis capabilities

### Step 6: Testing & Documentation

- [ ] Comprehensive test suite for hierarchy operations
- [ ] Migration testing for existing task workflows
- [ ] Update documentation with hierarchy examples
- [ ] Backward compatibility verification

## Acceptance Criteria

### Core Functionality

- [ ] Users can create subtasks with explicit parent relationships
- [ ] Task listing shows hierarchical structure with proper indentation
- [ ] All existing task workflows function without modification
- [ ] Parent task status reflects subtask completion state

### AI Integration

- [ ] `minsky tasks decompose` automatically creates subtasks with proper relationships
- [ ] AI can analyze tasks with hierarchy context
- [ ] Subtask generation maintains consistency with parent task scope

### Data Integrity

- [ ] Hierarchy relationships are validated and consistent
- [ ] No circular dependencies in task relationships
- [ ] Task deletion properly handles orphaned subtasks
- [ ] Backend migrations preserve existing task data

### User Experience

- [ ] Hierarchy visualization is clear and intuitive
- [ ] Commands follow existing Minsky CLI patterns
- [ ] Error messages are helpful for hierarchy violations
- [ ] Performance remains good with large task hierarchies

## Dependencies

- Task #175: Add AI-powered task management subcommands (for AI integration)
- Requires understanding of existing task backend architecture

## Future Compatibility

This implementation sets the foundation for:

- Phase 2: Task dependencies and graph relationships
- Phase 3: Planning vs execution separation
- Phase 4: Advanced visualization and workflow features

## Estimated Effort

Medium-Large (6-10 hours)

- Data model changes are straightforward
- Backend updates require careful testing
- CLI command additions follow existing patterns
- AI integration builds on established foundation


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
