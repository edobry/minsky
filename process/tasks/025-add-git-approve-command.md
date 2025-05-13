# Task #025: Add `git approve` Command for Session PR Merging

## Context

Minsky already has a `git pr` command that prepares PR descriptions, but the workflow for merging these PRs into the main branch is not fully automated. The current process requires manual merging steps after the PR has been reviewed and approved.

To complete the PR workflow, we need to implement a `git approve` command that works in concert with the existing `git pr` command. This will establish a "prepared-merge" workflow where the merge commit is created before review and then can be easily landed by a reviewer via fast-forward merge.

The workflow consists of two main steps:

1. Author creates a PR branch with a prepared merge commit (`minsky git pr`)
2. Reviewer approves and merges the prepared commit (`minsky git approve`)

This approach provides several benefits:

- Reviewers see and review the exact commit they will merge
- Fast-forward merges keep the history linear
- The main branch isn't polluted with direct pushes
- The workflow works with pure Git and doesn't require GitHub

## Requirements

1. **Enhanced PR Workflow**

   - Update `minsky git pr` to:

     - Ensure clean work-tree (exit 2 if dirty)
     - Create a PR branch named `pr/<feature-branch>` off latest BASE (default: `main`)
     - Generate a proper merge message (already implemented)
     - Perform a non-fast-forward merge (`--no-ff`) from the feature branch into the PR branch
     - Push the PR branch for review
     - Exit 4 if merge conflicts occur (user should resolve and retry)

   - Create new `minsky git approve` to:
     - Fetch the PR branch
     - Switch to the base branch (default: `main`)
     - Perform a fast-forward merge (`--ff-only`) of the PR branch
     - Push the updated base branch
     - Delete the PR branch from the remote
     - If a task ID is associated with the PR branch, update the task record with merge commit information
     - Exit 3 if base branch has moved (author must rerun `git pr`)

2. **CLI Behavior**

   - Command signatures:

     ```
     minsky git pr [--session <session>] [--path <repo-path>] [--base <base-branch>]
     minsky git approve <pr-branch> [--session <session>] [--path <repo-path>] [--task <task-id>]
     ```

   - Exit codes must match exactly:
     - 2: Dirty work-tree (uncommitted changes)
     - 3: Remote base branch is outdated
     - 4: Merge conflicts

3. **Git Operations**
   For `git pr`:

   ```bash
   # 1. Sync & clean
   git fetch origin --prune
   git diff-index --quiet HEAD -- || exit 2   # dirty work-tree guard

   # 2. Create PR branch off latest BASE
   TOPIC=$(git branch --show-current)
   git switch -C pr/$TOPIC origin/main   # use --base to override

   # 3. Generate merge message (already implemented)
   minsky git pr message "$TOPIC" >.msg

   # 4. Merge feature -> PR branch
   git merge --no-ff --no-edit -F .msg "$TOPIC" || {
     git merge --abort
     exit 4                                        # conflicts → resolve & retry
   }

   # 5. Push for review
   git push -u origin pr/$TOPIC
   ```

   For `git approve`:

   ```bash
   git fetch origin pr/$TOPIC
   git switch main
   git merge --ff-only origin/pr/$TOPIC   # land prepared merge

   # Get the merge commit hash
   MERGE_COMMIT=$(git rev-parse HEAD)

   git push origin main                   # publish
   git push origin --delete pr/$TOPIC     # tidy up

   # If task ID is provided, update task record with merge commit info
   if [ -n "$TASK_ID" ]; then
     minsky tasks set-metadata "$TASK_ID" --merge-commit "$MERGE_COMMIT" --merge-date "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
   fi
   ```

4. **Task Record Updates**

   - Extend the Task interface to include merge commit information:
     ```typescript
     interface Task {
       id: string;
       title: string;
       description: string;
       status: string;
       specPath?: string;
       mergeInfo?: {
         commitHash: string;
         mergeDate: string;
         mergedBy?: string;
       };
     }
     ```
   - Add a new method to the TaskService to update task metadata:
     ```typescript
     async setTaskMetadata(id: string, metadata: Partial<Task['mergeInfo']>): Promise<void>
     ```
   - Implement this method in the MarkdownTaskBackend to store the metadata in a structured way

5. **Integration with Existing Code**
   - Extend the GitService to support these operations
   - Make the commands aware of the current session context when applicable
   - Ensure proper error handling and user feedback
   - Add task metadata update functionality to the `approve` method

## Implementation Steps

1. [ ] Update GitService in `src/domain/git.ts`:

   - [ ] Enhance the `pr` method to create and push a PR branch with a prepared merge commit
   - [ ] Add an `approve` method to fetch, merge, push, and clean up
   - [ ] Add proper error handling with specific exit codes
   - [ ] Add functionality to capture merge commit information

2. [ ] Update PR command in `src/commands/git/pr.ts`:

   - [ ] Update the command to create and push a PR branch
   - [ ] Add `--base` option to specify the base branch (default: `main`)
   - [ ] Ensure proper validation and error handling

3. [ ] Create Approve command in `src/commands/git/approve.ts`:

   - [ ] Implement command using Commander.js
   - [ ] Add appropriate options and arguments, including `--task <task-id>`
   - [ ] Implement action handler to call GitService methods
   - [ ] Add proper error handling
   - [ ] Implement task metadata update after successful merge

4. [ ] Register new command in `src/commands/git/index.ts`

5. [ ] Update TaskService in `src/domain/tasks.ts`:

   - [ ] Extend the Task interface to include merge commit information
   - [ ] Add a `setTaskMetadata` method to update task metadata
   - [ ] Implement this method in the MarkdownTaskBackend

6. [ ] Add comprehensive tests:

   - [ ] Unit tests for the GitService methods
   - [ ] Unit tests for the TaskService metadata methods
   - [ ] Integration tests for the commands
   - [ ] Test edge cases (merge conflicts, non-fast-forward situations)

7. [ ] Update documentation:
   - [ ] Update README.md with the new workflow
   - [ ] Update minsky-workflow.mdc to include the new PR workflow
   - [ ] Add usage examples

## Verification

- [ ] Can successfully create a PR branch with `minsky git pr`
- [ ] The PR branch contains a proper merge commit
- [ ] Can approve and merge the PR branch with `minsky git approve`
- [ ] Base branch is updated with a fast-forward merge
- [ ] PR branch is deleted after successful merge
- [ ] Task record is updated with merge commit information when `--task` is provided
- [ ] Error handling works correctly:
  - [ ] Detects dirty work-tree (exit 2)
  - [ ] Handles merge conflicts appropriately (exit 4)
  - [ ] Detects when base branch has moved (exit 3)
- [ ] All tests pass
- [ ] Documentation is updated

## Notes

This implementation follows the "prepared-merge" workflow described in the specification, which offers several advantages over traditional merge workflows:

- **Exact review**: Reviewers diff the commit they will merge
- **Fast landing**: Fast-forward keeps history linear
- **No base pollution**: Authors never push directly to `main`
- **Pure Git**: Works over plain SSH remotes without requiring GitHub
- **Task traceability**: Merge commit information is stored in the task record for future reference

The workflow is particularly useful for projects with distributed teams or when integrating with automated review systems. Adding merge commit information to task records enhances traceability and provides a complete history of the task from creation to completion.
