# Task md#406: Complete TaskBackend enum refactoring across codebase

## Context

**Context**

The TaskBackend enum was introduced and partially implemented to replace string literals throughout the codebase for better type safety. Quick wins (validation arrays, display functions) have been completed, but more comprehensive refactoring remains.

**Remaining High-Value Opportunities**

### TaskService Creation Logic (Medium Priority)

**File**: `src/domain/tasks/taskService.ts` (lines 608-636)
**Current Code**:

```typescript
const effectiveBackend = backend || "markdown"; // Default to markdown
if (effectiveBackend === "github-issues") {
  // ...
} else {
  taskBackend =
    effectiveBackend === "markdown"
      ? createMarkdownTaskBackend({ name: "markdown", workspacePath })
      : createJsonFileTaskBackend({ name: "json-file", workspacePath });
}
```

**Improvement**: Replace string comparisons with enum values
**Risk**: Medium - would require updating function signatures and callers

### Init Command Backend Mapping (Medium Priority)

**File**: `src/adapters/shared/commands/init.ts` (lines 287-293, 307)
**Current Code**:

```typescript
const domainBackend =
  backend === "markdown"
    ? "tasks.md"
    : backend === "json-file"
      ? "tasks.md"
      : backend === "github-issues"
        ? "tasks.md"
        : "tasks.md";

if (backend === "github-issues") {
  log.debug("GitHub Issues backend selected", { githubOwner, githubRepo });
}
```

**Improvement**: Use enum values for consistency

### CLI Display Functions (Low Priority)

**Files**: `src/adapters/cli/cli-command-factory.ts`, other CLI utilities
**Current Code**: Various switch statements with string literals for backend display

**Already Completed ✅**

- Backend Detection Service (enum return type)
- Config validation arrays (`Object.values(TaskBackend)`)
- Display function switch statements (enum values)
- Backend validation functions (enum comparisons)

**Not Worth Effort ❌**

- Configuration schema definitions (already using Zod enums)
- TypeScript interface object keys (work fine with string literals)
- External API boundaries (need string serialization)

**Acceptance Criteria**

1. Replace string comparisons with enum values in TaskService creation logic
2. Update init command backend mapping to use enum
3. Update any remaining CLI display functions to use enum values
4. Maintain backward compatibility (enum values should serialize to same strings)
5. All tests pass after changes
6. No breaking changes to public APIs

**Benefits**

- Complete type safety for backend identifiers
- Single source of truth for all backend references
- Easier refactoring when adding/removing backends
- Consistent enum usage across entire codebase

**Estimated Effort**: 2-3 hours
**Priority**: Medium - good type safety improvement but not critical

## Requirements

## Solution

## Notes
