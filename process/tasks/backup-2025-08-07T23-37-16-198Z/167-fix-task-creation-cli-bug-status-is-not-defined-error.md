# Fix Task Creation CLI Bug - "status is not defined" Error

## Overview

Fix the critical bug in the `minsky tasks create` command that causes it to fail with "status is not defined" error, preventing proper task creation workflow.

## Background

When attempting to use the `minsky tasks create` command as required by the task creation process, the command fails with:

```
error defined
Error: status is not defined
```

This prevents the proper task creation workflow and forces manual task creation as a fallback, which should only be used when the CLI is unavailable.

## Current Impact

- **Broken task creation workflow**: Cannot use `minsky tasks create <spec-path>`
- **Process violations**: Forces manual task creation instead of CLI-driven process
- **Inconsistent task tracking**: Manual creation is error-prone and bypasses automated ID assignment
- **Developer friction**: Slows down task creation and violates established workflow

## Root Cause Analysis

The error "status is not defined" suggests this is likely related to the variable naming issues we've been addressing throughout the codebase. Specifically:

1. **Variable naming patterns**: Function parameters with underscores (`_status`) being referenced without underscores (`status`)
2. **TypeScript errors**: Part of the 1235+ errors revealed when we removed incompatible `@types/commander`
3. **Scope issues**: Variables not properly defined in the function scope where they're used

## Requirements

### Core Requirements

1. **Identify the exact location** of the "status is not defined" error in the task creation code path
2. **Fix the variable naming issue** causing the undefined reference
3. **Verify task creation works** end-to-end with test cases
4. **Ensure no regressions** in existing task creation functionality

### Investigation Steps

1. **Trace the error**:

   - Find where "status" is referenced in task creation code
   - Check for parameter naming mismatches (e.g., `_status` parameter, `status` usage)
   - Review import statements and variable declarations

2. **Common locations to check**:

   - `src/adapters/shared/commands/tasks/task-commands.ts`
   - `src/domain/tasks/task-service.ts`
   - `src/domain/tasks/taskCommands.ts`
   - Task backend implementations (markdown, json-file, github)

3. **Fix patterns to apply**:
   - Change `_status` parameters to `status`
   - Add missing variable declarations
   - Fix import statements if needed
   - Ensure proper TypeScript types

### Verification Requirements

1. **Basic functionality**:

   ```bash
   # Should work without errors
   minsky tasks create process/tasks/temp-test-spec.md
   ```

2. **End-to-end workflow**:

   - Create temporary spec file
   - Run `minsky tasks create` command
   - Verify task is added to `process/tasks.md`
   - Verify correct task ID assignment
   - Verify spec file can be renamed to use assigned ID

3. **Edge cases**:
   - Test with different spec file formats
   - Test with various command options (`--backend`, `--json`, etc.)
   - Test error handling for invalid spec files

### Success Criteria

- [ ] `minsky tasks create` command executes without "status is not defined" error
- [ ] Task creation workflow completes successfully end-to-end
- [ ] Tasks are properly added to `process/tasks.md` with correct formatting
- [ ] Task IDs are assigned correctly and sequentially
- [ ] All command options work as expected (`--backend`, `--json`, etc.)
- [ ] Error handling works for invalid inputs
- [ ] No regressions in existing task functionality

## Implementation Strategy

1. **Phase 1: Investigation**

   - Run `minsky tasks create` with verbose/debug output if available
   - Search codebase for "status" references in task-related files
   - Identify the exact file and line causing the error

2. **Phase 2: Fix**

   - Apply variable naming fixes (likely removing underscores from parameters)
   - Test the fix locally
   - Ensure TypeScript compilation succeeds

3. **Phase 3: Verification**
   - Test basic task creation
   - Test all command options
   - Test error conditions
   - Verify no regressions in related commands

## Technical Notes

- This bug is likely part of the broader variable naming issues affecting the codebase
- The fix should be straightforward once the exact location is identified
- May be related to Task #165 (process.exit issues) or Task #166 (TypeScript errors)
- Should be prioritized as HIGH since it blocks the core task creation workflow

## Dependencies

- This task should be completed before implementing Task #165 or #166
- Fixing this will enable proper CLI-driven task creation for future tasks
- May reveal additional variable naming issues in the task management code path

## Estimated Effort

**Small to Medium** - Likely a simple variable naming fix, but requires investigation to locate the exact issue and thorough testing to ensure the workflow is fully restored.
