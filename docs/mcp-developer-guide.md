# MCP Developer Guide

## Adding New MCP Commands to Minsky

This guide provides step-by-step instructions for adding new MCP commands to Minsky, following the established dual architecture and standardized error handling patterns.

## Architecture Decision Tree

Before adding a new MCP command, determine which system to use:

### Use **Direct MCP Tools** if:
- ✅ Session workspace operations (file operations, content manipulation)
- ✅ High-performance requirements (frequent calls, low latency needs)
- ✅ Complex file handling (line ranges, content processing, path resolution)
- ✅ Rich error context needed (semantic error classification)

### Use **Bridged MCP Tools** if:
- ✅ Management operations (task management, configuration, git operations)  
- ✅ Shared business logic with CLI commands
- ✅ Parameter consistency requirements across interfaces
- ✅ Standard CRUD operations

## Adding Direct MCP Tools

### Step 1: Identify the Target File

Choose the appropriate file based on functionality:
- **`session-files.ts`**: File operations (read, write, create, delete, move, rename)
- **`session-edit-tools.ts`**: Content editing and modification
- **`session-workspace.ts`**: Workspace operations (search, validation, listing)

### Step 2: Define Parameters Using Shared Schemas

```typescript
// Use existing schemas from shared-schemas.ts
import { 
  SessionIdentifierSchema, 
  FilePathSchema, 
  LineRangeSchema,
  CreateDirectoriesSchema 
} from "../shared-schemas";

// Define command parameters
const myOperationParams = z.object({
  sessionName: SessionIdentifierSchema,
  path: FilePathSchema,
  // Add operation-specific parameters
  myParam: z.string().describe("Description of my parameter"),
  optional: z.boolean().optional().default(false).describe("Optional parameter"),
});
```

### Step 3: Implement the Command Handler

```typescript
// Use standardized error handling wrapper
commandMapper.addCommand({
  name: "session.my_operation",
  description: "Description of what this operation does",
  parameters: myOperationParams,
  handler: withStandardizedMcpErrorHandling("session.my_operation", async (args) => {
    // Path resolution with session workspace isolation
    const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);
    
    // Validate path exists if needed
    await pathResolver.validatePathExists(resolvedPath);
    
    // Implementation logic
    const result = await performOperation(resolvedPath, args.myParam);
    
    // Log success
    log.debug("Operation completed successfully", {
      session: args.sessionName,
      path: args.path,
      result: result.summary,
    });
    
    // Return structured response
    return {
      success: true,
      path: args.path,
      session: args.sessionName,
      resolvedPath: relative(
        await pathResolver.getSessionWorkspacePath(args.sessionName),
        resolvedPath
      ),
      result: result.data,
      // Add operation-specific response fields
      myResult: result.mySpecificData,
    };
  }),
});
```

### Step 4: Add to Schema Definitions (if needed)

If you need new reusable parameter schemas, add them to `shared-schemas.ts`:

```typescript
// Add new base schema
export const MyParameterSchema = z.object({
  myField: z.string().describe("Description of field"),
  options: z.array(z.string()).optional().describe("Optional array of options"),
});

// Add composed schema if it will be reused
export const MyOperationSchema = z.object({
  sessionName: SessionIdentifierSchema,
  path: FilePathSchema,
  config: MyParameterSchema,
});
```

## Adding Bridged MCP Tools

### Step 1: Add to Shared Command Registry

Create or extend a shared command file in `src/adapters/shared/commands/`:

```typescript
// src/adapters/shared/commands/my-category.ts
import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
} from "../command-registry";
import { 
  CommonParameters,
  composeParams 
} from "../common-parameters";

// Define parameters using shared libraries
const myCommandParams = composeParams(
  {
    // Use common parameters where possible
    repo: CommonParameters.repo,
    debug: CommonParameters.debug,
    json: CommonParameters.json, // Will be filtered out in MCP
  },
  {
    // Add command-specific parameters
    myParam: {
      schema: z.string(),
      description: "My command-specific parameter",
      required: true,
    },
    optional: {
      schema: z.boolean().optional(),
      description: "Optional parameter",
      required: false,
      defaultValue: false,
    },
  }
);

// Register the command
export function registerMyCommands() {
  sharedCommandRegistry.registerCommand({
    id: "my.command",
    category: CommandCategory.MY_CATEGORY, // Add new category if needed
    name: "my-command",
    description: "Description of what this command does",
    parameters: myCommandParams,
    execute: async (params: any, context: CommandExecutionContext) => {
      // Implementation logic
      const result = await performMyOperation(params);
      
      // Return result (format will be standardized automatically)
      return {
        success: true,
        data: result,
        // Add command-specific response fields
      };
    },
  });
}
```

### Step 2: Create MCP Adapter

Create a new MCP adapter file or extend an existing one:

```typescript
// src/adapters/mcp/my-category.ts
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerMyCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

export function registerMyTools(commandMapper: CommandMapper): void {
  log.debug("Registering my commands via shared command integration");

  registerMyCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "my.command": {
        description: "MCP-specific description if different from shared command",
      },
      "my.hidden": {
        hidden: true, // Hide specific commands from MCP if needed
      },
    },
  });

  log.debug("My commands registered successfully via shared integration");
}
```

### Step 3: Add Bridge Function

Add the bridge function to `shared-command-integration.ts`:

```typescript
// Add to existing shared-command-integration.ts
export function registerMyCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.MY_CATEGORY],
    ...config,
  });
}
```

### Step 4: Register with MCP Server

Add to the main MCP server registration in `src/mcp/server.ts`:

```typescript
// Import the new adapter
import { registerMyTools } from "../adapters/mcp/my-category";

// Register in the server setup
registerMyTools(commandMapper);
```

## Parameter Best Practices

### Naming Conventions
- Use `sessionName` for session identifiers (consistent with direct MCP tools)
- Use descriptive parameter names: `targetPath` instead of `path2`
- Follow camelCase for parameter names
- Use kebab-case for command names: `my-command` not `myCommand`

### Parameter Composition
```typescript
// ✅ Good: Compose from shared parameters
const params = composeParams(
  {
    sessionName: CommonParameters.sessionName,
    debug: CommonParameters.debug,
  },
  {
    specificParam: MyCommandParameters.specificParam,
  }
);

// ❌ Bad: Duplicate parameter definitions
const params = {
  sessionName: {
    schema: z.string(),
    description: "Session identifier", // Duplicated!
    required: false,
  },
  // ...
};
```

### Validation and Types
```typescript
// ✅ Good: Use specific types with validation
myParam: {
  schema: z.enum(["option1", "option2", "option3"]),
  description: "Choose from available options",
  required: true,
},

// ✅ Good: Use Zod refinements for complex validation  
path: {
  schema: z.string().refine(
    (path) => !path.includes(".."), 
    "Path cannot contain '..' for security"
  ),
  description: "Target file path",
  required: true,
},
```

## Error Handling Best Practices

### Direct MCP Tools

```typescript
// ✅ Good: Use withStandardizedMcpErrorHandling wrapper
handler: withStandardizedMcpErrorHandling("operation.name", async (args) => {
  // Implementation logic - errors automatically handled
  return result;
});

// ✅ Good: Manual error handling with classification
handler: async (args): Promise<McpResponse> => {
  try {
    const result = await operation(args);
    return createMcpSuccessResponse(result, {
      operation: "operation.name",
      session: args.sessionName,
    });
  } catch (error) {
    return classifyErrorForMcp(error, {
      operation: "operation.name",
      session: args.sessionName,
      path: args.path,
      debug: args.debug,
    });
  }
};
```

### Bridged MCP Tools

```typescript
// ✅ Good: Let shared command integration handle errors automatically
execute: async (params, context) => {
  // Throw errors normally - they'll be handled automatically
  if (!params.requiredParam) {
    throw new ValidationError("Required parameter missing");
  }
  
  const result = await operation(params);
  return result; // Success responses handled automatically
},
```

### Custom Error Messages

```typescript
// ✅ Good: Provide helpful error messages and suggestions
throw new Error(
  `Session '${sessionName}' not found. ` +
  `Use session.list to see available sessions or session.start to create a new one.`
);

// ✅ Good: Include context in error messages
throw new Error(
  `File '${args.path}' not found in session '${args.sessionName}'. ` +
  `Check the file path and ensure it exists in the session workspace.`
);
```

## Testing New MCP Commands

### Manual Testing with MCP Inspector

```bash
# Start Minsky MCP server
minsky mcp

# Test command using MCP inspector or direct calls
```

### Integration Testing

```typescript
// Example test structure
describe("my.command MCP integration", () => {
  let commandMapper: CommandMapper;
  
  beforeEach(() => {
    commandMapper = new CommandMapper();
    registerMyTools(commandMapper);
  });
  
  it("should execute command successfully", async () => {
    const result = await commandMapper.executeCommand("my.command", {
      sessionName: "test-session",
      myParam: "test-value",
    });
    
    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
  });
  
  it("should handle validation errors", async () => {
    const result = await commandMapper.executeCommand("my.command", {
      // Missing required parameters
    });
    
    expect(result.success).toBe(false);
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});
```

## Common Patterns and Examples

### File Operation Pattern (Direct MCP)

```typescript
// Pattern for file operations with proper error handling
handler: withStandardizedMcpErrorHandling("session.read_config", async (args) => {
  const resolvedPath = await pathResolver.resolvePath(args.sessionName, ".minsky/config.json");
  
  if (!(await pathResolver.pathExists(resolvedPath))) {
    throw new Error(
      `Configuration file not found in session '${args.sessionName}'. ` +
      `Run 'session.init' to create default configuration.`
    );
  }
  
  const content = await readFile(resolvedPath, "utf8");
  const config = JSON.parse(content);
  
  return {
    success: true,
    config,
    path: ".minsky/config.json",
    session: args.sessionName,
  };
});
```

### Management Operation Pattern (Bridged MCP)

```typescript
// Pattern for management operations using shared commands
export function registerTaskCommands() {
  sharedCommandRegistry.registerCommand({
    id: "tasks.update",
    category: CommandCategory.TASKS,
    parameters: composeParams(
      {
        taskId: TaskParameters.taskId,
        repo: CommonParameters.repo,
        debug: CommonParameters.debug,
      },
      {
        title: {
          schema: z.string().optional(),
          description: "New task title",
          required: false,
        },
        status: {
          schema: z.enum(["TODO", "IN-PROGRESS", "DONE"]).optional(),
          description: "New task status",
          required: false,
        },
      }
    ),
    execute: async (params, context) => {
      const taskProvider = createTaskProvider(params.repo);
      const task = await taskProvider.getTask(params.taskId);
      
      if (!task) {
        throw new Error(`Task #${params.taskId} not found`);
      }
      
      if (params.title) task.title = params.title;
      if (params.status) task.status = params.status;
      
      await taskProvider.updateTask(task);
      
      return {
        success: true,
        task,
        updated: Object.keys(params).filter(k => k !== 'taskId' && k !== 'repo'),
      };
    },
  });
}
```

## Troubleshooting

### Common Issues

**Command not appearing in MCP**
- Check that the command is registered with the command mapper
- Verify the command is not marked as `hidden: true`
- Ensure the category is included in the bridge registration

**Parameter validation failing**
- Check parameter schema definitions
- Verify required vs optional parameter settings
- Test parameter parsing with simple values first

**Error responses not standardized**
- For direct MCP tools: Use `withStandardizedMcpErrorHandling()` wrapper
- For bridged tools: Ensure command is registered through shared-command-integration
- Check error response format matches `McpResponse` schema

**TypeScript compilation errors**
- Verify imports are correct
- Check that new schemas are exported from shared-schemas.ts
- Ensure parameter composition follows established patterns

### Debug Mode

Enable debug mode for detailed logging:

```typescript
// For direct MCP tools
const debug = args.debug || false;

// For bridged MCP tools  
const context: CommandExecutionContext = {
  interface: "mcp",
  debug: args?.debug || false,
  format: "json",
};
```

---

*This developer guide reflects the architecture established in Task #322 and enhanced in Task #288.*