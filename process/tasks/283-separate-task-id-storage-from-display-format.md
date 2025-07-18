# Separate Task ID Storage from Display Format

## Status

IN-PROGRESS (Phase 5 of 8)

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
- 🔄 Input normalization functions
- ⏳ Database migration script
- ⏳ Test updates

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
- [x] Update `JsonFileTaskBackend` to store plain format task IDs
- [x] Update `SessionDbAdapter` to use new task ID utilities
- [x] Modify task creation to generate plain IDs
- [x] Enhance session lookup to handle multiple input formats
- [x] Integration testing to verify functionality

### Phase 4: Display Layer Updates ✅ COMPLETED
- [x] Update CLI result formatters to use `formatTaskIdForDisplay()`
- [x] Update session summary and details formatters
- [x] Update task markdown formatting for consistent # prefix
- [x] Update session review formatters
- [x] Update CLI bridge formatters for task lists and status
- [x] Verify display functions work across all scenarios

### Phase 5: Input Normalization Layer 🔄 IN PROGRESS
- [ ] Update CLI commands to use `normalizeTaskIdForStorage()`
- [ ] Update MCP handlers to normalize input task IDs
- [ ] Update command validation to accept multiple input formats
- [ ] **REVIEW NOTE**: Before proceeding with normalization implementation, review the current approach to ensure we're taking the simplest path and not overcomplicating things or introducing redundant logic. Consider if existing utilities can be leveraged or if simpler patterns would achieve the same goals.

### Phase 6: Database Migration Script ⏳ PENDING
- [ ] Create script to convert existing stored task IDs from "#XXX" to "XXX"
- [ ] Handle session records, task data, and other stored references
- [ ] Backup and rollback capabilities
- [ ] Dry-run mode for testing

### Phase 7: Test Updates ⏳ PENDING
- [ ] Update existing tests to expect plain storage format
- [ ] Update tests to verify # display format
- [ ] Ensure all integration tests pass with new approach
- [ ] Add regression tests for edge cases

### Phase 8: Final Verification ⏳ PENDING
- [ ] Test complete implementation across CLI and MCP
- [ ] Verify consistent behavior for create, read, update operations
- [ ] Verify input acceptance and display consistency
- [ ] Performance impact assessment

## Success Criteria

### ✅ Achieved So Far
- [x] Task IDs consistently stored as plain numbers (e.g., "283")
- [x] Task IDs consistently displayed with # prefix (e.g., "#283")
- [x] Utility functions provide clear separation of storage/display logic
- [x] All display components show consistent # prefix formatting
- [x] Session lookup accepts multiple input formats
- [x] Zero breaking changes to existing functionality
- [x] 100% test coverage for utility functions

### 🎯 Remaining Goals
- [ ] All CLI commands accept both "283" and "#283" input formats
- [ ] All MCP endpoints normalize input before storage
- [ ] Database migration completed without data loss
- [ ] All existing tests updated and passing
- [ ] Performance maintained or improved
- [ ] No regression in user experience

## Implementation Progress

**Current Status**: Phase 5 of 8 (62% Complete)

**Completed**:
- ✅ **Utility Functions**: 7 functions with 30 tests
- ✅ **Data Interfaces**: Clear documentation for storage format
- ✅ **Storage Layer**: JsonFileTaskBackend and SessionDbAdapter updated
- ✅ **Display Layer**: All formatters show consistent # prefix

**Verification Results**:
- ✅ Task ID utilities: All 30 tests passing
- ✅ JsonFileTaskBackend: All 12 tests passing  
- ✅ Display functions: Verified working correctly
- ✅ Session lookup: Handles multiple input formats

**Next Priority**: Input normalization layer with simplicity review

## Architecture Notes

### Key Design Decisions
1. **Single Source of Truth**: `task-id-utils.ts` handles all format conversions
2. **Clear Separation**: Storage (plain) vs Display (# prefix) formats
3. **Backward Compatibility**: Accept multiple input formats during transition
4. **Incremental Migration**: Phase-by-phase implementation reduces risk

### Technical Debt Considerations
- Temporary redundancy during migration phase
- Multiple normalization paths may exist initially
- Need to ensure simplicity is maintained as implementation progresses
