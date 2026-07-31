# MCP to Domain Schema Migration Guide

## Overview

This guide documents the migration of MCP modules from Task #322's MCP-specific schemas to the new domain-wide schemas from Task #329.

## Files to Migrate

1. `src/adapters/mcp/session-workspace.ts`
2. `src/adapters/mcp/session-files.ts`
3. `src/adapters/mcp/session-edit-tools.ts`

## Schema Mapping

### Parameter Schema Mapping

| MCP Schema                     | Domain Schema             | Notes                                                                  |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------- |
| `SessionFileReadSchema`        | `FileReadSchema`          | Same structure: sessionId + path + line range + explanation            |
| `SessionFileWriteSchema`       | `FileWriteSchema`         | Same structure: sessionId + path + content + createDirs                |
| `SessionFileEditSchema`        | `FileEditSchema`          | Same structure: sessionId + path + instructions + content + createDirs |
| `SessionFileOperationSchema`   | `BaseFileOperationSchema` | Same structure: sessionId + path                                       |
| `SessionDirectoryListSchema`   | `DirectoryListSchema`     | Same structure: sessionId + path + showHidden                          |
| `SessionFileExistsSchema`      | `FileExistsSchema`        | Same structure: sessionId + path                                       |
| `SessionFileDeleteSchema`      | `FileDeleteSchema`        | Same structure: sessionId + path                                       |
| `SessionDirectoryCreateSchema` | `DirectoryCreateSchema`   | Same structure: sessionId + path + recursive                           |
| `SessionGrepSearchSchema`      | `GrepSearchSchema`        | Same structure: sessionId + query + options                            |
| `SessionFileMoveSchema`        | `FileMoveSchema`          | Same structure: sessionId + sourcePath + targetPath + options          |
| `SessionFileRenameSchema`      | `FileRenameSchema`        | Same structure: sessionId + path + newName + overwrite                 |

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

### Manual Migration

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

## Structured MCP error codes

When an MCP tool handler fails with a structured error, `error.data.code` carries one of
the canonical codes from `packages/domain/src/errors/mcp-error-codes.ts` (the source of
truth — codes are documented inline there and kept alphabetized). External agents should
branch on `error.data.code` rather than regex-parsing `error.message`.

| Code                | Meaning                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `COMMIT_MSG_FAILED` | A commit-msg hook blocked the commit; `subprocessOutput` carries the hook stderr.                                 |
| `CONFLICT`          | A git merge conflict prevented the operation (a genuine conflict — see below).                                    |
| `PRE_COMMIT_FAILED` | A pre-commit hook blocked the commit; `subprocessOutput` carries the hook stderr.                                 |
| `RATE_LIMITED`      | The upstream API (e.g. GitHub) rejected the request due to rate limiting. Wait for the reset window, then retry.  |
| `SERVICE_DEGRADED`  | The upstream API is degraded or unavailable (5xx). Not a problem with your branch or PR — retry once it recovers. |
| `SUBPROCESS_FAILED` | A subprocess invoked during the operation exited non-zero.                                                        |
| `VALIDATION_ERROR`  | Input parameters failed validation.                                                                               |

### `session.pr.merge` error classification (mt#2890)

`session.pr.merge` distinguishes failure classes rather than reporting every merge-API
failure as a conflict:

- **`CONFLICT`** — only for genuine merge conflicts (GitHub reports `mergeable: false`, or
  a 405/422 with conflict semantics). Remediation: `session.update` (rebase) and resolve.
- **`RATE_LIMITED`** — the merge call hit the API rate limit. Remediation: wait, retry.
  Do NOT rebase; the branch is fine.
- **`SERVICE_DEGRADED`** — upstream 5xx (check githubstatus.com). Remediation: wait, retry.
- When GitHub has not yet computed mergeability (`mergeable: null`), the merge path polls
  briefly; if still unknown it fails with a distinct "merge readiness could not be
  determined" error rather than a false conflict.
- The structured error's `summary` includes the original upstream error message
  (truncated), so the true failure is always visible to the operator.

Originating incident: PR #1988 (2026-07-16), where GitHub API degradation was mislabeled
as merge conflicts across five merge attempts.
