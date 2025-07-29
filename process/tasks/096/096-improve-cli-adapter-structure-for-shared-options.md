# Task #096: Improve CLI Adapter Structure for Shared Options

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

## Design Approach

Based on the work from Task #80 (Review Workspace and Repository Path Concepts) and Task #87 (Implement Unified Session and Repository Resolution), we'll create a consistent structure for CLI options that aligns with the established conceptual model for workspaces, repositories, and sessions.

The design will follow these principles:

- Options should be grouped by functionality
- Option descriptions should be consistent across commands
- Helper functions should make it easy to add option groups to commands
- Normalization functions should convert CLI options to domain parameters

## Implementation Steps

1. [ ] Create a new utility module at `src/adapters/cli/utils/shared-options.ts`

   - [ ] Define interfaces for common option groups
     - [ ] Repository resolution options (`RepoOptions`)
     - [ ] Output format options (`OutputOptions`)
     - [ ] Task identification options (`TaskOptions`)
   - [ ] Implement functions to add common options to Commander commands
     - [ ] `addRepoOptions(command)` for adding repository resolution options
     - [ ] `addOutputOptions(command)` for adding output format options
     - [ ] `addTaskOptions(command)` for adding task identification options
   - [ ] Add proper JSDoc comments for all exports

2. [ ] Create helper functions for parameter normalization

   - [ ] Function to normalize repository resolution options
     - [ ] Handle converting CLI options to domain parameters
     - [ ] Implement priority order for options (e.g., explicit workspace overrides repo)
   - [ ] Function to normalize output format options
     - [ ] Handle JSON output, debug flags, etc.
   - [ ] Function to normalize task identification options
     - [ ] Handle task ID normalization

3. [ ] Update existing CLI commands to use shared options

   - [ ] Update Git commands
     - [ ] Modify `git.ts` and related files to use shared options
   - [ ] Update Task commands
     - [ ] Modify `tasks.ts` to use shared options
   - [ ] Update Session commands
     - [ ] Modify `session.ts` to use shared options
   - [ ] Update Rule commands
     - [ ] Modify `rules.ts` to use shared options

4. [ ] Add tests for the shared option utilities

   - [ ] Test option composability
     - [ ] Verify that options can be combined correctly
   - [ ] Test parameter normalization
     - [ ] Verify CLI options are correctly converted to domain parameters
   - [ ] Test option handling in commands
     - [ ] Verify commands correctly process the shared options

5. [ ] Update documentation to reflect the new approach
   - [ ] Update code comments to document usage patterns
   - [ ] Add examples of how to use shared options in new commands

## Verification

- [ ] All CLI commands continue to work as before
- [ ] Options are consistently defined across commands
- [ ] Help text is consistent for shared options
- [ ] Option handling is consistent across commands
- [ ] Tests for shared option utilities pass
- [ ] Code duplication is significantly reduced
