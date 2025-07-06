# Phase 2: Implement Task Dependencies and Basic Task Graphs

## Status

BACKLOG

## Priority

MEDIUM

## Description

# Phase 2: Implement Task Dependencies and Basic Task Graphs

Extend Minsky's hierarchical task system to support task dependencies and basic task graph relationships, enabling sophisticated workflow modeling and dependency-aware execution planning.

## Parent Task

This is Phase 2 of Task #237: Implement Hierarchical Task System with Subtasks and Dependencies

## Dependencies

- Task #238: Phase 1: Implement Basic Subtask Support with Parent-Child Relationships

## Objectives

1. **Task Dependencies**: Enable tasks to depend on other tasks regardless of hierarchy
2. **Dependency Validation**: Prevent circular dependencies and orphaned relationships
3. **Workflow Visualization**: Basic text-based task graph visualization
4. **Dependency-Aware Operations**: Task listing, status updates, and execution planning
5. **AI Integration**: Leverage AI for dependency analysis and suggestion

## Technical Requirements

### 1. Extended Data Model

```typescript
interface TaskData {
  // ... existing fields from Phase 1
  dependsOn?: string[]; // Tasks this task depends on
  blockedBy?: string[]; // Tasks blocking this task (derived)
  blocking?: string[]; // Tasks this task is blocking (derived)
  dependencies?: {
    prerequisite: string[]; // Must complete before this task starts
    related: string[]; // Related but not blocking
    optional: string[]; // Can start without, but benefits from completion
  };
}
```

### 2. Dependency Management

- **Dependency Types**: Prerequisite (blocking), related (informational), optional (beneficial)
- **Cycle Detection**: Prevent circular dependency chains
- **Dependency Resolution**: Calculate transitive dependencies and critical paths
- **Status Propagation**: Automatic status updates based on dependency completion

### 3. Enhanced CLI Commands

```bash
# Dependency management
minsky tasks add-dependency <task-id> --depends-on <dependency-task-id> [--type prerequisite|related|optional]
minsky tasks remove-dependency <task-id> --dependency <dependency-task-id>
minsky tasks list-dependencies <task-id>

# Dependency-aware listing
minsky tasks list --ready-to-start        # Tasks with no unmet dependencies
minsky tasks list --blocked               # Tasks waiting on dependencies
minsky tasks list --critical-path        # Tasks on the critical path

# Workflow analysis
minsky tasks analyze-dependencies [--task-id <id>]
minsky tasks suggest-order               # AI-suggested task execution order
```

### 4. Dependency Visualization

- **ASCII Graph**: Simple text-based dependency visualization
- **Dependency Tree**: Show dependency chains for specific tasks
- **Critical Path**: Highlight the longest dependency chain
- **Blocking Analysis**: Show which tasks are blocking others

### 5. AI-Enhanced Dependency Management

- **Dependency Analysis**: AI suggests potential dependencies based on task content
- **Workflow Optimization**: AI recommends optimal task ordering
- **Risk Assessment**: AI identifies potential workflow bottlenecks
- **Dependency Validation**: AI helps validate proposed dependency relationships

## Implementation Steps

### Step 1: Dependency Data Model

- [ ] Extend TaskData interface with dependency fields
- [ ] Create dependency validation logic (cycle detection)
- [ ] Add dependency relationship types and metadata
- [ ] Implement dependency calculation functions (transitive, critical path)

### Step 2: Backend Updates

- [ ] Update all task backends to store dependency relationships
- [ ] Add dependency migration utilities for existing tasks
- [ ] Implement dependency-aware task querying
- [ ] Add dependency integrity validation

### Step 3: Dependency Management Logic

- [ ] Implement dependency addition/removal operations
- [ ] Add cycle detection and prevention
- [ ] Create dependency graph traversal algorithms
- [ ] Implement critical path calculation

### Step 4: CLI Command Extensions

- [ ] Add dependency management commands
- [ ] Extend list command with dependency filtering
- [ ] Implement dependency analysis commands
- [ ] Add workflow ordering suggestions

### Step 5: Visualization & Analysis

- [ ] Create ASCII dependency graph renderer
- [ ] Implement dependency tree visualization
- [ ] Add critical path highlighting
- [ ] Create blocking relationship analysis

### Step 6: AI Integration

- [ ] Develop dependency suggestion AI prompts
- [ ] Implement workflow analysis with AI
- [ ] Add dependency validation using AI
- [ ] Create intelligent task ordering recommendations

### Step 7: Testing & Documentation

- [ ] Comprehensive dependency relationship testing
- [ ] Cycle detection and prevention testing
- [ ] Performance testing with large dependency graphs
- [ ] Documentation with workflow examples

## Acceptance Criteria

### Core Functionality

- [ ] Tasks can have multiple dependency types (prerequisite, related, optional)
- [ ] Dependency relationships are validated and prevent cycles
- [ ] Task listing supports dependency-aware filtering
- [ ] Critical path calculation works correctly

### Workflow Management

- [ ] Users can visualize task dependencies as ASCII graphs
- [ ] Dependency-aware task ordering is available
- [ ] Blocked and ready-to-start tasks are clearly identified
- [ ] Status changes propagate appropriately through dependencies

### AI Integration

- [ ] AI can suggest dependencies based on task content
- [ ] AI provides workflow optimization recommendations
- [ ] AI helps validate dependency relationships
- [ ] AI-suggested task ordering considers dependencies and priorities

### Data Integrity

- [ ] Circular dependencies are prevented
- [ ] Dependency relationships are maintained during task operations
- [ ] Task deletion properly handles dependency cleanup
- [ ] Performance remains good with complex dependency graphs

## Technical Considerations

### Graph Algorithms

- Implement efficient cycle detection (DFS-based)
- Use topological sorting for dependency ordering
- Calculate critical path using longest path algorithms
- Optimize for large graphs with caching

### Dependency Types

- **Prerequisite**: Hard dependency, task cannot start until dependency completes
- **Related**: Informational dependency, helpful context but not blocking
- **Optional**: Soft dependency, task can start but benefits from dependency completion

### Status Propagation Rules

- Parent tasks remain in-progress while subtasks are incomplete
- Prerequisites must be completed before dependent tasks can start
- Optional dependencies provide context but don't block execution

## Future Integration Points

This phase prepares for:

- **Phase 3**: Planning vs execution separation with dependency-aware planning
- **Phase 4**: Advanced visualization with interactive dependency graphs
- **External Tools**: Integration with project management platforms

## Estimated Effort

Large (8-12 hours)

- Dependency graph algorithms require careful implementation
- Visualization features add complexity
- AI integration requires prompt engineering
- Extensive testing needed for graph operations


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
