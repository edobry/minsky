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

| MCP Tool                       | Underlying git command                          | Deadlock class unblocked                                                   | Requires confirmation?                                                  |
| ------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `mcp__minsky__git_pull`        | `git pull --ff-only <remote> <branch>`          | Pull blocked by local changes; non-FF rejection                            | No (safe default; structural error on conflict)                         |
| `mcp__minsky__git_status`      | `git status --porcelain=v2 --branch`            | Blind to working-tree state when diagnosing blocks                         | No (read-only)                                                          |
| `mcp__minsky__git_stash`       | `git stash push [-m msg] [-- paths]`            | Local changes blocking pull or rebase                                      | No                                                                      |
| `mcp__minsky__git_stash_pop`   | `git stash pop [ref]`                           | Restoring stashed changes after pull succeeds                              | No                                                                      |
| `mcp__minsky__git_stash_list`  | `git stash list --format=...`                   | Auditing stash stack before pop/drop                                       | No (read-only)                                                          |
| `mcp__minsky__git_stash_drop`  | `git stash drop <ref>`                          | Discarding a stash entry permanently                                       | Yes: `confirmDrop: true` required                                       |
| `mcp__minsky__git_restore`     | `git restore -- <paths>`                        | Discarding a single file's unstaged changes                                | No (paths-scoped; less destructive than reset --hard)                   |
| `mcp__minsky__git_reset`       | `git reset --{soft\|mixed\|hard} <target>`      | Unstaging changes, moving HEAD, discarding working-tree                    | `confirmHard: true` required for `mode: "hard"`                         |
| `mcp__minsky__git_repair_lock` | inspects `.git/index.lock`, `rm` when stale     | An abandoned `index.lock` blocking every write op                          | `confirm: true` required for removal (read-only diagnostic otherwise)   |
| `mcp__minsky__git_repair_refs` | `git update-ref -d <ref>` + `git fetch --prune` | A corrupt/stale remote-tracking ref (`fatal: bad object refs/remotes/...`) | `confirm: true` required for repair (read-only scan/identify otherwise) |

Every write-class tool above (`git_pull`/`git_status`/`git_stash`/`git_stash_pop`/
`git_restore`/`git_reset`) also accepts an optional `repairLock: boolean` param
(mt#2820): when `true`, a blocked `.git/index.lock` is auto-repaired
(confirm-gated internally — only removed when provably stale) and the
operation retried once; when omitted, a lock-blocked call throws an enriched
error (age + owning-process liveness) pointing at `git_repair_lock` instead of
the raw git fatal.

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

## Git-State Repair Affordances (mt#2820)

MCP git tools used to relay raw git fatals for repairable repo-state
problems verbatim, forcing ad hoc shell forensics (`ls -la` + `ps aux` +
manual `rm`, or a raw `git update-ref -d` via `session_exec`). mt#2820 added
detection + confirm-gated repair for the two most common cases, covering
BOTH the main workspace and session workspaces (these tools operate on
whatever `repo`/`session` path resolves — there is nothing main-workspace-
specific about the repair logic itself).

### Stale `index.lock` detection and repair

A git write operation (`restore`/`reset`/`commit`/`stash`) fails hard when
`.git/index.lock` already exists (`fatal: Unable to create '.../index.lock':
File exists`). That lock is legitimate while another git process is
genuinely running, but can also be **abandoned** — left behind by a process
that was killed or crashed mid-write. `git_repair_lock` distinguishes the
two:

- **Age**: how long the lock file has existed (from its mtime).
- **Owning-process liveness**: primary signal `lsof -t -- <lockfile>` (a
  live process holding the lock keeps a file descriptor open on it —
  the strongest possible signal); secondary signal a running `git` process
  whose command line references the repo path (covers the narrow window
  between lock acquisition and first write). If NEITHER probe answers
  conclusively, liveness is `undetermined` and repair refuses for safety.

A lock is removed ONLY when **both** conditions hold: no live owning process
AND age >= `LOCK_STALE_THRESHOLD_MS` (10 minutes, grounded in the mt#2820
incident data — the originating lock was zero-byte and ~22 hours old when
discovered; every git\_\* main-workspace op this repairs is a short local
operation that never legitimately holds the lock anywhere near that long).
A lock held by a live process is reported busy and never removed, regardless
of the `confirm` param. The 10-minute default can be overridden per-call via
`staleThresholdMs` (ms) on `git_repair_lock`, for environments whose
legitimate git\_\* operations routinely run longer or shorter than the
incident-grounded default.

**Liveness determination (PR #1986 R1).** Only `lsof -t -- <lockfile>` —
which inspects the lock file's own open file descriptors directly — is
trusted to declare "not live"; a clean run finding zero holders is
self-sufficient. The secondary `ps`-based probe (scanning for a running
`git` process whose command line references the repo path) is
**positive-only**: a match adds an extra "live" signal, but the absence of a
match is never used to confirm "not live," since command-line substring
matching is unreliable (a process invoked with a relative path, or already
`cd`'d into the repo with no `-C <path>` argument, has no textual reference
to the repo path at all). If `lsof` itself can't run cleanly (missing,
denied, erroring), liveness is `undetermined` regardless of what `ps` finds
— repair refuses rather than trusting the weaker signal alone.

**Pre-unlink TOCTOU guard (PR #1986 R1).** Between diagnosis and removal, a
legitimate process could have replaced the lock (finished, cleaned up, and a
new operation acquired a fresh lock at the same path) or newly acquired the
still-same lock. `git_repair_lock`'s repair path re-stats the lock
immediately before unlinking — comparing inode, device, and mtime against
the diagnosis snapshot — and re-runs the liveness check one more time,
aborting on ANY change rather than trusting the earlier snapshot.

```
1. Diagnose (read-only):
   mcp__minsky__git_repair_lock { repo: "/path/to/repo" }
   → { present: true, staleEligible: true, ageMs: 660000, liveProcess: false, ... }

2. Repair (mutating):
   mcp__minsky__git_repair_lock { repo: "/path/to/repo", confirm: true }
   → { removed: true, ... }
```

Every write-class git\_\* tool also accepts `repairLock: true` directly, to
repair-then-retry the original operation in one call instead of a separate
diagnose/repair/retry round-trip.

### Corrupt/stale remote-ref repair

A remote-tracking ref (`refs/remotes/origin/<branch>`) can point at an
object that no longer resolves — surfacing as `fatal: bad object
refs/remotes/origin/<branch>` on any command that touches it. `git_repair_refs`
identifies the ref (`git log -1 <ref>`, which — unlike `git cat-file -e`,
whose `-e` mode is silent by design — surfaces this exact diagnostic text),
and, with `confirm: true`, repairs it: `git update-ref -d <ref>` followed by
`git fetch <remote> --prune` to re-create the ref from upstream if it still
legitimately exists there. The repair refuses (throws) if the named ref
turns out to be healthy — it never deletes a ref that isn't actually
corrupt.

```
1. Scan (read-only, no ref specified — enumerates refPrefix, default refs/remotes/origin):
   mcp__minsky__git_repair_refs { repo: "/path/to/repo" }
   → { scanned: true, results: [{ ref: "...", bad: false }, ...] }

2. Identify a specific ref:
   mcp__minsky__git_repair_refs { repo: "/path/to/repo", ref: "refs/remotes/origin/task/mt-2304" }
   → { bad: true, error: "fatal: bad object refs/remotes/origin/task/mt-2304" }

3. Repair (mutating):
   mcp__minsky__git_repair_refs { repo: "/path/to/repo", ref: "refs/remotes/origin/task/mt-2304", confirm: true }
   → { deleted: true, refetched: true }
```

### Root cause of the originating incident

The mt#2820 investigation traced the abandoned-lock incident to a burst of
`staleness_exit` MCP server respawns (mt#1315's stale-source mechanism)
during the lock's creation window — evidenced in
`~/.local/state/minsky/mcp-disconnect-log.json`. `mt#2701`'s single-process
staleness-drain (`triggerStaleSignal`/`scheduleStaleExitAfterDrain` in
`src/mcp/server.ts`) already prevents an in-flight tool call's OWN git
subprocess from being orphaned by ITS process exiting — but has no
visibility across separate MCP server processes. `git-params-facade.ts`'s
`defaultExecDeps` now bounds every git\_\* subprocess to a 60s timeout (there
was previously none), giving git's own SIGTERM-triggered lockfile cleanup a
chance to fire on a hang rather than running unbounded. The residual
cross-process race (two respawned MCP server processes both writing to the
same repo's `index.lock` during a rapid respawn burst) is tracked separately
in mt#2886, since closing it requires a cross-process coordination
mechanism, not just detection/repair.

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
- mt#2820 — git-state repair affordances (index.lock detection/repair, remote-ref
  repair, git-exec timeout hardening); evidence trail: conversations 4b019e33,
  3c8cd612 (lock), c01f89af (bad ref)
- mt#2886 — filed follow-up: cross-process mutual exclusion for the residual
  root-cause gap this task's investigation surfaced but did not close
- `packages/domain/src/git/lock-operations.ts` — `detectIndexLock`,
  `repairIndexLock`, `runGitCommandWithLockHandling`
- `packages/domain/src/git/ref-repair-operations.ts` — `checkRef`,
  `scanForBadRefs`, `repairBadRef`
- `scripts/smoke-git-repair.ts` — end-to-end smoke covering all three mt#2820
  acceptance tests through the full command-registry execute path
