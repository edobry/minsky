# md#410: Fix task status update to use main workspace and configure main workspace path

## Summary

- Investigate and fix failures when updating task status after GitHub merges due to using repoUrl as a filesystem path.
- Ensure Markdown/JSON tasks backends always operate on files in the main workspace directory.
- Add config field for main workspace path and have in-tree task backends read and use it.

## Motivation

Post-merge, the session cleanup attempted to update task status by reading process/tasks.md from repoUrl (https:/github.com/...). This fails with ENOENT. The tasks backends should only operate in the main workspace (filesystem), not remote URLs.

## Requirements

- Add configuration key: workspace.mainPath (string; absolute path).
- In Markdown and JSON tasks backends, resolve task files against workspace.mainPath rather than repoUrl.
- Guard logic to skip file-based updates if workspace.mainPath is not set and provide a clear error message.
- Update session merge workflow to rely on the task backend (which will now use workspace.mainPath).
- Add tests to verify path resolution and error messaging.

## Acceptance Criteria

- Task status updates no longer attempt to read from https:/github.com/... .
- When configured, updates use workspace.mainPath/process/tasks.md.
- Helpful error if workspace.mainPath missing.
- Document new config in configuration guide.
