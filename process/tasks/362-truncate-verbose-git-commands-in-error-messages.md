# Fix Session Approve Creating Merge Commits Instead of Fast-Forward

## Context

The session approve workflow was incorrectly trying to create new merge commits instead of fast-forwarding to prepared merge commits, causing failure with conventional commit message validation.

**Error Observed:**
```
❌ Invalid commit message:
Merge commits into main must use conventional commit format. Use squash merge or reword the commit message.

Commit message: "Merge branch 'pr/task335'"
```

**Root Cause:**
The `mergePreparedMergeCommitPR` function in `src/domain/git/prepared-merge-commit-workflow.ts` was using `git merge --no-ff` instead of `git merge --ff-only`.

## Problem

The prepared merge commit workflow is designed to:

1. **`session pr`** creates a PR branch with a prepared merge commit (using `--no-ff` to merge feature → PR branch)
2. **`session approve`** should fast-forward main to that prepared commit (using `--ff-only`)

But the approval step was incorrectly using `--no-ff`, trying to create a brand new merge commit instead of fast-forwarding to the existing prepared merge commit.

## Solution

Changed line 206 in `src/domain/git/prepared-merge-commit-workflow.ts`:

```typescript
// FROM (incorrect):
await gitExec("merge", `merge --no-ff ${prBranch}`, { workdir, timeout: 180000 });

// TO (correct):
await gitExec("merge", `merge --ff-only ${prBranch}`, { workdir, timeout: 180000 });
```

## Verification

- ✅ Prepared merge commit workflow tests pass
- ✅ Session approval operations tests pass
- ✅ Fix aligns with existing test expectations (many tests already expected `--ff-only`)
- ✅ Commit message validation will no longer block session approve

## Status

**COMPLETED** ✅ - Fix committed and ready for use.

The session approve workflow now correctly fast-forwards to prepared merge commits instead of creating invalid new merge commits.
