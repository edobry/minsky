# Add `git push` Command to Simplify Pushing Branches

## Context

Currently, Minsky users need to manually push their branches to remote repositories using standard git commands. This requires remembering branch names and knowing the appropriate remote to push to. To simplify the workflow, especially for junior engineers and AI agents, a dedicated `minsky git push` command would streamline the process by handling all the session-specific details automatically.

## Requirements

1. **CLI Behavior**

   - Command signature:
     ```
     minsky git push [--session <session-name>] [--repo <repo-path>] [--remote <remote-name>] [--force]
     ```
   - If `--session` is provided:
     - Use the session's branch name (same as session name)
     - Push to the default remote (origin) or the specified remote
   - If `--repo` is provided:
     - Use the repository at the specified path
     - Infer the current branch from the repository
   - If neither is provided:
     - Attempt to determine session from current directory
     - If not in a session directory, use the current git repository and branch

2. **Remote Handling**

   - Default to `origin` if `--remote` is not specified
   - Allow specifying a different remote with `--remote <remote-name>`
   - Verify remote exists before attempting to push
   - Provide a clear error if the remote doesn't exist

3. **Force Push Option**

   - Support a `--force` flag for force-pushing when needed
   - Include a warning about the risks of force-pushing when this option is used

4. **Output and Error Handling**

   - Display clear progress messages during the push
   - Show helpful error messages for common issues (e.g., no upstream, network issues)
   - On success, display information about the pushed branch and remote

5. **Integration with Workflow**
   - Update the minsky-workflow.mdc to recommend using this command instead of direct git commands
   - Ensure it works seamlessly with the rest of the Minsky task workflow

## Implementation Steps

1. Create a new command file `src/commands/git/push.ts`:

   - Implement the command with the required options
   - Handle session and repository resolution

2. Update the GitService in `src/domain/git.ts`:

   - Add a `push` method to handle pushing branches to remotes
   - Include logic for handling force push and remote validation

3. Add appropriate error handling and user feedback.

4. Write tests to cover various scenarios:

   - Pushing from a session
   - Pushing from a standalone repository
   - Handling various error conditions

5. Update documentation and workflow guidance:
   - Update README.md with the new command
   - Update minsky-workflow.mdc to reference the new command
   - Add appropriate CLI help text

## Verification

- [ ] Can push a branch from a session using `minsky git push --session <session-name>`
- [ ] Can push from the current directory when in a session folder
- [ ] Can push from a specified repository path using `--repo`
- [ ] Defaults to `origin` when no remote is specified
- [ ] Can specify an alternate remote with `--remote`
- [ ] Force push option works correctly
- [ ] Appropriate error messages are shown for common problems
- [ ] All relevant tests pass
- [ ] Documentation and CLI help are updated
- [ ] minsky-workflow.mdc is updated to reference the new command

## Notes

- This command simplifies the most common git operation in the Minsky workflow
- It's particularly helpful for junior engineers and AI agents who may not be familiar with git commands
- It ensures consistency in how branches are pushed, reducing the chance of errors
- Future enhancements could include support for pushing specific commits or pushing to multiple remotes
