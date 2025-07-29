# MCP Schema Composition Guide

## Overview

This guide explains how to use the new MCP schema composition architecture introduced in Task #322. The architecture eliminates parameter duplication and provides standardized response patterns across all MCP tools.

## Architecture Components

### 1. Common Parameter Schemas (`src/adapters/mcp/schemas/common-parameters.ts`)

#### Base Parameter Building Blocks

```typescript
// Session identification
export const SessionIdentifierSchema = z.object({
  sessionName: z.string().describe("Session identifier (name or task ID)"),
});

// File path within session workspace
export const FilePathSchema = z.object({
  path: z.string().describe("Path to the file within the session workspace"),
});

// Line range support for file reading
export const LineRangeSchema = z.object({
  start_line_one_indexed: z.number().min(1).optional(),
  end_line_one_indexed_inclusive: z.number().min(1).optional(),
  should_read_entire_file: z.boolean().optional().default(false),
});
```

#### Composed Operation Schemas

```typescript
// Base operation: session + file path
export const SessionFileOperationSchema = SessionIdentifierSchema.merge(FilePathSchema);

// File reading: base + line range + explanation
export const SessionFileReadSchema =
  SessionFileOperationSchema.merge(LineRangeSchema).merge(ExplanationSchema);

// File writing: base + content + directory creation
export const SessionFileWriteSchema =
  SessionFileOperationSchema.merge(FileContentSchema).merge(CreateDirectoriesSchema);
```

### 2. Response Builders (`src/adapters/mcp/schemas/common-responses.ts`)

#### Response Type Hierarchy

```typescript
// Base response interface
export interface BaseResponse {
  success: boolean;
  error?: string;
}

// Session-scoped response
export interface SessionResponse extends BaseResponse {
  session: string;
}

// File operation response
export interface FileResponse extends SessionResponse {
  path: string;
  resolvedPath?: string;
}

// Extended file operation response
export interface FileOperationResponse extends FileResponse {
  bytesWritten?: number;
  created?: boolean;
  edited?: boolean;
  // ... other operation-specific fields
}
```

#### Response Builder Functions

```typescript
// Create standardized error response
export function createErrorResponse(
  error: string,
  context: { path?: string; session?: string }
): BaseResponse & { path?: string; session?: string };

// Create file operation success response
export function createFileOperationResponse(
  context: { path: string; session: string; resolvedPath?: string },
  operationData: Partial<FileOperationResponse>
): FileOperationResponse;

// Create file read success response
export function createFileReadResponse(
  context: { path: string; session: string; resolvedPath?: string },
  readData: { content: string; totalLines?: number /* ... */ }
): FileReadResponse;
```

### 3. Error Handling Utilities (`src/adapters/mcp/utils/error-handling.ts`)

```typescript
// Create standardized error handler for a tool
export function createMcpErrorHandler(toolName: string) {
  return (error: unknown, context: McpErrorContext): FileMcpResponse => {
    const errorMessage = getErrorMessage(error);
    log.error(`${toolName} failed`, { ...context, error: errorMessage });
    return createMcpErrorResponse(error, context);
  };
}

// Wrap handler with standardized error handling
export function withMcpErrorHandling<T, R>(
  toolName: string,
  handler: (args: T) => Promise<R>
): (args: T) => Promise<R | FileMcpResponse>;
```

## How to Create New MCP Tools

### Step 1: Define Parameters Using Composition

```typescript
import {
  SessionIdentifierSchema,
  FilePathSchema,
  CreateDirectoriesSchema,
} from "./schemas/common-parameters";

// Compose existing schemas for your operation
const MyOperationSchema = SessionIdentifierSchema.merge(FilePathSchema)
  .merge(CreateDirectoriesSchema)
  .merge(
    z.object({
      // Add operation-specific parameters
      customOption: z.string().optional().describe("Custom operation option"),
    })
  );

type MyOperationArgs = z.infer<typeof MyOperationSchema>;
```

### Step 2: Use Response Builders

```typescript
import { createFileOperationResponse, createErrorResponse } from "./schemas/common-responses";

const handler = async (args: MyOperationArgs): Promise<Record<string, any>> => {
  try {
    // ... perform operation

    return createFileOperationResponse(
      {
        path: args.path,
        session: args.sessionName,
        resolvedPath: relativeResolvedPath,
      },
      {
        // Operation-specific response data
        customResult: "operation completed",
        bytesProcessed: 1024,
      }
    );
  } catch (error) {
    return createErrorResponse(getErrorMessage(error), {
      path: args.path,
      session: args.sessionName,
    });
  }
};
```

### Step 3: Register the Tool

```typescript
commandMapper.addCommand({
  name: "session.my_operation",
  description: "Description of what this operation does",
  parameters: MyOperationSchema,
  handler,
});
```

## Available Schema Building Blocks

### Parameter Schemas

| Schema                    | Purpose                     | Fields                                                                                |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `SessionIdentifierSchema` | Session identification      | `sessionName`                                                                         |
| `FilePathSchema`          | File path within session    | `path`                                                                                |
| `LineRangeSchema`         | Line range for file reading | `start_line_one_indexed`, `end_line_one_indexed_inclusive`, `should_read_entire_file` |
| `FileContentSchema`       | File content for writing    | `content`                                                                             |
| `CreateDirectoriesSchema` | Directory creation option   | `createDirs`                                                                          |
| `ShowHiddenFilesSchema`   | Hidden files option         | `showHidden`                                                                          |
| `GrepSearchSchema`        | Search parameters           | `query`, `case_sensitive`, `include_pattern`, `exclude_pattern`                       |
| `SearchReplaceSchema`     | Search and replace          | `search`, `replace`                                                                   |
| `EditInstructionsSchema`  | Edit instructions           | `instructions`, `content`                                                             |

### Pre-composed Schemas

| Schema                       | Composition                                    | Use Case                     |
| ---------------------------- | ---------------------------------------------- | ---------------------------- |
| `SessionFileOperationSchema` | Session + File                                 | Basic file operations        |
| `SessionFileReadSchema`      | Session + File + LineRange + Explanation       | File reading with line range |
| `SessionFileWriteSchema`     | Session + File + Content + CreateDirs          | File writing                 |
| `SessionFileEditSchema`      | Session + File + EditInstructions + CreateDirs | File editing                 |
| `SessionSearchReplaceSchema` | Session + File + SearchReplace                 | Search and replace           |
| `SessionDirectoryListSchema` | Session + OptionalPath + ShowHidden            | Directory listing            |
| `SessionGrepSearchSchema`    | Session + GrepSearch                           | Grep search                  |

### Response Builders

| Function                      | Purpose                         | Returns                  |
| ----------------------------- | ------------------------------- | ------------------------ |
| `createErrorResponse`         | Standardized error response     | `BaseResponse & context` |
| `createSuccessResponse`       | Generic success response        | `FileResponse & T`       |
| `createFileOperationResponse` | File operation response         | `FileOperationResponse`  |
| `createFileReadResponse`      | File read response with content | `FileReadResponse`       |
| `createDirectoryListResponse` | Directory listing response      | `DirectoryListResponse`  |

## Best Practices

### 1. Always Use Composed Schemas

❌ **Don't create inline schemas:**

```typescript
parameters: z.object({
  sessionName: z.string().describe("Session identifier"),
  path: z.string().describe("File path"),
  // ... duplicated definitions
});
```

✅ **Use composed schemas:**

```typescript
parameters: SessionFileOperationSchema.merge(
  z.object({
    // Only operation-specific parameters
    customOption: z.string().optional(),
  })
);
```

### 2. Always Use Response Builders

❌ **Don't create manual response objects:**

```typescript
return {
  success: true,
  path: args.path,
  session: args.sessionName,
  // ... manual construction
};
```

✅ **Use response builders:**

```typescript
return createFileOperationResponse(
  { path: args.path, session: args.sessionName },
  {
    /* operation-specific data */
  }
);
```

### 3. Consistent Error Handling

❌ **Don't use manual error handling:**

```typescript
catch (error) {
  return {
    success: false,
    error: getErrorMessage(error),
    path: args.path,
    session: args.sessionName,
  };
}
```

✅ **Use standardized error responses:**

```typescript
catch (error) {
  const errorMessage = getErrorMessage(error);
  log.error("Operation failed", { ...context, error: errorMessage });
  return createErrorResponse(errorMessage, {
    path: args.path,
    session: args.sessionName,
  });
}
```

### 4. Type Safety

Always define TypeScript types from schemas:

```typescript
type MyOperationArgs = z.infer<typeof MyOperationSchema>;

const handler = async (args: MyOperationArgs): Promise<Record<string, any>> => {
  // TypeScript will enforce correct usage of args
};
```

## Migration Guide

### From Old Pattern to New Pattern

**Old way (duplicated):**

```typescript
commandMapper.addCommand({
  name: "session.my_tool",
  parameters: z.object({
    sessionName: z.string().describe("Session identifier (name or task ID)"),
    path: z.string().describe("Path to the file within the session workspace"),
    createDirs: z
      .boolean()
      .optional()
      .default(true)
      .describe("Create parent directories if they don't exist"),
    // ... operation-specific params
  }),
  handler: async (args) => {
    try {
      // ... implementation
      return {
        success: true,
        path: args.path,
        session: args.sessionName,
        // ... manual response construction
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
        path: args.path,
        session: args.sessionName,
      };
    }
  },
});
```

**New way (composed):**

```typescript
import { SessionFileOperationSchema, CreateDirectoriesSchema } from "./schemas/common-parameters";
import { createFileOperationResponse, createErrorResponse } from "./schemas/common-responses";

commandMapper.addCommand({
  name: "session.my_tool",
  parameters: SessionFileOperationSchema.merge(CreateDirectoriesSchema).merge(
    z.object({
      // Only operation-specific parameters
    })
  ),
  handler: async (args) => {
    try {
      // ... implementation
      return createFileOperationResponse(
        { path: args.path, session: args.sessionName },
        {
          /* operation results */
        }
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error("My tool failed", { ...args, error: errorMessage });
      return createErrorResponse(errorMessage, {
        path: args.path,
        session: args.sessionName,
      });
    }
  },
});
```

## Examples

### Example 1: Simple File Operation

```typescript
import { SessionFileOperationSchema } from "./schemas/common-parameters";
import { createFileOperationResponse, createErrorResponse } from "./schemas/common-responses";

commandMapper.addCommand({
  name: "session.file_size",
  description: "Get the size of a file within a session workspace",
  parameters: SessionFileOperationSchema,
  handler: async (args: SessionFileOperation): Promise<Record<string, any>> => {
    try {
      const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);
      const stats = await stat(resolvedPath);

      return createFileOperationResponse(
        { path: args.path, session: args.sessionName },
        {
          size: stats.size,
          modified: stats.mtime,
          isFile: stats.isFile(),
        }
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error("File size check failed", { ...args, error: errorMessage });
      return createErrorResponse(errorMessage, {
        path: args.path,
        session: args.sessionName,
      });
    }
  },
});
```

### Example 2: Complex Composed Operation

```typescript
import {
  SessionFileOperationSchema,
  CreateDirectoriesSchema,
  ExplanationSchema,
} from "./schemas/common-parameters";

const ArchiveFileSchema = SessionFileOperationSchema.merge(CreateDirectoriesSchema)
  .merge(ExplanationSchema)
  .merge(
    z.object({
      compressionLevel: z.number().min(1).max(9).default(6),
      includeMetadata: z.boolean().default(true),
    })
  );

type ArchiveFileArgs = z.infer<typeof ArchiveFileSchema>;

commandMapper.addCommand({
  name: "session.archive_file",
  description: "Archive a file within a session workspace",
  parameters: ArchiveFileSchema,
  handler: async (args: ArchiveFileArgs): Promise<Record<string, any>> => {
    try {
      // ... complex archiving logic

      return createFileOperationResponse(
        { path: args.path, session: args.sessionName },
        {
          archived: true,
          compressionRatio: 0.75,
          archivePath: `${args.path}.zip`,
          originalSize: originalStats.size,
          compressedSize: compressedStats.size,
        }
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error("File archiving failed", { ...args, error: errorMessage });
      return createErrorResponse(errorMessage, {
        path: args.path,
        session: args.sessionName,
      });
    }
  },
});
```

## Extending the Schema System

### Adding New Base Parameters

To add a new commonly-used parameter, add it to `common-parameters.ts`:

```typescript
// Add to common-parameters.ts
export const TimestampSchema = z.object({
  timestamp: z.string().datetime().optional().describe("ISO timestamp for operation"),
});

// Use in composed schemas
export const SessionFileOperationWithTimestampSchema =
  SessionFileOperationSchema.merge(TimestampSchema);
```

### Adding New Response Types

To add new response types, extend `common-responses.ts`:

```typescript
// Add to common-responses.ts
export interface ArchiveResponse extends FileOperationResponse {
  compressionRatio: number;
  archivePath: string;
  originalSize: number;
  compressedSize: number;
}

export function createArchiveResponse(
  context: { path: string; session: string },
  archiveData: {
    compressionRatio: number;
    archivePath: string;
    originalSize: number;
    compressedSize: number;
  }
): ArchiveResponse {
  return createFileOperationResponse(context, {
    archived: true,
    ...archiveData,
  }) as ArchiveResponse;
}
```

## Summary

The MCP schema composition architecture provides:

1. **DRY Compliance**: No parameter duplication across tools
2. **Type Safety**: Full TypeScript inference and validation
3. **Consistency**: Standardized response patterns
4. **Maintainability**: Single source of truth for common patterns
5. **Extensibility**: Easy to add new parameters and response types
6. **Developer Experience**: Clear patterns for creating new tools

This architecture eliminates the 60%+ code duplication that existed in the original MCP tools while maintaining full backward compatibility and improving developer productivity.
