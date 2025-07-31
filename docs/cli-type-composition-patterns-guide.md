# CLI Type Composition Patterns Guide

This guide documents the standardized CLI patterns implemented in Task #335, which apply the type composition work from Tasks #322 and #329 to CLI adapters.

## Overview

The CLI type composition patterns provide:
- **Standardized parameter validation** using Zod schemas
- **Consistent response formatting** for JSON and human-readable output
- **Enhanced error handling** with proper exit codes
- **Composable command patterns** for easy extension
- **Type safety** throughout the CLI layer

## Core Components

### 1. CLI Parameter Schemas (`src/adapters/cli/schemas/cli-parameter-schemas.ts`)

Defines standardized parameter validation schemas that extend domain schemas:

```typescript
import { createCliCommandSchema } from "../schemas/cli-parameter-schemas";
import { z } from "zod";

// Domain-specific schema
const MyCommandParametersSchema = z.object({
  name: z.string().min(1, "Name is required"),
  force: z.boolean().default(false),
});

// CLI schema with standardized options
const CliMyCommandParametersSchema = createCliCommandSchema(MyCommandParametersSchema);
```

#### Key Features:
- **Automatic CLI option inclusion**: `json`, `quiet`, `verbose`, `debug`, `format`, `verbosity`
- **Composable patterns**: `createCliCommandSchema()`, `createCliListingCommandSchema()`, `createCliCrudCommandSchema()`
- **Type safety**: Full TypeScript validation for command parameters

### 2. CLI Response Schemas (`src/adapters/cli/schemas/cli-response-schemas.ts`)

Provides standardized response formatting:

```typescript
import {
  createCliSuccessResponse,
  formatCliOutput,
} from "../schemas/cli-response-schemas";

// Create standardized response
const response = createCliSuccessResponse(
  { result: data, message: "Operation completed" },
  {
    command: "my.command",
    format: "text",
    verbosity: "normal",
  }
);

// Format and output
formatCliOutput(response, options);
```

#### Output Formats Supported:
- **JSON**: Structured data output
- **Text**: Human-readable formatting
- **Table**: Tabular data display (future)
- **YAML**: YAML format output (future)

### 3. Standardized Error Handler (`src/adapters/cli/utils/standardized-error-handler.ts`)

Enhanced error handling with proper exit codes:

```typescript
import {
  validateCliParameters,
  handleStandardizedCliError,
} from "../utils/standardized-error-handler";

try {
  const validatedParams = validateCliParameters(
    CliMyCommandParametersSchema,
    rawParams,
    "my.command",
    options
  );
  // Use validated parameters...
} catch (error) {
  handleStandardizedCliError(error, "my.command", options);
}
```

#### Error Categories:
- **Validation errors**: Parameter validation failures
- **Resource errors**: File/network/service issues
- **Authentication errors**: Permission and access issues
- **Configuration errors**: Setup and config problems

### 4. Composable Command Patterns (`src/adapters/cli/patterns/composable-cli-commands.ts`)

High-level patterns for creating CLI commands:

```typescript
import {
  createStandardCliCommand,
  createListingCommand,
  createCrudCommand,
} from "../patterns/composable-cli-commands";

// Create a standard command with full validation and formatting
const myCommand = createStandardCliCommand({
  commandId: "my.command",
  parameterSchema: CliMyCommandParametersSchema,
  handler: async (params, context) => {
    // Command implementation
    return { success: true, data: result };
  },
});
```

## CLI Bridge Integration

### Schema-Based Validation

The CLI bridge now supports `parameterSchema` property for automatic validation:

```typescript
import { CliCommandOptions } from "../shared/bridges/cli-bridge";

const commandOptions: CliCommandOptions = {
  // Automatic parameter validation using Zod schemas
  parameterSchema: CliMyCommandParametersSchema,
  
  // Traditional parameter definitions (optional when using schema)
  parameters: {
    name: {
      description: "Name of the resource",
    },
    force: {
      description: "Force the operation",
    },
  },
};
```

### Migration Path

1. **Add `parameterSchema`** to existing command options
2. **Keep existing `parameters`** for backwards compatibility
3. **Test schema validation** in development
4. **Remove manual parameter definitions** once schema validation is confirmed

## Creating New CLI Commands

### Step 1: Define Domain Schema

```typescript
// In src/domain/schemas/my-domain-schemas.ts
import { z } from "zod";

export const MyCommandParametersSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  force: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
});
```

### Step 2: Create CLI Schema

```typescript
// In your customizations file
import { createCliCommandSchema } from "../schemas/cli-parameter-schemas";

const CliMyCommandParametersSchema = createCliCommandSchema(MyCommandParametersSchema);
```

### Step 3: Add Command Customization

```typescript
// In your category customizations
export function getMyCustomizations() {
  return {
    category: CommandCategory.MY_CATEGORY,
    options: {
      commandOptions: {
        "my.command": {
          parameterSchema: CliMyCommandParametersSchema,
          parameters: {
            name: {
              asArgument: true,
              description: "Name of the resource",
            },
            force: {
              description: "Force the operation",
            },
            // Standardized CLI options are automatically included
            json: {
              description: "Output in JSON format",
            },
          },
          outputFormatter: (result: any) => {
            const options = {
              json: result.json,
              quiet: result.quiet,
              verbose: result.verbose,
              format: result.format,
            };

            try {
              const validatedParams = validateCliParameters(
                CliMyCommandParametersSchema,
                result,
                "my.command",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.data },
                {
                  command: "my.command",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);
            } catch (error) {
              handleStandardizedCliError(error, "my.command", options);
            }
          },
        },
      },
    },
  };
}
```

### Step 4: Register Customizations

```typescript
// In CLI setup
import { getMyCustomizations } from "./customizations/my-customizations";

const customizations = getMyCustomizations();
cliFactory.customizeCategory(customizations.category, customizations.options);
```

## Migration from Legacy Patterns

### Identifying Legacy Patterns

Legacy CLI customizations typically:
- Use manual parameter definitions without schemas
- Have inconsistent error handling
- Lack standardized output formatting
- Don't include all standard CLI options

### Migration Steps

1. **Create domain schema** for the command parameters
2. **Generate CLI schema** using `createCliCommandSchema()`
3. **Add `parameterSchema`** to command options
4. **Update output formatter** to use standardized patterns
5. **Add schema validation** in the formatter
6. **Test thoroughly** to ensure compatibility

### Before (Legacy Pattern)

```typescript
"my.command": {
  parameters: {
    name: {
      asArgument: true,
      description: "Name of the resource",
    },
    force: {
      description: "Force the operation",
    },
    json: {
      description: "Output in JSON format",
    },
  },
  outputFormatter: (result: any) => {
    if (result.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Created: ${result.name}`);
    }
  },
}
```

### After (Standardized Pattern)

```typescript
"my.command": {
  parameterSchema: CliMyCommandParametersSchema,
  parameters: {
    name: {
      asArgument: true,
      description: "Name of the resource",
    },
    force: {
      description: "Force the operation",
    },
    // Standardized options included automatically
  },
  outputFormatter: (result: any) => {
    const options = {
      json: result.json,
      quiet: result.quiet,
      verbose: result.verbose,
      format: result.format,
      verbosity: result.verbosity,
    };

    try {
      const validatedParams = validateCliParameters(
        CliMyCommandParametersSchema,
        result,
        "my.command",
        options
      );

      const response = createCliSuccessResponse(
        { result: result.data },
        {
          command: "my.command",
          format: options.format || "text",
          verbosity: options.verbosity || "normal",
        }
      );

      formatCliOutput(response, options);
    } catch (error) {
      handleStandardizedCliError(error, "my.command", options);
    }
  },
}
```

## Best Practices

### 1. Schema Design

- **Use descriptive validation messages**: Help users understand requirements
- **Provide sensible defaults**: Reduce required parameters where possible
- **Compose from domain schemas**: Reuse validation logic across interfaces
- **Include examples in descriptions**: Show users expected formats

### 2. Response Formatting

- **Always use standardized response creators**: Ensure consistent output structure
- **Support all output formats**: JSON, text, and future formats
- **Respect verbosity levels**: Adjust output detail based on user preference
- **Include helpful success messages**: Confirm operations completed

### 3. Error Handling

- **Use standardized error handlers**: Ensure consistent error formatting
- **Provide actionable error messages**: Help users fix issues
- **Include proper exit codes**: Support scripting and automation
- **Log validation failures appropriately**: Aid in debugging

### 4. Testing

- **Test all parameter combinations**: Ensure schema validation works
- **Verify output formats**: Check JSON, text, and quiet modes
- **Test error scenarios**: Ensure proper error handling
- **Validate backwards compatibility**: Ensure existing users aren't broken

## Examples by Category

### Task Commands

```bash
# Standardized task commands with full validation
minsky tasks list --status TODO --json
minsky tasks create --title "New task" --description "Task description" --verbose
minsky tasks get 123 --format table
```

### Session Commands

```bash
# Standardized session commands with enhanced formatting
minsky session start --task 123 --quiet
minsky session list --current --verbose
minsky session pr --title "Fix bug" --body-path ./description.md
```

### Git Commands

```bash
# Standardized git commands with consistent validation
minsky git commit -m "Fix issue" --json
minsky git branch feature-branch --verbose
minsky git status --short --quiet
```

## Troubleshooting

### Schema Validation Errors

If you see validation errors:
1. Check parameter names match schema definitions
2. Verify required parameters are provided
3. Ensure parameter types match schema expectations
4. Review schema validation messages for guidance

### Output Formatting Issues

If output doesn't appear correctly:
1. Verify `formatCliOutput` is being called
2. Check that response structure matches expected format
3. Ensure output options are properly extracted
4. Test with different verbosity and format settings

### CLI Bridge Integration

If schema validation isn't working:
1. Confirm `parameterSchema` is set in command options
2. Verify CLI bridge has been updated to support schemas
3. Check that validation import paths are correct
4. Test with simpler schemas first

## Future Enhancements

### Planned Features

1. **Enhanced Output Formats**: Table and YAML formatting
2. **Interactive Mode**: Prompt for missing required parameters
3. **Auto-completion**: Generate shell completions from schemas
4. **Validation Caching**: Improve performance for complex schemas
5. **Custom Formatters**: Easy plugin system for output formatting

### Migration Roadmap

1. **Phase 1**: Core patterns established (Task #335) ✅
2. **Phase 2**: CLI bridge integration complete
3. **Phase 3**: All command categories migrated
4. **Phase 4**: Legacy patterns removed
5. **Phase 5**: Advanced features implemented

This guide provides the foundation for creating consistent, well-validated CLI commands using the type composition patterns from Task #335. 
