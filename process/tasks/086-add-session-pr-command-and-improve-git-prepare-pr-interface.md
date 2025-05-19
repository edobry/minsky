# Task #086: Add `session pr` Command and Improve `git prepare-pr` Interface

## Context

The PR preparation workflow rule currently references a `session pr` command that doesn't exist. This command would make the PR creation process more intuitive for users by automatically detecting the session context and simplifying the command interface. Additionally, the existing `git prepare-pr` command's interface may need refinement for better consistency with other commands.

## Problem Statement

Currently, the PR preparation workflow documentation references a `session pr` command that doesn't exist. This creates confusion for users following the documentation. Additionally, the `git prepare-pr` command has a `--session` option which may be redundant when already in a session context.

## Objectives

1. Implement a new `session pr` command that:
   - Internally uses the existing `git prepare-pr` domain functionality
   - Automatically detects and uses the current session context
   - Follows the same design pattern as other session-specific commands

2. Review the `git prepare-pr` command to:
   - Determine if the `--session` option is necessary or redundant
   - Consider removing/deprecating the option if it's redundant with session auto-detection
   - Ensure proper parameter validation and error handling

## Implementation Details

### New `session pr` Command

The `session pr` command should:
- Accept a `--title` parameter for the PR title
- Automatically use the current session name and context
- Create a PR branch named `pr/<session-name>`
- Merge the current session branch into the PR branch with a non-fast-forward merge
- Include any PR description file content in the merge commit message
- Push the PR branch to the remote repository

### Improvements to `git prepare-pr`

Review the `git prepare-pr` command to:
- Evaluate if the `--session` option is necessary when used within a session
- Consider making session auto-detection behavior consistent with other commands
- Improve error messages when required parameters are missing
- Ensure proper handling of the PR description file

## Acceptance Criteria

1. A new `session pr` command exists and works as expected
2. The command follows the same design patterns as other session commands
3. The `git prepare-pr` command has been reviewed and improved
4. All commands have proper documentation and help text
5. The PR preparation workflow rule has been updated to match the actual command structure
6. Tests have been added for the new command

## Technical Considerations

- Follow the existing command organization patterns
- Reuse the domain logic from the `git prepare-pr` implementation
- Ensure proper error handling for cases like:
  - No active session
  - Missing PR title
  - Existing PR branch
  - Uncommitted changes
- Update any related documentation and help text

## Task Size Estimate

Medium

## Dependencies

- Existing `git prepare-pr` command implementation
- Session detection utilities
- Command organization patterns

## Backward Compatibility

The existing `git prepare-pr` command should continue to work while being improved. 
