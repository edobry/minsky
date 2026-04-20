---
name: git-safety
description: >-
  Safety protocols for destructive git operations: pre-command verification,
  force-push gates, error recovery, and surgical operation protocol.
  Use when performing force push, git reset, destructive git operations,
  rebasing, or any operation that modifies commit history.
user-invocable: true
---

# Git Safety

Safety protocols for destructive git operations. Applies to any command that modifies history, overwrites remote state, or alters the working directory irreversibly.

## Arguments

Optional: description of the operation being considered (e.g., `/git-safety force push to fix broken commit`).

## Pre-command verification (MANDATORY)

Before executing ANY destructive git command (`reset`, `rebase`, `push --force`, `checkout -- .`, `clean -fd`, `branch -D`):

### 1. Document current state

- `git status` — working tree status
- `git log --oneline -n 5` — recent commit history
- `git branch --show-current` — current branch

### 2. Predict expected outcome

Explicitly state what will change:

- Working directory files
- Staging area
- Local commit history
- Remote repository state (if applicable)

### 3. Consider safer alternatives

| Destructive command | Safer alternative                                 |
| ------------------- | ------------------------------------------------- |
| `git reset --hard`  | `git stash` or create a temporary branch          |
| `git rebase`        | Work on a new temporary branch first              |
| `git push --force`  | `git revert` (creates new commit undoing changes) |
| `git checkout -- .` | `git stash` (preserves changes)                   |
| `git branch -D`     | `git branch -d` (refuses if unmerged)             |

### 4. Execute with verification

- Use `--dry-run` when available
- Break complex operations into smaller, verifiable steps
- For critical operations, create backup: `git branch temp-backup`

### 5. Post-command verification

- `git status` — verify new state
- Compare actual vs predicted outcome
- If unexpected results: **STOP** — do not run additional commands
- Use `git reflog` for recovery options

## Force push prohibition

`git push --force` is **strictly prohibited** except when ALL conditions are met:

1. **Personal branch only** — no other collaborator has pulled or based work on it
2. **Explicit user approval** — written, case-by-case approval for the specific branch and reason
3. **Recent personal error** — correcting a very recent commit error on a branch you exclusively control

### Mandatory verification before ANY force push

1. `git status` — clean working directory
2. `git log --graph --oneline --all --decorate` — inspect full history
3. `git fetch origin && git log --graph --oneline origin/<branch> HEAD` — compare with remote
4. Document exactly which commits will be removed/replaced
5. Obtain user confirmation after presenting the impact

### Preferred alternatives

- `git revert <commit>` — safely undo pushed changes by creating a new commit
- Rebase on a **new branch** name, push that, open a new PR
- `git commit --amend` — only if the commit hasn't been pushed yet

## Error recovery protocol

If a git error occurs:

1. **STOP immediately** — no additional git commands
2. **Document state**: `git status`, `git log --oneline`, `git reflog`
3. **Consult reflog** to identify lost commits
4. **Create recovery branch**: `git branch recovery-branch <commit-hash>`
5. **Verify recovery** contains expected content
6. **Plan recovery** before executing more commands
7. **Document** the error and recovery for team knowledge

## Surgical operation protocol

When the user requests "surgical", "targeted", or "precise" operations:

1. **Identify minimal scope** — exact commits/files that need modification
2. **Choose least invasive tool**:
   - `git rebase -i <range>` for specific commit edits
   - Manual file edits for content changes
   - `git filter-repo --refs <range>` for targeted history (NEVER global)
3. **Verify scope before execution** — "This will affect N commits in range X-Y"
4. **Confirm approach** matches the user's precision requirement

**Anti-pattern:** Using comprehensive tools (`git filter-repo` on entire history) when surgical precision was requested.

## Command-specific safety

### `git reset`

- Never `--hard` on pushed/shared branches
- Always create backup branch first
- Prefer `git revert` for pushed commits

### `git rebase`

- Never rebase branches others may have pulled
- Create backup before rebasing
- Verify history after: `git log --graph --oneline`

### `git checkout`

- Stash uncommitted changes before switching branches
- For `checkout -- .`: run `git diff` first to see what will be lost

### Branch deletion

- Verify you're not on the branch being deleted
- Check merge status: `git branch --merged`
- For remote branches: confirm no team member needs it

## Key principles

- **Measure twice, cut once.** Every destructive operation gets a pre-check and a post-check.
- **Prefer reversible operations.** `git revert` over `git reset --hard`. `git stash` over `git checkout -- .`.
- **Force push is a last resort.** Three conditions must ALL be met, plus user approval.
- **Stop on unexpected results.** If the outcome doesn't match your prediction, investigate before continuing.
- **Recovery is always possible.** `git reflog` remembers everything for 90 days.
