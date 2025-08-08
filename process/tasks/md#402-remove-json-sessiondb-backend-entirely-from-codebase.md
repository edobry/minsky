# Remove JSON sessiondb backend entirely from codebase

## Context

Remove the JSON sessiondb backend completely from the Minsky codebase, including:

## Scope of Removal

### Core JSON SessionDB Components

- `src/domain/storage/backends/json-file-storage.ts` - Main JSON backend implementation
- `src/domain/storage/json-file-storage.ts` - Generic JSON storage implementation
- `src/domain/storage/json-file-storage.test.ts` - Tests for JSON storage

### Configuration and Schema Updates

- Remove JSON backend option from `src/domain/configuration/schemas/sessiondb.ts`
- Update default backend from "json" to "sqlite" in schema
- Remove JSON-specific configuration handling
- Update validation functions to exclude JSON backend

### Command Integration Updates

- Remove JSON backend option from MCP and CLI commands
- Update sessiondb migrate command to exclude JSON as source/target
- Update sessiondb check command to exclude JSON backend
- Remove JSON backend display logic from configuration commands

### Task Backend Updates

- Remove `src/domain/tasks/jsonFileTaskBackend.ts` - JSON task backend
- Update task service to exclude JSON task backend
- Remove JSON backend from multi-backend error handling

### Test Updates

- Remove all JSON backend test cases from storage tests
- Update database integrity checker tests to exclude JSON
- Update configuration tests to exclude JSON backend
- Remove JSON backend from test utilities and mocks

### Documentation Updates

- Update all documentation to remove JSON backend references
- Update migration guides to reflect JSON backend removal
- Update architecture documentation
- Update configuration examples

## Migration Strategy

Since JSON was the original backend, ensure:

1. Clear migration path to SQLite for existing JSON users
2. Updated default configuration points to SQLite
3. Error messages guide users to migrate from JSON to SQLite
4. Backup existing JSON data before removal

## Verification Requirements

- All tests pass with JSON backend removed
- No remaining references to JSON backend in codebase
- Configuration validation rejects JSON backend
- SQLite becomes the new default backend
- Migration commands work properly without JSON support

## Requirements

## Solution

## Notes
