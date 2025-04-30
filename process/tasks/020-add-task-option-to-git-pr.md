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

1. [ ] Update the command options in `src/commands/git/pr.ts`:
   - [ ] Add the `--task` option with appropriate description
   - [ ] Update the command usage documentation

2. [ ] Enhance the PR generation logic:
   - [ ] Modify the command to accept and validate the task option
   - [ ] Implement task-to-session resolution logic
   - [ ] Integrate with existing session path resolution

3. [ ] Add error handling for task-specific cases:
   - [ ] Task not found
   - [ ] No session for task
   - [ ] Multiple sessions for task (if relevant)

4. [ ] Update tests:
   - [ ] Add unit tests for task option validation
   - [ ] Add integration tests for PR generation with task option
   - [ ] Test error cases and option precedence

5. [ ] Update documentation:
   - [ ] Update command help text
   - [ ] Update README or other documentation

## Verification

- [ ] Running `minsky git pr --task <taskId>` successfully generates a PR description
- [ ] The command correctly finds the session associated with the task
- [ ] Appropriate error messages are shown for invalid task IDs or missing sessions
- [ ] Option precedence works correctly when multiple options are provided
- [ ] All tests pass
- [ ] Documentation is updated 
