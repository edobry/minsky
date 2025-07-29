# Task #328: Fix Command Nesting Architecture and Eliminate Complex Nesting Warnings

## Problem Statement

The Minsky CLI has architectural inconsistencies in how commands are organized and nested, leading to:

1. **"Complex command nesting not yet supported" warnings** during CLI startup
2. **Inconsistent command structure** between top-level commands and sub-commands
3. **Failed command parsing** where `minsky tasks status get 160` results in "unknown command 'status'" 
4. **Architectural mismatch** between category-based top-level commands and space-separated sub-command parsing

## Root Cause Analysis

### Current Problematic Architecture

**Top-level commands** (working correctly):
```
minsky
├── tasks (category-based)
├── session (category-based) 
├── git (category-based)
└── core (category-based)
```

**Sub-commands** (problematic):
```
minsky tasks
├── list
├── get
├── create  
├── delete
├── "status.get" (space-separated parsing - broken)
└── "status.set" (space-separated parsing - broken)
```

### Technical Issues

1. **Space-separated name parsing**: Commands like `"status get"` and `"status set"` rely on complex string parsing instead of proper hierarchical structure
2. **Inconsistent nesting approaches**: Mixed usage of category-based and space-parsing approaches  
3. **Command collision**: Multiple commands trying to create the same intermediate command (e.g., "AI", "Models")
4. **Incomplete recursive nesting**: 3+ level commands fall back to warnings instead of proper nesting

## Solution Architecture

### Hierarchical Command Structure (Consistent with Top-Level)

**Proposed structure**:
```
minsky tasks
├── list
├── get
├── create
├── delete
└── status (proper subcommand group)
    ├── get
    └── set
```

**Result**: `minsky tasks status get 160` works naturally

### Implementation Approach

#### Phase 1: Fix Command Registration Structure

1. **Remove space-separated parsing** from command names
   - Change `name: "status get"` → proper hierarchical registration
   - Change `name: "status set"` → proper hierarchical registration

2. **Implement proper subcommand groups**
   - Register `status` as a subcommand under `tasks`
   - Register `get` and `set` as subcommands under `status`

3. **Consistent key generation** for command groups
   - Use same naming convention across all nesting levels
   - Prevent duplicate intermediate command creation

#### Phase 2: Eliminate Complex Nesting Warnings

1. **Implement recursive command nesting** for arbitrary depth
2. **Shared command group caching** to prevent duplicates
3. **Consistent command key generation** across all nesting methods

#### Phase 3: Extend Pattern to Other Command Domains

Apply the same hierarchical structure to other command domains that may have similar issues:
- AI commands (`core AI models list` vs `core AI models refresh`)
- Session commands
- Git commands
- Any other domains with nested command structures

## Acceptance Criteria

### Must Have
- [ ] `minsky tasks status get <taskId>` works without errors
- [ ] `minsky tasks status set <taskId> <status>` works without errors  
- [ ] No "Complex command nesting not yet supported" warnings during CLI startup
- [ ] No "cannot add command 'X' as already have command 'X'" errors
- [ ] All existing command functionality preserved
- [ ] Consistent hierarchical structure across all command domains

### Should Have
- [ ] Help output shows proper command hierarchy (`minsky tasks --help` shows `status` as subcommand)
- [ ] `minsky tasks status --help` shows `get` and `set` as subcommands
- [ ] All 3+ level commands work with proper nesting (no warnings)
- [ ] Command completion works properly for nested commands

### Could Have
- [ ] Performance improvements from better command group caching
- [ ] Enhanced error messages for malformed command structures
- [ ] Documentation updates reflecting new command structure

## Implementation Details

### Files to Modify

1. **`src/adapters/shared/commands/tasks-modular.ts`**
   - Remove space-separated names (`"status get"`, `"status set"`)
   - Implement proper hierarchical registration

2. **`src/adapters/shared/bridges/cli/category-command-handler.ts`**
   - Fix recursive nesting implementation
   - Implement consistent command group caching
   - Remove complex nesting warnings

3. **Task status command files**
   - Potentially restructure to support hierarchical registration

### Technical Considerations

1. **Backward Compatibility**: Ensure existing scripts and workflows continue to work
2. **MCP Integration**: Verify that MCP command exposure still works correctly
3. **Testing**: Ensure all existing tests pass and add tests for new command structures
4. **Documentation**: Update help text and documentation to reflect new structure

## Dependencies

- Understanding of Commander.js command hierarchy patterns
- Knowledge of current Minsky command registration system
- Familiarity with both CLI and MCP command interfaces

## Risks and Mitigations

### Risks
1. **Breaking existing workflows** that rely on current command structure
2. **MCP command mapping conflicts** if command IDs change
3. **Complex refactoring** across multiple command domains

### Mitigations
1. **Incremental implementation** starting with tasks status commands
2. **Comprehensive testing** before and after changes
3. **Maintain command IDs** for MCP compatibility while changing CLI structure
4. **Clear documentation** of any breaking changes

## Definition of Done

- All acceptance criteria met
- No CLI startup warnings or errors
- All existing tests pass
- New tests added for hierarchical command structure
- Documentation updated
- Code review completed
- Changes verified in both CLI and MCP interfaces

## Notes

This task represents a significant architectural improvement that will make the CLI more consistent, predictable, and maintainable. The hierarchical approach aligns with standard CLI design patterns and will eliminate the current parsing complexity. 
