# Add Session Inspect Subcommand for Current Session Detection

## Context

Minsky provides session management capabilities through the `minsky session` command. Currently, users can list, get, start, delete, update, and perform other operations on sessions. When working within a session workspace, several commands already leverage auto-detection to determine the current session context (implemented in Task #070 and expanded in Task #084).

However, there is no dedicated command for quickly inspecting the current session details when a user is already working within a session workspace. A simple `minsky session inspect` command would provide a straightforward way for users to verify their current session context without having to remember to use `minsky session get` with auto-detection.

## Goal

Implement a new `inspect` subcommand for the `minsky session` command that automatically detects and displays details of the current session if the user is in a session workspace.

## Requirements

1. **Command Implementation:**

   - Add a new `inspect` subcommand to the `minsky session` command
   - The command should work with no arguments and auto-detect the current session
   - Reuse the existing `getCurrentSessionContext` utility for session detection
   - Output similar details to the `session get` command (session name, branch, task ID if available)

2. **User Experience:**

   - Provide clear error messages when not in a session workspace
   - Include appropriate help text describing the command's purpose
   - Support JSON output format option for programmatic consumption
   - Ensure consistent behavior with other session commands

3. **Code Organization:**

   - Follow the established pattern for command implementation in `src/adapters/cli/session.ts`
   - Reuse existing domain functions where appropriate
   - Maintain separation between interface and domain logic

4. **Testing:**
   - Add unit tests for the new subcommand
   - Add integration tests that verify behavior both inside and outside session workspaces
   - Ensure tests cover both successful auto-detection and error scenarios

## Implementation Steps

### 1. Command Implementation

- [ ] Create a new `createInspectCommand` function in `src/adapters/cli/session.ts`
- [ ] Implement auto-detection using `getCurrentSessionContext` from `domain/workspace.js`
- [ ] Add appropriate error handling for when not in a session workspace
- [ ] Add command to the `createSessionCommand` function's list of subcommands
- [ ] Reuse the output formatting approach from the `get` command for consistency

### 2. Testing

- [ ] Add unit tests for the new `inspect` subcommand
- [ ] Add integration tests that verify behavior in different contexts
- [ ] Test JSON output formatting option

### 3. Documentation

- [ ] Update command help text to clearly explain the command's purpose
- [ ] Ensure help text is consistent with other session commands
- [ ] Add the new command to any relevant user documentation

## Implementation Strategy

1. Study existing auto-detection implementations in `session dir` and `tasks get` commands
2. Reuse the established patterns for command structure and output formatting
3. Leverage the existing `getCurrentSessionContext` utility for session detection
4. Ensure consistent error handling with other auto-detecting commands

## Verification

- [ ] `minsky session inspect` works correctly when run from a session workspace
- [ ] `minsky session inspect --json` outputs properly formatted JSON
- [ ] Command provides clear error messages when not in a session workspace
- [ ] All unit and integration tests pass
- [ ] Command help text is clear and follows the established pattern

## Related Tasks

- Task #070: Auto-Detect Current Session/Task in Minsky CLI (reference implementation)
- Task #084: Extend Auto-Detection to Additional Commands (pattern for extending auto-detection)
