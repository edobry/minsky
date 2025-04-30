# Task #012: Add `session update` Command

## Context

Currently, there's no streamlined way to update a session with the latest changes from the main branch. Users need to manually perform several git operations: stashing changes, pulling updates, merging main, pushing changes, and unstashing. An automated command would simplify this workflow and reduce potential errors.

## Requirements

1. **CLI Behavior**
   - Command signature:
     ```
     minsky session update [session-name]
     ```
   - If no session name is provided, use the current session (if in one)
   - The command should:
     - Enter the session directory if not already there
     - Stash any uncommitted changes
     - Pull latest changes from remote
     - Merge in latest changes from main branch
     - Push updated branch to remote
     - Apply stashed changes back

2. **Integration with Git Domain Module**
   - Leverage the existing git domain module for all git operations
   - Add necessary methods to GitService if not already available:
     - stashChanges
     - popStash
     - pullLatest
     - mergeBranch
     - pushBranch

3. **Error Handling**
   - Handle merge conflicts gracefully:
     - If conflicts occur, restore original state and notify user
     - Provide clear instructions on manual resolution steps
   - Handle network issues during pull/push
   - Handle cases where working directory is not clean
   - Provide clear error messages for all failure cases

4. **CLI Options**
   - Support the following options:
     - `--no-stash`: Skip stashing changes (useful if working directory is clean)
     - `--no-push`: Skip pushing changes to remote
     - `--branch <branch>`: Specify branch to merge from (defaults to main)
     - `--remote <remote>`: Specify remote to use (defaults to origin)

## Implementation Steps

1. [ ] Add new methods to GitService (if not existing):
   - [ ] stashChanges: Stash working directory changes
   - [ ] popStash: Apply stashed changes
   - [ ] pullLatest: Pull latest changes from remote
   - [ ] mergeBranch: Merge specified branch
   - [ ] pushBranch: Push current branch to remote

2. [ ] Create new file src/commands/session/update.ts:
   - [ ] Define command using Commander.js
   - [ ] Add command options
   - [ ] Implement command handler:
     - [ ] Get current session if no name provided
     - [ ] Enter session directory
     - [ ] Execute update workflow using GitService
     - [ ] Handle errors and provide clear messages

3. [ ] Register command in src/commands/session/index.ts

4. [ ] Add tests:
   - [ ] Unit tests for new GitService methods
   - [ ] Integration tests for update command
   - [ ] Test error scenarios:
     - [ ] Merge conflicts
     - [ ] Network issues
     - [ ] Dirty working directory
     - [ ] Invalid session name

5. [ ] Update documentation:
   - [ ] Add command to README
   - [ ] Document error messages and resolution steps
   - [ ] Add examples for common use cases

## Verification

- [ ] Command successfully updates a session with latest changes:
  - [ ] Stashes and restores changes correctly
  - [ ] Pulls latest changes from remote
  - [ ] Merges main branch successfully
  - [ ] Pushes updated branch to remote
- [ ] All options work as expected:
  - [ ] `--no-stash` skips stashing
  - [ ] `--no-push` skips pushing
  - [ ] `--branch` merges from specified branch
  - [ ] `--remote` uses specified remote
- [ ] Error handling works correctly:
  - [ ] Merge conflicts are handled gracefully
  - [ ] Network issues provide clear error messages
  - [ ] Working directory state is preserved on failure
- [ ] All tests pass
- [ ] Documentation is complete and accurate 
