# Task #025: Add PR Merging Commands for Session Workflow

## Context

Minsky already has a `git pr` command that prepares PR descriptions, but the workflow for merging these PRs into the main branch is not fully automated. The current process requires manual merging steps after the PR has been reviewed and approved.

To complete the PR workflow, we need to implement commands for merging PRs with a clearer separation of concerns:
1. A git-level command that handles just the core git operations
2. A session-level command that provides a higher-level workflow including task metadata updates

This will establish a "prepared-merge" workflow where the merge commit is created before review and then can be easily landed by a reviewer via fast-forward merge.

The workflow consists of two main steps:

1. Author creates a PR branch with a prepared merge commit (`minsky git prepare-pr`)
2. Reviewer approves and merges the prepared commit (`minsky session approve`)

This approach provides several benefits:

- Reviewers see and review the exact commit they will merge
- Fast-forward merges keep the history linear
- The main branch isn't polluted with direct pushes
- The workflow works with pure Git and doesn't require GitHub
- Clean separation of concerns between git operations and session/task management

## Requirements

### 1. Repository Backend Support

- **Multi-Backend Support**:

  - **Local/Remote Git**: Implement the "prepared-merge" workflow as described, with PR branches
  - **GitHub Backend**: When using GitHub repository backend, create an actual GitHub PR using the GitHub API (coordination with Task #010)
  - All operations must work through the existing repository backend abstraction layer

- **Backend Detection**:
  - Use the existing repository backend system to detect backend type
  - Apply the appropriate workflow based on the detected repository type
  - Maintain consistent user experience across different backends

### 2. Enhanced PR Workflow

- Rename and enhance `minsky git pr` to `minsky git prepare-pr` to:

  - Ensure clean work-tree (exit 2 if dirty)
  - Create a PR branch named `pr/<feature-branch>` off latest BASE (default: `main`)
  - Accept `--title` and `--body` parameters for PR metadata (like `minsky git commit`)
  - Perform a non-fast-forward merge (`--no-ff`) from the feature branch into the PR branch
  - Push the PR branch for review
  - For GitHub backend: Create an actual GitHub PR via API
  - For non-GitHub backends: Create a local PR branch with prepared merge commit
  - Exit 4 if merge conflicts occur (user should resolve and retry)

- Create new `minsky git merge-pr` for git-specific operations:
  - Fetch the PR branch
  - Switch to the base branch (default: `main`)
  - Perform a fast-forward merge (`--ff-only`) of the PR branch
  - Push the updated base branch
  - Delete the PR branch from the remote
  - For GitHub backend: Close the PR as merged via API
  - For non-GitHub backends: Clean up the PR branch
  - Exit 3 if base branch has moved (author must rerun `git prepare-pr`)
  - On any error, revert changes and provide clear error messages

- Create new `minsky session approve` for higher-level workflow:
  - Calls `git merge-pr` for the core git operations
  - Updates task status to DONE
  - Updates task metadata with merge information
  - Performs any other session cleanup/completion tasks
  - Handles any session-specific error cases

### 3. Session and Task Context Integration

- **Session Autodetection**:

  - Reuse the existing `SessionResolver` class from other commands
  - If run in a session directory, automatically use that session's repository
  - Honor explicit `--session` or `--repo` parameters when provided
  - Maintain consistent behavior with other Minsky commands

- **Task ID Detection**:
  - Reuse the existing task detection logic from other commands
  - If run in a task-associated session, automatically use that task ID
  - Honor explicit `--task` parameter when provided
  - Use the same pattern as other commands for consistency

### 4. CLI Behavior

- Command signatures:

  ```
  minsky git prepare-pr [--session <session>] [--repo <repo-path>] [--base <base-branch>] [--title <pr-title>] [--body <pr-body>]
  minsky git merge-pr <pr-branch> [--session <session>] [--repo <repo-path>] [--base <base-branch>]
  minsky session approve [--task <task-id>] [--session <session>] [--repo <repo-path>]
  ```

- Exit codes must match exactly:
  - 2: Dirty work-tree (uncommitted changes)
  - 3: Remote base branch is outdated
  - 4: Merge conflicts

### 5. Task Metadata Storage

- **Implementation Approach**:

  - Extend the MarkdownTaskBackend to store task metadata in YAML frontmatter
  - Add the following fields to task specification files:
    ```yaml
    ---
    merge_info:
      commit_hash: abc123...
      merge_date: 2023-06-15T14:32:00Z
      merged_by: username
    ---
    ```
  - This approach:
    - Preserves backward compatibility
    - Keeps metadata with the task specification
    - Avoids need for separate database
    - Is human-readable and editable

- **TaskService Extension**:
  - Add a new method to update task metadata:
    ```typescript
    async setTaskMetadata(id: string, metadata: Partial<Task['mergeInfo']>): Promise<void>
    ```
  - Add methods to retrieve and display metadata

### 6. Error Handling

- **Simplified Approach**:
  - For any merge conflicts or errors, abort and revert to the previous state
  - Provide clear, actionable error messages
  - Do not attempt to automatically resolve conflicts
  - Use specific exit codes to indicate different error types

### 7. Git Operations

For `git prepare-pr`:

```bash
# 1. Sync & clean
git fetch origin --prune
git diff-index --quiet HEAD -- || exit 2   # dirty work-tree guard

# 2. Create PR branch off latest BASE
TOPIC=$(git branch --show-current)
git switch -C pr/$TOPIC origin/main   # use --base to override

# 3. Use user-provided title/body or generate
if [ -n "$PR_TITLE" ]; then
  # Create commit message from provided title/body
  echo "$PR_TITLE" > .pr_title
  echo "" >> .pr_title
  echo "$PR_BODY" >> .pr_title
else
  # Generate from commits using existing logic
  minsky git pr message "$TOPIC" > .pr_title
fi

# 4. Merge feature -> PR branch
git merge --no-ff "$TOPIC" -F .pr_title || {
  git merge --abort
  rm -f .pr_title
  exit 4                              # conflicts → notify user
}

# 5. Push for review
git push -u origin pr/$TOPIC

# 6. For GitHub backend only
if [ "$REPO_BACKEND" = "github" ]; then
  # Create GitHub PR using GitHub API
  # This integrates with Task #010
fi
```

For `git merge-pr`:

```bash
# 1. Fetch PR branch
git fetch origin pr/$TOPIC
git switch main

# 2. Try fast-forward merge
git merge --ff-only origin/pr/$TOPIC || {
  echo "Cannot fast-forward merge. Base branch may have moved."
  exit 3
}

# 3. Record merge information
MERGE_COMMIT=$(git rev-parse HEAD)
MERGE_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MERGED_BY=$(git config user.name)

# 4. Push and clean up
git push origin main
git push origin --delete pr/$TOPIC

# 5. For GitHub backend only
if [ "$REPO_BACKEND" = "github" ]; then
  # Close the GitHub PR as merged
  # This integrates with Task #010
fi
```

For `session approve`:

```bash
# 1. Get task ID from session or from --task parameter
if [ -z "$TASK_ID" ]; then
  # Try to get task ID from session metadata
  TASK_ID=$(minsky session get --json | jq -r '.taskId')
fi

# 2. Call git merge-pr for git operations
PR_BRANCH=$(git branch --show-current | sed 's/^/pr\//')
minsky git merge-pr "$PR_BRANCH" --session "$SESSION" --repo "$REPO"

# 3. Update task metadata and status
if [ -n "$TASK_ID" ]; then
  # Update task metadata
  minsky tasks set-metadata "$TASK_ID" \
    --merge-commit "$MERGE_COMMIT" \
    --merge-date "$MERGE_DATE" \
    --merged-by "$MERGED_BY"
    
  # Update task status
  minsky tasks status set "$TASK_ID" DONE
fi
```

## Implementation Steps

1. [ ] Update GitService in `src/domain/git.ts`:

   - [ ] Rename and enhance the `pr` method to `preparePr` to support prepared-merge workflow
   - [ ] Add support for user-provided PR title/body
   - [ ] Add a `mergePr` method for merging PR branches
   - [ ] Ensure methods work with all repository backends through the abstraction layer
   - [ ] Add proper error handling with specific exit codes

2. [ ] Update PR command in `src/commands/git/pr.ts` to be `prepare-pr.ts`:

   - [ ] Rename and update to create and push a PR branch with prepared merge commit
   - [ ] Add `--base` option for base branch (default: `main`)
   - [ ] Add `--title` and `--body` options for PR metadata
   - [ ] Reuse existing session context detection code
   - [ ] Add proper validation and error handling

3. [ ] Create merge-pr command in `src/commands/git/merge-pr.ts`:

   - [ ] Implement command using Commander.js
   - [ ] Add options for session, repo, and base branch
   - [ ] Implement action handler with proper error handling
   - [ ] Handle repository backend-specific logic

4. [ ] Create session approve command in `src/commands/session/approve.ts`:

   - [ ] Implement command using Commander.js
   - [ ] Add options for session, repo, and task ID
   - [ ] Reuse existing task ID detection logic
   - [ ] Call git merge-pr for git operations
   - [ ] Update task metadata and status
   - [ ] Implement action handler with proper error handling

5. [ ] Register new commands in appropriate index.ts files

6. [ ] Update TaskService and MarkdownTaskBackend:

   - [ ] Extend the Task interface with merge information
   - [ ] Add methods to update and retrieve task metadata
   - [ ] Implement YAML frontmatter support in MarkdownTaskBackend
   - [ ] Ensure backward compatibility with existing task files

7. [ ] Add comprehensive tests:

   - [ ] Unit tests for GitService methods
   - [ ] Unit tests for TaskService metadata methods
   - [ ] Integration tests for commands
   - [ ] Tests for different repository backends
   - [ ] Error handling and edge case tests

8. [ ] Update documentation:
   - [ ] Update README.md with new workflow
   - [ ] Update minsky-workflow.mdc with PR workflow
   - [ ] Add usage examples for different scenarios

## Testing Strategy

### Unit Tests

1. **GitService Tests** (`src/domain/__tests__/git.test.ts`):

   - [ ] Test PR preparation with clean/dirty worktrees
   - [ ] Test PR preparation with different base branches
   - [ ] Test PR preparation with user-provided title/body
   - [ ] Test PR merging with valid/invalid PR branches
   - [ ] Test error handling for all exit code scenarios
   - [ ] Test repository backend integration

2. **TaskService Tests** (`src/domain/__tests__/tasks.test.ts`):
   - [ ] Test setting metadata on existing tasks
   - [ ] Test retrieving metadata after setting
   - [ ] Test updating existing metadata
   - [ ] Test YAML frontmatter parsing/generation

### Integration Tests

1. **Command Integration Tests**:

   - [ ] Test `git prepare-pr` command with actual repositories
   - [ ] Test `git merge-pr` command with prepared PR branches
   - [ ] Test `session approve` command with complete workflow
   - [ ] Test automatic session detection
   - [ ] Test automatic task detection
   - [ ] Test error scenarios with actual repositories

2. **Repository Backend Tests**:
   - [ ] Test with local Git repositories
   - [ ] Test with remote Git repositories
   - [ ] Test with mocked GitHub backend

### Mock Tests

1. **Repository Mocks**:

   - [ ] Create mock Git repositories with different states
   - [ ] Test repository operations with mocks
   - [ ] Test error handling with mock repositories

2. **TaskBackend Mocks**:
   - [ ] Test metadata operations with mock backends
   - [ ] Verify correct metadata persistence

### Edge Case Tests

1. **Error Scenarios**:

   - [ ] Test behavior with dirty worktree
   - [ ] Test behavior when base branch has moved
   - [ ] Test behavior with merge conflicts
   - [ ] Test behavior with invalid parameters

2. **Recovery Tests**:
   - [ ] Verify clean state after errors
   - [ ] Test operation resumption after resolving issues

## Test Cases

1. **Happy Path Tests**:

   - Create PR branch, approve it, verify merge
   - Create PR with custom title/body, verify it's used
   - Create PR in task session, verify task metadata updated

2. **Error Path Tests**:

   - Create PR with dirty worktree, verify error code 2
   - Try approving with moved base branch, verify error code 3
   - Create PR with merge conflicts, verify error code 4

3. **Integration Tests**:
   - Run full workflow from feature branch to merged PR
   - Verify PR branch cleanup after successful merge
   - Verify task metadata updated correctly

## Verification

- [ ] Can successfully create a PR branch with `minsky git prepare-pr`
- [ ] The PR branch contains a proper merge commit
- [ ] Can merge the PR branch with both `minsky git merge-pr` and `minsky session approve`
- [ ] Base branch is updated with a fast-forward merge
- [ ] PR branch is deleted after successful merge
- [ ] Task record is updated with merge commit information
- [ ] Task status is updated to DONE when using `session approve`
- [ ] Works with local/remote Git repositories
- [ ] Works with GitHub repositories (creates/closes real PRs)
- [ ] Session autodetection works correctly
- [ ] Task ID detection works correctly
- [ ] Error handling works correctly:
  - [ ] Detects dirty worktree (exit 2)
  - [ ] Detects moved base branch (exit 3)
  - [ ] Handles merge conflicts appropriately (exit 4)
- [ ] All tests pass
- [ ] Documentation is updated

## Notes

This implementation follows a cleaner separation of concerns:
- `git prepare-pr` and `git merge-pr` handle the core git operations
- `session approve` provides the higher-level workflow including task metadata and status updates

Key benefits of this approach:
- Clearer separation between git operations and task/session management
- Each command has a single responsibility
- Users can choose the level of automation they need
- More consistent with existing command organization
- More maintainable and easier to test
