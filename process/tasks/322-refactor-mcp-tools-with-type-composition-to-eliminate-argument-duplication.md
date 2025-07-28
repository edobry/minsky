# Task #322: Refactor MCP Tools with Type Composition to Eliminate Argument Duplication

## Overview

The MCP tool implementations have significant duplication in argument types, response patterns, and validation logic across different tools. This creates maintenance overhead and violates DRY principles. Refactor using TypeScript interface composition and Zod schema composition to eliminate this duplication.

## Problem Analysis

### Current Duplication Patterns

1. **Session Parameters** (17+ occurrences):

   ```ts
   sessionName: z.string().describe("Session identifier (name or task ID)");
   ```

2. **File Path Parameters** (15+ occurrences):

   ```ts
   path: z.string().describe("Path to the file within the session workspace");
   ```

3. **Common Options** (repeated across tools):

   ```ts
   createDirs: z.boolean()
     .optional()
     .default(true)
     .describe("Create parent directories if they don't exist");
   explanation: z.string()
     .optional()
     .describe("One sentence explanation of why this tool is being used");
   ```

4. **Error Response Patterns** (repeated in every tool):

   ```ts
   return {
     success: false,
     error: errorMessage,
     path: args.path,
     session: args.sessionName,
   };
   ```

5. **Success Response Patterns** (similar structures across tools):

   ```ts
   return {
     success: true,
     path: args.path,
     session: args.sessionName,
     // ... tool-specific fields
   };
   ```

6. **Line Range Parameters** (duplicated across file reading tools):
   ```ts
   start_line_one_indexed: z.number().min(1).optional().describe("..."),
   end_line_one_indexed_inclusive: z.number().min(1).optional().describe("..."),
   should_read_entire_file: z.boolean().optional().default(false).describe("...")
   ```

## Proposed Solution

### 1. Create Composable Parameter Schemas

Create `src/adapters/mcp/schemas/common-parameters.ts`:

```ts
import { z } from "zod";

// Base session parameter
export const sessionNameParam = z.string().describe("Session identifier (name or task ID)");

// File system parameters
export const filePathParam = z.string().describe("Path to the file within the session workspace");
export const createDirsParam = z
  .boolean()
  .optional()
  .default(true)
  .describe("Create parent directories if they don't exist");
export const explanationParam = z
  .string()
  .optional()
  .describe("One sentence explanation of why this tool is being used");

// Line range parameters (for file reading)
export const lineRangeParams = z.object({
  start_line_one_indexed: z
    .number()
    .min(1)
    .optional()
    .describe("The one-indexed line number to start reading from (inclusive)"),
  end_line_one_indexed_inclusive: z
    .number()
    .min(1)
    .optional()
    .describe("The one-indexed line number to end reading at (inclusive)"),
  should_read_entire_file: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to read the entire file"),
});

// Search parameters
export const searchParams = z.object({
  query: z.string().describe("Regex pattern to search for"),
  case_sensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether the search should be case sensitive"),
  include_pattern: z
    .string()
    .optional()
    .describe("Glob pattern for files to include (e.g. '*.ts' for TypeScript files)"),
  exclude_pattern: z.string().optional().describe("Glob pattern for files to exclude"),
});

// Composable parameter objects
export const sessionContext = z.object({
  sessionName: sessionNameParam,
});

export const fileContext = z.object({
  sessionName: sessionNameParam,
  path: filePathParam,
});

export const fileOperationContext = z.object({
  sessionName: sessionNameParam,
  path: filePathParam,
  createDirs: createDirsParam,
});
```

### 2. Create Composable Response Types

Create `src/adapters/mcp/schemas/common-responses.ts`:

```ts
export interface BaseResponse {
  success: boolean;
  error?: string;
}

export interface SessionResponse extends BaseResponse {
  session: string;
}

export interface FileResponse extends SessionResponse {
  path: string;
  resolvedPath?: string;
}

export interface FileOperationResponse extends FileResponse {
  bytesWritten?: number;
  created?: boolean;
  edited?: boolean;
}

export interface SearchResponse extends SessionResponse {
  results?: any[];
  matchCount?: number;
}

// Response builders
export function createErrorResponse(
  error: string,
  context: { path?: string; session?: string }
): FileResponse {
  return {
    success: false,
    error,
    ...(context.path && { path: context.path }),
    ...(context.session && { session: context.session }),
  };
}

export function createSuccessResponse<T extends Record<string, any>>(
  context: { path?: string; session?: string },
  additionalData: T
): FileResponse & T {
  return {
    success: true,
    ...(context.path && { path: context.path }),
    ...(context.session && { session: context.session }),
    ...additionalData,
  };
}
```

### 3. Refactor Tool Implementations

Update each tool to use composed schemas:

```ts
// Before
commandMapper.addCommand({
  name: "session.read_file",
  parameters: z.object({
    sessionName: z.string().describe("Session identifier (name or task ID)"),
    path: z.string().describe("Path to the file within the session workspace"),
    start_line_one_indexed: z.number().min(1).optional().describe("..."),
    // ... many more duplicated parameters
  }),
  // ...
});

// After
import { fileContext, lineRangeParams, explanationParam } from "./schemas/common-parameters";
import { createErrorResponse, createSuccessResponse } from "./schemas/common-responses";

commandMapper.addCommand({
  name: "session.read_file",
  parameters: fileContext.extend(lineRangeParams.shape).extend({
    explanation: explanationParam,
  }),
  handler: async (args) => {
    try {
      // ... implementation
      return createSuccessResponse(
        { path: args.path, session: args.sessionName },
        {
          content: processedContent,
          totalLines: processed.totalLines,
          // ... other specific data
        }
      );
    } catch (error) {
      return createErrorResponse(getErrorMessage(error), {
        path: args.path,
        session: args.sessionName,
      });
    }
  },
});
```

### 4. Create Common Error Handling

Create `src/adapters/mcp/utils/error-handling.ts`:

```ts
import { getErrorMessage } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { createErrorResponse } from "../schemas/common-responses";

export function createMcpErrorHandler(toolName: string) {
  return (error: unknown, context: { path?: string; session?: string; [key: string]: any }) => {
    const errorMessage = getErrorMessage(error);

    log.error(`${toolName} failed`, {
      ...context,
      error: errorMessage,
    });

    return createErrorResponse(errorMessage, context);
  };
}
```

## Implementation Steps

1. **Create Common Schema Files**

   - `src/adapters/mcp/schemas/common-parameters.ts`
   - `src/adapters/mcp/schemas/common-responses.ts`
   - `src/adapters/mcp/utils/error-handling.ts`

2. **Refactor Session File Tools**

   - Update `session-files.ts` to use composed schemas
   - Update `session-edit-tools.ts` to use composed schemas
   - Update `session-workspace.ts` to use composed schemas

3. **Refactor Other MCP Tools**

   - Apply composition patterns to other tool categories
   - Update any remaining hardcoded parameter patterns

4. **Create Documentation**

   - Document the composition patterns for future tool development
   - Add examples of how to extend base schemas for new tools

5. **Validation & Testing**
   - Ensure all existing functionality works unchanged
   - Test that parameter validation still works correctly
   - Verify error responses maintain consistent structure

## Benefits

1. **DRY Compliance**: Eliminate 17+ instances of duplicated parameters
2. **Maintainability**: Single source of truth for common patterns
3. **Consistency**: Standardized response structures across all tools
4. **Type Safety**: Better TypeScript inference and validation
5. **Extensibility**: Easy to add new common parameters or response fields
6. **Developer Experience**: Clear patterns for creating new MCP tools

## Success Criteria

- [ ] All session tools use composed parameter schemas
- [ ] Common parameters defined once in shared modules
- [ ] Error and success response patterns standardized
- [ ] Existing MCP functionality unchanged (backward compatibility)
- [ ] Reduced code duplication by 60%+ in MCP tool files
- [ ] Clear documentation for extending schemas

## Related Tasks

- Task #288: Comprehensive MCP Improvements and CLI/MCP Consistency Audit
- Task #290: Convert Cursor Rules to MCP-Only Tool References

## Notes

This refactoring will significantly improve the maintainability of the MCP adapter layer while maintaining full backward compatibility. The composition approach allows for flexible parameter combinations while eliminating repetitive code.
