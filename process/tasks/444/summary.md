# Implement status filtering for natural language task search

- Add `--status` and `--all` support to `tasks search` to match `tasks list` filtering semantics.
- Fix `listTasksFromParams` to honor `status` param rather than misusing `filter` key.
- Default behavior: hide DONE and CLOSED unless `--all` provided.
- Ensure changes are applied within session workspace `task-search-status-filter`.
