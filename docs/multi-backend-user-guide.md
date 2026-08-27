# Multi-Backend Task System User Guide

## Overview

The Minsky multi-backend task system allows you to work with tasks from multiple backends
(Minsky database, GitHub Issues) simultaneously. This guide covers everything you need
to know about using the system.

> **Note:** The GitHub Issues backend is **disabled by default** (`tasks.githubBackend.enabled=false`).
> The Minsky DB (`mt#`) backend is the operational default. To enable the github-issues
> backend, set `tasks.githubBackend.enabled: true` in your config — see
> [GitHub Issues Backend Guide](./github-issues-backend-guide.md).

## Task ID Formats

### Qualified Task IDs

The system uses **qualified task IDs** that include the backend prefix:

```bash
mt#123      # Minsky database backend, task 123
gh#456      # GitHub Issues backend, issue 456
```

## Session and Branch Names

### Session Names

```bash
task-mt#123     # Session for Minsky task 123
task-gh#456     # Session for GitHub issue 456
```

### Git Branch Names

```bash
task-mt#123     # Git-compatible branch name
task-gh#456     # Same format as session names
```

## CLI Commands

### Working with Qualified Task IDs

All CLI commands accept qualified task IDs:

```bash
# Get task from specific backend
minsky tasks get mt#123
minsky tasks get gh#456

# Update task status
minsky tasks status mt#123 IN-PROGRESS

# Create session for qualified task
minsky session start --task gh#456
```

### Backend Selection

#### Creating Tasks with Specific Backend

```bash
# Create task in specific backend
minsky tasks create --backend minsky "Fix bug in parser"
minsky tasks create --backend github "Add new feature"

# Default backend (minsky) if not specified
minsky tasks create "Update documentation"  # → mt#124
```

#### Cross-Backend Operations

```bash
# List tasks from all backends
minsky tasks list --all-backends

# List tasks from specific backends
minsky tasks list --backends mt,gh

# Search across multiple backends
minsky tasks search "authentication" --backends mt,gh
```

## Common Workflows

### 1. Working with Minsky Tasks (Default)

```bash
# Create task (defaults to minsky backend)
minsky tasks create "Implement feature X"  # → mt#125

# Start session
minsky session start --task mt#125

# Work on task
cd ~/.local/state/minsky/sessions/task-mt#125
# ... make changes ...

# Create PR
minsky session pr create --title "Implement feature X" --type feat
```

### 2. Working with GitHub Issues

> **Prerequisite:** The GitHub Issues backend must be explicitly enabled. Add
> `tasks.githubBackend.enabled: true` to `~/.config/minsky/config.yaml` first.
> Attempting to use the github backend without enabling it returns:
>
> ```
> GitHub-issues task backend is disabled. Set tasks.githubBackend.enabled=true in your Minsky config to use it.
> ```

```bash
# List GitHub issues
minsky tasks list --backend gh

# Start session for GitHub issue
minsky session start --task gh#789

# Work on issue
cd ~/.local/state/minsky/sessions/task-gh#789
# ... make changes ...

# Create PR that references GitHub issue
minsky session pr create --title "Resolve authentication bug" --type fix
```

### 3. Cross-Backend Project Management

```bash
# List all tasks across backends
minsky tasks list --all-backends

# Search for tasks related to authentication
minsky tasks search "auth" --backends mt,gh

# Migrate task between backends
minsky tasks migrate-backend --from minsky --to github --execute
```

## Best Practices

### 1. Backend Selection

- **Minsky database**: All internal tasks, personal work, project management
- **GitHub Issues**: Public projects, team collaboration, bug tracking with discussions

### 2. Task ID Usage

- **Use qualified IDs** (`mt#123`, `gh#456`) in documentation and commit messages for clarity

### 3. Git Workflow

- **Branch names are git-compatible** (uses # which is valid)
- **PR titles should include qualified IDs** for traceability
- **Commit messages benefit from qualified IDs** for cross-backend clarity

## Troubleshooting

### Common Issues

#### Task ID Not Found

```bash
# Error: Task 'xyz#123' not found
# Solution: Check backend is correct and task exists
minsky tasks list --backend mt
```

#### Session Name Confusion

```bash
# If unsure about session format:
minsky session list  # Shows all sessions with qualified names
```

#### Backend Not Available

```bash
# Error: GitHub-issues task backend is disabled.
# Solution: Enable the github backend in your config
#   tasks:
#     githubBackend:
#       enabled: true
# Then retry the command.

# Error: Backend 'gh' not configured (after enabling)
# Solution: Configure GitHub credentials (GITHUB_TOKEN, owner, repo)
minsky init --github-repo owner/repo
```

#### Task reads error instead of returning results (mt#3636)

Task reads **fail closed** when no task backend could be registered. They raise rather than
returning an empty list, because an empty list would be indistinguishable from a database that
genuinely has no tasks:

```
Task backend unavailable — cannot list tasks: the 'postgres' persistence backend was configured
but failed to initialize AT BOOT (getaddrinfo ENOTFOUND), so no task backend was registered. This
registration has NOT been re-attempted since boot, so the underlying dependency may well have
recovered in the meantime. This is a backend-REGISTRATION failure, which is not the same as an
empty database and not necessarily a current outage — an empty result here would be
indistinguishable from a real one, which is why this fails instead. Note `minsky persistence
check` may well PASS while this fails: it probes the live connection, whereas this reports what
happened when the backend was registered.
```

Once a re-registration has been attempted, the middle sentence is replaced by its timestamp and
cause — `Last re-registration attempt 2026-08-21T19:30:00.000Z also failed (connect ECONNREFUSED).`
That distinction is the point: without it, "stuck since boot" and "still retrying against a real
outage" read identically (ADR-035 rule 4).

**Read the tense carefully — it is deliberate (mt#4379).** This message describes what happened
**when the backend was registered**, not what is true now. The wording used to assert "The database
is unreachable" in the present tense, and that sentence was false often enough to be expensive: in
mt#4379 persistence had long since recovered, `minsky persistence check` returned "All checks
passed" seconds before this error rendered, and two separate agent sessions each opened their
diagnosis at a perfectly healthy database.

Before mt#3636 this state answered `{"tasks": [], "total": 0}` with exit 0, and
`tasks status get` reported an existing task as "not found" — which invited agents and scripts to
act on the emptiness (re-creating tasks that already exist, concluding a dependency was missing).

### A status WRITE reports what it actually changed (mt#4457)

`tasks status set` returns a `recordsAffected` count alongside `success`, `taskId` and `status`.
Read it rather than `success` alone when a script's next step depends on the write having landed:

| `recordsAffected` | Meaning                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1`               | The write persisted. This is the only value a successful call returns.                                                                                                                                     |
| `0`               | The write did **not** persist and the task's status is unchanged. The command raises `StatusWriteDidNotPersistError` rather than returning this, so a caller should never observe it in a success payload. |
| `>1`              | More records changed than the one task addressed — a corruption signal. The command raises rather than reporting success.                                                                                  |

The `changed` field in the CLI/MCP envelope is **derived from this count**, not asserted. Until
2026-08-25 it was the literal `true`, which meant the payload read identically whether or not the
update reached the row: on 2026-08-23 three task rows were reported as transitioned by writes that
never committed. A Postgres `UPDATE` matching zero rows raises nothing, so the count is the only
signal that distinguishes the two.

**Backend caveat.** The Minsky (Postgres) backend derives the count from the UPDATE itself, so it
is exact. The GitHub Issues backend has no rowcount and reports `1` for any successful API call —
including a transition to a status the issue already held. Do not read `changed: true` from a
`gh#` task as proof the status actually differed.

The error text distinguishes two causes, which need opposite responses:

| Error says                                                      | Cause                                                    | What to do                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "…was configured but failed to initialize AT BOOT (`<reason>`)" | Postgres IS configured; the connection failed at startup | Fix connectivity if it is still down. **A restart is no longer required** (mt#4379): the zero-backend service now marks itself a degraded substitute, so the container re-registers it on a later `get()`. Note `minsky persistence check` may PASS here — it probes the live connection, while this reports registration time. |
| "persistence is not configured (`<reason>`)"                    | No connection string anywhere                            | Set `persistence.postgres.connectionString`, or export `MINSKY_PERSISTENCE_POSTGRES_URL`                                                                                                                                                                                                                                        |

**The diagnostic surface stays available** while reads are failing, so you can diagnose without a
working database:

```bash
minsky persistence check     # names the underlying initialization failure
minsky debug systemInfo      # answers normally
minsky config list           # answers normally
```

`session` and `memory` commands also fail loudly in this state — they always did. A boot failure is
additionally logged at error level at startup, but note that it goes to **stderr**, so an MCP client
sees only the tool result; that is precisely why the read path had to carry the cause itself.

**The wording above is not specific to task reads (mt#4383).** Three separate renderers describe this
one state, and mt#4379 corrected only the first:

| Renderer                                         | Reaches                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `MultiBackendTaskService.describeUnavailability` | task reads (the message quoted above)                                                                                 |
| `describePersistenceUnavailability`              | the canonical helper — `session` / `memory` commands, task routing, cockpit widgets, schema readiness, the toil-miner |
| `describeFailedPersistenceInit`                  | the cockpit, where a failed init is PROPAGATED rather than substituted                                                |

All three now agree on the two things that matter: no claim that the database is currently
unreachable, and no instruction to restart. `minsky persistence check` PASSING while one of these
fails is expected, not contradictory — it probes the live connection, they report a failed
initialization.

The cockpit renderer keeps the present tense on purpose, and it is the one exception worth knowing:
its error is a live throw from the attempt just made, so "failed to initialize" is accurate at the
moment you read it. The other two replay a record stored at boot, which is why they say **AT BOOT**
and carry a retry clause.

## Advanced Features

### Collision Detection

```bash
# Check for ID conflicts across backends
minsky tasks detect-collisions
```

### Bulk Operations

```bash
# Update status for multiple tasks
minsky tasks status mt#123,gh#456 DONE
```

## API and MCP Integration

The multi-backend system works seamlessly across all interfaces:

### MCP Tools

```typescript
// MCP tools automatically support qualified IDs
await mcp.call("tasks.get", { taskId: "mt#123" });
await mcp.call("session.start", { taskId: "gh#456" });
```

## Getting Help

### Documentation

- Architecture overview: `docs/architecture/multi-backend-task-system-design.md`
- Schema reference: `src/domain/schemas/task-schemas.ts`

### Support Commands

```bash
# Validate current configuration
minsky config validate

# Debug task resolution
minsky tasks get mt#123 --debug

# Check schema compatibility
minsky session validate
```
