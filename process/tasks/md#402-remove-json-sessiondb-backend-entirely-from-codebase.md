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
- Storage factory properly rejects JSON backend requests