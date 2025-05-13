# Task #020: Add `--task` option to `git pr` command

## Context

Currently, the `minsky git pr` command requires either the `--session` or `--path` option to specify the repository to generate a PR for. Users are getting errors like:

```
Error: Either --session or --path must be provided
```

This is inconvenient for users who are already working on a specific task and want to generate a PR. Since tasks are often associated with sessions, it would be beneficial to allow users to generate a PR by directly specifying a task ID.

## Requirements

1. **CLI Behavior**

   - Enhance the `git pr` command to accept a new `--task` option:
     ```
     minsky git pr --task <taskId>
     ```
   - The command should:
     - Look up the session associated with the specified task ID
     - Generate a PR description for that session's repository
     - Use the existing PR generation logic after resolving the session

2. **Integration with Existing Code**

   - Update the command options in the git pr module to accept the `--task` option
   - Implement logic to look up the session associated with a task ID
   - Reuse the existing session-based PR generation logic

3. **Error Handling**

   - Validate that the task ID exists
   - Check if a session exists for the specified task
   - Provide clear error messages when:
     - The task ID doesn't exist
     - No session is found for the task
     - Multiple sessions exist for the task (if possible)

4. **Option Precedence**
   - If multiple options are provided, establish a clear precedence:
     - `--path` takes highest precedence (direct path specification)
     - `--session` takes second precedence (specific session name)
     - `--task` takes lowest precedence (resolves to a session)

## Implementation Steps

1. [x] Update the command options in `src/commands/git/pr.ts`:

   - [x] Add the `--task` option with appropriate description
   - [x] Update the command usage documentation

2. [x] Enhance the PR generation logic:

   - [x] Modify the command to accept and validate the task option
   - [x] Implement task-to-session resolution logic
   - [x] Integrate with existing session path resolution

3. [x] Add error handling for task-specific cases:

   - [x] Task not found
   - [x] No session for task
   - [x] Multiple sessions for task (if relevant)

4. [x] Update tests:

   - [x] Add unit tests for task option validation
   - [x] Add integration tests for PR generation with task option
   - [x] Test error cases and option precedence

5. [x] Update documentation:
   - [x] Update command help text
   - [x] Update README or other documentation

## Verification

- [x] Running `minsky git pr --task <taskId>` successfully generates a PR description
- [x] The command correctly finds the session associated with the task
- [x] Appropriate error messages are shown for invalid task IDs or missing sessions
- [x] Option precedence works correctly when multiple options are provided
- [x] All tests pass
- [x] Documentation is updated

## Work Log

- 2023-05-04: Implemented `--task` option in the `git pr` command
  - Added the `--task` option to the `git pr` command in `src/commands/git/pr.ts`
  - Updated the `PrOptions` interface in `src/domain/git.ts` to include `taskId`
  - Modified the `prWithDependencies` method to look up sessions by task ID
  - Added error handling for cases where no session is found for a task
  - Implemented option precedence hierarchy (session > path > task)
  - Added comprehensive tests for the new functionality
  - Fixed test code to properly work with Bun's testing framework
