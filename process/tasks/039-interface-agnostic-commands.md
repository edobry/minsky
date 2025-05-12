# Task #039: Interface-Agnostic Command Architecture

## Context

Currently, the MCP implementation in Minsky uses `execSync` to call CLI commands, effectively spawning a new process for each MCP tool call. This approach has several drawbacks:

1. **Inefficiency**: Spawning processes is resource-intensive and introduces latency
2. **Code Duplication**: Logic is essentially duplicated between interfaces
3. **Maintenance Burden**: Changes need to be made in multiple places
4. **Inconsistency Risk**: CLI and MCP interfaces could drift apart over time

We need to refactor the command architecture to enable direct function calls across different interfaces (CLI, MCP, and potentially others like REST APIs in the future).

## Requirements

1. **Shared Core Logic**
   - Extract pure domain functions that contain all business logic
   - Make these functions independent of any interface specifics
   - Ensure all domain functions are properly typed with TypeScript

2. **Interface Adapters**
   - Create CLI adapters that use the domain functions
   - Create MCP adapters that use the same domain functions
   - Ensure consistent behavior across all interfaces

3. **Parameter Validation**
   - Implement shared validation logic using Zod schemas
   - Use the same schemas for both CLI and MCP interfaces
   - Provide clear error messages for invalid inputs

4. **Response Formatting**
   - Define unified response types for all commands
   - Implement interface-specific formatting in adapters
   - Ensure consistent error handling across interfaces

5. **Testing**
   - Create unit tests for all domain functions
   - Add integration tests for each interface
   - Ensure backward compatibility with existing scripts

## Implementation Plan

### Phase 1: Domain Logic Extraction

1. **Task Commands**
   - Extract core logic from `tasks list`, `tasks get`, `tasks status` to pure domain functions
   - Move these functions to `src/domain/tasks.ts`
   - Add proper TypeScript types and interfaces
   - Create unit tests for each function

2. **Session Commands**
   - Extract core logic from `session list`, `session get`, `session start`, etc.
   - Move these functions to `src/domain/session.ts`
   - Add proper TypeScript interfaces
   - Create unit tests for each function

3. **Git Commands**
   - Extract core logic from `git clone`, `git branch`, `git pr`, etc.
   - Move these functions to `src/domain/git.ts`
   - Add proper TypeScript interfaces
   - Create unit tests for each function

### Phase 2: Interface Adapters

1. **CLI Adapters**
   - Create CLI adapters in `src/adapters/cli/`
   - Update existing commands to use domain functions
   - Ensure backward compatibility
   - Add tests for CLI adapters

2. **MCP Adapters**
   - Create MCP adapters in `src/adapters/mcp/`
   - Update existing MCP tools to use domain functions
   - Ensure consistent behavior with CLI
   - Add tests for MCP adapters

### Phase 3: Parameter Validation

1. **Validation Schemas**
   - Create Zod schemas for all command parameters
   - Move these schemas to `src/schemas/`
   - Share schemas between CLI and MCP
   - Add validation to all domain functions

2. **Error Handling**
   - Create standardized error types
   - Implement consistent error handling
   - Ensure clear error messages
   - Add error handling tests

### Phase 4: Testing and Documentation

1. **Comprehensive Testing**
   - Add unit tests for all domain functions
   - Add integration tests for each interface
   - Add end-to-end tests
   - Ensure test coverage meets standards

2. **Documentation**
   - Update architecture documentation
   - Document domain functions
   - Document interface adapters
   - Provide examples of usage

## Technical Design Decisions

1. **Architecture Pattern**
   - Use an adapter pattern to separate domain logic from interface concerns
   - Leverage dependency injection for flexibility
   - Maintain a clear separation of concerns

2. **Type Safety**
   - Use TypeScript interfaces and types throughout
   - Leverage Zod for runtime validation
   - Ensure type consistency between interfaces

3. **Code Organization**
   - Domain functions in `src/domain/`
   - Interface adapters in `src/adapters/`
   - Schemas in `src/schemas/`
   - Types in `src/types/`

4. **Backward Compatibility**
   - Ensure existing CLI commands behave the same
   - Maintain compatibility with existing scripts
   - Provide clear migration path for custom integrations

## Example Implementation

### Domain Function:

```typescript
// src/domain/tasks.ts
export async function listTasks(options?: {
  filter?: string;
  limit?: number;
  includeCompleted?: boolean;
}): Promise<Task[]> {
  // Implementation that returns typed task objects
}
```

### CLI Adapter:

```typescript
// src/adapters/cli/tasks.ts
import { listTasks } from '../../domain/tasks.js';

export function createTasksCommand() {
  return new Command('tasks')
    .command('list')
    .option('--filter <filter>')
    .option('--limit <limit>', 'Limit results', parseFloat)
    .option('--all', 'Include completed tasks')
    .action(async (options) => {
      const tasks = await listTasks({
        filter: options.filter,
        limit: options.limit,
        includeCompleted: options.all
      });
      
      // CLI-specific formatting and output logic
      if (options.json) {
        console.log(JSON.stringify(tasks, null, 2));
      } else {
        // Format for human-readable output
      }
    });
}
```

### MCP Adapter:

```typescript
// src/adapters/mcp/tasks.ts
import { listTasks } from '../../domain/tasks.js';
import { z } from 'zod';

export function registerTaskTools(commandMapper: CommandMapper): void {
  commandMapper.addTaskCommand(
    'list',
    'List all tasks',
    z.object({
      filter: z.string().optional(),
      limit: z.number().optional(),
      all: z.boolean().optional(),
    }),
    async (args) => {
      const tasks = await listTasks({
        filter: args.filter,
        limit: args.limit,
        includeCompleted: args.all
      });
      
      // MCP-specific response formatting
      return tasks;
    }
  );
}
```

### Shared Schema:

```typescript
// src/schemas/tasks.ts
import { z } from 'zod';

export const taskListParamsSchema = z.object({
  filter: z.string().optional().describe("Filter tasks by status or other criteria"),
  limit: z.number().optional().describe("Limit the number of tasks returned"),
  all: z.boolean().optional().describe("Include completed tasks"),
});

export type TaskListParams = z.infer<typeof taskListParamsSchema>;
```

## Verification

- [ ] All domain functions are extracted and properly typed
- [ ] CLI adapters use domain functions and maintain backward compatibility
- [ ] MCP adapters use domain functions and provide consistent behavior
- [ ] Parameter validation is implemented using shared schemas
- [ ] Tests are added for all domain functions and adapters
- [ ] Documentation is updated to reflect the new architecture
- [ ] No regression in existing functionality

## Work Log

1. 2025-05-09: Initial task specification created
