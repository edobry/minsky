# Task #100: Align MCP API with CLI Implementation and Remove Placeholders

## Context

Currently, there's a mismatch between the documented MCP API in README-MCP.md and the actual implemented functionality. Task #52 created documentation and tests for additional task commands (`filter`, `update`, `delete`, `info`), but these aren't actually implemented in either the CLI or MCP adapters. Additionally, there are placeholder comments in the CLI adapter files indicating future commands that aren't yet implemented (like `// Future: tasksCommand.addCommand(createUpdateCommand());` in the CLI tasks adapter).

This misalignment creates confusion about what functionality is actually available and can lead to errors when attempting to use unimplemented features. We need to either implement the missing functionality or update the documentation and remove placeholders to accurately reflect what's currently available.

## Requirements

1. **Documentation Accuracy**

   - Ensure README-MCP.md accurately reflects only implemented commands
   - Remove documentation for commands that don't exist in the codebase

2. **Code Cleanup**

   - Remove commented-out "future" references in CLI adapter files (e.g., `// Future: tasksCommand.addCommand(createUpdateCommand());`)
   - Ensure no dangling placeholder code exists anywhere in the codebase
   - Specifically clean up placeholders in the task command adapter and any other command adapters

3. **Command Consistency**

   - Ensure MCP commands exactly match CLI commands with no discrepancies
   - Apply this synchronization across all command types:
     - Task commands
     - Session commands
     - Git commands
     - Rules commands
     - Any other command categories

4. **Future Implementation Plan**
   - Document unimplemented but planned commands in a dedicated "Future Work" or "Roadmap" section
   - Make it clear which commands are planned but not yet available

## Implementation Steps

1. [ ] Audit Current Command Alignment

   - [ ] List all CLI commands implemented in `src/adapters/cli/*.ts`
   - [ ] Compare with MCP commands in `src/adapters/mcp/*.ts`
   - [ ] Identify mismatches between CLI and MCP implementations
   - [ ] Identify placeholder comments and future command references

2. [ ] Update Documentation

   - [ ] Remove documentation for unimplemented commands from README-MCP.md
   - [ ] Add a "Planned Features" section for future commands
   - [ ] Ensure parameter documentation reflects actual implementation

3. [ ] Clean Up CLI Code

   - [ ] Remove commented-out "future" references in task commands (`// Future: tasksCommand.addCommand(createUpdateCommand());`)
   - [ ] Check and remove similar placeholders in other command modules
   - [ ] Ensure the code accurately reflects what's implemented

4. [ ] Remove Test Mocks for Unimplemented Features

   - [ ] Identify tests for unimplemented features (like in `tasks-mcp.test.ts`)
   - [ ] Either remove these tests or mark them as skipped with a comment
   - [ ] Update test files to match actual implementation

5. [ ] Verify Both Interfaces Match
   - [ ] Confirm CLI and MCP expose exactly the same command functionality
   - [ ] Document any legitimate differences where appropriate

## Verification

- [ ] README-MCP.md only documents actual implemented commands
- [ ] No commented-out "future" command references remain in the codebase
- [ ] CLI adapter code is free of placeholder comments about future implementations
- [ ] MCP and CLI implementations offer the same functionality
- [ ] Tests accurately reflect the implemented functionality
- [ ] No references to unimplemented features remain in user-facing documentation
- [ ] A clear "Future Features" or "Roadmap" section exists in the documentation
