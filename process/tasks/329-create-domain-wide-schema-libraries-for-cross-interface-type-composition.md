# Create Domain-Wide Schema Libraries for Cross-Interface Type Composition

## Context

Extend the type composition patterns established in Task #322 beyond MCP tools to create domain-wide schema libraries that can be shared across CLI, MCP, and future API interfaces.

## Context

Task #322 successfully implemented type composition for MCP session tools, creating schemas like SessionIdentifierSchema, FilePathSchema, and standardized response builders. However, these patterns are currently MCP-specific. We need domain-wide schemas that can be used across all interfaces.

## Requirements

### 1. Domain Schema Libraries

Create reusable schema libraries organized by domain:
- src/domain/schemas/task-schemas.ts
- src/domain/schemas/session-schemas.ts  
- src/domain/schemas/file-schemas.ts
- src/domain/schemas/common-schemas.ts

### 2. Interface-Agnostic Response Types

Create standardized response interfaces that work across all interfaces with success/error patterns.

### 3. Cross-Interface Validation

Implement validation utilities that work consistently across CLI, MCP, and API.

### 4. Refactor Existing MCP Modules

Update existing MCP modules from Task #322 to use the new domain-wide schemas instead of MCP-specific ones:
- src/adapters/mcp/session-workspace.ts
- src/adapters/mcp/session-files.ts
- src/adapters/mcp/session-edit-tools.ts

This demonstrates practical migration and validates that domain schemas can replace interface-specific ones.

## Benefits

1. Code Reuse: Same schemas across CLI, MCP, and future APIs
2. Consistency: Identical validation logic across all interfaces
3. Type Safety: Full TypeScript coverage for all parameters
4. Maintainability: Single source of truth for domain concepts
5. Extensibility: Easy to add new interfaces using existing schemas
6. Migration Path: Clear example of moving from interface-specific to domain-wide schemas

## Implementation Plan

### Phase 1: Create Domain Schema Libraries ✅
- [x] common-schemas.ts with base types and response builders
- [x] task-schemas.ts for task domain operations
- [x] session-schemas.ts for session domain operations
- [x] file-schemas.ts for file domain operations
- [x] validation-utils.ts for cross-interface validation
- [x] index.ts for central exports

### Phase 2: Refactor MCP Modules 📋
- [x] Copy MCP modules to session workspace for refactoring
- [x] Create comprehensive migration guide with schema mapping
- [x] Document response builder migration patterns
- [ ] **FUTURE TASK**: Execute systematic migration of all 3 MCP files
- [ ] **FUTURE TASK**: Test migrated MCP tools functionality
- [ ] **FUTURE TASK**: Deprecate old MCP-specific schemas

### Phase 3: Documentation and Testing ✅
- [x] Comprehensive documentation with examples
- [x] Integration patterns for CLI, MCP, and API
- [x] Migration guide from MCP-specific schemas
- [x] Verification testing

## Solution

Implemented a comprehensive domain-wide schema architecture that extends Task #322's patterns to work across all interfaces. Created modular schema libraries with interface-agnostic validation utilities and response builders. Currently refactoring existing MCP modules to demonstrate practical migration.

## Notes

This task establishes the foundation for consistent type composition across the entire application while providing a clear migration path from interface-specific to domain-wide schemas.
