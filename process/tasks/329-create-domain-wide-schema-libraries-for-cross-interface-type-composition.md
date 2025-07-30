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

## Benefits

1. Code Reuse: Same schemas across CLI, MCP, and future APIs
2. Consistency: Identical validation logic across all interfaces
3. Type Safety: Full TypeScript coverage for all parameters
4. Maintainability: Single source of truth for domain concepts
5. Extensibility: Easy to add new interfaces using existing schemas

## Requirements

## Solution

## Notes
