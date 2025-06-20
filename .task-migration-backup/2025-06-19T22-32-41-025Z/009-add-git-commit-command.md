# Task #009: Add `git commit` Command to Stage and Commit Changes

## Context

Currently, Minsky users need to manually stage and commit changes using standard git commands. This requires multiple steps: first using `git add` to stage files and then using `git commit` to commit them. To simplify the workflow, especially for junior engineers and AI agents, a dedicated `minsky git commit` command would streamline the process by automatically staging all changes and then committing them in a single step.

## Requirements

1. **CLI Behavior**

   - Command signature:
     ```
     minsky git commit [--session <session-name>] [--repo <repo-path>] [--message <commit-message>] [--all] [--amend]
     ```
   - If `--session` is provided:
     - Use the session's repository path
   - If `--repo` is provided:
     - Use the repository at the specified path
   - If neither is provided:
     - Attempt to determine session from current directory
     - If not in a session directory, use the current git repository

2. **Staging Behavior**

   - By default, stage all modified and untracked files (equivalent to `git add .`)
   - If `--all` flag is provided, stage all modified, untracked, and deleted files (equivalent to `git add -A`)
   - Provide clear output about which files were staged

3. **Commit Message**

   - Require a commit message via the `--message` or `-m` option
   - If the task ID is known (via session), automatically include the task ID in the commit message
   - If no task ID is available, use the provided message as is

4. **Amend Option**

   - Support an `--amend` flag to amend the previous commit
   - When used with `--message`, update the commit message
   - When used without `--message`, retain the previous commit message

5. **Output and Error Handling**

   - Display clear progress messages during the staging and commit process
   - Show helpful error messages for common issues (e.g., no changes to commit)
   - On success, display the commit hash and message

6. **Integration with Workflow**
   - Update the minsky-workflow.mdc to recommend using this command instead of direct git commands
   - Ensure it works seamlessly with the rest of the Minsky task workflow

## Implementation Steps

1. [ ] Create a new command file `src/commands/git/commit.ts`:

   - [ ] Implement the command with the required options
   - [ ] Handle session and repository resolution
   - [ ] Add support for the commit message option
   - [ ] Implement the amend and all flags

2. [ ] Update the GitService in `src/domain/git.ts`:

   - [ ] Add a `stageAll` method to stage all changes
   - [ ] Add a `commit` method to commit staged changes
   - [ ] Include logic for amending commits

3. [ ] Add appropriate error handling and user feedback:

   - [ ] Check if there are changes to stage
   - [ ] Validate the commit message
   - [ ] Handle common git errors

4. [ ] Write tests to cover various scenarios:

   - [ ] Committing from a session
   - [ ] Committing from a standalone repository
   - [ ] Amending a commit
   - [ ] Handling various error conditions

5. [ ] Update documentation and workflow guidance:
   - [ ] Update README.md with the new command
   - [ ] Update minsky-workflow.mdc to reference the new command
   - [ ] Add appropriate CLI help text

## Verification

- [ ] Can stage and commit changes using `minsky git commit --message "commit message"`
- [ ] Can commit changes from a session using `minsky git commit --session <session-name> --message "commit message"`
- [ ] Can commit from the current directory when in a session folder
- [ ] Can commit from a specified repository path using `--repo`
- [ ] The `--all` flag correctly stages deleted files in addition to modified and untracked files
- [ ] The `--amend` flag correctly amends the previous commit
- [ ] Task ID is automatically included in commit messages when committing from a session
- [ ] Appropriate error messages are shown when there are no changes to commit
- [ ] All relevant tests pass
- [ ] Documentation and CLI help are updated
- [ ] minsky-workflow.mdc is updated to reference the new command

## Notes

- This command simplifies the git workflow by combining staging and committing into a single step
- It's particularly helpful for junior engineers and AI agents who may not be familiar with git commands
- It ensures consistency in how commits are formatted, especially for task-related work
- Future enhancements could include support for interactive staging or excluding specific files
