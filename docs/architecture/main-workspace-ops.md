# Main-Workspace Git Operations

## Background

Minsky's hook system blocks raw `git` CLI in the main workspace to prevent
agent-driven mutations that bypass session provenance (mt#1103). Session-scoped
operations have first-class MCP equivalents (`session_update`, `session_commit`,
`session_pr_create`, etc.). Before mt#1549, the _main workspace itself_ had no
first-class equivalents for legitimate maintenance operations (stash, pull,
restore, reset, status).

The gap was surfaced during mt#1509 / mt#1503 (2026-05-01): a lock-file drift
(`skills-lock.json`) blocked a `git pull --ff-only` that was required to pick up
a diagnostic fix merged on GitHub, and every obvious escape route was hook-denied
with no MCP alternative.

---

## Tool Table

Each tool below maps to the deadlock-class it was added to unblock.

| MCP Tool                      | Underlying git command                     | Deadlock class unblocked                                | Requires confirmation?                                |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------- |
| `mcp__minsky__git_pull`       | `git pull --ff-only <remote> <branch>`     | Pull blocked by local changes; non-FF rejection         | No (safe default; structural error on conflict)       |
| `mcp__minsky__git_status`     | `git status --porcelain=v2 --branch`       | Blind to working-tree state when diagnosing blocks      | No (read-only)                                        |
| `mcp__minsky__git_stash`      | `git stash push [-m msg] [-- paths]`       | Local changes blocking pull or rebase                   | No                                                    |
| `mcp__minsky__git_stash_pop`  | `git stash pop [ref]`                      | Restoring stashed changes after pull succeeds           | No                                                    |
| `mcp__minsky__git_stash_list` | `git stash list --format=...`              | Auditing stash stack before pop/drop                    | No (read-only)                                        |
| `mcp__minsky__git_stash_drop` | `git stash drop <ref>`                     | Discarding a stash entry permanently                    | Yes: `confirmDrop: true` required                     |
| `mcp__minsky__git_restore`    | `git restore -- <paths>`                   | Discarding a single file's unstaged changes             | No (paths-scoped; less destructive than reset --hard) |
| `mcp__minsky__git_reset`      | `git reset --{soft\|mixed\|hard} <target>` | Unstaging changes, moving HEAD, discarding working-tree | `confirmHard: true` required for `mode: "hard"`       |

---

## When to Use Main-Workspace Ops vs. Session-Workspace Ops

### Use **main-workspace** ops (`git_*`) when:

- You are maintaining the _main checkout_ (e.g., pulling after a PR merged on
  GitHub, discarding lock-file drift, inspecting HEAD state).
- The operation does not involve a task's session directory.
- You need to unblock a `git pull --ff-only` that is failing because of
  uncommitted local changes in the main workspace.

### Use **session-workspace** ops (`session_*`) when:

- You are implementing or reviewing work for a specific task.
- The operation touches files inside a session worktree
  (`~/.local/state/minsky/sessions/<id>/`).
- `session_update` is the correct way to rebase a session on the latest main.
- `session_commit`, `session_pr_create`, etc. handle provenance tracking
  automatically.

### Decision flow

```
Is the target directory a Minsky session worktree?
  Yes → use session_* tools
  No  → is this a read operation?
          Yes → git_status, git_stash_list, git_diff, git_log, git_blame
          No  → is it a targeted file discard?
                  Yes → git_restore (paths required)
                  No  → git_stash / git_stash_pop / git_pull / git_reset
```

---

## Confirmation-Required Operations

Two operations require explicit confirmation flags because they are destructive
and irreversible:

### `git_reset` with `mode: "hard"`

```json
{
  "repoPath": "/path/to/repo",
  "mode": "hard",
  "confirmHard": true
}
```

Without `confirmHard: true`, the call throws a descriptive error with a message
suggesting `git_stash` as a safer alternative.

### `git_stash_drop`

```json
{
  "repoPath": "/path/to/repo",
  "ref": "stash@{0}",
  "confirmDrop": true
}
```

Without `confirmDrop: true`, the call throws before running any git command.

---

## Error Handling

### `git_pull`

On `--ff-only` conflict:

```
Pull blocked: local changes to the following files would be overwritten
by the fast-forward merge:
  - skills-lock.json

Use `mcp__minsky__git_stash` to stash these changes, then retry the pull,
then `mcp__minsky__git_stash_pop` to restore.
```

The thrown `Error` also carries a `conflictingFiles: string[]` property for
programmatic use.

On non-fast-forward rejection:

```
Pull rejected: cannot fast-forward. The remote has diverged from the local
branch. Use `mcp__minsky__git_status` to inspect the state, then decide
whether to rebase or merge manually.
```

For unrecognized errors (network, auth, etc.) the original exec error is
re-thrown unchanged so the caller can inspect the raw stderr.

---

## mt#1509 Deadlock Resolution Pattern

The canonical workflow that was blocked before mt#1549 and is now first-class:

```
1. Detect conflict
   mcp__minsky__git_pull  → "Pull blocked: skills-lock.json"

2. Stash the conflicting file
   mcp__minsky__git_stash  → { stashed: true, stashRef: "stash@{0}" }

3. Pull now succeeds
   mcp__minsky__git_pull  → { alreadyUpToDate: false }

4. Restore the stashed change
   mcp__minsky__git_stash_pop  → { popped: true, conflicts: [] }
```

For simple lock-file drift (when the local content is not worth preserving),
`git_restore` is shorter:

```
1. mcp__minsky__git_restore { paths: ["skills-lock.json"] }
2. mcp__minsky__git_pull
```

---

## Cross-References

- mt#1509 — live deadlock evidence trail (2026-05-01)
- mt#1503 — originating incident context
- mt#1549 — implementation task for all eight tools
- mt#1103 — main-workspace edit hook (the structural enforcement that blocks raw edits)
- `src/domain/git/pull-operations.ts` — `pullImpl` domain function
- `src/domain/git/stash-operations.ts` — `stashImpl`, `stashPopImpl`, `stashListImpl`, `stashDropImpl`
- `src/domain/git/restore-operations.ts` — `restoreImpl`
- `src/domain/git/reset-operations.ts` — `resetImpl`
- `src/domain/git/status-operations.ts` — `statusImpl`
- `src/domain/git/mt1509-deadlock.test.ts` — integration test reproducing the scenario
- `.claude/hooks/block-git-gh-cli.ts` — denial messages point at the new tools
