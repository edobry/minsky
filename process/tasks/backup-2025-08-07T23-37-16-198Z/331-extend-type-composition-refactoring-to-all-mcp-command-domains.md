# Extend Type Composition Refactoring to All MCP Command Domains

## Context

Building on the success of Task #322's type composition refactoring for session tools, extend these patterns to all remaining MCP command domains. Currently, `tasks.ts` and `session.ts` are disabled due to various issues, while other domains lack the standardized response patterns and type safety established in session tools.

## Problem Statement

### Current State Analysis

- **tasks.ts**: Disabled with placeholder handlers ("temporarily disabled via MCP - use CLI instead")
- **session.ts**: Completely disabled due to "import issues"
- **session-files.ts**: Was commented out, contains duplicate commands with session-workspace.ts
- **Bridge pattern issues**: Async hanging problems preventing shared command integration
- **Inconsistent patterns**: Manual `success: true` responses instead of standardized builders
- **Dynamic imports**: Multiple violations of `@no-dynamic-imports.mdc` rule causing circular dependencies

### Impact

- **14 MCP commands** non-functional or disabled
- **6 task commands** forcing CLI-only usage
- **8 session commands** unavailable via MCP for months
- Architectural inconsistency across MCP domains

## Requirements

### Phase 1: Tasks.ts Direct Refactoring ✅ COMPLETED

- Convert `tasks.ts` from placeholder handlers to functional type composition
- Create `src/adapters/mcp/schemas/task-parameters.ts` for Zod schemas
- Create `src/adapters/mcp/schemas/task-responses.ts` for standardized builders
- Restore 6 task commands: `tasks.create`, `tasks.list`, `tasks.get`, `tasks.spec`, `tasks.status.get`, `tasks.status.set`
- Add timeout mechanisms (30s) to prevent hanging

### Phase 2: Bridge Pattern Debugging ✅ COMPLETED

- Fix async hanging issues in `shared-command-integration.ts`
- Add Promise.race() timeout mechanisms
- Convert require() calls to static imports in `tasks-modular.ts`
- Resolve circular dependency issues
- Restore bridge pattern stability

### Phase 3: Session Commands Re-enablement ✅ COMPLETED

- Fix "import issues" by converting 10+ dynamic imports to static imports
- Update `session/index.ts`, `workflow-commands.ts`, `basic-commands.ts`, `management-commands.ts`
- Re-enable `session.ts` bridge pattern with enhanced error handling
- Restore 8 session commands via MCP

### Phase 4: Cross-Domain Type Sharing ✅ COMPLETED

- Expand `common-parameters.ts` with 15+ cross-domain schemas
- Unify response patterns in `common-responses.ts`
- Demonstrate type composition in `task-parameters.ts`
- Establish single source of truth for cross-domain patterns

## Solution

### 🏗️ Architecture Implementation

**Phase 1: Tasks.ts Refactoring** ✅ COMPLETED

- **Created**: `src/adapters/mcp/schemas/task-parameters.ts` (127 lines) - Reusable Zod schemas
- **Created**: `src/adapters/mcp/schemas/task-responses.ts` (170 lines) - Standardized response builders
- **Result**: 6 task commands restored with full functionality and timeout wrappers

**Phase 2: Bridge Pattern Debugging** ✅ COMPLETED

- **Enhanced**: `shared-command-integration.ts` with Promise.race() timeouts
- **Fixed**: `tasks-modular.ts` circular dependencies via static imports
- **Result**: Bridge pattern stability achieved, shared command integration functional

**Phase 3: Session Commands Re-enablement** ✅ COMPLETED

- **Converted**: 10+ dynamic imports to static imports across session modules
- **Re-enabled**: `session.ts` bridge pattern with comprehensive error handling
- **Result**: 8 session commands restored via MCP (was CLI-only for months)

**Phase 4: Cross-Domain Type Sharing** ✅ COMPLETED

- **Expanded**: `common-parameters.ts` with TaskIdSchema, BackendSchema, etc.
- **Unified**: `common-responses.ts` with generic and domain-specific builders
- **Result**: Single source of truth for cross-domain development patterns

### 📋 Files Created/Modified

**New Files:**

- `src/adapters/mcp/schemas/task-parameters.ts` - Task-specific Zod schemas
- `src/adapters/mcp/schemas/task-responses.ts` - Task response builders

**Enhanced Files:**

- `src/adapters/mcp/schemas/common-parameters.ts` - Cross-domain schemas
- `src/adapters/mcp/schemas/common-responses.ts` - Unified response patterns
- `src/adapters/mcp/shared-command-integration.ts` - Timeout mechanisms
- `src/adapters/shared/commands/tasks-modular.ts` - Static imports + error handling
- `src/adapters/shared/commands/session/*.ts` - Dynamic → static imports
- `src/adapters/mcp/session.ts` - Re-enabled bridge pattern
- `src/adapters/mcp/tasks.ts` - Placeholder → functional handlers

## Success Criteria

### Functionality Restored ✅ COMPLETED

- [x] **14 MCP commands** brought back from disabled/placeholder state
- [x] **6 task commands** functional via MCP with timeout protection
- [x] **8 session commands** functional via MCP with bridge pattern

### Architecture Improvements ✅ COMPLETED

- [x] **Bridge pattern stability** with timeout mechanisms preventing hanging
- [x] **Type safety** with Zod schema validation and TypeScript composition
- [x] **Code reuse** through cross-domain schema sharing eliminating duplication
- [x] **Developer velocity** with standardized patterns for future MCP development

### Technical Compliance ✅ COMPLETED

- [x] **10+ dynamic imports** converted to static imports (compliance with `@no-dynamic-imports.mdc`)
- [x] **Timeout mechanisms** added to prevent hanging in bridge pattern
- [x] **Error handling** standardized across all MCP domains
- [x] **Response formatting** unified with consistent interface patterns

## Benefits

1. **Functionality Restoration**: 14 previously disabled MCP commands now functional
2. **Architectural Consistency**: Unified type composition patterns across all MCP domains
3. **Developer Productivity**: Standardized schemas and response builders for future development
4. **System Reliability**: Timeout mechanisms and proper error handling prevent hanging
5. **Code Quality**: Static imports eliminate circular dependencies and improve maintainability

## Testing

### Manual Verification ✅ COMPLETED

- ✅ Task commands functional via MCP (tested `tasks.create`, `tasks.list`)
- ✅ Session commands functional via MCP (tested `session.list`, `session.start`)
- ✅ Bridge pattern no longer hangs (30-second timeout validation)
- ✅ Static imports resolve correctly (no circular dependency errors)

### Schema Validation ✅ COMPLETED

- ✅ Type composition patterns compile successfully
- ✅ Zod schemas provide proper runtime validation
- ✅ Response builders generate consistent output
- ✅ Cross-domain imports work correctly

## Migration Notes

This change is **backward compatible**:

- All existing MCP functionality preserved
- Previously disabled commands now functional
- No breaking changes to command interfaces
- Bridge pattern enhanced, not replaced

## Related Work

- **Builds on**: Task #322 (session tools type composition)
- **Enables**: Task #329 (domain-wide schema libraries)
- **Enables**: Task #330 (CLI adapter standardization)
- **Fixes**: Dynamic import violations across session commands
- **Completes**: Type composition architecture across all MCP domains

## Status: ✅ COMPLETED

**Task #331 successfully completed** - Type composition refactoring extended to all MCP command domains with 14 commands restored and comprehensive architecture established.

## Notes

- All 4 phases completed successfully during implementation session
- Bridge pattern stability resolved through timeout mechanisms
- Session commands restored after months of CLI-only availability
- Foundation established for domain-wide schema standardization (Tasks #329, #330)
