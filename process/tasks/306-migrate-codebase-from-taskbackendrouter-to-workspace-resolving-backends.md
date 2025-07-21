# Migrate codebase from TaskBackendRouter to workspace-resolving backends

## Status

IN-PROGRESS - **Core workspace resolution already migrated in Task #276**

## Priority

MEDIUM

## Description

# Migrate codebase from TaskBackendRouter to workspace-resolving backends

## Context

Task #276 successfully implemented **workspace-resolving backends** that handle workspace resolution internally, eliminating the need for the over-engineered `TaskBackendRouter`. The architectural foundation is complete, and **immediate critical improvements have been delivered**.

## ✅ PROGRESS UPDATE (Task #276 Immediate Improvements)

**CORE WORKSPACE RESOLUTION ALREADY MIGRATED:**
- ✅ `resolveTaskWorkspacePath()` now uses enhanced TaskService instead of TaskBackendRouter
- ✅ All 8+ functions in `taskCommands.ts` automatically benefit from improved pattern
- ✅ Prototype pollution eliminated from test suite (28/28 tests passing)
- ✅ Real-world TaskBackendRouter usage reduced significantly

## Remaining Problem Statement

Some advanced usage patterns still use the complex external workspace resolution:

```typescript
// FIXED: Core workspace resolution (Task #276)
✅ const workspacePath = await resolveTaskWorkspacePath({ backend: "markdown", repoUrl });
✅ const taskService = new TaskService({ workspacePath, backend: "markdown" });

// TARGET: Direct enhanced TaskService usage
const taskService = await TaskService.createMarkdownWithRepo({ repoUrl });
```

## Requirements

### 1. **Complete Task Commands Migration** (Option 2)
**Impact: Medium | Effort: Low** (⚡ REDUCED - core work done)

**✅ COMPLETED:**
- Core `resolveTaskWorkspacePath()` migrated to enhanced TaskService
- All 8+ functions in `taskCommands.ts` automatically use improved pattern
- Prototype pollution eliminated from test suite

**🔄 REMAINING:**
- Optional: Update individual task command functions to use direct enhanced TaskService calls
- Update CLI adapters to use enhanced patterns directly (optional optimization)
- Update MCP adapters for consistency (optional optimization)

### 2. **Create Workspace-Resolving JSON Backend** (Option 3)
**Impact: Medium | Effort: Low**

- Apply same pattern to `JsonFileTaskBackend`
- Create `workspace-resolving-json-backend.ts`
- Provides consistency across all backend types
- Completes the architectural foundation

### 3. **Complete TaskBackendRouter Cleanup** (Option 4)
**Impact: Medium | Effort: Low** (⚡ REDUCED - major usage eliminated)

**✅ PARTIALLY COMPLETED:**
- Core `resolveTaskWorkspacePath()` no longer uses TaskBackendRouter
- Dangerous test patterns eliminated
- Real-world usage significantly reduced

**🔄 REMAINING:**
- Remove remaining TaskBackendRouter class and unused imports
- Clean up any remaining direct TaskBackendRouter usage
- Update documentation and types
- Update all imports and references

## Implementation Strategy

### Phase 1: TaskService Integration ✅ COMPLETE
✅ **Enhanced TaskService** - Static factory methods implemented
✅ **Core workspace resolution** - `resolveTaskWorkspacePath()` migrated
✅ **Test cleanup** - Prototype pollution eliminated

### Phase 2: Command Migration ⚡ MOSTLY COMPLETE
✅ **Core infrastructure** - All task commands automatically use improved pattern
🔄 **Optional optimizations** - Direct enhanced TaskService usage in individual functions
🔄 **Adapter updates** - CLI and MCP adapters can use enhanced patterns directly

### Phase 3: Backend Consistency
🔄 **JSON backend** - Implement `workspace-resolving-json-backend.ts`
🔄 **Pattern completion** - Apply same patterns to any other backend types
🔄 **API consistency** - Ensure consistent API across all backends

### Phase 4: Router Cleanup ⚡ MOSTLY COMPLETE
✅ **Core usage eliminated** - Major TaskBackendRouter usage removed
✅ **Test patterns fixed** - Dangerous prototype manipulation eliminated
🔄 **Final cleanup** - Remove remaining TaskBackendRouter class and imports
🔄 **Documentation** - Update all references and documentation

## Success Criteria

**✅ ACHIEVED (Task #276 Immediate Improvements):**
- ✅ Core workspace resolution uses enhanced TaskService pattern
- ✅ All task commands automatically benefit from improved pattern
- ✅ Major TaskBackendRouter usage eliminated from production code
- ✅ `resolveTaskWorkspacePath` utility enhanced (not removed - improved)
- ✅ No regressions in existing functionality
- ✅ All tests pass (28/28 with clean patterns)
- ✅ Prototype pollution completely eliminated

**🔄 REMAINING:**
- 🔄 All backend types support internal workspace resolution (JSON backend pending)
- 🔄 `TaskBackendRouter` class completely removed from codebase
- 🔄 Documentation updated to reflect enhanced patterns
- 🔄 Optional: Direct enhanced TaskService usage in all adapters

## Dependencies

- **Prerequisite**: Task #276 completion (workspace-resolving architecture foundation)
- **Builds On**: Workspace-resolving markdown backend implementation
- **Enables**: Complete elimination of TaskBackendRouter anti-pattern

## Benefits

1. **Simplified Architecture**: One-step backend creation
2. **Better Encapsulation**: Backends manage their own concerns
3. **Reduced Complexity**: Eliminates unnecessary abstraction layers
4. **Improved Maintainability**: Cleaner separation of concerns
5. **Type Safety**: Better type checking without complex routing logic

This task completes the architectural cleanup started in #276, bringing the full codebase to the improved patterns.

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
