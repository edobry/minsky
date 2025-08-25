# Remove hardcoded 'markdown' backend defaults

## Context

Replace all hardcoded backend='markdown' fallbacks with proper configuration system defaults. Maintain 'markdown' as valid option but not hardcoded default. System should use backend detection service or explicit configuration instead of hardcoded values.

With the completion of **md#443 (Multi-Backend TaskService)**, the system now supports automatic qualified ID routing (`md#123` → markdown, `mt#456` → minsky, etc.) and multi-backend coordination.

However, several areas of the codebase still contain hardcoded `|| "markdown"` fallbacks that bypass this new architecture and force markdown as the default backend.

## Requirements

### 1. **Remove Hardcoded Fallbacks in Task Commands**

- **Location**: `src/domain/tasks/taskCommands.ts` (Lines 227, 290, 309, 369, 416, 596)
- **Current**: `backend: validParams.backend || "markdown"`
- **Required**: Use backend detection service or multi-backend service default
- **Impact**: 6 instances across multiple task command functions

### 2. **Fix Base Task Operation Default**

- **Location**: `src/domain/tasks/operations/base-task-operation.ts` (Line 115)
- **Current**: `backend: params.backend || "markdown", // Use markdown as default to avoid config lookup`
- **Required**: Use proper backend resolution instead of hardcoded fallback
- **Impact**: Affects all task operations that don't specify a backend

### 3. **Update CLI Formatting Utilities**

- **Location**: `src/adapters/cli/utilities/formatting-utilities.ts` (Line 158)
- **Current**: `const taskBackend = resolved.tasks?.backend || resolved.backend || "markdown"`
- **Required**: Use backend detection or remove hardcoded fallback
- **Impact**: Affects CLI display formatting

### 4. **Fix Migration Command Fallback**

- **Location**: `src/adapters/shared/commands/tasks/migrate-backend-command.ts` (Line 195)
- **Current**: `return "markdown"; // Default fallback`
- **Required**: Use backend detection service instead of hardcoded return
- **Impact**: Migration operations incorrectly assume markdown as default

### 5. **Update Error Templates**

- **Location**: `src/errors/enhanced-error-templates.ts` (Line 370)
- **Current**: `"• markdown (default)\n• json-file\n• github-issues"`
- **Required**: Remove "(default)" designation or make it dynamic
- **Impact**: Error messages incorrectly suggest markdown is always the default

### 6. **Review Backend Detection Logic**

- **Location**: `src/domain/configuration/backend-detection.ts` (Line 44)
- **Current**: `return TaskBackend.MARKDOWN; // Default fallback - prefer markdown for new projects`
- **Required**: Review if this is appropriate or should use different logic
- **Impact**: New project initialization behavior

## Solution

### **Phase 1: Replace Hardcoded Fallbacks with Backend Detection**

The multi-backend TaskService (from md#443) already provides proper backend resolution:

- When no backend specified: registers all available backends, uses first as default
- When qualified ID used: routes automatically to correct backend
- Backend detection service can determine appropriate backend based on project structure

### **Phase 2: Use Proper Service Integration**

Instead of hardcoded `|| "markdown"` patterns, use:

1. **Backend Detection Service**: `_backendDetectionService.detectBackend(workingDir)`
2. **Multi-Backend Default**: Let `createConfiguredTaskService()` determine available backends
3. **Configuration System**: Use `resolveConfiguration()` to determine backend preferences

### **Phase 3: Update Error Messaging**

Remove references to markdown as "default" in error messages and help text, since the actual default now depends on:

- Project structure (what backends are available)
- Configuration settings
- Backend detection logic

## Testing Strategy

1. **Verify Multi-Backend Routing**: Ensure qualified IDs still route correctly
2. **Test Backend Detection**: Verify projects detect appropriate backends
3. **Test Fallback Behavior**: Ensure graceful handling when no backend detected
4. **CLI Integration**: Verify commands work without hardcoded defaults
5. **Error Scenarios**: Test error messages don't reference incorrect defaults

## Success Criteria

- ✅ Zero instances of `|| "markdown"` in production code
- ✅ All task operations use proper backend resolution
- ✅ Error messages accurately reflect dynamic backend selection
- ✅ Multi-backend TaskService integration preserved
- ✅ Backend detection service used instead of hardcoded fallbacks
- ✅ All existing tests pass
- ✅ CLI commands work correctly without hardcoded defaults

## Notes

This task complements md#443 by removing the remaining hardcoded assumptions that bypass the new multi-backend architecture. The goal is to make backend selection truly dynamic based on project structure and configuration, rather than defaulting to markdown regardless of context.
