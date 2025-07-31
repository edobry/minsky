# Apply Type Composition Patterns to CLI Adapters

## Context

Apply the type composition patterns established in Task #322 and extended in Task #329 to CLI adapters, creating standardized parameter handling, response formatting, and error handling across all CLI commands.

## Context

While Task #322 focused on MCP tools and Task #329 creates domain-wide schemas, CLI adapters in src/adapters/cli/ currently have inconsistent patterns for parameter validation, response formatting, and error handling. This task standardizes CLI adapters to use the same type composition patterns.

## Requirements

### 1. CLI Parameter Standardization

Standardize CLI parameter handling using domain schemas for validation consistency across all commands.

### 2. CLI Response Standardization

Create standardized response formatting for both JSON and human-readable output across all CLI commands.

### 3. CLI Error Handling Standardization

Implement consistent error handling patterns with proper exit codes and user-friendly messages.

### 4. CLI Command Composition

Create composable CLI command patterns that use Zod schemas for validation.

## Benefits

1. Consistency: Identical parameter validation logic across CLI and MCP
2. Type Safety: Full TypeScript coverage for CLI parameters
3. Maintainability: Shared validation logic reduces duplication
4. User Experience: Consistent error messages and output formatting
5. Developer Experience: Composable patterns for creating new CLI commands

## Dependencies

- Task #329 must be completed first to provide domain schemas
- Builds on patterns established in Task #322

## Requirements

## Solution

## Notes
