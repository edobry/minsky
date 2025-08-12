# Phase 1: Implement Basic Subtask Support with Parent-Child Relationships

## Status

TODO

## Priority

HIGH

## Parent Task

Part of [Task #237: Implement Hierarchical Task System with Subtasks and Dependencies](process/tasks/237-implement-hierarchical-task-system-with-subtasks-and-dependencies.md)

## Summary

Implement basic subtask functionality with parent-child relationships while maintaining full backward compatibility with existing task workflows. This foundational phase enables explicit subtask relationships and integrates with Task #175 AI decomposition capabilities.

## Context & Dependencies

### Building on Existing Foundation

- **Task #175**: AI-powered task decomposition provides natural subtask creation
- **Multi-backend architecture**: TaskBackend interface supports extensible data models
- **Interface-agnostic design**: Command patterns support hierarchical operations
- **Existing TaskData interface**: Clean extension point for hierarchical fields

### Alignment with Minsky Architecture

- Follows Minsky's domain/adapter separation patterns
- Extends existing TaskService orchestration model
- Maintains compatibility with all current task backends
- Builds on established session-based workflow model

## Requirements

### 1. Data Model Extensions

#### 1.1 Extend TaskData Interface

```typescript
interface TaskData {
  // ... existing fields

  // Hierarchical fields (all optional for backward compatibility)
  parentTaskId?: string; // ID of parent task (null for root tasks)
  subtaskIds?: string[]; // Array of direct child task IDs
  taskLevel?: number; // Depth in hierarchy (0 = root, 1 = first level subtask, etc.)
  hierarchyPath?: string[]; // Full path from root to this task (for efficient queries)

  // Enhanced metadata
  metadata?: {
    // AI decomposition context
    decomposedFrom?: string; // Original task ID if created by AI decomposition
    decompositionReason?: string; // Why this subtask was created

    // Hierarchical metadata
    isSubtask?: boolean; // Explicit flag for subtask identification
    subtaskOrder?: number; // Order within parent's subtasks
    estimatedEffort?: string; // XS, S, M, L, XL from AI estimation

    // Extensibility
    [key: string]: any;
  };
}
```

#### 1.2 Backend Storage Support

- **Markdown Backend**: Extend frontmatter and nested list structures
- **JSON Backend**: Direct schema support with validation
- **GitHub Backend**: Use issue labels and linked issues for relationships

### 2. Core Domain Operations

#### 2.1 Subtask Management Functions

```typescript
// Core pure functions (no side effects)
function addSubtask(tasks: TaskData[], parentId: string, subtaskId: string): TaskData[];
function removeSubtask(tasks: TaskData[], parentId: string, subtaskId: string): TaskData[];
function moveSubtask(tasks: TaskData[], subtaskId: string, newParentId: string): TaskData[];
function getSubtasks(tasks: TaskData[], parentId: string): TaskData[];
function getParentTask(tasks: TaskData[], subtaskId: string): TaskData | null;
function getTaskHierarchy(tasks: TaskData[], rootId: string): HierarchyNode[];
function validateHierarchy(tasks: TaskData[]): ValidationResult[];

interface HierarchyNode {
  task: TaskData;
  children: HierarchyNode[];
  depth: number;
  path: string[];
}
```

#### 2.2 Hierarchy Validation

- Prevent circular references (task cannot be subtask of itself or descendants)
- Validate parent-child relationship consistency
- Ensure hierarchy path accuracy
- Validate subtask ordering and levels

### 3. CLI Command Extensions

#### 3.1 New Subtask Commands

```bash
# Create subtask under existing task
minsky tasks create-subtask <parent-task-id> --title "Subtask Title" [--description "..."]

# List tasks with hierarchical view
minsky tasks list --hierarchical [--depth <max-depth>] [--parent <parent-id>]

# Move subtask to different parent
minsky tasks move <subtask-id> --parent <new-parent-id>

# Detach subtask (make it a root task)
minsky tasks detach <subtask-id>

# Show task hierarchy starting from specific task
minsky tasks hierarchy <task-id> [--depth <max-depth>]
```

#### 3.2 Enhanced Existing Commands

```bash
# Enhanced task listing with hierarchy indicators
minsky tasks list --status TODO
# Output:
# - #001: Root Task [TODO]
#   └─ #002: Subtask A [TODO]
#      └─ #003: Sub-subtask [IN-PROGRESS]
#   └─ #004: Subtask B [TODO]

# Get task details with hierarchy context
minsky tasks get #002
# Shows: parent task, sibling subtasks, child subtasks

# Task creation with automatic parent detection (from AI decomposition)
minsky tasks create --parent <parent-id> --title "Generated Subtask"
```

### 4. AI Integration (Building on Task #175)

#### 4.1 Enhanced Decomposition

```bash
# AI decomposition with automatic subtask creation
minsky tasks decompose #001 --create-subtasks
# Result: Creates subtasks under #001 with proper hierarchy

# Estimate subtask complexity in context of parent
minsky tasks estimate #002 --include-hierarchy-context
```

#### 4.2 Intelligent Subtask Creation

- AI analyzes parent task and suggests logical decomposition
- Creates subtasks with appropriate metadata and relationships
- Maintains traceability from AI decomposition to task structure
- Supports iterative refinement of task breakdowns

### 5. Backend Implementation Updates

#### 5.1 TaskBackend Interface Extensions

```typescript
interface TaskBackend {
  // ... existing methods

  // Hierarchical operations (optional - only implemented if backend supports)
  supportsHierarchy?(): boolean;
  createSubtask?(parentId: string, subtaskData: TaskData): Promise<TaskWriteOperationResult>;
  moveTask?(taskId: string, newParentId: string | null): Promise<TaskWriteOperationResult>;
  getTaskHierarchy?(rootId: string): Promise<TaskReadOperationResult>;
}
```

#### 5.2 Backward Compatibility Strategy

- All hierarchical fields are optional in TaskData
- Existing tasks without hierarchy data continue to work normally
- Legacy task operations remain unchanged
- Gradual migration path for adding hierarchy to existing tasks

### 6. Testing Requirements

#### 6.1 Unit Tests

- TaskData extension compatibility
- Hierarchy validation functions
- Pure function correctness
- Backend compatibility across all implementations

#### 6.2 Integration Tests

- CLI command functionality
- AI decomposition integration
- Cross-backend hierarchy support
- Migration scenarios

#### 6.3 Backward Compatibility Tests

- Existing workflows continue to function
- Legacy task data remains valid
- No breaking changes to existing APIs

## Implementation Plan

### Step 1: Core Data Model (Week 1)

- [ ] Extend TaskData interface with hierarchical fields
- [ ] Implement hierarchy validation functions
- [ ] Add comprehensive unit tests for data model

### Step 2: Backend Updates (Week 1-2)

- [ ] Update JSON backend with hierarchy support
- [ ] Extend markdown backend parsing/formatting
- [ ] Add GitHub backend issue linking support
- [ ] Ensure backward compatibility across all backends

### Step 3: Domain Service Integration (Week 2)

- [ ] Extend TaskService with hierarchy operations
- [ ] Add subtask management functions
- [ ] Integrate with existing task creation/updating flows

### Step 4: CLI Commands (Week 2-3)

- [ ] Implement create-subtask command
- [ ] Add hierarchical listing options
- [ ] Create move/detach commands
- [ ] Update existing commands with hierarchy awareness

### Step 5: AI Integration (Week 3)

- [ ] Integrate with Task #175 decomposition
- [ ] Add automatic subtask creation
- [ ] Enhance estimation with hierarchy context

### Step 6: Testing & Documentation (Week 3-4)

- [ ] Comprehensive testing across all components
- [ ] Documentation updates
- [ ] Migration guides for existing users

## Success Criteria

### Functional Requirements

- [ ] Users can create subtasks with explicit parent relationships
- [ ] Hierarchical task listing displays proper tree structure
- [ ] AI decomposition automatically creates subtask relationships
- [ ] All existing task workflows function unchanged
- [ ] Hierarchy validation prevents circular references

### Technical Requirements

- [ ] All task backends support hierarchical data
- [ ] Performance impact is minimal for flat task workflows
- [ ] Data migration is seamless for existing users
- [ ] API remains backward compatible

### User Experience Requirements

- [ ] Intuitive CLI commands for hierarchy management
- [ ] Clear visual indicators for parent-child relationships
- [ ] Helpful error messages for invalid operations
- [ ] Smooth integration with existing task management workflows

## Future Integration Points

### Phase 2 Preparation

- Data model supports dependency relationships
- CLI commands provide foundation for dependency operations
- Backend architecture supports graph-like task relationships

### AI Enhancement Opportunities

- Learning from user hierarchy patterns
- Suggesting optimal task decomposition strategies
- Automated hierarchy reorganization based on task progress

## Estimated Effort

**6-10 hours** across 3-4 weeks with incremental delivery and testing

## Risk Mitigation

### Technical Risks

- **Backend compatibility**: Comprehensive testing across all backends
- **Performance impact**: Benchmark testing with large task sets
- **Data migration**: Phased rollout with fallback options

### User Experience Risks

- **Workflow disruption**: Maintain exact backward compatibility
- **Complexity creep**: Keep hierarchical features optional and intuitive
- **Learning curve**: Comprehensive documentation and examples
