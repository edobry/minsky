# Auto-commit and push for tasks_create (Minsky Tasks)

## Context

Problem

- Creating tasks via the tasks_create tool generates files (process/tasks/md#NNN-\*.md and updates to tasks.md) but does not automatically commit/push, unlike tasks status set flows.

Goal

- Make task creation flows auto-stage, commit, and push the generated/updated files by default to ensure persistence and visibility without manual follow-up.

Scope

- Implement auto-commit + push in the Markdown Tasks backend (same backend used by `tasks status set`).
- Reuse the exact same commit/push logic as `tasks status set` (stash/commit/push/restore flow). No duplicate implementations.
- Do NOT implement commit/push behavior inside the `tasks create` CLI command; the CLI must delegate to the backend which performs commit/push.
- Commit message format: `chore(task): create <qualified-id> <title>`
- Include all created/updated files: new task spec, `process/tasks.md` index (registry), and any sidecar files.
- Detect and handle dirty workspace by stashing before write and restoring after push.
- Error handling: pushing may fail; creation must still succeed locally and report a warning.
- Tests: unit tests assert that create triggers commit/push with the expected message and a no-op when there are no changes.

Acceptance Criteria

- Creating a task (via MCP or CLI `tasks create`) triggers the Markdown Tasks backend which stages, commits, and pushes by default.
- Backend logic is the same as `tasks status set` (stash/commit/push/restore) and is implemented exclusively in the backend, not in the CLI layer.
- Commit message includes the qualified id and title, e.g. `chore(task): create md#123 Some Title`.
- Unit tests cover: commit/push occurs after creation; and commit is suppressed when there are no changes.
- Docs/changelog updated.

Implementation Notes

- Centralize commit/push logic in the Markdown Tasks backend so callers (CLI/MCP) do not need to manually perform VCS operations.
- Ensure the backend path used by `tasks status set` is invoked for task creation as well, reusing shared utilities for staging, committing, and pushing.

## Requirements

## Solution

- Implemented in `src/domain/tasks/markdownTaskBackend.ts` within the session workspace.
- Added injectable `gitService` to facilitate unit testing without global mocks.
- Implemented stash/commit/push/restore flow around task creation for both spec-file and object creation paths.
- Commit message format: `chore(task): create <qualified-id> <title>`.
- Added focused unit tests to verify commit/push behavior and no-op when no changes.

## Notes
