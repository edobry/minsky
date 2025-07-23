# Implement Basic Task Parent-Child Relationships

## Problem Statement

Enable arbitrary depth task decomposition by implementing simple parent-child relationships between tasks. This provides immediate value for test decomposition and complex task management without adding complexity.

## Goal

Implement the minimal viable parent-child relationship system that allows:

- Creating subtasks under any task
- Viewing task hierarchies
- Managing parent-child relationships through CLI
- Supporting arbitrary depth decomposition

## Context

**Immediate Need**: Task decomposition for test-driven development and complex feature breakdown
**Future Foundation**: Extensible relationship model for dependencies and other relationship types later
**NEW: Monitorability Foundation**: Task graph structure that supports Chain-of-Thought monitoring of AI task execution

## Dependencies

**Task #235**: This task builds on the research and architectural analysis from Task #235 "Add metadata support to tasks (subtasks, priority, dependencies)". Task #235 provides the foundational research on task metadata systems and backend capabilities that inform the implementation approach for this parent-child relationship system.

**⚠️ CRITICAL SEQUENCING**: This task MUST NOT begin implementation until Task #235 has completed its architectural decision and provided implementation guidelines. The implementation approach described below may need to be revised based on #235's architectural recommendations.

## Chain-of-Thought Monitoring Considerations

### Monitorable Task Graph Design

**Execution Transparency Requirements:**

- Task hierarchy must support real-time monitoring of AI execution at each node
- Parent-child relationships must enable "Chain-of-Execution" visibility
- Task state changes must be observable and interventions must be possible
- Task graph structure must support subgraph preemption and restart capabilities

**Intervention Points:**

- Each parent-child relationship represents a potential intervention boundary
- Task execution can be interrupted at any node in the hierarchy
- Subgraph termination and regeneration must be supported
- Human oversight can redirect execution at any level of the hierarchy

**Metadata for Monitoring:**

- Task relationships must store execution context and reasoning traces
- Parent-child links must support intervention history and decision rationale
- Task hierarchy must enable rollback to any previous state
- Execution monitoring metadata must be preserved across task modifications

## Simplified Solution

### Core Schema (Minimal)

```typescript
// NOTE: This schema design is provisional and subject to
// revision based on Task #235's architectural decisions
interface Task {
  // ... existing fields
  parentTaskId?: string; // Simple parent reference
}

interface TaskRelationship {
  id: string;
  parentTaskId: string;
  childTaskId: string;
  createdAt: Date;
}
```

### Essential Commands

1. `minsky tasks create --parent <task-id> "description"` - Create subtask
2. `minsky tasks tree <task-id>` - Show hierarchy
3. `minsky tasks list --parent <task-id>` - List children

### Database Changes

```sql
-- NOTE: These database changes are provisional and subject to
-- revision based on Task #235's architectural decisions

-- Add parent reference to tasks table
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;

-- Add relationship table for integrity
CREATE TABLE task_relationships (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  child_task_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id),
  FOREIGN KEY (child_task_id) REFERENCES tasks(id),
  UNIQUE(parent_task_id, child_task_id)
);
```

## Implementation Steps

### Phase 0: Architectural Alignment (REQUIRED FIRST)

1. **Wait for Task #235 completion** - Do not proceed until architectural decisions are made
2. **Review architectural guidelines** - Ensure this implementation aligns with chosen approach
3. **Revise implementation plan** - Update schema and approach based on #235's recommendations
4. **Get architectural approval** - Confirm implementation plan follows architectural guidelines

### Phase 1: Core Functionality (After #235 completion)

1. **Database migration** - Add parent_task_id column and relationships table (per #235 guidelines)
2. **TaskService updates** - Add parent-child methods to existing task service
3. **CLI command updates** - Add `--parent` flag to `tasks create`
4. **Tree display** - Simple `tasks tree` command with ASCII output

### Phase 2: Enhanced Display (Soon After)

1. **Improved tree visualization** - Better formatting and depth handling
2. **Enhanced list command** - Add `--parent` and `--root` filters
3. **Validation** - Prevent circular dependencies

## Test Decomposition Pattern (Primary Use Case)

```bash
# Create main task
minsky tasks create "Implement user authentication"

# Break down into test categories
minsky tasks create --parent 123 "Unit tests"
minsky tasks create --parent 123 "Integration tests"
minsky tasks create --parent 123 "E2E tests"

# Break down unit tests further
minsky tasks create --parent 124 "Test login validation"
minsky tasks create --parent 124 "Test password hashing"

# View complete hierarchy
minsky tasks tree 123
```

**Expected Output**:

```
Task #123: "Implement user authentication"
├── Task #124: "Unit tests"
│   ├── Task #127: "Test login validation"
│   └── Task #128: "Test password hashing"
├── Task #125: "Integration tests"
└── Task #126: "E2E tests"
```

## Technical Implementation

### TaskService Extensions

```typescript
class TaskService {
  // ... existing methods

  async createSubtask(parentId: string, spec: CreateTaskSpec): Promise<Task> {
    // Validate parent exists
    // Create task with parent_task_id
    // Create relationship record
  }

  async getChildren(taskId: string): Promise<Task[]> {
    // Get tasks where parent_task_id = taskId
  }

  async getAncestors(taskId: string): Promise<Task[]> {
    // Walk up parent chain
  }
}
```

### CLI Command Updates

```typescript
// Extend existing tasks create command
create.option("--parent <task-id>", "Create as subtask of parent");

// Add new tree command
tasks.command("tree <task-id>").action(async (taskId) => {
  // Display task hierarchy
});
```

## Acceptance Criteria

### Core Functionality

- [ ] `minsky tasks create --parent <id> "description"` creates subtasks
- [ ] Parent-child relationships are stored in database
- [ ] `minsky tasks tree <id>` displays hierarchy
- [ ] `minsky tasks list --parent <id>` shows children
- [ ] Circular dependency validation prevents invalid relationships

### Display and Navigation

- [ ] Tree display handles arbitrary depth
- [ ] ASCII tree formatting is clear and readable
- [ ] Parent/child relationships are correctly displayed
- [ ] Root tasks (no parent) are properly identified

### Chain-of-Thought Monitoring Support

- [ ] **NEW: Task hierarchy supports real-time execution monitoring**
- [ ] **NEW: Parent-child relationships enable intervention at any level**
- [ ] **NEW: Task graph structure supports subgraph preemption**
- [ ] **NEW: Execution context and reasoning traces are preservable**
- [ ] **NEW: Task relationships support rollback and restart capabilities**

### Data Integrity

- [ ] Relationship constraints prevent orphaned references
- [ ] Deleting parent tasks handles child tasks appropriately
- [ ] Database migrations work correctly
- [ ] **NEW: Intervention history and monitoring metadata is preserved**

## Future Extensibility

This simple parent-child system provides the foundation for:

- **AI-powered decomposition** - Build on this to add intelligent task breakdown
- **Dependencies** - Add BLOCKS/DEPENDS_ON relationship types
- **Status propagation** - Parent status based on children
- **Other relationship types** - RELATES_TO, DUPLICATE, etc.
- **NEW: Chain-of-Thought monitoring** - Real-time observation and intervention in task execution
- **NEW: Subgraph preemption** - Terminate and restart entire branches of task execution
- **NEW: Multi-agent supervision** - AI agents monitoring and intervening in other AI agents' task execution

The unified relationship model allows extending without refactoring the core system, while maintaining **full monitorability** for safety and control.

## Migration Strategy

1. **Safe addition** - New functionality doesn't break existing features
2. **Backward compatibility** - All existing tasks become root tasks
3. **Gradual adoption** - Users can adopt hierarchical tasks incrementally

This implementation provides immediate value for task decomposition while establishing the foundation for future relationship features.
