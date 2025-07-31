# Domain-Wide Schema Architecture

## Overview

This document describes the domain-wide schema architecture implemented in Task #329, which extends the type composition patterns from Task #322 to create interface-agnostic schemas that can be used across CLI, MCP, and future API interfaces.

## Architecture Components

### 1. Core Schema Libraries

The domain schemas are organized into modular libraries in `src/domain/schemas/`:

- **`common-schemas.ts`** - Base cross-interface types and utilities
- **`task-schemas.ts`** - Task domain operations
- **`session-schemas.ts`** - Session domain operations
- **`file-schemas.ts`** - File domain operations
- **`validation-utils.ts`** - Cross-interface validation utilities
- **`index.ts`** - Central export point

### 2. Schema Organization Principles

#### Interface-Agnostic Design
All schemas are designed to work across CLI, MCP, and API interfaces without modification:

```typescript
// Same schema works for CLI, MCP, and API
import { TaskCreateParametersSchema } from "src/domain/schemas";

// CLI usage
const cliValidation = validateCliArguments(TaskCreateParametersSchema, cliArgs, "tasks create");

// MCP usage
const mcpValidation = validateMcpArguments(TaskCreateParametersSchema, mcpArgs, "tasks.create");

// API usage
const apiValidation = validateApiRequest(TaskCreateParametersSchema, requestBody, "POST /tasks");
```

#### Composition Over Duplication
Schemas are built through composition of smaller, reusable components:

```typescript
// Base components
export const TaskIdSchema = z.string().min(1, "Task ID cannot be empty");
export const BaseBackendParametersSchema = z.object({
  backend: BackendIdSchema.optional(),
  repo: RepoIdSchema.optional(),
  // ...
});

// Composed schemas
export const TaskGetParametersSchema = z.object({
  taskId: TaskIdSchema,
}).merge(BaseBackendParametersSchema).merge(BaseExecutionContextSchema);
```

## Usage Examples

### 1. Task Operations

```typescript
import {
  TaskCreateParametersSchema,
  TaskListParametersSchema,
  validateOperationParameters,
  createSuccessResponse,
} from "src/domain/schemas";

// Validate task creation parameters
const createParams = {
  title: "Implement feature X",
  description: "Add new functionality",
  priority: "high",
  backend: "local",
};

const validation = validateOperationParameters(
  TaskCreateParametersSchema,
  createParams,
  "task creation"
);

if (validation.success) {
  // Use validated data
  const task = await createTask(validation.data);
  return createSuccessResponse({ task });
} else {
  // Handle validation error
  return createValidationErrorResponse(validation, "task creation");
}
```

### 2. Session Operations

```typescript
import {
  SessionStartParametersSchema,
  SessionPRParametersSchema,
  validateOperationParameters,
} from "src/domain/schemas";

// Start a new session
const sessionParams = {
  name: "feature-branch",
  description: "Working on feature X",
  task: "123",
  packageManager: "bun",
};

const validation = validateOperationParameters(
  SessionStartParametersSchema,
  sessionParams,
  "session start"
);
```

### 3. File Operations

```typescript
import {
  FileReadSchema,
  FileWriteSchema,
  DirectoryListSchema,
  validateOperationParameters,
} from "src/domain/schemas";

// Read a file with line range
const readParams = {
  sessionName: "my-session",
  path: "src/file.ts",
  start_line_one_indexed: 10,
  end_line_one_indexed_inclusive: 20,
};

const validation = validateOperationParameters(
  FileReadSchema,
  readParams,
  "file read"
);
```

## Integration Patterns

### 1. CLI Integration

```typescript
// In CLI command handler
import { validateCliArguments, TaskCreateParametersSchema } from "src/domain/schemas";

export function createTaskCommand() {
  return new Command("create")
    .option("--title <title>", "Task title")
    .option("--description <description>", "Task description")
    .option("--priority <priority>", "Task priority")
    .action(async (options) => {
      const validation = validateCliArguments(
        TaskCreateParametersSchema,
        options,
        "tasks create"
      );
      
      if (!validation.success) {
        console.error(validation.error);
        process.exit(1);
      }
      
      // Use validated parameters
      await handleTaskCreation(validation.data);
    });
}
```

### 2. MCP Integration

```typescript
// In MCP tool implementation
import { validateMcpArguments, SessionStartParametersSchema } from "src/domain/schemas";

export const sessionStartTool = {
  name: "session.start",
  description: "Start a new development session",
  inputSchema: zodToJsonSchema(SessionStartParametersSchema),
  handler: async (args: unknown) => {
    const validation = validateMcpArguments(
      SessionStartParametersSchema,
      args,
      "session.start"
    );
    
    if (!validation.success) {
      return createValidationErrorResponse(validation, "session start");
    }
    
    // Use validated parameters
    const result = await startSession(validation.data);
    return createSuccessResponse({ session: result });
  },
};
```

### 3. API Integration

```typescript
// In API route handler
import { validateApiRequest, TaskListParametersSchema } from "src/domain/schemas";

app.get("/api/tasks", async (req, res) => {
  const validation = validateApiRequest(
    TaskListParametersSchema,
    req.query,
    "GET /api/tasks"
  );
  
  if (!validation.success) {
    return res.status(400).json(createValidationErrorResponse(validation));
  }
  
  // Use validated parameters
  const tasks = await listTasks(validation.data);
  res.json(createSuccessResponse({ tasks }));
});
```

## Benefits Achieved

### 1. Code Reuse
- **Single source of truth** for domain concepts
- **Same validation logic** across all interfaces
- **Consistent parameter structures** everywhere

### 2. Type Safety
- **Full TypeScript coverage** for all parameters and responses
- **Compile-time validation** of schema usage
- **Autocomplete and IntelliSense** support

### 3. Maintainability
- **Easy updates** - change once, applies everywhere
- **Clear separation** between interface and domain logic
- **Standardized error handling** patterns

### 4. Consistency
- **Identical behavior** across CLI, MCP, and API
- **Uniform response formats** for all interfaces
- **Standard validation messages** and error codes

### 5. Extensibility
- **Easy to add new interfaces** using existing schemas
- **Simple to extend existing schemas** with new fields
- **Modular composition** allows flexible combinations

## Migration Guide

### From MCP-Specific Schemas

The domain-wide schemas replace the MCP-specific schemas from Task #322:

```typescript
// Before (MCP-specific)
import { SessionIdentifierSchema } from "src/adapters/mcp/schemas/common-parameters";

// After (domain-wide)
import { SessionIdSchema } from "src/domain/schemas";
```

### Updating Existing Code

1. **Replace MCP imports** with domain schema imports
2. **Use validation utilities** for consistent error handling
3. **Leverage response builders** for standardized responses
4. **Apply to CLI and API** interfaces using the same schemas

## Future Enhancements

This architecture is designed to support future enhancements:

1. **Additional Domains** - Easy to add git, config, or other domain schemas
2. **API Interfaces** - Ready for REST API or GraphQL implementations
3. **Advanced Validation** - Can extend with custom validation rules
4. **Schema Evolution** - Supports versioning and migration patterns

## Conclusion

The domain-wide schema architecture provides a solid foundation for type-safe, consistent, and maintainable interfaces across the entire Minsky application. By centralizing domain concepts and validation logic, it reduces duplication, improves reliability, and makes the codebase more approachable for new developers. 
