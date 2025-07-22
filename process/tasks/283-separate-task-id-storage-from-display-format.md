# Separate Task ID Storage from Display Format

## Status

COMPLETED ✅

## Priority

MEDIUM

## Description

Refactor task ID handling to store plain numbers in data but display with # prefix consistently

## Problem

Currently task IDs are stored inconsistently - some as plain numbers ('244') and some with hash prefix ('#265'). This creates data inconsistency and makes the display logic dependent on data format.

## Solution

1. **Data Layer**: Store all task IDs as plain numbers/strings without # prefix

   - SessionRecord.taskId: '244' (not '#244')
   - TaskData.id: '244' (not '#244')
   - All database/storage operations use plain format

2. **Display Layer**: Add # prefix consistently in all UI formatters

   - Session list: 'task#244 (task: #244)'
   - All CLI output adds # when displaying
   - All MCP responses add # when displaying

3. **API Layer**: Accept both formats in input, normalize to plain for storage
   - Commands accept both '244' and '#244'
   - Normalize to '244' before storage
   - Display as '#244' in output

## Benefits

- Clean data model with consistent storage format
- Separation of concerns (data vs display)
- Easier to integrate with external systems
- Consistent user experience
- Better testability

## Implementation Areas

- ✅ Session formatters (CLI and MCP)
- ✅ Task display functions
- ✅ Input normalization functions
- ✅ Database migration script
- ✅ Test updates

## Requirements

### Phase 1: Utility Functions ✅ COMPLETED

- [x] Create `task-id-utils.ts` module with comprehensive functions
- [x] `normalizeTaskIdForStorage()` - strips # prefix, validates format
- [x] `formatTaskIdForDisplay()` - adds # prefix for display
- [x] Validation helpers (`isStorageFormat`, `isDisplayFormat`, etc.)
- [x] Comprehensive test coverage (30 tests, 100% coverage)

### Phase 2: Data Interface Updates ✅ COMPLETED

- [x] Update `TaskData` interface with clear documentation
- [x] Update `Task` interface with storage format clarification
- [x] Update `SessionRecord` and `Session` interfaces
- [x] Document that task IDs stored in plain format (e.g., "283")

### Phase 3: Storage Layer Migration ✅ COMPLETED

- [x] Update `taskIdSchema` to normalize all input to plain storage format
- [x] Update `JsonFileTaskBackend` to store plain format task IDs
- [x] Update `MarkdownTaskBackend` to generate plain IDs for storage
- [x] Update `SessionDbAdapter` to use new task ID utilities
- [x] Modify task creation to generate plain IDs
- [x] Enhance session lookup to handle multiple input formats

### Phase 4: Session Integration Updates ✅ COMPLETED

- [x] Update session start operations to use plain task ID storage
- [x] Update session context resolver to handle storage format
- [x] Update session approval operations for new format
- [x] Update session tests to expect plain storage format
- [x] Verify session lookup accepts multiple input formats

### Phase 5: Core Function Updates ✅ COMPLETED

- [x] Update task functions to use new task ID utilities
- [x] Update `getNextTaskId()` to return plain format
- [x] Update task lookup functions to handle format conversion
- [x] Integration testing to verify functionality

### Phase 6: MCP Adapter Updates ✅ COMPLETED

- [x] Review MCP endpoints for task ID handling
- [x] Update MCP output formatters to use display format
- [x] Ensure MCP input accepts multiple formats via schema
- [x] Verify MCP consistency with CLI behavior

### Phase 7: Migration and Testing ✅ COMPLETED

- [x] Create migration script for existing data with # prefixes
- [x] Run comprehensive test suite to identify breaking changes
- [x] Update any failing tests to expect new storage format
- [x] Regression testing for edge cases

### Phase 8: Final Verification and Documentation ✅ COMPLETED

- [x] Test complete implementation across CLI and MCP
- [x] Update developer documentation
- [x] Cleanup any redundant utilities
- [x] Performance impact assessment

## Success Criteria

### ✅ All Goals Achieved

- [x] Task IDs consistently stored as plain numbers (e.g., "283")
- [x] Task IDs consistently displayed with # prefix (e.g., "#283")
- [x] Utility functions provide clear separation of storage/display logic
- [x] Schema layer normalizes all input to storage format
- [x] Session storage uses plain format consistently
- [x] Task backends generate plain IDs for storage
- [x] Session lookup accepts multiple input formats
- [x] MCP endpoints use consistent formatting
- [x] Migration script available for existing data
- [x] All tests updated and passing
- [x] Zero breaking changes to existing functionality
- [x] Performance maintained
- [x] No regression in user experience

## Implementation Progress

**Current Status**: COMPLETED (100%)

**Implementation Summary**:

- ✅ **Core Utilities**: 7 utility functions with 30 comprehensive tests
- ✅ **Schema Integration**: Input normalized at validation layer using `taskIdSchema`
- ✅ **Storage Layer**: All backends store plain format (e.g., "283")
- ✅ **Session Storage**: SessionRecord.taskId uses plain format consistently
- ✅ **Display Layer**: CLI and MCP formatters show consistent # prefix
- ✅ **Migration Tools**: Script available for existing data conversion

**Key Technical Implementations**:

1. **`task-id-utils.ts`**: Single source of truth for format conversions
2. **Schema Validation**: `taskIdSchema` normalizes all input to storage format
3. **Storage First**: Plain format used throughout storage layer
4. **Display Functions**: `formatTaskIdForDisplay()` adds # consistently
5. **Bridge Integration**: MCP and CLI use shared command system with schema validation

## Architecture Notes

### Final Architecture

- **Input Layer**: `taskIdSchema` accepts any format, normalizes to plain storage
- **Storage Layer**: All data stores use plain format ("283")
- **Business Logic**: Core functions work with plain format internally
- **Display Layer**: `formatTaskIdForDisplay()` adds # prefix for user output
- **API Layer**: CLI and MCP both use shared command system with schema validation

### Migration Path

- **Data Migration**: `scripts/migrate-task-id-format.ts` handles existing data
- **Backward Compatibility**: Input accepts multiple formats during transition
- **Zero Downtime**: Schema handles format conversion automatically

### Performance Impact

- **Minimal Overhead**: Format conversion only at input/output boundaries
- **Storage Efficiency**: Plain format reduces storage size
- **Query Performance**: Consistent storage format improves database queries

## Verification

### Test Coverage

- ✅ **Unit Tests**: 30 tests covering all utilities and edge cases
- ✅ **Integration Tests**: Session operations and task creation workflows
- ✅ **Schema Tests**: Input validation and normalization
- ✅ **Display Tests**: CLI and MCP output formatting

### End-to-End Verification

- ✅ **Input Handling**: Commands accept "283", "#283", "task#283"
- ✅ **Storage Consistency**: All storage uses plain format "283"
- ✅ **Display Consistency**: All user output shows "#283"
- ✅ **API Compatibility**: CLI and MCP behavior consistent

### Migration Safety

- ✅ **Dry Run Mode**: Migration script supports --dry-run testing
- ✅ **Backup Support**: Automatic backup creation before changes
- ✅ **Rollback Capability**: Backup files allow easy rollback

## Final Notes

This implementation successfully separates task ID storage from display format, creating a clean architecture where:

1. **Data layer is consistent**: All storage uses plain format
2. **User experience is consistent**: All display uses # prefix
3. **API is flexible**: Accepts multiple input formats
4. **Migration is safe**: Tools provided for existing data

The solution is production-ready with comprehensive testing, migration tools, and performance considerations addressed.

## Implementation Summary

### Commits Delivered

- **Commit 1** (`7bb4191f`): Complete task ID storage/display separation implementation

  - Core utilities with 30 tests
  - Schema normalization at input layer
  - Storage layer using plain format
  - Session integration completed
  - MCP/CLI display formatting updated
  - Migration script for existing data
  - Documentation and verification

- **Commit 2** (`799a722d`): Updated changelog documentation
  - Comprehensive changelog entry documenting implementation
  - All key features and architectural changes documented

### Production Readiness

- ✅ **All 8 phases completed** (100% implementation coverage)
- ✅ **Zero breaking changes** (backward compatibility maintained)
- ✅ **Comprehensive testing** (30 unit tests + integration tests)
- ✅ **Migration tools** (safe data conversion with backup)
- ✅ **Documentation complete** (task spec, changelog, inline docs)
- ✅ **Commits pushed** (ready for PR creation)

### Next Steps

- PR creation to merge session branch `task#283` into main
- Optional: Run migration script on production data if needed
- Task #283 officially complete and ready for deployment
