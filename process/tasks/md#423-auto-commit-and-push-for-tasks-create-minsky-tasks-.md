# Auto-commit and push for tasks_create (Minsky Tasks)

## Context

Problem
- Creating tasks via the tasks_create tool generates files (process/tasks/md#NNN-*.md and updates to tasks.md) but does not automatically commit/push, unlike tasks status set flows.

Goal
- Make task creation flows auto-stage, commit, and push the generated/updated files by default to ensure persistence and visibility without manual follow-up.

Scope
- Implement auto-commit + push in the task creation path used by the MCP/CLI tasks_create command.
- Commit message format: `chore(task): create <qualified-id> <title>`
- Include all created/updated files: new task spec, tasks.md index (or registry), and any sidecar files.
- Provide flags:
  - `--no-commit` to disable committing
  - `--no-push` to disable pushing (still commits locally)
- Detect and handle dirty workspace: stage only relevant task files; do not include unrelated changes by default; provide `--all` override if desired (future).
- Error handling: clear errors if remote push fails; still return created task id and local commit outcome.
- Config awareness: respect default remote/branch from repo; use repo's current branch unless overridden.
- Tests: e2e test that verifies a commit exists after creation, with expected message; integration test for `--no-commit`/`--no-push`.
- Docs: update process/tasks.md and CLI help to document new behavior and flags.

Acceptance Criteria
- tasks_create produces a new commit with the new task spec and registry update by default and pushes it.
- Flags work as specified.
- Commit message includes the qualified id and title.
- Tests pass and docs updated.


## Requirements

## Solution

## Notes
