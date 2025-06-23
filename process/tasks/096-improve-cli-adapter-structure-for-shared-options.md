# Improve CLI Adapter Structure for Shared Options

## Context

The current CLI adapter structure in the Minsky project defines command options separately for each command. This leads to duplication of common options (like `--repo`, `--session`, `--workspace`, `--json`) across multiple commands, making maintenance harder and increasing the chance of inconsistencies.

## Requirements

1. **Shared Options Types**

   - Create a set of shared TypeScript interface types for commonly used option groups
   - Implement at minimum these shared option groups:
     - Repository resolution options (`--repo`, `--session`, `--workspace`)
     - Output format options (`--json`, `--debug`)
     - Task identification options (`--task <taskId>`)

2. **Reusable Option Definitions**

   - Create a utility module to define reusable command option definitions
   - Each shared option should be consistently defined with the same description and behavior
   - Options should be composable (able to be combined in different commands)

3. **Migration Strategy**

   - Update all existing CLI commands to use the shared option definitions
   - Ensure backward compatibility is maintained
   - Document the new approach for future command implementations

4. **Validation Helpers**
   - Create validation utilities for shared options if needed
   - Ensure that mutually exclusive options are properly handled

## Implementation Steps

1. [ ] Create a new utility module at `src/adapters/cli/utils/shared-options.ts`

   - [ ] Define interfaces for common option groups
   - [ ] Implement functions to add common options to Commander commands
   - [ ] Add proper JSDoc comments for all exports

2. [ ] Create helper functions for parameter normalization

   - [ ] Function to normalize repository resolution options
   - [ ] Function to normalize output format options
   - [ ] Function to normalize task identification options

3. [ ] Update existing CLI commands to use shared options

   - [ ] Update Git commands
   - [ ] Update Task commands
   - [ ] Update Session commands
   - [ ] Update Rule commands

4. [ ] Add tests for the shared option utilities

   - [ ] Test option composability
   - [ ] Test parameter normalization

5. [ ] Update documentation to reflect the new approach

## Verification

- [ ] All CLI commands continue to work as before
- [ ] Options are consistently defined across commands
- [ ] Help text is consistent for shared options
- [ ] Option handling is consistent across commands
- [ ] Tests for shared option utilities pass
- [ ] Code duplication is significantly reduced
