# feat(#402): Remove JSON sessiondb backend entirely from codebase

## Summary

**BREAKING CHANGE**: Completely removes the JSON sessiondb backend from Minsky, updating the default to SQLite and eliminating all JSON backend configuration options. This focused removal preserves the generic JsonFileStorage used by task backends while modernizing session storage architecture.

## Changes

### Core Backend Removal

- **Deleted** `src/domain/storage/backends/json-file-storage.ts` - SessionDB-specific JSON backend
- **Removed** JSON from sessiondb backend enum (now `sqlite | postgres` only)
- **Updated** default sessiondb backend from `json` to `sqlite`

### Configuration Schema Updates

- **Removed** JSON backend options from all configuration schemas
- **Updated** validation functions to exclude JSON backend
- **Eliminated** JSON-specific configuration handling and legacy migration logic
- **Fixed** schema imports and type definitions

### Storage Factory Updates

- **Removed** JSON backend support from both storage factory functions
- **Updated** error messages to exclude JSON backend references
- **Cleaned up** unused imports and type definitions
- **Updated** default configurations

### Test Infrastructure

- **Removed** all JSON backend test cases from sessiondb tests (15+ test cases)
- **Fixed** test file syntax issues after removals
- **Updated** test configurations to use SQLite instead of JSON
- **Maintained** comprehensive test coverage for remaining backends

### CLI and Display Logic

- **Updated** default backend fallbacks from `json` to `sqlite`
- **Removed** JSON backend display logic from CLI commands
- **Fixed** conditional statement syntax after JSON case removal
- **Updated** configuration display functions

## Preserved Components

- ✅ **Generic JsonFileStorage** (`src/domain/storage/json-file-storage.ts`) - still used by TaskBackend
- ✅ **JsonFileTaskBackend** - continues to work normally
- ✅ **CLI `--json` output flags** - unrelated to storage backends
- ✅ **All task backend functionality** - no disruption to existing workflows

## Migration Impact

### For Users

- **Required**: Users with JSON sessiondb configurations must migrate to SQLite or PostgreSQL
- **Automatic**: New installations default to SQLite backend
- **Validation**: Configuration validation now rejects JSON backend selections with clear error messages

### Breaking Change Details

- JSON is no longer accepted as a valid sessiondb backend
- Configuration files with `sessiondb.backend: "json"` will fail validation
- Migration tooling and documentation remain available for transition period

## Testing

- ✅ **26+ tests pass** across storage and configuration modules
- ✅ **Expected warnings** appear for legacy JSON configurations (confirms removal)
- ✅ **SQLite default** properly configured and functional
- ✅ **No remaining JSON sessiondb references** in active code paths
- ✅ **Task backend JSON storage** unaffected and fully functional

## Technical Notes

### Focused Removal Strategy

This removal was surgically focused on sessiondb-specific JSON backend while preserving:

- Generic JSON file storage infrastructure
- Task backend JSON storage capabilities
- JSON output formatting options
- Existing backup and migration utilities

### Code Quality

- **Syntax verified**: All removed conditional statements properly cleaned up
- **Linting passed**: No formatting or style issues
- **Type safety**: All TypeScript definitions updated correctly
- **Import cleanup**: Removed unused dependencies and imports

## Verification

The removal has been comprehensively verified:

- Configuration validation properly rejects JSON backend
- Default SQLite backend works correctly
- All tests pass with expected configuration warnings
- No functional regressions in related systems
- Task backend JSON storage completely unaffected

This change modernizes Minsky's session storage architecture while maintaining backward compatibility for all non-sessiondb JSON usage.
