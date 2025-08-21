## Summary

Add status filtering support to natural-language task search and centralize task status filtering logic for consistency with `tasks list`.

## Changes

- tasks search: add `--status` and `--all` flags; default hides DONE/CLOSED unless `--all` provided
- centralize status filtering in `src/domain/tasks/task-filters.ts`
- use shared filter in `TaskService.listTasks` and in `tasks search` command
- update changelog

## Testing

- Added unit test `src/domain/tasks/task-filters.test.ts` covering:
  - default behavior (hides DONE/CLOSED)
  - `--all` includes all statuses
  - explicit `--status` matches only the given status
- Focused test run green. Broader suite has unrelated existing failures in session environment; changes are isolated to task filtering and search.

## Notes

- This aligns `tasks search` filtering semantics with `tasks list` via a single shared utility.
- No breaking changes to existing commands or output formats.
