<<<<<<< HEAD

# Task #402: Remove JSON sessiondb backend entirely from codebase

## Status

TODO

## Priority

Medium

## Summary

Remove ONLY the JSON sessiondb backend from the Minsky codebase. This is specifically about removing JSON as a storage option for sessions, NOT the generic JsonFileStorage used by other components.

## Scope of Removal

### SessionDB-Specific JSON Backend Only

- `src/domain/storage/backends/json-file-storage.ts` - SessionDB-specific JSON backend
- Remove "json" option from sessiondb backend enum in `src/domain/configuration/schemas/sessiondb.ts`
- Update default backend from "json" to "sqlite"
- Remove JSON backend case from storage factory functions
- Remove JSON-specific configuration schema for sessiondb

### Files to Keep (Used by Other Components)

- `src/domain/storage/json-file-storage.ts` - Generic JSON storage used by TaskBackend
- `src/domain/tasks/jsonFileTaskBackend.ts` - Uses generic JSON storage, not sessiondb
- CLI `--json` output format options (completely unrelated to storage backends)

## Specific Changes Required

1. **Configuration Schema Updates**:

   - Remove "json" from `sessionDbBackendSchema` enum in `src/domain/configuration/schemas/sessiondb.ts`
   - Change default from "json" to "sqlite"
   - Remove `jsonSessionDbConfigSchema`
   - Remove json config from `sessionDbConfigSchema`
   - Remove JSON handling from validation functions

2. **Storage Factory Updates**:

   - Remove JSON case from `createStorageBackend()` in `src/domain/storage/storage-backend-factory.ts`
   - Remove JSON case from `EnhancedStorageBackendFactory`
   - Remove JsonFileStorage import from these files

3. **Backend File Removal**:

   - Delete `src/domain/storage/backends/json-file-storage.ts`

4. **Test Updates**:
   - Remove JSON backend test cases from storage factory tests
   - Remove JSON backend from database integrity checker tests
   - Update any tests that reference JSON as a sessiondb backend option

## Verification Requirements

- All tests pass with JSON sessiondb backend removed
- SQLite becomes the default sessiondb backend
- Generic JsonFileStorage still works for task backend
- No remaining references to JSON as a sessiondb backend option
- # Storage factory properly rejects JSON backend requests

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

> > > > > > > origin/main
