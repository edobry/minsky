# MCP Architecture Documentation

## Overview

The Minsky MCP (Model Context Protocol) implementation uses a **dual architecture** approach to provide a comprehensive set of tools while maintaining separation of concerns and optimizing for different use cases.

This document explains the architecture established during Task #322 (parameter deduplication) and enhanced during Task #288 (MCP improvements and consistency audit).

## Dual Architecture Overview

### Architecture Diagram

```
MCP Client (Cursor, etc.)
        │
        ├── Direct MCP Tools (Session Workspace Operations)
        │   ├── session-files.ts
        │   ├── session-edit-tools.ts  
        │   └── session-workspace.ts
        │       └── shared-schemas.ts (409 lines)
        │           ├── SessionIdentifierSchema
        │           ├── FilePathSchema
        │           ├── LineRangeSchema
        │           └── 15+ composed schemas
        │
        └── Bridged MCP Tools (Management Commands)
            ├── tasks.ts, git.ts, rules.ts, session.ts, init.ts, debug.ts
            └── shared-command-integration.ts
                └── common-parameters.ts (382 lines)
                    ├── CommonParameters.*
                    ├── GitParameters.*
                    ├── SessionParameters.*
                    └── RulesParameters.*
```

### System 1: Direct MCP Tools

**Purpose**: Session-scoped workspace operations requiring high performance and detailed file handling

**Files**:
- `src/adapters/mcp/session-files.ts` - File operations (read, write, list, delete, move, rename)
- `src/adapters/mcp/session-edit-tools.ts` - File editing and search/replace operations  
- `src/adapters/mcp/session-workspace.ts` - Workspace operations (grep search, file existence checks)

**Parameter System**: `src/adapters/mcp/shared-schemas.ts`
- Direct Zod schema definitions
- 17+ base parameter schemas (SessionIdentifierSchema, FilePathSchema, etc.)
- 15+ composed schemas for specific operations
- Optimized for file operations with rich type safety

**Error Handling**: Sophisticated semantic error classification via `SemanticErrorClassifier`

**Key Features**:
- High-performance file operations
- Rich error context and recovery suggestions
- Line range support for file reading
- Directory creation automation
- Path validation and resolution

### System 2: Bridged MCP Tools

**Purpose**: Management operations leveraging existing shared command infrastructure

**Files**:
- `src/adapters/mcp/tasks.ts` - Task management operations
- `src/adapters/mcp/git.ts` - Git operations (mostly hidden in MCP)
- `src/adapters/mcp/rules.ts` - Rule management operations
- `src/adapters/mcp/session.ts` - Session management operations  
- `src/adapters/mcp/init.ts` - Project initialization
- `src/adapters/mcp/debug.ts` - Debug operations

**Parameter System**: `src/adapters/shared/common-parameters.ts` 
- Composed parameter libraries 
- Shared across CLI and MCP interfaces
- CommonParameters, GitParameters, SessionParameters, etc.
- Automatic parameter conversion via `shared-command-integration.ts`

**Error Handling**: Standardized MCP error responses with field-specific validation

**Key Features**:
- Unified CLI/MCP parameter consistency
- Automatic JSON parameter filtering (MCP always returns JSON)
- Consistent interface across multiple execution contexts
- Shared business logic with CLI commands

## Parameter Deduplication Results

### Before Task #322
- **210+ parameter duplications** across both systems
- SessionName parameter defined 17+ times (94% duplication)
- JSON parameter defined 5+ times across shared commands
- Path parameter defined 15+ times (93% duplication)

### After Task #322  
- **Unified parameter libraries**: single source of truth for all parameters
- **70% code reduction**: ~1000 lines → ~300 lines of parameter definitions
- **Zero breaking changes**: full backward compatibility maintained
- **Type-safe composition**: extensible patterns for future parameters

## Standardized Error Handling (Task #288)

### Unified Error Response Schema

All MCP tools now return standardized responses via `src/schemas/mcp-error-responses.ts`:

```typescript
// Success Response
{
  success: true,
  result: any,
  metadata?: {
    operation: string,
    requestId: string,
    performance: { duration: number }
  }
}

// Error Response  
{
  success: false,
  error: {
    message: string,
    code: McpErrorCode,
    fieldErrors?: FieldValidationError[],
    context?: ErrorContext,
    suggestions?: string[],
    stack?: string (debug only)
  }
}
```

### Error Handling Integration

**Direct MCP Tools**: Use `withStandardizedMcpErrorHandling()` wrapper or `classifyErrorForMcp()`
- Preserves sophisticated semantic error classification
- Converts to standardized format automatically
- Maintains rich error context and suggestions

**Bridged MCP Tools**: Automatic standardization via `shared-command-integration.ts`
- Field-specific validation error reporting
- Request tracking with unique IDs
- Performance metrics collection
- Debug mode support

## Parameter Consistency Resolutions

### JSON Parameter Handling

**Issue**: Inconsistent JSON parameter handling between systems

**Resolution**:
- **Direct MCP Tools**: No JSON parameter (MCP always returns JSON)
- **Bridged MCP Tools**: JSON parameter filtered out during conversion
- **Rationale**: MCP protocol is inherently JSON-based

### Session Parameter Naming

**Issue**: Mixed usage of `session` vs `sessionName` parameters

**Current State**:
- **Direct MCP Tools**: Use `sessionName` (more descriptive)
- **Bridged MCP Tools**: Have both `session` and `sessionName` for compatibility

**Recommendation**: Standardize on `sessionName` in future refactoring

## Developer Guide: Adding New MCP Commands

### Adding Direct MCP Tools

For session workspace operations requiring high performance:

```typescript
// 1. Define in session-files.ts, session-edit-tools.ts, or session-workspace.ts
commandMapper.addCommand({
  name: "session.my_operation", 
  description: "Description of operation",
  parameters: z.object({
    sessionName: SessionIdentifierSchema,
    path: FilePathSchema,
    // ... other parameters using shared schemas
  }),
  handler: withStandardizedMcpErrorHandling("session.my_operation", async (args) => {
    // Implementation logic
    return result;
  }),
});
```

### Adding Bridged MCP Tools

For management operations leveraging shared command infrastructure:

```typescript
// 1. Add to shared command registry in src/adapters/shared/commands/
export function registerMyCommands() {
  sharedCommandRegistry.registerCommand({
    id: "my.command",
    category: CommandCategory.MY_CATEGORY,
    parameters: composeParams({
      // Use parameters from common-parameters.ts
      repo: CommonParameters.repo,
      debug: CommonParameters.debug,
    }, {
      // Add command-specific parameters
      myParam: MyParameters.myParam,
    }),
    execute: async (params, context) => {
      // Implementation logic
    },
  });
}

// 2. Register with MCP in src/adapters/mcp/my-category.ts
export function registerMyTools(commandMapper: CommandMapper): void {
  registerMyCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "my.command": {
        description: "MCP-specific description",
      },
    },
  });
}
```

## Behavioral Differences: CLI vs MCP

### Parameter Handling
- **CLI**: Supports both `--json` flag and text output formatting
- **MCP**: Always returns JSON format, `json` parameter filtered out

### Session Context
- **CLI**: Auto-detects current session context from working directory
- **MCP**: Requires explicit session parameter specification

### Error Responses
- **CLI**: Supports both JSON and human-readable text error formatting
- **MCP**: Always returns structured error responses with standardized codes

### Command Availability
- **CLI**: All commands available
- **MCP**: Git commands hidden (use session commands instead)

## Performance Considerations

### Direct MCP Tools
- **Optimized for**: File I/O operations, session workspace management
- **Performance**: Direct parameter validation, minimal conversion overhead
- **Use Case**: High-frequency operations requiring low latency

### Bridged MCP Tools  
- **Optimized for**: Consistency, shared business logic, unified interfaces
- **Performance**: Parameter conversion overhead, but shared with CLI execution
- **Use Case**: Management operations where consistency is more important than latency

## Security Considerations

### Error Information Exposure
- **Production Mode**: Stack traces and debug information filtered out
- **Debug Mode**: Full error context available for troubleshooting
- **Field Validation**: Specific field errors without exposing system internals

### Path Validation
- **Session Workspace Isolation**: All file operations restricted to session workspaces
- **Path Resolution**: Relative path enforcement with validation
- **Permission Checking**: Explicit permission validation before file operations

## Future Architecture Considerations

### Potential Consolidation
- **Option A**: Migrate direct MCP tools to use shared command infrastructure
- **Option B**: Extract shared schemas into common parameter library
- **Recommendation**: Maintain dual architecture for performance reasons

### Parameter Naming Standardization
- Standardize on `sessionName` across all systems
- Eliminate duplicate `session`/`sessionName` parameters
- Update documentation and migration guides

### Enhanced Error Classification  
- Expand semantic error classification to bridged tools
- Add operation-specific error codes and suggestions
- Implement error analytics and monitoring

## Migration Guide

### From Legacy Error Handling

**Before** (Legacy format):
```typescript
catch (error) {
  return {
    success: false,
    error: error.message,
  };
}
```

**After** (Standardized format):
```typescript
// For Direct MCP Tools
handler: withStandardizedMcpErrorHandling("operation.name", async (args) => {
  // Implementation - errors automatically handled
  return result;
});

// For Bridged MCP Tools  
// Automatic via shared-command-integration.ts - no changes needed
```

### Parameter Refactoring

**Before** (Duplicated parameters):
```typescript
const params = {
  sessionName: z.string().describe("Session identifier"),
  debug: z.boolean().optional().describe("Enable debug output"),
  // ... repeated across multiple files
};
```

**After** (Shared parameters):
```typescript
const params = composeParams({
  sessionName: CommonParameters.sessionName,
  debug: CommonParameters.debug,
});
```

---

*This architecture documentation reflects the state after Task #322 (Parameter Deduplication) and Task #288 (MCP Improvements and Consistency Audit).*