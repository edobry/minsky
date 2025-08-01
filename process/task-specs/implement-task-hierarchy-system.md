# Implement Task Hierarchy System (Parent-Child Relationships)

> **⚠️ SPEC UPDATE REQUIRED**: This spec was written before Task #325 architectural decision. Following the GitHub Issues interim strategy, this spec needs updating to use GitHub Issues for hierarchies instead of complex backend metadata. See `analysis/updated-ai-task-management-spec.md` for the new approach.

## Problem Statement

To enable arbitrary depth task decomposition and test decomposition workflows, we need to implement a parent-child relationship system for tasks. This will allow breaking down complex tasks into manageable subtasks at any depth level.

## Context

The current task system treats all tasks as independent entities. To support effective test decomposition and complex task management, we need:

1. **Arbitrary depth task hierarchy** - Tasks can have subtasks, which can have their own subtasks, without depth limits
2. **Test decomposition pattern** - Break down testing tasks into specific test cases and test suites
3. **Simple parent-child relationships** - A unified approach that can be extended to other relationship types later
4. **Immediate value** - Focus on core functionality with minimal complexity

## Dependencies

**Task #235**: This task builds on the comprehensive research and architectural analysis from Task #235 "Add metadata support to tasks (subtasks, priority, dependencies)". Task #235 provides the foundational analysis of task metadata systems, backend capabilities, and architectural approaches that inform the design decisions for this hierarchical task system.

**⚠️ CRITICAL SEQUENCING**: This task MUST NOT begin implementation until Task #235 has completed its architectural decision and provided implementation guidelines. The technical implementation details described below may need to be significantly revised based on #235's architectural recommendations.

## Future Direction Considerations

### Multi-Level Task Graph Architecture with Chain-of-Thought Monitoring

**RESEARCH REQUIRED**: This implementation should be designed to support future extension to a multi-level task graph with **full Chain-of-Thought (CoT) monitoring capabilities** at each level:

1. **User-specified tasks** (from user requirements) - **Strategic CoT monitoring**
2. **AI-decomposed strategic subtasks** (high-level breakdown) - **Tactical CoT monitoring**
3. **Tactical subtasks/todos** (immediate action items: tool calls, code generation, thinking steps) - **Execution CoT monitoring**

**Key architectural questions to preserve in this implementation:**

- Should tactical subtasks be full task entities or lightweight execution metadata?
- How to support human-in-the-loop intervention at any graph level?
- How to enable subgraph recomputation when user requirements change?
- How to integrate with ephemeral git branches for rollback capabilities?
- **NEW: How to ensure CoT monitorability at each level of the task graph?**
- **NEW: What intervention patterns are needed for safe multi-level AI task execution?**
- **NEW: How to maintain reasoning transparency across task graph levels?**

**Design Constraint**: Implementation must not preclude future addition of:

- **Inspectable task graphs** - Full visibility before execution
- **Intervention points** - Human review/modification between execution phases
- **Requirement iteration** - Ability to modify user requirements and recompute affected subgraphs
- **Execution rollback** - Using ephemeral git branches for safe experimentation
- **NEW: Chain-of-Thought monitoring** - Real-time observation of AI reasoning at each task level
- **NEW: Multi-level intervention** - Ability to interrupt and redirect at strategic, tactical, or execution levels
- **NEW: Reasoning pattern detection** - Automated detection of problematic planning across all levels

**Architecture Impact**: The parent-child relationship system designed here should be extensible to support different relationship types and task weights (heavyweight strategic vs lightweight tactical), with **full Chain-of-Thought monitorability** enabling safe and transparent AI-driven task execution.

## Chain-of-Thought Monitoring Integration

### Monitorable Task Graph Design

**Multi-Level CoT Architecture:**

- **Strategic Level**: Monitor AI reasoning about high-level task decomposition and planning
- **Tactical Level**: Monitor AI reasoning about task dependencies, sequencing, and resource allocation
- **Execution Level**: Monitor AI reasoning about specific implementation approaches and decisions

**Intervention Capabilities:**

- **Subgraph Preemption**: Terminate and restart entire branches of task execution based on CoT analysis
- **Real-time Redirection**: Interrupt AI task planning mid-stream when problematic reasoning is detected
- **Context Preservation**: Maintain reasoning context across interventions for seamless resumption

**Safety Through Transparency:**

- All AI reasoning about task hierarchy creation and modification must be observable
- Decision rationale for task relationships must be externalized and monitorable
- Alternative approaches considered must be visible for human oversight
- Confidence levels and uncertainty must be explicitly acknowledged

### Monitorability Requirements for Task Hierarchy

**Transparent Reasoning:**

- AI must externalize reasoning about task complexity, dependencies, and hierarchy design
- Parent-child relationship decisions must include observable decision rationale
- Task decomposition choices must be justified with visible reasoning chains
- Alternative hierarchy structures considered must be documented

**Intervention Points:**

- Each level of the task hierarchy represents a potential intervention boundary
- Real-time monitoring can detect problematic hierarchy decisions as they occur
- Human can redirect AI planning before inappropriate task structures are committed
- Rollback capabilities allow reverting to previous hierarchy states

**Pattern Detection:**

- Monitor for over-decomposition (unnecessary complexity) or under-decomposition (insufficient breakdown)
- Detect circular dependencies or inappropriate task relationships
- Identify scope creep or boundary violations in task definition
- Recognize when AI planning is stuck or producing poor hierarchy designs

## Goal

Implement a parent-child task relationship system that enables:

- Creating subtasks under any existing task
- Viewing task hierarchies in tree format
- Managing task relationships through simple CLI commands
- Supporting arbitrary depth decomposition for complex workflows

## Proposed Solution

**NOTE**: The technical approach described below is provisional and subject to revision based on Task #235's architectural decisions.

### Phase 1: Core Parent-Child Relationships (After #235 completion)

**Database Schema Extension** (provisional):

```typescript
// NOTE: This schema design may be revised based on Task #235's
// architectural decisions and chosen approach
interface TaskRelationship {
  id: string;
  parentTaskId: string;
  childTaskId: string;
  createdAt: Date;
}

interface Task {
  // ... existing fields
  parentTaskId?: string; // Simple parent reference
  hasChildren?: boolean; // Optimization flag for tree operations
}
```

**Core Operations**:

1. **Create subtask** - `minsky tasks create --parent <task-id> "Subtask description"`
2. **View hierarchy** - `minsky tasks tree <task-id>`
3. **List children** - `minsky tasks list --parent <task-id>`
4. **Move task** - `minsky tasks move <task-id> --parent <new-parent-id>`

### Phase 2: Hierarchy Display and Navigation (Soon After)

**Tree Visualization**:

```
Task #123: "Implement user authentication"
├── Task #124: "Unit tests for auth service"
│   ├── Task #125: "Test login validation"
│   ├── Task #126: "Test password hashing"
│   └── Task #127: "Test session management"
├── Task #128: "Integration tests"
│   ├── Task #129: "Test API endpoints"
│   └── Task #130: "Test database integration"
└── Task #131: "E2E tests"
    └── Task #132: "Test complete user flow"
```

**Enhanced Navigation**:

- `minsky tasks tree --depth 2` - Limit tree depth
- `minsky tasks ancestors <task-id>` - Show parent chain
- `minsky tasks descendants <task-id>` - Show all children recursively

### Phase 3: Status Propagation (Future)

**Hierarchy-aware Status**:

- Parent tasks show aggregated status from children
- Automatic status updates when all children complete
- Status validation (can't complete parent if children are pending)

## Technical Implementation

**⚠️ IMPLEMENTATION NOTICE**: All technical implementation details are provisional and must be aligned with Task #235's architectural decisions before proceeding.

### Database Changes (provisional)

1. **Add TaskRelationship table** (subject to #235's architecture):

   ```sql
   -- NOTE: This schema may be revised based on Task #235's decisions
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

2. **Add parent_task_id column to tasks table** (subject to #235's architecture):
   ```sql
   -- NOTE: This change may be revised based on Task #235's decisions
   ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
   ALTER TABLE tasks ADD COLUMN has_children BOOLEAN DEFAULT FALSE;
   ```

### Service Layer

1. **TaskHierarchyService**:

   - `createSubtask(parentId, taskSpec)` - Create child task
   - `getChildren(taskId)` - Get immediate children
   - `getAncestors(taskId)` - Get parent chain
   - `getDescendants(taskId)` - Get all descendants
   - `moveTask(taskId, newParentId)` - Change parent

2. **TreeVisualizationService**:
   - `renderTree(taskId, options)` - ASCII tree display
   - `validateHierarchy(taskId)` - Check for circular dependencies

### CLI Commands

1. **Enhanced `tasks create`**:

   - `--parent <task-id>` - Create as subtask
   - Validates parent exists and is not a descendant

2. **New `tasks tree`**:

   - `minsky tasks tree <task-id>` - Show task hierarchy
   - `--depth <n>` - Limit tree depth
   - `--format [ascii|json]` - Output format

3. **Enhanced `tasks list`**:
   - `--parent <task-id>` - Show only children of parent
   - `--root` - Show only root tasks (no parent)
   - `--tree` - Show hierarchical view

## Use Cases

### Test Decomposition Pattern

```bash
# Create main task
minsky tasks create "Implement user authentication"

# Break down into test categories
minsky tasks create --parent 123 "Unit tests for auth service"
minsky tasks create --parent 123 "Integration tests"
minsky tasks create --parent 123 "E2E tests"

# Break down unit tests into specific tests
minsky tasks create --parent 124 "Test login validation"
minsky tasks create --parent 124 "Test password hashing"
minsky tasks create --parent 124 "Test session management"

# View the complete hierarchy
minsky tasks tree 123
```

### Complex Feature Development

```bash
# Create feature task
minsky tasks create "Add real-time notifications"

# Break down by component
minsky tasks create --parent 200 "Backend WebSocket service"
minsky tasks create --parent 200 "Frontend notification UI"
minsky tasks create --parent 200 "Database notification storage"

# Break down backend further
minsky tasks create --parent 201 "WebSocket connection management"
minsky tasks create --parent 201 "Message queuing system"
minsky tasks create --parent 201 "Authentication middleware"
```

## Acceptance Criteria

### Phase 1 - Core Functionality

- [ ] Tasks can be created with parent-child relationships
- [ ] `minsky tasks create --parent <id> "description"` creates subtasks
- [ ] `minsky tasks tree <id>` displays task hierarchy
- [ ] `minsky tasks list --parent <id>` shows immediate children
- [ ] Parent-child relationships are properly stored and retrieved
- [ ] Circular dependency validation prevents invalid relationships
- [ ] All existing task operations work with hierarchical tasks

### Phase 2 - Enhanced Display

- [ ] Tree visualization supports arbitrary depth
- [ ] Tree display includes task status and basic metadata
- [ ] Navigation commands work correctly (ancestors, descendants)
- [ ] Performance is acceptable for deep hierarchies (100+ tasks)

### Phase 3 - Status Integration

- [ ] Parent tasks show aggregated status from children
- [ ] Status updates propagate appropriately through hierarchy
- [ ] Validation prevents invalid status transitions

## Future Extensibility

This parent-child relationship system provides the foundation for:

- **Dependencies** - Add `BLOCKS` and `DEPENDS_ON` relationship types
- **References** - Add `RELATES_TO` relationship type
- **Constraint behaviors** - Add scheduling and blocking constraints
- **Bulk operations** - Operations on entire task subtrees
- **External integrations** - Export/import task hierarchies

The unified relationship model allows adding new relationship types without changing the core architecture.

## Migration Strategy

1. **Phase 1**: Add new schema and functionality alongside existing system
2. **Phase 2**: Migrate existing tasks to support hierarchy (all start as root tasks)
3. **Phase 3**: Add advanced features and optimizations

No breaking changes to existing task operations - all current functionality remains available.

## Implementation Steps

### Phase 0: Architectural Alignment (REQUIRED FIRST)

1. **Wait for Task #235 completion** - Do not proceed until architectural decisions are made
2. **Review comprehensive architectural guidelines** - Ensure all implementation details align with chosen approach
3. **Revise entire implementation plan** - Update all schemas, APIs, and approaches based on #235's recommendations
4. **Validate backend compatibility** - Ensure approach works with Task #235's backend capability decisions
5. **Get architectural approval** - Confirm complete implementation plan follows architectural guidelines

### Phase 1: Core Parent-Child Relationships (After #235 architectural approval)
