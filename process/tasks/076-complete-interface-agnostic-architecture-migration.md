# Task #076: Complete Interface-Agnostic Architecture Migration

## Context

The Minsky project is in the middle of a transition from a traditional CLI command structure to a new interface-agnostic architecture. This migration was started in Task #039 (Interface-Agnostic Command Architecture) and aims to eliminate code duplication between CLI and MCP (Model Context Protocol) interfaces by extracting shared domain logic into standalone functions.

Currently, the migration is only partially complete:

- The Tasks module has been partially migrated (CLI imports from new adapter, but old files still exist)
- The Git module has adapter files but the CLI still uses the old implementation
- Session, Init, Rules, and other command modules haven't started migration
- This partial state leads to code duplication and maintenance challenges

## Requirements

1. **Complete Tasks Module Migration**

   - Verify all tasks functionality in the new adapter implementation
   - Add any missing functionality to the adapter
   - Clean up and remove old tasks implementation files
   - Update tests to only use the new implementation

2. **Migrate Git Commands**

   - Update the CLI entry point to use the Git adapter
   - Verify all git functionality works through the new adapter
   - Add any missing functionality to the adapter
   - Update tests to use the new implementation
   - Clean up and remove old git implementation files

3. **Migrate Session Commands**

   - Create session adapter implementation in `src/adapters/cli/session.ts`
   - Ensure all functionality is properly working through the adapter
   - Update the CLI entry point to use the new adapter
   - Update tests to use the new implementation
   - Clean up and remove old session implementation files

4. **Migrate Remaining Commands**

   - Create adapters for Init and Rules commands
   - Update the CLI entry point to use these adapters
   - Verify all functionality works through the new adapters
   - Update tests to use the new implementations
   - Clean up and remove old implementation files

5. **Final Documentation and Cleanup**
   - Update all documentation to reflect the new architecture
   - Ensure consistent error handling across all adapters
   - Remove any remaining old implementation files
   - Update the build and test scripts as needed

## Implementation Steps

### Phase 1: Complete Tasks Module Migration

- [ ] Audit all tasks functionality in the old implementation
- [ ] Compare with functionality in the new adapter
- [ ] Add missing functionality to the new adapter
- [ ] Run all existing tests against the new implementation
- [ ] Fix any issues found during testing
- [ ] Remove old tasks implementation files

### Phase 2: Migrate Git Commands

- [ ] Audit functionality in git command files
- [ ] Update git adapter implementation if necessary
- [ ] Update CLI entry point to use git adapter
- [ ] Run tests to verify functionality
- [ ] Add any missing functionality to the adapter
- [ ] Remove old git implementation files

### Phase 3: Migrate Session Commands

- [ ] Create session adapter implementation
- [ ] Implement all existing session command functionality
- [ ] Update CLI entry point to use session adapter
- [ ] Add tests for session adapter
- [ ] Fix any issues found during testing
- [ ] Remove old session implementation files

### Phase 4: Migrate Remaining Commands

- [ ] Create init adapter implementation
- [ ] Create rules adapter implementation
- [ ] Update CLI entry point to use new adapters
- [ ] Run tests to verify functionality
- [ ] Add any missing functionality to adapters
- [ ] Remove old implementation files

### Phase 5: Final Documentation and Cleanup

- [ ] Update architecture documentation
- [ ] Document adapter implementation patterns
- [ ] Update changelog
- [ ] Update README with new architecture information
- [ ] Perform final code cleanup

## Verification

- [ ] All CLI commands work correctly through the new architecture
- [ ] MCP commands use the same domain functions as CLI commands
- [ ] No duplicate implementations exist in the codebase
- [ ] All tests pass
- [ ] Documentation is updated to reflect the new architecture
- [ ] No performance regressions are introduced

## Benefits

- **Reduced Code Duplication**: Eliminates duplicate code between CLI and MCP interfaces
- **Improved Maintainability**: Changes only need to be made in one place
- **Consistency**: Ensures consistent behavior across all interfaces
- **Testability**: More isolated and focused testing of domain logic
- **Extensibility**: Easier to add new interfaces in the future (like REST API)

## Related Tasks

- Task #039: Interface-Agnostic Command Architecture (parent task that started this migration)
