# Validation and Error Handling in Minsky

## Overview

Minsky uses a comprehensive validation and error handling approach to ensure consistent behavior across all interfaces (CLI, MCP, etc.). This document outlines the validation patterns and error handling strategies implemented in the interface-agnostic command architecture.

## Validation Patterns

### Schema-Based Validation with Zod

Minsky uses [Zod](https://github.com/colinhacks/zod) for schema validation throughout the codebase:

```typescript
// Example of a Zod schema for task listing parameters
const taskListParamsSchema = z.object({
  filter: z.string().optional().describe("Filter tasks by status or other criteria"),
  limit: z.number().optional().describe("Limit the number of tasks returned"),
  includeCompleted: z.boolean().optional().describe("Include completed tasks"),
});

// Type inference from schema
type TaskListParams = z.infer<typeof taskListParamsSchema>;
```

### Key Benefits of Schema-Based Validation

1. **Single Source of Truth**: The same schema is used for both CLI and MCP interfaces
2. **Runtime Validation**: Parameters are validated at runtime, not just compile time
3. **Self-Documenting**: Schemas include descriptions used for help text and documentation
4. **Type Safety**: TypeScript types are derived from schemas, ensuring consistency

### Validation Layers

Validation occurs at multiple layers:

1. **Interface Layer**: Basic validation of input format (CLI args, JSON payloads)
2. **Schema Layer**: Structural validation using Zod schemas
3. **Domain Layer**: Business rule validation in domain functions
4. **Persistence Layer**: Final validation before data storage

## Error Handling Strategy

### Error Types

Minsky implements a structured error handling system with specific error types:

1. **ValidationError**: For schema validation failures
2. **NotFoundError**: When requested resources don't exist
3. **PermissionError**: For access control violations
4. **ConfigurationError**: For system configuration issues
5. **ExternalServiceError**: For failures in external services or dependencies
6. **OperationError**: For general operation failures

### Error Structure

All errors follow a consistent structure:

```typescript
interface MinskyError {
  code: string; // Error code for programmatic handling
  message: string; // Human-readable error message
  details?: unknown; // Optional additional context
  cause?: Error; // Original error that caused this one
}
```

### Interface-Specific Error Handling

Each interface adapter handles errors according to its context:

#### CLI Error Handling

```typescript
try {
  const result = await domainFunction(params);
  // Format and display result
} catch (error) {
  if (error instanceof ValidationError) {
    console.error(`Invalid parameters: ${error.message}`);
    // Show help text if applicable
    process.exit(1);
  } else if (error instanceof NotFoundError) {
    console.error(`Not found: ${error.message}`);
    process.exit(2);
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
```

#### MCP Error Handling

```typescript
commandMapper.addTaskCommand("list", "List all tasks", taskListParamsSchema, async (args) => {
  try {
    const result = await listTasks(args);
    return result; // Success case
  } catch (error) {
    // Format error for MCP client
    return {
      error: {
        code: error instanceof MinskyError ? error.code : "UNKNOWN_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
});
```

## Validation Examples

### Task Status Validation

```typescript
// In domain layer
export async function setTaskStatus(id: string, status: string): Promise<void> {
  // Validate the status is a known value
  if (!Object.values(TASK_STATUS).includes(status as TaskStatus)) {
    throw new ValidationError(
      `Invalid status: ${status}. Must be one of: ${Object.values(TASK_STATUS).join(", ")}`
    );
  }

  // Validate the task exists
  const task = await getTask(id);
  if (!task) {
    throw new NotFoundError(`Task ${id} not found`);
  }

  // Proceed with implementation...
}
```

### Session Creation Validation

```typescript
// Using Zod for parameter validation
const sessionStartParamsSchema = z.object({
  name: z.string().optional(),
  task: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  quiet: z.boolean().optional(),
});

// In domain function
export async function startSessionFromParams(
  params: z.infer<typeof sessionStartParamsSchema>
): Promise<Session> {
  // Additional validation logic
  if (!params.repo && !params.task) {
    throw new ValidationError("Either repo or task must be provided");
  }

  // Implementation...
}
```

## Best Practices

### For CLI Commands

1. **Use Commander.js Options**: Leverage Commander.js for basic CLI option parsing
2. **Call Domain Functions**: Call domain functions with validated parameters
3. **Handle Errors**: Format errors appropriately for command-line context
4. **Provide Help**: Include detailed help text for each command

### For MCP Tools

1. **Use Zod Schemas**: Define parameters using Zod schemas
2. **Return Structured Data**: Return well-structured JSON responses
3. **Handle Errors Consistently**: Format errors in a consistent way for clients
4. **Include Descriptive Messages**: Ensure error messages are helpful

### For Domain Functions

1. **Validate Early**: Validate all parameters at the beginning of functions
2. **Throw Typed Errors**: Use specific error types for different failure cases
3. **Preserve Context**: Include relevant context in error details
4. **Document Requirements**: Clearly document validation requirements

## Testing Validation and Error Handling

```typescript
// Example test for validation
test("should reject invalid task status", async () => {
  // Arrange
  const taskId = "#001";
  const invalidStatus = "INVALID_STATUS";

  // Act & Assert
  await expect(setTaskStatus(taskId, invalidStatus)).rejects.toThrow(/Invalid status/);
});

// Example test for error propagation
test("should format errors appropriately in CLI", async () => {
  // Arrange
  const mockConsole = jest.spyOn(console, "error").mockImplementation();
  const mockExit = jest.spyOn(process, "exit").mockImplementation();

  // Act
  await executeCliCommand(["tasks", "status", "set", "#999", "INVALID"]);

  // Assert
  expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining("Invalid status"));
  expect(mockExit).toHaveBeenCalledWith(1);

  // Cleanup
  mockConsole.mockRestore();
  mockExit.mockRestore();
});
```

## Conclusion

Minsky's validation and error handling approach ensures:

1. **Consistency**: The same validation rules apply across all interfaces
2. **Clarity**: Users receive clear and helpful error messages
3. **Robustness**: The system handles errors gracefully at all levels
4. **Extensibility**: New validation rules can be added without breaking existing code

By following these patterns, Minsky maintains a reliable and user-friendly experience regardless of which interface is used to access its functionality.
