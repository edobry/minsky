## Summary

Implements automatic session task association updates during task migrations to prevent orphaned sessions and merge command failures.

## Key Features

- **Session Task Association Management**: New module with core functionality for updating session-to-task relationships
- **Migration Integration**: Automatic session updates during TasksMigrateBackendCommand execution
- **Dry-run Support**: Preview what session updates would happen without making changes
- **Comprehensive Testing**: 15 test cases covering all scenarios and error conditions
- **Complete Documentation**: Technical docs and changelog updates

## Changes

### Added
- `src/domain/session/session-task-association.ts` - Core functionality module
- `src/domain/session/session-task-association.test.ts` - Comprehensive test suite
- `docs/session-task-association.md` - Technical documentation

### Modified
- `src/adapters/shared/commands/tasks/migrate-backend-command.ts` - Integration with migration workflow
- `CHANGELOG.md` - Feature documentation

## Problem Solved

When tasks are migrated between backends (e.g., md#123 → mt#473), sessions remain associated with the old task ID, causing merge command failures. This implementation automatically repoints session associations during migrations.

## Testing

- ✅ 15 comprehensive test cases
- ✅ All existing 193 session tests pass
- ✅ Integration verified with migration command
- ✅ Dry-run mode tested and working

## Usage

Sessions are automatically updated during task migrations:

```bash
# Preview what would happen
minsky tasks migrate-backend --from markdown --to minsky

# Execute with automatic session updates
minsky tasks migrate-backend --from markdown --to minsky --execute
```

Resolves the issue where sessions become orphaned after task migrations, preventing merge command failures.