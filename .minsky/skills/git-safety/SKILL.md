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

## Session-level MCP operations that force-push

Some Minsky MCP tools internally do `git push --force` and are NOT covered by the `git push --force` hooks because they don't go through the `Bash` or `session_exec` git CLI surfaces. Treat these as destructive operations subject to the same protocols as direct `git push --force`:

- **`mcp__minsky__session_update`** — merges main onto local session HEAD, then force-pushes. If the remote `task/<id>` branch has been advanced beyond the local session HEAD by another agent (e.g. another session, reviewer-bot iteration on the PR), the merge commit's parent is the **stale local** rather than the advanced remote, and the force-push silently orphans the remote commits. The tool returns `{success: true}` with no warning.
- **`mcp__minsky__session_pr_create`** — calls `session_update` internally before creating the PR. Same destructive failure mode applies.

mt#1304 tracks the tool-level fix. Until that lands, follow the pre-flight check below for every call.

### Pre-flight check (MANDATORY before session_update or session_pr_create)

When the session's task has an open PR:

1. `mcp__minsky__session_get(task)` → note `lastCommitHash`.
2. `mcp__minsky__session_pr_list(task)` (or `mcp__github__pull_request_read get` and inspect `head.sha`).
3. **If `lastCommitHash !== head.sha`**: the remote has advanced beyond the local session. **Do NOT call `session_update` or `session_pr_create`.** Surface the divergence to the user. Use non-mutating reads (`mcp__github__get_file_contents(ref="task/mt-N")`, `mcp__github__pull_request_read(method="get_diff")`) for analysis. Edit the session only when actually committing, and only after confirming local-vs-origin parity.

### Recovery if you orphaned commits

The orphaned SHAs remain accessible on GitHub by SHA for some retention window. Restore via the GitHub Refs API directly (server-side; doesn't need local repo state):

```bash
gh api -X PATCH /repos/<owner>/<repo>/git/refs/heads/<branch> \
  -f sha=<orphaned-head-sha> -F force=true
```

After restoring, **stop touching the branch in this session** — the local session is still at the corrupted state. Surface the incident to the user, who can either start a fresh session or run an explicit recovery. Do NOT call `session_update` again on the recovered branch in the corrupted session — you'll just re-trigger the same destructive force-push.

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
