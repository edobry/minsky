# Consolidate Multiple Task ID Parsing Implementations

## Context

TECHNICAL DEBT: Multiple inconsistent task parsing implementations prevent qualified backend IDs (md#367, gh#123) from appearing in task list.

## Problem

- Task creation works: generates md#367 ✅
- File storage works: saves [md#367] ✅
- Manual regex test works: extracts md#367 ✅
- Task list fails: completely ignores qualified IDs ❌

## Root Cause

At least 3 different parsing implementations:

1. src/domain/tasks/taskFunctions.ts (task list uses this)
2. src/domain/tasks/markdownTaskBackend.ts (task creation uses this)
3. src/domain/tasks/markdown-task-backend.ts (alternative implementation)

## Evidence

Task md#367 exists in process/tasks.md but invisible in `minsky tasks list`

## Required Fix

Consolidate all parsing into single unified implementation that supports both:

- Legacy format: #123
- Qualified format: md#123, gh#456

## Success Criteria

`minsky tasks list` shows qualified backend IDs correctly

## Requirements

## Solution

## Notes

## 🎯 EXPANDED SCOPE: Multiple Validation Layers Broken

**NEW DISCOVERY**: CLI schema validation rejects qualified IDs:
`minsky tasks get md#367` → "Task ID must be a valid number"

**Complete Scope of Issues:**

1. ✅ Creation/Storage: Works (md#367 created & saved)
2. ❌ CLI Schema: Rejects qualified IDs ("283", "#283", "task#283" only)
3. ❌ Task List: Ignores qualified IDs (parsing regex issue)
4. ❌ Task Retrieval: Cannot access qualified IDs

**Files to Fix:**

- CLI validation schemas (reject qualified IDs)
- Multiple parsing implementations (inconsistent)
- Task list display logic (ignores qualified IDs)

**This confirms multiple incompatible validation/parsing layers - classic technical debt.**

## 🎯 IMPLEMENTATION STATUS - PARTIALLY COMPLETED IN TASK #397

**CRITICAL DISCOVERY (2025-01-07)**: This task was marked DONE but **never actually implemented**. The backwards compatibility issues remained and broke the multi-backend system implemented in Task #356.

**WORK COMPLETED IN TASK #397**:

✅ **Root Cause Identified**: `normalizeTaskId()` in `parseTasksFromMarkdown()` was converting qualified IDs (`md#123`) back to legacy format (`#123`), breaking multi-backend routing

✅ **Core Fix Applied**: Removed backwards compatibility normalization in `taskFunctions.ts` lines 62-66:
```typescript
// OLD (BROKEN):
const normalizedId = normalizeTaskId(id) || id;

// NEW (FIXED):
// Keep ID as-is for multi-backend compatibility
// Note: normalizeTaskId was stripping qualified prefixes (md#123 -> #123)
// which breaks multi-backend routing
```

✅ **Multi-Backend Fixes**:
- Fixed `MarkdownTaskBackend.getTask()` to handle ID format mismatches
- Fixed `MultiBackendTaskService.getTask()` to re-qualify task IDs
- Fixed `MultiBackendTaskService.listAllTasks()` to re-qualify task IDs

**REMAINING WORK**:
- Complete testing of multi-backend integration
- Verify all CLI commands work with qualified IDs
- Remove remaining `normalizeTaskId` calls if any
- Complete systematic replacement plan below

**ORIGINAL IMPLEMENTATION APPROACH**:

**NAMING DECISION: Use `TaskId` as the unified system name**

- Clean, simple, obvious purpose
- Single source of truth for all task ID operations

**REQUIRED: Start with @test-driven-bugfix.mdc**

1. **Write failing tests first** that demonstrate the current inconsistent behavior
2. **Test each broken layer**: CLI validation, task list parsing, task retrieval
3. **Document the exact failure modes** in test descriptions
4. **Implement TaskId system** to make tests pass
5. **Systematically replace** all scattered implementations

## TARGET API DESIGN

```typescript
import { TaskId } from "./task-id";

// Replace ALL scattered logic with:
TaskId.parse("md#367"); // → {backend: "md", localId: "367"}
TaskId.validate("gh#123"); // → true
TaskId.format(parsedId); // → "md#367"
TaskId.normalize("#367"); // → "md#367" (with default backend)
TaskId.isLegacy("#367"); // → true
```

## SYSTEMATIC REPLACEMENT PLAN

Replace these scattered implementations with TaskId calls:

1. CLI schema validation (rejects qualified IDs)
2. taskConstants.ts regex patterns
3. taskFunctions.ts parsing
4. markdownTaskBackend.ts parsing
5. Task display formatting
6. Task list parsing

## SUCCESS TESTS

- `minsky tasks get "md#367"` works ✅
- `minsky tasks list` shows qualified IDs ✅
- All legacy IDs still work ✅
- Consistent behavior across all operations ✅
