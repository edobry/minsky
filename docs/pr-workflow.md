# Enhanced PR Workflow

This document describes the workflow for creating and merging pull requests using Minsky's enhanced PR workflow commands.

## Overview

The enhanced PR workflow offers a streamlined approach to creating and merging pull requests. The workflow includes the following steps:

1. Create a PR summary to review changes (`git summary`)
2. Prepare a PR with a pre-created merge commit (`session pr` or `git prepare-pr`)
3. Approve and merge the prepared PR (`session approve` or `git merge-pr`)

This workflow is designed to minimize merge conflicts and ensure that merges occur via fast-forward only, resulting in a cleaner, more linear commit history.

## Performance Optimizations

### PR State Caching (Task #275)

The PR workflow includes intelligent caching to optimize performance:

- **PR Branch Existence**: Session records cache PR branch existence status to avoid redundant git operations
- **Cache Validity**: 5-minute staleness threshold balances performance with data freshness
- **Graceful Fallback**: Automatically falls back to git operations when cache is missing or stale
- **Performance Impact**: Eliminates 2-3 git operations per approval (60-70% reduction in race conditions)

**Implementation Details:**
- PR state is stored in the `prState` field of session records
- Cache includes branch name, existence status, and timestamp metadata
- Automatically updated on PR creation and merge operations
- Backward compatible with existing sessions

## Commands

### `git summary`

Generates a formatted PR description based on the changes in your branch.

```bash
minsky git summary [options]
```

**Options:**

- `--repo <path>`: Path to the repository (defaults to current directory)
- `--branch <branch>`: Base branch to compare against (defaults to main/master)
- `--debug`: Enable debug output
- `--session <session>`: Session to create PR for
- `--json`: Output as JSON

**Example:**

```bash
minsky git summary --session my-feature
```

This will generate a formatted PR description with:

- Summary of changes
- List of commits
- List of changed files
- Task ID (if associated with a session)

The command will also automatically update the task status to "IN_REVIEW" if a task is associated with the session.

### `session pr`

Creates a PR branch for a session with a pre-created merge commit that is ready for fast-forward merge.

```bash
minsky session pr [session-name] [options]
```

**Options:**

- `--task <taskId>`: Task ID to match (if not providing session name)
- `--title <title>`: PR title (if not provided, will be generated)
- `--body <body>`: PR body (if not provided, will be generated)
- `--base-branch <branch>`: Base branch for PR (defaults to main)
- `--debug`: Enable debug output
- `--no-status-update`: Skip updating task status

**Example:**

```bash
minsky session pr my-feature --title "Add new feature X"
```

This command:

1. Creates a new branch from the base branch (typically main)
2. Uses the current git branch for naming the PR branch (format: `pr/<branch-name>`)
3. Pushes the PR branch to the remote repository
4. Updates the task status to IN-REVIEW (if associated with a task)

### `git prepare-pr`

Creates a PR branch with a pre-created merge commit that is ready for fast-forward merge.

```bash
minsky git prepare-pr [options]
```

**Options:**

- `--repo <path>`: Path to the repository
- `--base-branch <branch>`: Base branch for PR (defaults to main)
- `--title <title>`: PR title (if not provided, will be generated)
- `--body <body>`: PR body (if not provided, will be generated)
- `--debug`: Enable debug output
- `--session <session>`: Session to create PR for

**Example:**

```bash
minsky git prepare-pr --session my-feature --title "Add new feature X"
```

This command:

1. Creates a new branch from the base branch (typically main)
2. Uses the current git branch for naming the PR branch (format: `pr/<branch-name>`)
3. Pushes the PR branch to the remote repository

The naming convention for PR branches is `pr/<branch-name>`.

### `git merge-pr`

Merges a previously prepared PR branch using fast-forward merge.

```bash
minsky git merge-pr [options]
```

**Options:**

- `--repo <path>`: Path to the repository
- `--pr-branch <branch>`: PR branch to merge (required)
- `--base-branch <branch>`: Base branch to merge into (defaults to main)
- `--session <session>`: Session the PR branch is for

**Example:**

```bash
minsky git merge-pr --pr-branch pr/my-feature
```

This command:

1. Switches to the base branch (main)
2. Merges the PR branch with `--ff-only`
3. Pushes the updated base branch to the remote
4. Deletes the PR branch locally and remotely

### `session approve`

A high-level command that combines PR merging with task status updates.

```bash
minsky session approve [options]
```

**Options:**

- `--session <session>`: Name of the session to approve
- `--task <taskId>`: Task ID associated with the session
- `--repo <path>`: Repository path

**Example:**

```bash
minsky session approve --session my-feature
```

This command:

1. Identifies the PR branch for the session
2. Merges it using fast-forward only
3. Updates the task status to "DONE"
4. Records merge metadata (commit hash, date, author) in the task spec

## Error Codes

The PR workflow commands use specific exit codes to indicate common failure conditions:

- `2`: Dirty work-tree (uncommitted changes)
- `3`: Remote base branch is outdated
- `4`: Merge conflicts

## Use Cases

### Standard Workflow

1. Create a session and make your changes:

   ```bash
   minsky session start my-feature --task "#123"
   # make your changes
   git add .
   git commit -m "Implement feature X"
   git push
   ```

2. Prepare a PR branch:

   ```bash
   minsky session pr
   ```

3. Review the PR and when ready to merge:
   ```bash
   minsky session approve
   ```

### Manual Workflow

If you prefer more control:

1. Generate a PR summary:

   ```bash
   minsky git summary --session my-feature
   ```

2. Manually create a PR branch:

   ```bash
   minsky git prepare-pr --session my-feature --title "Custom PR title"
   ```

3. Manually merge when ready:

   ```bash
   minsky git merge-pr --pr-branch pr/my-feature
   ```

4. Update task status:
   ```bash
   minsky tasks status set "#123" "DONE"
   ```

## Benefits

- **Clean History**: Ensures a linear commit history with meaningful merge commits
- **Reduced Conflicts**: Conflicts are resolved during PR branch preparation, not during merging
- **Consistent Process**: Standardizes the PR workflow across all projects
- **Task Integration**: Automatically updates task status and records merge metadata
