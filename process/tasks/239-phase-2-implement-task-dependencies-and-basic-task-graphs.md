# Phase 2: Implement Task Dependencies and Basic Task Graphs

## Status

TODO

## Priority

MEDIUM

## Parent Task

Part of [Task #237: Implement Hierarchical Task System with Subtasks and Dependencies](process/tasks/237-implement-hierarchical-task-system-with-subtasks-and-dependencies.md)

## Summary

Add dependency relationships between tasks, implement cycle detection, and create dependency-aware task operations. This builds on Phase 1's hierarchical foundation to support complex task graphs and workflow sequencing.

## Context & Dependencies

### Prerequisites

- **Task #238 (Phase 1)**: Basic subtask support must be completed
- **Task #175**: AI-powered task decomposition provides intelligent dependency analysis
- **Multi-backend architecture**: Existing foundation supports dependency storage

### Building on Phase 1

- Extends hierarchical TaskData model with dependency relationships
- Leverages established backend abstraction for dependency storage
- Builds on Phase 1 CLI patterns for consistency
- Uses Phase 1 validation framework for dependency validation

## Requirements

### 1. Data Model Extensions

#### 1.1 Extend TaskData with Dependencies

```typescript
interface TaskData {
  // ... existing fields from Phase 1

  // Dependency relationships
  dependencies?: {
    // Tasks that must be completed before this task can start
    prerequisite?: string[]; // "blocked by" - hard dependencies

    // Tasks that should ideally be completed first but aren't required
    optional?: string[]; // "ideally after" - soft dependencies

    // Related tasks that inform this one but don't block it
    related?: string[]; // "see also" - informational links

    // Tasks that this task blocks (computed from other tasks' dependencies)
    blocks?: string[]; // "blocks" - computed field
  };

  // Enhanced metadata for dependency context
  metadata?: {
    // ... existing metadata from Phase 1

    // Dependency analysis metadata
    dependencyDepth?: number; // How many levels deep in dependency chain
    criticalPath?: boolean; // Whether this task is on the critical path
    dependencyStatus?: "ready" | "blocked" | "partial"; // Computed status

    // AI-generated dependency insights
    dependencyReason?: Record<string, string>; // Why each dependency exists
    suggestedDependencies?: string[]; // AI-suggested dependencies
  };
}
```

#### 1.2 Dependency Graph Types

```typescript
interface DependencyGraph {
  nodes: TaskNode[];
  edges: DependencyEdge[];
  cycles?: TaskCycle[];
  criticalPath?: string[];
}

interface TaskNode {
  taskId: string;
  task: TaskData;
  dependencyDepth: number;
  readyToStart: boolean;
  blockedBy: string[];
}

interface DependencyEdge {
  fromTaskId: string;
  toTaskId: string;
  type: "prerequisite" | "optional" | "related";
  reason?: string;
}

interface TaskCycle {
  taskIds: string[];
  path: DependencyEdge[];
  severity: "blocking" | "warning";
}
```

### 2. Core Domain Operations

#### 2.1 Dependency Management Functions

```typescript
// Pure dependency operations
function addDependency(
  tasks: TaskData[],
  taskId: string,
  dependencyId: string,
  type: DependencyType
): TaskData[];
function removeDependency(tasks: TaskData[], taskId: string, dependencyId: string): TaskData[];
function getDependencies(tasks: TaskData[], taskId: string, type?: DependencyType): string[];
function getBlockedTasks(tasks: TaskData[], taskId: string): string[];
function isTaskReady(tasks: TaskData[], taskId: string): boolean;

// Graph analysis operations
function buildDependencyGraph(tasks: TaskData[]): DependencyGraph;
function detectCycles(tasks: TaskData[]): TaskCycle[];
function findCriticalPath(tasks: TaskData[], startTaskId?: string): string[];
function getTopologicalOrder(tasks: TaskData[]): string[];
function getDependencyDepth(tasks: TaskData[], taskId: string): number;

// Validation operations
function validateDependencies(tasks: TaskData[]): ValidationResult[];
function validateNewDependency(
  tasks: TaskData[],
  taskId: string,
  dependencyId: string
): ValidationResult;

type DependencyType = "prerequisite" | "optional" | "related";
```

#### 2.2 Dependency Validation

- **Cycle Detection**: Prevent circular dependencies that would create deadlocks
- **Hierarchy Compatibility**: Ensure dependencies work with parent-child relationships
- **Cross-Hierarchy Dependencies**: Support dependencies between different task hierarchies
- **Status Consistency**: Validate that dependency status makes logical sense

### 3. CLI Command Extensions

#### 3.1 New Dependency Commands

```bash
# Add dependencies between tasks
minsky tasks add-dependency <task-id> --prerequisite <dep-id> [--reason "explanation"]
minsky tasks add-dependency <task-id> --optional <dep-id> [--reason "explanation"]
minsky tasks add-dependency <task-id> --related <dep-id> [--reason "explanation"]

# Remove dependencies
minsky tasks remove-dependency <task-id> <dep-id>

# List dependencies for a task
minsky tasks dependencies <task-id> [--type prerequisite|optional|related] [--show-blocked]

# Analyze dependency graph
minsky tasks graph [--start <task-id>] [--format text|json] [--show-cycles]
minsky tasks critical-path [--start <task-id>] [--end <task-id>]

# Find ready tasks (no blocking dependencies)
minsky tasks list --ready [--include-optional]

# Validate dependency graph
minsky tasks validate-dependencies [--fix-cycles]
```

#### 3.2 Enhanced Task Listing with Dependencies

```bash
# Show tasks with dependency indicators
minsky tasks list --show-dependencies
# Output:
# - #001: Setup Database [TODO]
# - #002: Create API [TODO] ← depends on #001
#   └─ #003: API Tests [TODO] ← depends on #002 (parent)
# - #004: Frontend [BLOCKED] ← depends on #002
# ⚠️  #005: Deploy [TODO] ← circular dependency detected

# Filter by dependency status
minsky tasks list --status-type ready        # Tasks ready to start
minsky tasks list --status-type blocked      # Tasks blocked by dependencies
minsky tasks list --status-type partial      # Tasks with some dependencies completed
```

### 4. AI Integration Enhancement

#### 4.1 Intelligent Dependency Analysis

```bash
# AI-powered dependency analysis
minsky tasks analyze-dependencies <task-id>
# Suggests prerequisite, optional, and related dependencies

# Batch dependency analysis for project
minsky tasks analyze-dependencies --all [--apply-suggestions]

# Dependency reasoning
minsky tasks explain-dependency <task-id> <dep-id>
# AI explains why dependency relationship exists or should exist
```

#### 4.2 Workflow Optimization

- AI analyzes dependency graphs for optimization opportunities
- Suggests parallel task execution paths
- Identifies bottlenecks and critical path tasks
- Recommends task decomposition to reduce dependencies

### 5. Backend Implementation Updates

#### 5.1 Backend Capability Extensions

```typescript
interface TaskBackend {
  // ... existing methods

  // Dependency-specific operations (optional)
  supportsDependencies?(): boolean;
  addTaskDependency?(
    taskId: string,
    dependencyId: string,
    type: DependencyType
  ): Promise<TaskWriteOperationResult>;
  removeTaskDependency?(taskId: string, dependencyId: string): Promise<TaskWriteOperationResult>;
  getDependencyGraph?(): Promise<TaskReadOperationResult>;
}
```

#### 5.2 Backend-Specific Implementation

- **JSON Backend**: Store dependencies in task metadata with efficient querying
- **Markdown Backend**: Use YAML frontmatter for dependencies, link references in content
- **GitHub Backend**: Leverage issue relationships, linked issues, and project boards

### 6. Graph Visualization

#### 6.1 ASCII Graph Visualization

```bash
minsky tasks graph #001
# Output:
#     #001 (Setup)
#        ↓
#     #002 (API) ← #004 (Config)
#        ↓
#     #003 (Tests)
#        ↓
#     #005 (Deploy)
#
# Legend: → prerequisite, ⇢ optional, ~ related
```

#### 6.2 Dependency Analysis Output

```bash
minsky tasks critical-path
# Output:
# Critical Path (4 tasks, est. 12 hours):
# #001 (Setup) → #002 (API) → #003 (Tests) → #005 (Deploy)
#
# Parallel Opportunities:
# #004 (Config) can run parallel to #001-#002
# #006 (Docs) can run parallel to #003
```

### 7. Advanced Dependency Features

#### 7.1 Conditional Dependencies

```typescript
// Future enhancement - conditional dependencies based on task outcomes
interface ConditionalDependency {
  condition: "success" | "failure" | "skipped";
  targetTaskId: string;
  dependencyType: DependencyType;
}
```

#### 7.2 Time-Based Dependencies

```typescript
// Future enhancement - time-based dependency relationships
interface TimeDependency {
  delay: string; // '2 days', '1 week', etc.
  type: "start-to-start" | "finish-to-start" | "start-to-finish" | "finish-to-finish";
}
```

## Implementation Plan

### Step 1: Core Dependency Model (Week 1)

- [ ] Extend TaskData interface with dependency fields
- [ ] Implement dependency management functions
- [ ] Add dependency validation and cycle detection
- [ ] Create comprehensive unit tests

### Step 2: Graph Analysis Engine (Week 1-2)

- [ ] Implement dependency graph building
- [ ] Add cycle detection algorithms
- [ ] Create critical path analysis
- [ ] Add topological sorting for task ordering

### Step 3: Backend Integration (Week 2)

- [ ] Update all backends to support dependency storage
- [ ] Implement backend-specific dependency features
- [ ] Add migration for existing tasks
- [ ] Ensure cross-backend dependency consistency

### Step 4: CLI Commands (Week 2-3)

- [ ] Implement dependency management commands
- [ ] Add graph analysis and visualization commands
- [ ] Update task listing with dependency indicators
- [ ] Create dependency validation tools

### Step 5: AI Integration (Week 3)

- [ ] Integrate dependency analysis with AI backend
- [ ] Add intelligent dependency suggestion
- [ ] Implement workflow optimization features
- [ ] Create dependency reasoning capabilities

### Step 6: Testing & Polish (Week 3-4)

- [ ] Comprehensive testing of dependency operations
- [ ] Performance testing with complex graphs
- [ ] Documentation and user guides
- [ ] Integration testing with Phase 1 features

## Success Criteria

### Functional Requirements

- [ ] Users can create and manage dependency relationships between tasks
- [ ] System prevents circular dependencies and provides clear error messages
- [ ] Dependency-aware task listing shows ready/blocked status
- [ ] Critical path analysis identifies project bottlenecks
- [ ] AI provides intelligent dependency suggestions

### Technical Requirements

- [ ] Dependency operations are efficient even with large task graphs
- [ ] All backends support dependency storage appropriately
- [ ] Graph algorithms handle edge cases (cycles, disconnected components)
- [ ] API maintains backward compatibility with Phase 1

### User Experience Requirements

- [ ] Clear visual indicators for dependency relationships
- [ ] Intuitive commands for dependency management
- [ ] Helpful analysis tools for understanding project workflow
- [ ] Smooth integration with existing task management practices

## Performance Considerations

### Graph Algorithm Optimization

- Efficient cycle detection (DFS-based)
- Cached critical path calculations
- Incremental graph updates
- Memory-efficient graph representation

### Database Query Optimization

- Indexed dependency lookups
- Bulk dependency operations
- Efficient graph traversal queries
- Minimal data transfer for graph operations

## Future Integration Points

### Phase 3 Preparation

- Data model supports planning vs execution task types
- Dependency system supports workflow checkpointing
- AI integration provides foundation for automated planning

### Advanced Workflow Features

- Integration with external project management tools
- Time-based project scheduling
- Resource allocation based on dependencies
- Automated workflow orchestration

## Risk Mitigation

### Complexity Management

- **Graph Complexity**: Limit maximum graph size and depth
- **User Complexity**: Provide simple dependency patterns and templates
- **Performance**: Benchmark testing with realistic task graphs

### Data Integrity

- **Dependency Consistency**: Comprehensive validation across all backends
- **Migration Safety**: Thorough testing of existing task conversion
- **Concurrent Updates**: Handle race conditions in dependency updates

## Estimated Effort

**8-12 hours** across 3-4 weeks with iterative development and testing

This phase significantly enhances Minsky's task management capabilities while maintaining the clean architecture and user experience established in Phase 1.
