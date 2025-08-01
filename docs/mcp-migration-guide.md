# MCP to Domain Schema Migration Guide

## Overview

This guide documents the migration of MCP modules from Task #322's MCP-specific schemas to the new domain-wide schemas from Task #329.

## Files to Migrate

1. `src/adapters/mcp/session-workspace.ts`
2. `src/adapters/mcp/session-files.ts`
3. `src/adapters/mcp/session-edit-tools.ts`

## Schema Mapping

### Parameter Schema Mapping

| MCP Schema                     | Domain Schema             | Notes                                                                    |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------ |
| `SessionFileReadSchema`        | `FileReadSchema`          | Same structure: sessionName + path + line range + explanation            |
| `SessionFileWriteSchema`       | `FileWriteSchema`         | Same structure: sessionName + path + content + createDirs                |
| `SessionFileEditSchema`        | `FileEditSchema`          | Same structure: sessionName + path + instructions + content + createDirs |
| `SessionFileOperationSchema`   | `BaseFileOperationSchema` | Same structure: sessionName + path                                       |
| `SessionDirectoryListSchema`   | `DirectoryListSchema`     | Same structure: sessionName + path + showHidden                          |
| `SessionFileExistsSchema`      | `FileExistsSchema`        | Same structure: sessionName + path                                       |
| `SessionFileDeleteSchema`      | `FileDeleteSchema`        | Same structure: sessionName + path                                       |
| `SessionDirectoryCreateSchema` | `DirectoryCreateSchema`   | Same structure: sessionName + path + recursive                           |
| `SessionGrepSearchSchema`      | `GrepSearchSchema`        | Same structure: sessionName + query + options                            |
| `SessionFileMoveSchema`        | `FileMoveSchema`          | Same structure: sessionName + sourcePath + targetPath + options          |
| `SessionFileRenameSchema`      | `FileRenameSchema`        | Same structure: sessionName + path + newName + overwrite                 |

### Response Builder Mapping

| MCP Response Builder                                  | Domain Response Builder                                                                           | Usage Pattern              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------- |
| `createFileReadResponse(context, readData)`           | `createSuccessResponse({ ...readData, session: context.session, path: context.path })`            | Merge context and data     |
| `createFileOperationResponse(context, operationData)` | `createSuccessResponse({ ...operationData, session: context.session, path: context.path })`       | Merge context and data     |
| `createDirectoryListResponse(context, listData)`      | `createSuccessResponse({ ...listData, session: context.session, path: context.path })`            | Merge context and data     |
| `createErrorResponse(error, context)`                 | `createErrorResponse(error, "OPERATION_ERROR", { session: context.session, path: context.path })` | Add error code and details |

## Import Changes

### Before (MCP-specific)

```typescript
import {
  SessionFileReadSchema,
  SessionFileWriteSchema,
  // ... other schemas
} from "./schemas/common-parameters";
import {
  createFileReadResponse,
  createFileOperationResponse,
  createErrorResponse,
} from "./schemas/common-responses";
```

### After (Domain-wide)

```typescript
import {
  FileReadSchema,
  FileWriteSchema,
  BaseFileOperationSchema,
  // ... other schemas
  createSuccessResponse,
  createErrorResponse,
} from "../../domain/schemas";
```

## Migration Steps

### Automated Migration (Recommended)

**Step 1: Run the Codemod**

```bash
# Navigate to project root
cd /path/to/minsky

# Run the automated migration codemod
bun run codemods/mcp-to-domain-schema-migrator.ts
```

**Step 2: Review Changes**

- Examine the changes made by the codemod
- Verify import statements are correctly updated
- Check schema references are properly migrated

**Step 3: Manual Response Builder Adjustments**

- Review response builder calls flagged by the codemod
- Update argument structures if needed for domain response builders
- Test response format compatibility

**Step 4: Test Functionality**

```bash
# Run tests to verify MCP tools still work
bun test src/adapters/mcp/

# Test specific MCP tool functionality
bun run test:mcp
```

### Manual Migration (Alternative)

If you prefer manual migration or need to understand the process:

**Step 1: Update Imports**
Replace MCP-specific imports with domain schema imports.

**Step 2: Update Schema References**
Replace schema names throughout the files using the mapping table above.

**Step 3: Update Response Builders**
Replace MCP-specific response builders with domain response builders, merging context and data appropriately.

**Step 4: Test Functionality**
Verify that all MCP tools still work correctly after migration.

## Benefits After Migration

1. **Single Source of Truth**: All interfaces use the same validation logic
2. **Consistency**: Identical parameter structures across CLI, MCP, and future APIs
3. **Maintainability**: Changes to domain concepts update all interfaces automatically
4. **Type Safety**: Full TypeScript coverage with domain-wide type definitions

## Expected File Changes

Each file should see:

- ~15-20 lines of import changes
- ~5-10 schema name updates
- ~3-5 response builder function updates
- Zero functional changes to the actual tool behavior

## Validation

After migration, verify:

- [ ] All TypeScript compilation errors resolved
- [ ] All MCP tools still function as expected
- [ ] Response formats remain consistent
- [ ] Parameter validation works identically

## Future Benefits

This migration enables:

- Easy addition of CLI commands using the same schemas
- Future API endpoints with identical validation logic
- Consistent error handling across all interfaces
- Simplified maintenance and feature additions
