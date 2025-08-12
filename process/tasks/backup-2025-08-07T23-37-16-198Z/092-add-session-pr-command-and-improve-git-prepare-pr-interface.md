# Add Session PR Command and Improve Git Prepare-PR Interface

## Context

This task is part of improving the PR workflow in Minsky. The PR preparation workflow documentation references a `session pr` command that does not exist. This task aims to implement that command and improve the related `git prepare-pr` interface for better consistency.

## Background

The current PR preparation workflow documentation references a `session pr` command that does not exist. Additionally, the `git prepare-pr` interface could be improved for better user experience and consistency with other commands.

## Objectives

1. Implement a new `session pr` command that automatically detects session context
2. Review and improve the `git prepare-pr` command interface for consistency
3. Update PR preparation workflow documentation to match actual commands

## Requirements

1. **Session PR Command:**

   - Implement a new `session pr` command in the session command group
   - The command should automatically detect the current session context
   - It should create a properly named PR branch based on the session and task
   - The command should provide clear user feedback on success or failure

2. **Git Prepare-PR Improvements:**

   - Review the current `git prepare-pr` command interface
   - Ensure consistent parameter naming and behavior with other git commands
   - Improve error handling and user feedback
   - Ensure the command works correctly in both session and main workspaces

3. **Documentation Updates:**
   - Update the PR preparation workflow documentation to accurately reflect available commands
   - Provide clear examples of using both `session pr` and `git prepare-pr` commands
   - Ensure consistency in command references across all documentation

## Implementation Suggestions

1. Create a new session PR command in the session command group
2. Review and refactor the `git prepare-pr` command as needed
3. Update PR workflow documentation to reflect the actual command structure
4. Add tests for the new `session pr` command

## Acceptance Criteria

- [ ] New `session pr` command is implemented and working correctly
- [ ] `git prepare-pr` command has consistent interface with other commands
- [ ] PR preparation workflow documentation is updated to match actual commands
- [ ] Both commands work correctly in their respective contexts
- [ ] Test coverage is provided for the new functionality
