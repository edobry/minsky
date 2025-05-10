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

### Phase 1: Directory Structure and Schema Setup (Foundation)

1. **Create New Directory Structure**

   - Create `src/adapters/cli` directory for CLI adapters
   - Create `src/adapters/mcp` directory for MCP adapters
   - Create `src/schemas` directory for shared validation schemas

2. **Create Shared Schema Files**

   - Create `src/schemas/tasks.ts` for task-related parameter schemas
   - Create `src/schemas/session.ts` for session-related parameter schemas
   - Create `src/schemas/git.ts` for git-related parameter schemas
   - Create `src/schemas/common.ts` for commonly used schemas (e.g., paths)

3. **Define Error Handling Strategy**

   - Create consistent error hierarchy in `src/errors/index.ts`:

     ```typescript
     // Base application error
     export class MinskyError extends Error {
       constructor(
         message: string,
         public readonly cause?: unknown
       ) {
         super(message);
         this.name = this.constructor.name;
       }
     }

     // Domain-specific errors
     export class ValidationError extends MinskyError {}
     export class ResourceNotFoundError extends MinskyError {}
     export class AuthorizationError extends MinskyError {}
     export class NetworkError extends MinskyError {}
     export class ConfigurationError extends MinskyError {}
     ```

   - Establish error propagation patterns:
     - Domain layer: Throw domain-specific errors
     - Adapter layer: Catch domain errors, translate to interface-appropriate format
     - All errors include proper stack traces and cause chains

### Phase 2: Refactor Tasks Domain and Commands

1. **Refactor Task Domain Module**

   - Review and update `src/domain/tasks.ts` to ensure all business logic is properly encapsulated
   - **Define domain-specific types and interfaces within the module**
   - Ensure all functions have proper TypeScript types
   - Add validation using Zod schemas from the new schema files
   - Ensure all error handling is consistent
   - Implement dependency injection through function parameters:
     ```typescript
     // Example of dependency injection pattern for domain functions
     export async function listTasksFromParams(
       params: TaskListParams,
       deps: {
         resolveRepoPath: typeof resolveRepoPath;
         resolveWorkspacePath: typeof resolveWorkspacePath;
         createTaskService: (options: TaskServiceOptions) => TaskService;
       } = {
         resolveRepoPath,
         resolveWorkspacePath,
         createTaskService: (options) => new TaskService(options),
       }
     ): Promise<Task[]> {
       // Implementation using injected dependencies
     }
     ```

2. **Create Tasks CLI Adapter**

   - Create `src/adapters/cli/tasks.ts` that imports from domain and schemas
   - Move CLI-specific logic from `src/commands/tasks/*.ts` to this adapter
   - Update existing CLI commands to use the adapter

3. **Create Tasks MCP Adapter**

   - Create `src/adapters/mcp/tasks.ts` that imports from domain and schemas
   - Move MCP-specific logic from `src/mcp/tools/tasks.ts` to this adapter
   - Update MCP command registrations to use the adapter

4. **Update Tests**
   - Update or create tests for the domain functions
   - Create tests for CLI adapters
   - Create tests for MCP adapters

### Phase 3: Refactor Session Domain and Commands

1. **Refactor Session Domain Module**

   - Review and update `src/domain/session.ts` to ensure all business logic is properly encapsulated
   - **Define domain-specific types and interfaces within the module**
   - Ensure all functions have proper TypeScript types
   - Add validation using Zod schemas
   - Ensure all error handling is consistent

2. **Create Session CLI Adapter**

   - Create `src/adapters/cli/session.ts` that imports from domain and schemas
   - Move CLI-specific logic from `src/commands/session/*.ts` to this adapter
   - Update existing CLI commands to use the adapter

3. **Create Session MCP Adapter**

   - Create `src/adapters/mcp/session.ts` that imports from domain and schemas
   - Move MCP-specific logic from `src/mcp/tools/session.ts` to this adapter
   - Update MCP command registrations to use the adapter

4. **Update Tests**
   - Update or create tests for the domain functions
   - Create tests for CLI adapters
   - Create tests for MCP adapters

### Phase 4: Refactor Git Domain and Commands

1. **Refactor Git Domain Module**

   - Review and update `src/domain/git.ts` to ensure all business logic is properly encapsulated
   - **Define domain-specific types and interfaces within the module**
   - Ensure all functions have proper TypeScript types
   - Add validation using Zod schemas
   - Ensure all error handling is consistent

2. **Create Git CLI Adapter**

   - Create `src/adapters/cli/git.ts` that imports from domain and schemas
   - Move CLI-specific logic from `src/commands/git/*.ts` to this adapter
   - Update existing CLI commands to use the adapter

3. **Create Git MCP Adapter**

   - Create `src/adapters/mcp/git.ts` that imports from domain and schemas
   - Move MCP-specific logic from any existing git-related MCP tools to this adapter
   - Update MCP command registrations to use the adapter

4. **Update Tests**
   - Update or create tests for the domain functions
   - Create tests for CLI adapters
   - Create tests for MCP adapters

### Phase 5: MCP Server Refactoring

1. **Update Command Mapper**

   - Refactor `src/mcp/command-mapper.ts` to use the new adapter pattern
   - Ensure it properly handles error responses from domain functions
   - Update type definitions as needed

2. **Update MCP Server**
   - Update `src/mcp/server.ts` to use the new adapters
   - Ensure proper error handling and response formatting
   - Add tests for the updated MCP server

### Phase 6: Final Integration and Testing

1. **Integration Tests**

   - Create integration tests that ensure CLI and MCP produce consistent results
   - Test error handling scenarios
   - Test backward compatibility

2. **Documentation**
   - Update architecture documentation with new patterns
   - Document how to add new commands using the new pattern
   - Provide examples for both CLI and MCP interfaces

### Phase 7: Documentation and Interface Contracts

1. **Document Domain Function Interfaces**

   - Create README.md in each domain directory explaining:
     - Purpose and responsibility of the domain module
     - Key types and interfaces
     - Available functions and their usage examples
     - Error handling expectations

2. **Document Schema Validation**

   - Create comprehensive JSDoc for all schemas
   - Include examples of valid and invalid inputs
   - Document error messages for common validation failures

3. **Adapter Implementation Guide**

   - Create a guide for implementing new adapters
   - Document conventions for adapter organization
   - Provide examples of proper error handling in adapters

4. **Update Architecture Documentation**
   - Create diagrams showing the flow from interface through adapters to domain
   - Document domain boundaries and responsibilities
   - Add sequence diagrams for key operations

### Example Workflow for Tasks List Command

As a concrete example, here's how the refactoring might look for the `tasks list` command:

1. **Create Task List Schema**

```typescript
// src/schemas/tasks.ts
import { z } from "zod";

export const taskListParamsSchema = z.object({
  filter: z.string().optional().describe("Filter tasks by status"),
  limit: z.number().optional().describe("Limit the number of tasks returned"),
  all: z.boolean().optional().describe("Include completed tasks"),
  session: z.string().optional().describe("Session name to use for repo resolution"),
  repo: z.string().optional().describe("Path to a git repository"),
  workspace: z.string().optional().describe("Path to main workspace"),
  backend: z.string().optional().describe("Specify task backend"),
});

export type TaskListParams = z.infer<typeof taskListParamsSchema>;

// Add additional schemas for other task commands...
```

2. **Update Domain Function**

```typescript
// src/domain/tasks.ts (modifications)
import { taskListParamsSchema, TaskListParams } from "../schemas/tasks";

// Existing TaskService class will be kept, but with some modifications

// New function to be called from adapters
export async function listTasksFromParams(params: TaskListParams): Promise<Task[]> {
  // Validate params
  const validParams = taskListParamsSchema.parse(params);

  // First get the repo path (needed for workspace resolution)
  const repoPath = await resolveRepoPath({
    session: validParams.session,
    repo: validParams.repo,
  });

  // Then get the workspace path (main repo or session's main workspace)
  const workspacePath = await resolveWorkspacePath({
    workspace: validParams.workspace,
    sessionRepo: repoPath,
  });

  const taskService = new TaskService({
    workspacePath: workspacePath,
    backend: validParams.backend,
  });

  let tasks;

  // If status filter is explicitly provided, use it
  if (validParams.filter) {
    tasks = await taskService.listTasks({
      status: validParams.filter,
    });
  } else {
    // Otherwise get all tasks first
    tasks = await taskService.listTasks();

    // Unless "all" is provided, filter out DONE tasks
    if (!validParams.all) {
      tasks = tasks.filter((task) => task.status !== TASK_STATUS.DONE);
    }
  }

  return tasks;
}
```

3. **Create CLI Adapter**

```typescript
// src/adapters/cli/tasks.ts
import { Command } from "commander";
import { listTasksFromParams } from "../../domain/tasks";
import { generateFilterMessages } from "../../utils/filter-messages";

export function createListCommand(): Command {
  return new Command("list")
    .description("List tasks")
    .option("-s, --status <status>", "Filter tasks by status")
    .option("--session <session>", "Session name to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--workspace <workspacePath>", "Path to main workspace (overrides repo and session)")
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output tasks as JSON")
    .option("--all", "Include DONE tasks in the output (by default, DONE tasks are hidden)")
    .action(
      async (options: {
        status?: string;
        backend?: string;
        session?: string;
        repo?: string;
        workspace?: string;
        json?: boolean;
        all?: boolean;
      }) => {
        try {
          const tasks = await listTasksFromParams({
            filter: options.status,
            backend: options.backend,
            session: options.session,
            repo: options.repo,
            workspace: options.workspace,
            all: options.all,
          });

          if (tasks.length === 0) {
            if (options.json) {
              console.log(JSON.stringify([]));
            } else {
              // Generate and display filter messages in non-JSON mode
              const filterMessages = generateFilterMessages({
                status: options.status,
                all: options.all,
              });

              // Display filter messages if any exist
              if (filterMessages.length > 0) {
                filterMessages.forEach((message) => console.log(message));
                console.log("");
              }

              console.log("No tasks found.");
            }
            return;
          }

          if (options.json) {
            console.log(JSON.stringify(tasks, null, 2));
          } else {
            // Generate and display filter messages in non-JSON mode
            const filterMessages = generateFilterMessages({
              status: options.status,
              all: options.all,
            });

            // Display filter messages if any exist
            if (filterMessages.length > 0) {
              filterMessages.forEach((message) => console.log(message));
              console.log("");
            }

            console.log("Tasks:");
            tasks.forEach((task) => {
              console.log(`- ${task.id}: ${task.title} [${task.status}]`);
            });
          }
        } catch (error) {
          console.error("Error listing tasks:", error);
          process.exit(1);
        }
      }
    );
}
```

4. **Create MCP Adapter**

```typescript
// src/adapters/mcp/tasks.ts
import { z } from "zod";
import { CommandMapper } from "../../mcp/command-mapper";
import { listTasksFromParams } from "../../domain/tasks";
import { taskListParamsSchema } from "../../schemas/tasks";

export function registerTaskTools(commandMapper: CommandMapper): void {
  // Task list tool
  commandMapper.addTaskCommand(
    "list",
    "List all tasks",
    taskListParamsSchema, // Use the shared schema
    async (args) => {
      try {
        // Use the shared domain function
        const tasks = await listTasksFromParams(args);
        return tasks;
      } catch (error) {
        console.error("Error listing tasks:", error);
        throw new Error(
          `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Other task tools...
}
```

5. **Update Command Registration**

```typescript
// src/commands/tasks/index.ts
import { Command } from "commander";
import { createListCommand } from "../../adapters/cli/tasks";
// Import other command creators...

export function createTasksCommand(): Command {
  const tasksCommand = new Command("tasks").description("Task management operations");

  tasksCommand.addCommand(createListCommand());
  // Add other commands...

  return tasksCommand;
}
```

6. **Update MCP Registration**

```typescript
// src/mcp/server.ts
import { registerTaskTools } from "../adapters/mcp/tasks";
// Import other tool registrations...

// In server setup:
registerTaskTools(commandMapper);
// Register other tools...
```

By following this pattern for each command, we'll achieve a consistent interface-agnostic architecture that promotes code reuse, type safety, and maintainability.

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

   - Domain functions and their related types in `src/domain/`
   - Interface adapters in `src/adapters/`
   - Schemas in `src/schemas/`

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
import { listTasks } from "../../domain/tasks.js";

export function createTasksCommand() {
  return new Command("tasks")
    .command("list")
    .option("--filter <filter>")
    .option("--limit <limit>", "Limit results", parseFloat)
    .option("--all", "Include completed tasks")
    .action(async (options) => {
      const tasks = await listTasks({
        filter: options.filter,
        limit: options.limit,
        includeCompleted: options.all,
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
import { listTasks } from "../../domain/tasks.js";
import { z } from "zod";

export function registerTaskTools(commandMapper: CommandMapper): void {
  commandMapper.addTaskCommand(
    "list",
    "List all tasks",
    z.object({
      filter: z.string().optional(),
      limit: z.number().optional(),
      all: z.boolean().optional(),
    }),
    async (args) => {
      const tasks = await listTasks({
        filter: args.filter,
        limit: args.limit,
        includeCompleted: args.all,
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
import { z } from "zod";

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
2. 2025-05-10: Added Zod library for schema validation
3. 2025-05-10: Created error handling system in src/errors/index.ts
4. 2025-05-10: Added schemas in src/schemas/ for tasks, session, git, and common parameters
5. 2025-05-10: Created initial CLI adapter for tasks in src/adapters/cli/tasks.ts
6. 2025-05-10: Added MCP adapter for tasks in src/adapters/mcp/tasks.ts
7. 2025-05-10: Added CLI adapter for git commands in src/adapters/cli/git.ts
8. 2025-05-10: Created domain utility functions with parameter validation in domain files
9. 2025-05-10: Updated domain/index.ts to export shared functions for use by adapters
10. 2025-05-10: Implemented task status domain functions with proper parameter validation
11. 2025-05-10: Updated CLI and MCP adapters to use the new task status domain functions
12. 2025-05-10: Added tests for the interface-agnostic task functions
13. 2025-05-11: Implemented startSessionFromParams with validation, error handling and dependency injection
14. 2025-05-11: Implemented updateSessionFromParams with similar robust error handling pattern
15. 2025-05-11: Added tests for interface-agnostic session functions
16. 2025-05-12: Implemented createPullRequestFromParams and commitChangesFromParams git domain functions
17. 2025-05-12: Added tests for interface-agnostic git functions

## Current Status

- [x] Phase 1: Set up schema validation system with Zod
- [x] Phase 1: Create error handling system 
- [x] Phase 1: Begin domain logic extraction with parameter validation
- [x] Phase 2: Begin implementing interface adapters for CLI and MCP
- [x] Phase 2: Implement task status domain functions with proper validation and error handling
- [x] Phase 2: Update CLI and MCP adapters to use the new domain functions
- [x] Phase 2: Implement session management domain functions with proper validation
- [x] Phase 4: Add initial tests for the interface-agnostic architecture
- [x] Phase 2: Complete refactoring of git commands to use domain functions
- [ ] Phase 3: Complete parameter validation for git commands
- [ ] Phase 5: Update MCP server to use the new adapters
- [ ] Phase 6: Add comprehensive integration tests
- [ ] Phase 7: Update architecture documentation

## Remaining Work

1. **Update MCP Adapters**
   - Update MCP adapters to use domain functions directly
   - Ensure consistent behavior between CLI and MCP
   - Add tests for MCP adapters

2. **Integration Tests**
   - Add integration tests that verify consistent behavior across interfaces
   - Test error handling and edge cases
   - Test end-to-end flows involving multiple commands

3. **Documentation**
   - Update architecture documentation with new patterns
   - Document validation and error handling approach
   - Provide examples of correct usage for future development
