# Apply Type Composition Patterns to CLI Adapters

## Context

Apply the type composition patterns established in Task #322 and extended in Task #329 to CLI adapters, creating standardized parameter handling, response formatting, and error handling across all CLI commands.

## Context

While Task #322 focused on MCP tools and Task #329 creates domain-wide schemas, CLI adapters in src/adapters/cli/ currently have inconsistent patterns for parameter validation, response formatting, and error handling. This task standardizes CLI adapters to use the same type composition patterns.

## Requirements

### 1. CLI Parameter Standardization

Standardize CLI parameter handling using domain schemas for validation consistency across all commands.

### 2. CLI Response Standardization

Create standardized response formatting for both JSON and human-readable output across all CLI commands.

### 3. CLI Error Handling Standardization

Implement consistent error handling patterns with proper exit codes and user-friendly messages.

### 4. CLI Command Composition

Create composable CLI command patterns that use Zod schemas for validation.

## Benefits

1. Consistency: Identical parameter validation logic across CLI and MCP
2. Type Safety: Full TypeScript coverage for CLI parameters
3. Maintainability: Shared validation logic reduces duplication
4. User Experience: Consistent error messages and output formatting
5. Developer Experience: Composable patterns for creating new CLI commands

## Dependencies

- Task #329 must be completed first to provide domain schemas
- Builds on patterns established in Task #322

## Solution

Successfully implemented standardized parameter handling, response formatting, and error handling patterns for CLI adapters, building on the type composition work from Tasks #322 and #329.

### Implementation Overview

Applied the type composition patterns established in Tasks #322 and #329 to CLI adapters through:

1. **CLI Parameter Schemas** (`src/adapters/cli/schemas/cli-parameter-schemas.ts`)
   - CLI-specific parameter schemas extending domain schemas
   - Composable schema patterns with `createCliCommandSchema()`, `createCliListingCommandSchema()`, `createCliCrudCommandSchema()`
   - Standardized CLI options (json, quiet, verbose, debug, format, verbosity)
   - Type-safe parameter validation using Zod schemas

2. **CLI Response Schemas** (`src/adapters/cli/schemas/cli-response-schemas.ts`)
   - Enhanced CLI response schemas with metadata
   - Response builders: `createCliSuccessResponse()`, `createCliErrorResponse()`
   - Generic output formatter: `formatCliOutput()`
   - Specialized formatters: `formatTaskListOutput()`, `formatSessionListOutput()`
   - Verbosity-aware formatting (quiet, normal, verbose, debug)

3. **Standardized Error Handler** (`src/adapters/cli/utils/standardized-error-handler.ts`)
   - Standardized CLI exit codes following conventions
   - Error categorization with recovery suggestions
   - Enhanced error handler: `handleStandardizedCliError()`
   - Parameter validation: `validateCliParameters()`
   - Command execution wrappers: `withErrorHandling()`, `withParameterValidation()`

4. **Composable CLI Command Patterns** (`src/adapters/cli/patterns/composable-cli-commands.ts`)
   - Command builder functions for standardized CLI commands
   - High-level command factories: `createTaskListCommand()`, `createTaskGetCommand()`, etc.
   - Command registration helpers
   - Integrated parameter validation, response formatting, and error handling

5. **Migration Example** (`src/adapters/cli/customizations/standardized-tasks-customizations.ts`)
   - Demonstrates migration from manual parameter definitions to schema-based validation
   - Shows standardized response formatting integration
   - Provides comprehensive migration guide and examples

### Key Benefits Achieved

1. **Consistency**: Identical parameter validation logic across CLI and MCP interfaces
2. **Type Safety**: Full TypeScript coverage with Zod schema validation  
3. **Maintainability**: Reduced code duplication through composable patterns
4. **Developer Experience**: Clear composition patterns for creating new CLI commands
5. **User Experience**: Consistent command-line interface with helpful error messages

### Example Usage

```typescript
// CLI parameter validation
const CliTaskListParametersSchema = TaskListParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    status: z.array(TaskStatusSchema).optional(),
    completed: AllSchema,
  });

// Standardized response formatting
const response = createCliSuccessResponse(
  { result: tasks },
  { command: "tasks.list", format: "text", verbosity: "normal" }
);
formatCliOutput(response, options, formatTaskListOutput);

// Error handling with proper exit codes
try {
  const params = validateCliParameters(schema, rawParams, "tasks.list");
  // ... command execution
} catch (error) {
  handleStandardizedCliError(error, "tasks.list", options);
}
```

### Testing & Validation

- ✅ Created and ran test suite to verify schema imports and functionality
- ✅ Validated parameter schema composition works correctly
- ✅ Confirmed response builders and formatters function properly
- ✅ Verified error handling patterns integrate correctly

## Notes

This implementation establishes a comprehensive foundation for standardized CLI command development that can be applied to all remaining CLI command categories (git, session, config, rules) to ensure consistency and maintainability across the entire CLI interface.

The patterns created here directly extend the type composition work from Tasks #322 and #329, providing a unified approach to parameter validation, response formatting, and error handling across CLI, MCP, and future API interfaces.
