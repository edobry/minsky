# Task #037: Add `session commit` Command to Stage, Commit, and Push All Changes for a Session

## Context

Currently, users must manually stage, commit, and push changes for a session using separate commands. To streamline the workflow, a dedicated `minsky session commit` command should be introduced. This command will stage all changes, commit them with a user-supplied or prompted message, and push the branch to the remote repository by default. It should leverage the existing domain methods for `git commit` and `git push`.

## Requirements

1. **Command Behavior**
   - Command signature:
     ```
     minsky session commit [--session <session-name>] [--repo <repo-path>] [--message <msg>] [--no-push]
     ```
   - If `--session` is provided, operate on that session; otherwise, use the current session (inferred from directory).
   - Stage all changes in the session's working directory.
   - Commit with the provided message, or prompt the user if not supplied.
   - By default, push the branch to the remote after committing.
   - If `--no-push` is supplied, skip the push step.

2. **Integration with Domain Methods**
   - Internally use the domain methods for `git commit` and `git push`.
   - Do not duplicate git logic; delegate to the appropriate domain modules.

3. **User Feedback and Error Handling**
   - Output clear progress and success messages for each step (stage, commit, push).
   - If any step fails, display an error and exit with a non-zero code.
   - If the push fails, show a clear error message.

4. **Tests**
   - Add or update tests to verify:
     - Staging, committing, and pushing all work as expected
     - Supplying `--no-push` skips the push
     - Proper error handling and output for failures

5. **Documentation**
   - Update help text and documentation to describe the new command, its options, and workflow.

## Implementation Steps

- [ ] Implement the `minsky session commit` command with all required options and behaviors
- [ ] Integrate with domain methods for git commit and push
- [ ] Add or update tests
- [ ] Update documentation and help text
- [ ] Update the changelog

## Verification

- [ ] Running the session commit command stages, commits, and pushes all changes for a session
- [ ] Supplying `--no-push` skips the push
- [ ] Output clearly indicates each step and any errors
- [ ] Tests cover all behaviors and error cases
- [ ] Documentation is updated 
