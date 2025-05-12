# Interface-Agnostic Command Architecture

## Overview

Minsky implements an interface-agnostic command architecture that separates core domain logic from interface-specific concerns. This allows the same underlying functionality to be accessed through multiple interfaces (CLI, MCP, potentially REST APIs) without duplicating business logic.

## Key Components

### 1. Domain Layer

The domain layer contains the core business logic, independent of any interface concerns:

- **Location**: `src/domain/`
- **Key Files**:
  - `tasks.ts`: Core task management functionality
  - `session.ts`: Session management logic
  - `git.ts`: Git operations logic
  - `init.ts`: Project initialization logic

Domain functions are pure TypeScript functions with proper type definitions and validation. They focus on the "what" rather than the "how" of each operation.

### 2. Interface Adapters

Adapters translate between the domain layer and specific interfaces:

- **CLI Adapters** (`src/adapters/cli/`): Convert command-line arguments to domain function calls
- **MCP Adapters** (`src/adapters/mcp/`): Map MCP tool invocations to domain function calls

Each adapter is responsible for:

- Parsing input specific to its interface
- Calling the appropriate domain functions
- Formatting output for the specific interface
- Handling interface-specific error handling

### 3. Parameter Validation

Shared validation schemas ensure consistent parameter handling across interfaces:

- **Zod Schemas**: Define validation rules for command parameters
- **Shared Types**: Common TypeScript types ensure consistency between interfaces
- **Error Handling**: Standardized error types for uniform error handling

### 4. Command Mapping

The CommandMapper class (`src/mcp/command-mapper.ts`) provides utilities for mapping Minsky CLI commands to MCP tools:

```typescript
addTaskCommand<T extends z.ZodTypeAny>(
  name: string,
  description: string,
  parameters: T,
  executeFunction: (args: z.infer<T>) => Promise<string | Record<string, unknown>>
): void
```

## Implementation Pattern

### Example: Task Listing

#### 1. Domain Function (Pure Logic)

```typescript
// src/domain/tasks.ts
export async function listTasks(options?: {
  filter?: string;
  limit?: number;
  includeCompleted?: boolean;
}): Promise<Task[]> {
  // Implementation returns typed task objects
}
```

#### 2. CLI Adapter (Command-Line Interface)

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

      // CLI-specific formatting and output
      if (options.json) {
        console.log(JSON.stringify(tasks, null, 2));
      } else {
        // Format for human-readable output
        console.table(tasks);
      }
    });
}
```

#### 3. MCP Adapter (Model Context Protocol)

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

      // MCP returns structured data directly
      return tasks;
    }
  );
}
```

## Benefits

1. **Reduced Duplication**: Core logic is implemented once and shared across interfaces
2. **Improved Maintainability**: Changes to business logic only need to be made in one place
3. **Consistency**: Same validation and behavior across all interfaces
4. **Extensibility**: New interfaces can be added without modifying core logic
5. **Testability**: Domain functions can be tested independently of interfaces

## Best Practices for Future Development

When adding new functionality to Minsky:

1. **Start with Domain Logic**: Implement core functionality in the domain layer first
2. **Define Clear Interfaces**: Create well-typed interfaces between domain and adapters
3. **Implement Adapters**: Create adapters for each supported interface (CLI, MCP, etc.)
4. **Add Validation**: Use Zod schemas for parameter validation
5. **Write Tests**: Test domain logic and adapters separately

## Error Handling

Standardized error handling ensures consistent user experience across interfaces:

1. **Domain Errors**: Core domain functions throw typed errors
2. **Adapter Handling**: Adapters catch and format errors appropriately for their interface
3. **User Feedback**: Clear error messages guide users to correct usage

## Testing Strategy

Testing the interface-agnostic architecture involves:

1. **Unit Tests**: Test domain functions in isolation
2. **Integration Tests**: Test adapters with their respective interfaces
3. **End-to-End Tests**: Test complete flows across different interfaces

## Future Enhancements

1. **Additional Interfaces**: Support for REST API, GraphQL, or other interfaces
2. **Expanded Schema Coverage**: More comprehensive validation schemas
3. **Enhanced Error Types**: More specific error categories for better handling
4. **Streaming Support**: For long-running operations or large data sets
