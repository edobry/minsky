# md#375: Collapse Unnecessary Application Layer in Task Architecture

## Context

Refactor task-related code to eliminate the unnecessary application layer that's causing duplicate logic, inconsistent behavior, and architectural complexity. Move business logic to the domain layer where it belongs.

## Architectural Motivation

### Current Problem
The task system has an over-engineered architecture with an unnecessary "application layer" that:
- **Duplicates business logic**: Filtering rules exist in multiple places with different implementations
- **Causes inconsistencies**: CLI shows CLOSED tasks, MCP hides them (different application layer functions)
- **Violates DRY principle**: Same parameter validation and orchestration logic repeated
- **Adds complexity**: Extra abstraction layers without clear value

### Target Architecture: Domain-Driven Design
Move from 3-layer to 2-layer architecture:

**BEFORE (Over-engineered)**:
```
Interface Layer (CLI/MCP) → Application Layer (taskCommands.ts, operations/) → Domain Layer (TaskService)
```

**AFTER (Simplified)**:
```
Interface Layer (CLI/MCP) → Domain Layer (TaskService with rich interface)
```

### Architectural Philosophy

1. **Business Logic Belongs in Domain Layer**: Default filtering, validation, and business rules should live in `TaskService`, not scattered across application functions
2. **Interface Layer Should Be Thin**: CLI/MCP adapters should only handle protocol-specific concerns (parsing, formatting)
3. **Eliminate Unnecessary Abstraction**: If a layer is just passing data through with minimal value-add, remove it
4. **Single Source of Truth**: Business rules should exist in exactly one place

## Refactoring Strategy

### Step 1: Identify Application Layer Anti-Patterns

**Locations to examine**:
- `src/domain/tasks/taskCommands.ts` - Functions that just orchestrate single domain calls
- `src/domain/tasks/operations/` - Operation classes that wrap domain methods
- `src/domain/tasks/taskCommands-modular.ts` - Modular wrappers around domain calls

**Anti-pattern signatures**:
```typescript
// ❌ Unnecessary application layer
export async function someTaskOperation(params) {
  const service = await createTaskService();
  const result = await service.domainMethod();
  // Some filtering/validation that should be in domain
  return result;
}

// ❌ Operation class that just wraps domain calls  
class SomeTaskOperation {
  async execute(params) {
    const service = await this.setupService();
    return await service.domainMethod(); // Just a passthrough
  }
}
```

### Step 2: Enrich Domain Layer Interface

**Target pattern for TaskService**:
```typescript
class TaskService {
  async listTasks(options: {
    all?: boolean;           // Include DONE/CLOSED tasks
    status?: TaskStatus;     // Filter by specific status  
    filter?: string;         // Legacy filter parameter
    limit?: number;          // Pagination
  } = {}): Promise<Task[]> {
    // ALL business logic here:
    // - Parameter validation
    // - Default filtering rules
    // - Backend interaction
    // - Business rule application
  }
}
```

### Step 3: Update Interface Layers

**CLI adapters should become**:
```typescript
// src/adapters/cli/tasks.ts
program.command('tasks list')
  .action(async (cliOptions) => {
    const taskService = container.get(TaskService);
    const tasks = await taskService.listTasks(cliOptions);
    console.log(formatForCLI(tasks));
  });
```

**MCP adapters should become**:
```typescript
// src/adapters/mcp/tasks.ts  
commandMapper.addCommand('tasks.list', async (mcpArgs) => {
  const taskService = container.get(TaskService);
  const tasks = await taskService.listTasks(mcpArgs);
  return { tasks }; // MCP format
});
```

### Step 4: Systematic Refactoring Approach

1. **Audit current application layer functions**:
   - List all functions in `taskCommands.ts` and `operations/`
   - Identify which are just passthroughs vs. have real orchestration value
   
2. **Move business logic to domain layer**:
   - Parameter validation → Domain method signatures
   - Default behaviors → Domain method implementations  
   - Filtering rules → Domain business logic
   
3. **Update interface layers**:
   - Remove calls to application layer functions
   - Inject and call domain services directly
   - Keep only protocol-specific logic (parsing, formatting)
   
4. **Remove obsolete application layer code**:
   - Delete unnecessary files
   - Update imports throughout codebase
   - Update tests to test domain layer directly

### Files to Examine

**Application layer files (likely candidates for deletion)**:
- `src/domain/tasks/taskCommands.ts`
- `src/domain/tasks/taskCommands-modular.ts`  
- `src/domain/tasks/operations/query-operations.ts`
- `src/domain/tasks/operations/crud-operations.ts`

**Domain layer files (to be enriched)**:
- `src/domain/tasks/taskService.ts` - Main business logic
- `src/domain/tasks/taskConstants.ts` - Business rules and constants

**Interface layer files (to be simplified)**:
- `src/adapters/cli/` - CLI command handlers
- `src/adapters/mcp/` - MCP tool registrations  
- `src/adapters/shared/commands/` - Shared command implementations

### Benefits Expected

1. **Consistency**: All interfaces get same business behavior automatically
2. **Maintainability**: Business rule changes in one place only
3. **Testability**: Test business logic directly without interface concerns
4. **Simplicity**: Fewer files, clearer responsibilities, less cognitive overhead
5. **Performance**: Eliminate unnecessary abstraction layers

## Success Criteria

- [ ] Business logic consolidated into domain layer (TaskService methods)
- [ ] CLI and MCP interfaces show identical behavior
- [ ] Application layer files deleted or significantly simplified
- [ ] All tests pass with new architecture
- [ ] No duplicate filtering/validation logic across codebase
- [ ] Interface layers are thin and protocol-focused only

## Requirements

## Solution

## Notes
