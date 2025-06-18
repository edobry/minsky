# Task #144: Fix Session PR and Git Prepare-PR Commands to Implement Proper Prepared Merge Commit Workflow
## Context

The current implementation of `session pr` and `git prepare-pr` commands is **not following the documented workflow specification**. The commands are supposed to create a "prepared merge commit" that's ready for fast-forward merge, but they're actually just creating regular PR branches without the proper merge commit structure.
**Current Broken Behavior:**
1. `session pr` creates a PR branch as a copy of the feature branch
2. No prepared merge commit is created
3. The PR branch just contains the feature branch commits, not a merge commit
4. `session approve` cannot do a proper fast-forward merge because there's no prepared merge commit
**Expected Correct Behavior (per Task #025 specification):**
1. `session pr` creates a PR branch from the base branch (main)
2. **Merges the feature branch INTO the PR branch** with `--no-ff` to create a prepared merge commit
3. The prepared merge commit has a proper PR title and body (like a GitHub PR)
4. `session approve` does a fast-forward merge of the prepared merge commit

## Requirements

1. TBD

## Implementation Steps

1. [ ] TBD

## Verification

- [ ] TBD
