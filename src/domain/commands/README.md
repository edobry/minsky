# Type-Safe Database Command Architecture

This directory implements the new type-safe persistence provider architecture that combines compile-time type safety with runtime capability detection, featuring lazy initialization and clean dependency injection.

## Overview

The architecture consists of three main components:

1. **DatabaseCommand** - Abstract base class for type-safe database commands
2. **CommandDispatcher** - Central dispatcher with lazy initialization and provider injection
3. **DatabaseCommandContext** - Enhanced execution context with guaranteed provider access

## Key Benefits

- **Type Safety**: Full compile-time type checking for command parameters and results
- **Lazy Initialization**: Database connections only created when database commands execute
- **Unified Architecture**: Same command works for both CLI and MCP interfaces
- **Clean Testing**: Commands receive providers via dependency injection, enabling easy mocking
- **Performance**: Non-database commands avoid unnecessary database connections

## Architecture Components

### DatabaseCommand Abstract Base Class

```typescript
import { DatabaseCommand, DatabaseCommandContext } from "../database-command";

export class MyDatabaseCommand extends DatabaseCommand<ParamTypes, ResultType> {
  readonly id = "my.command";
  readonly category = CommandCategory.TASKS;
  readonly name = "my-command";
  readonly description = "Description of what this command does";

  readonly parameters = {
    param1: {
      schema: z.string(),
      spec: "Parameter description",
      required: true,
    },
    // ... more parameters
  } as const;

  async execute(params: ParamTypes, context: DatabaseCommandContext) {
    // Provider is guaranteed to be initialized and available
    const { provider } = context;

    // Use provider for database operations
    const result = await provider.query("SELECT * FROM table WHERE id = $1", [params.param1]);
    return result.rows;
  }
}
```

### CommandDispatcher

The `CommandDispatcher` automatically:

- Detects database commands using `instanceof DatabaseCommand`
- Performs lazy initialization of persistence provider only when needed
- Injects initialized provider into `DatabaseCommandContext`
- Handles non-database commands without database connections

```typescript
// Usage is automatic via CLI and MCP bridges
const result = await commandDispatcher.executeCommand(commandId, params, context);
```

### DatabaseCommandContext

Enhanced execution context that guarantees provider availability:

```typescript
interface DatabaseCommandContext extends CommandExecutionContext {
  provider: PersistenceProvider; // Guaranteed to be initialized
}
```

## Migration Guide

### For New Commands

1. Extend `DatabaseCommand` instead of implementing execute directly
2. Define typed parameters with Zod schemas
3. Use the injected provider from context
4. Register with shared command registry using `getExecutionHandler()`

### For Existing Commands

Existing commands continue to work unchanged. To migrate:

1. Convert to extend `DatabaseCommand`
2. Remove manual `PersistenceService.initialize()` calls
3. Use `context.provider` instead of `PersistenceService.getProvider()`
4. Update parameter definitions to use Zod schemas

## Command Registration

```typescript
import { sharedCommandRegistry } from "../../adapters/shared/command-registry";

// Create command instance
const command = new MyDatabaseCommand();

// Register with shared registry
sharedCommandRegistry.registerCommand({
  id: command.id,
  category: command.category,
  name: command.name,
  description: command.description,
  parameters: command.parameters,
  execute: command.getExecutionHandler(), // Bridges to DatabaseCommand interface
});
```

## Testing Strategy

### Database Command Testing

```typescript
import { createMockProvider } from "../../persistence/testing/mock-provider";

describe("MyDatabaseCommand", () => {
  it("should execute with mocked provider", async () => {
    const command = new MyDatabaseCommand();
    const mockProvider = createMockProvider();

    // Mock provider behavior
    mockProvider.query.mockResolvedValue({ rows: [{ id: "123" }] });

    // Create context with mock provider
    const context: DatabaseCommandContext = {
      interface: "test",
      provider: mockProvider,
    };

    const result = await command.execute({ param1: "test" }, context);

    expect(result).toEqual([{ id: "123" }]);
    expect(mockProvider.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT * FROM table"),
      ["test"]
    );
  });
});
```

### Integration Testing

```typescript
describe("Command Dispatcher Integration", () => {
  it("should initialize provider for database commands", async () => {
    const result = await commandDispatcher.executeCommand(
      "my.database.command",
      { param1: "test" },
      { interface: "test" }
    );

    expect(result.success).toBe(true);
    expect(PersistenceService.isInitialized()).toBe(true);
  });

  it("should not initialize provider for non-database commands", async () => {
    const result = await commandDispatcher.executeCommand(
      "my.regular.command",
      {},
      { interface: "test" }
    );

    expect(result.success).toBe(true);
    // Provider initialization is not required for non-database commands
  });
});
```

## Performance Considerations

### Lazy Initialization Benefits

- CLI commands that don't need database access start faster
- Memory usage is reduced for non-database operations
- Connection pooling is optimized for actual usage patterns

### Single-Flight Initialization

- Prevents race conditions during concurrent command execution
- Ensures only one initialization attempt occurs per process
- Handles initialization failures gracefully

## Error Handling

### Database Command Errors

```typescript
async execute(params: ParamTypes, context: DatabaseCommandContext) {
  const { provider } = context;

  try {
    return await provider.query("SELECT ...", params);
  } catch (error) {
    // Handle database-specific errors
    if (error.code === "23505") { // Unique constraint violation
      throw new Error(`Duplicate entry for ${params.id}`);
    }
    throw error; // Re-throw other errors
  }
}
```

### Dispatcher Error Handling

The CommandDispatcher wraps all errors in a consistent format:

```typescript
{
  success: false,
  error: {
    message: "Error description",
    type: "EXECUTION_ERROR" | "COMMAND_NOT_FOUND" | "VALIDATION_ERROR",
    details?: any // Additional error context
  }
}
```

## Command Development Best Practices

1. **Use Zod for Parameter Validation**: All parameters should have proper Zod schemas
2. **Implement Proper Error Messages**: Provide user-friendly error messages
3. **Handle Database Constraints**: Convert database errors to meaningful messages
4. **Use Transactions**: For multi-step operations, use provider transaction support
5. **Test with Mocks**: Use dependency injection for comprehensive testing
6. **Document Parameters**: Provide clear `spec` descriptions for all parameters

## Examples

See `examples/database-command-example.ts` for comprehensive examples showing:

- Simple database queries
- Complex multi-operation commands
- Custom error handling
- Parameter validation
- Registration patterns

## Related Documentation

- [ADR-002: Persistence Provider Architecture](../../../docs/architecture/adr-002-persistence-provider-architecture.md)
- [Command Registry Documentation](../../adapters/shared/command-registry.ts)
- [Testing Best Practices](../../../docs/testing/test-architecture-documentation.md)
