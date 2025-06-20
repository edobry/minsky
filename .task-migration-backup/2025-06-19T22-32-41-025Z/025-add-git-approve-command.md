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

- Rename the current `minsky git pr` command to `minsky git summary` to maintain original PR description functionality:

  - Generate a markdown document containing git history
  - Accept the same options as the current `git pr` command
  - This preserves the existing behavior of just creating PR descriptions

- Create new `minsky git prepare-pr` command that:

  - Ensures clean work-tree (exit 2 if dirty)
  - Creates a PR branch named `pr/<feature-branch>` off latest BASE (default: `main`)
  - Accepts `--title` and `--body` parameters for PR metadata (like `minsky git commit`)
  - Performs a non-fast-forward merge (`--no-ff`) from the feature branch into the PR branch
  - Pushes the PR branch for review
  - For GitHub backend: Creates an actual GitHub PR via API
  - For non-GitHub backends: Creates a local PR branch with prepared merge commit
  - Exits 4 if merge conflicts occur (user should resolve and retry)

- Create new `minsky git merge-pr` for git-specific operations:

  - Fetches the PR branch
  - Switches to the base branch (default: `main`)
  - Performs a fast-forward merge (`--ff-only`) of the PR branch
  - Pushes the updated base branch
  - Deletes the PR branch from the remote
  - Returns commit metadata (hash, date, author) for use by higher-level commands
  - For GitHub backend: Closes the PR as merged via API
  - For non-GitHub backends: Cleans up the PR branch
  - Exits 3 if base branch has moved (author must rerun `git prepare-pr`)
  - On any error, reverts changes and provides clear error messages

- Create new `minsky session approve` for higher-level workflow:
  - Calls `git merge-pr` for the core git operations
  - Captures returned metadata from the merge operation
  - Updates task status to DONE upon successful merge
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
  minsky git summary [--session <session>] [--repo <repo-path>] [--branch <branch>]
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
  - Errors are handled in TypeScript through direct method calls
  - Use proper TypeScript error propagation between domain methods
  - For any merge conflicts or errors, abort and revert to the previous state
  - Provide clear, actionable error messages
  - Do not attempt to automatically resolve conflicts
  - Use specific exit codes to indicate different error types
  - Higher-level commands will properly handle errors from lower-level commands

### 7. Git Operations

For `git summary` (renamed from `git pr`):

```bash
# This maintains the original PR description functionality
# Reuse existing code from current `git pr` command
```

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
  minsky git summary "$TOPIC" > .pr_title
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

# 6. Return metadata
echo "{\"commit_hash\":\"$MERGE_COMMIT\",\"merge_date\":\"$MERGE_DATE\",\"merged_by\":\"$MERGED_BY\"}"
```

For `session approve`:

```bash
# 1. Get task ID from session or from --task parameter
if [ -z "$TASK_ID" ]; then
  # Try to get task ID from session metadata
  TASK_ID=$(minsky session get --json | jq -r '.taskId')
fi

# 2. Call git merge-pr for git operations and capture metadata
PR_BRANCH=$(git branch --show-current | sed 's/^/pr\//')
MERGE_RESULT=$(minsky git merge-pr "$PR_BRANCH" --session "$SESSION" --repo "$REPO")
MERGE_INFO=$(echo $MERGE_RESULT | jq -r '.')

# 3. Update task metadata and status
if [ -n "$TASK_ID" ]; then
  # Update task metadata
  minsky tasks set-metadata "$TASK_ID" "$MERGE_INFO"

  # Update task status to DONE after successful merge
  minsky tasks status set "$TASK_ID" DONE
fi
```

## Implementation Steps

1. [x] Update GitService in `src/domain/git.ts`:

   - [x] Rename the current `pr` method to `summary` to maintain the original PR description functionality
   - [x] Create a new `preparePr` method to support prepared-merge workflow
   - [x] Add support for user-provided PR title/body
   - [x] Add a `mergePr` method for merging PR branches
   - [x] Ensure methods work with all repository backends through the abstraction layer
   - [x] Add proper error handling with specific exit codes
   - [x] Implement metadata return for merge operations

2. [x] Implement the new commands:

   - [x] Create `src/commands/git/summary.ts` based on the current `pr.ts` implementation
   - [x] Create `src/commands/git/prepare-pr.ts` for the new PR preparation workflow
   - [x] Create `src/commands/git/merge-pr.ts` for the git-specific merge operations
   - [x] Create `src/commands/session/approve.ts` for the higher-level merge workflow
   - [x] Ensure all commands use consistent parameter handling
   - [x] Implement proper session and task detection
   - [x] Add proper validation and error handling

3. [x] Update TaskService and MarkdownTaskBackend:

   - [x] Extend the Task interface with merge information fields
   - [x] Implement YAML frontmatter parsing and updating in MarkdownTaskBackend
   - [x] Add the `setTaskMetadata` method to TaskService and task backends
   - [x] Ensure backward compatibility with existing task files
   - [x] Add tests for the new metadata functionality

4. [x] Add comprehensive tests:

   - [x] Unit tests for all new GitService methods
   - [x] Unit tests for TaskService metadata methods
   - [x] Command tests for all new CLI commands
   - [x] Edge case tests for error handling scenarios
   - [x] Integration tests for the full workflow

5. [x] Update documentation:
   - [x] Update README.md with the new workflow
   - [x] Update minsky-workflow.mdc with PR workflow
   - [x] Add clear examples for different use cases

## Test Plan

1. **GitService Tests** (`src/domain/__tests__/git.test.ts`):

   - [x] Test summary generation (former PR) functionality
   - [x] Test PR preparation with clean/dirty worktrees
   - [x] Test PR preparation with different base branches
   - [x] Test PR preparation with user-provided title/body
   - [x] Test PR merging with valid/invalid PR branches
   - [x] Test error handling for all exit code scenarios
   - [x] Test repository backend integration

2. **TaskService Tests** (`src/domain/__tests__/tasks.test.ts`):

   - [x] Test storage and retrieval of merge metadata
   - [x] Test frontmatter parsing and updating
   - [x] Test error handling for invalid task IDs
   - [x] Test backward compatibility with existing tasks

3. **Command Integration Tests**:

   - [x] Test `git summary` command correctly generates PR descriptions
   - [x] Test `git prepare-pr` command with actual repositories
   - [x] Test `git merge-pr` command with prepared PR branches
   - [x] Test `session approve` command with complete workflow
   - [x] Test automatic session detection
   - [x] Test automatic task detection
   - [x] Test error handling and exit codes for each command

## Verification

- [x] Can successfully generate a PR description with `minsky git summary`
- [x] Can successfully create a PR branch with `minsky git prepare-pr`
- [x] The PR branch contains a proper merge commit
- [x] Can merge the PR branch with both `minsky git merge-pr` and `minsky session approve`
- [x] Base branch is updated with a fast-forward merge
- [x] PR branch is deleted after successful merge
- [x] Task record is updated with merge commit information
- [x] Task status is updated to DONE when using `session approve`
- [x] Works with local/remote Git repositories
- [ ] Works with GitHub repositories (creates/closes real PRs)
- [x] Proper error messages and exit codes for all error scenarios

## Worklog

### 2025-05-16

- Implemented initial code structure based on task specification
- Renamed the current `git pr` to `git summary` to maintain the original PR description functionality
- Created a new `preparePr` method for the "prepared-merge" workflow
- Added support for the new PR workflow approach with merge commit preparation
- Created new `git merge-pr` functionality for merging PR branches
- Implemented comprehensive error handling with specific exit codes (2, 3, 4)
- Added task metadata storage using YAML frontmatter in specification files
- Added the `setTaskMetadata` method to the TaskService
- Extended the Task interface with merge information fields
- Created the high-level `session approve` command for the complete workflow including task updates
- Implemented session and task detection for integrated workflow
- Created detailed tests for the PR preparation, merging, and approval flows
- Added documentation for the new commands
- Created comprehensive test suite for all the new functionality
- Removed backward compatibility for old commands as requested
- Pushed changes to the repository

## Remaining Work

1. **GitHub API Integration**:

   - The GitHub backend integration (creating actual GitHub PRs) is incomplete
   - The current implementation only supports local/remote Git repositories
   - GitHub integration should be handled as part of Task #010 (GitHub API integration)

2. **Interactive PR Creation**:

   - Add support for interactive PR title/body editing similar to git commit
   - This would enhance the user experience but was not part of the core requirements

3. **Advanced Merge Conflict Resolution**:

   - Currently, merge conflicts require manual intervention and restarting the process
   - A helper command for conflict resolution could be added in a future update

4. **Command Testing Improvements**:

   - Some of the tests have linter warnings that should be addressed
   - Integration tests could be expanded for more edge cases

5. **Additional Documentation**:
   - Add more examples to the documentation showing different use cases
   - Create tutorial-style documentation for the complete PR workflow

## Notes

This implementation follows a cleaner separation of concerns:

- `git summary` maintains the original PR description functionality
- `git prepare-pr` and `git merge-pr` handle the core git operations
- `session approve` provides the higher-level workflow including task metadata and status updates

Key benefits of this approach:

- Clearer separation between git operations and task/session management
- Each command has a single responsibility
- Users can choose the level of automation they need
- More consistent with existing command organization
- More maintainable and easier to test
- Better integration with the existing repository backend system
