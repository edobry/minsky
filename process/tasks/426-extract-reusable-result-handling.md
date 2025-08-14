---
id: md#426
title: Extract reusable result-handling utilities for list/get commands
status: TODO
owner: devx
---

Goal

- Create a universal, reusable module for list/get result handling across CLI commands (sessions, tasks, PRs, etc.).

Scope

- Common concerns:
  - Filtering: status (multi-select), backend, time windows (since/until), text search (future)
  - Sorting: updated/created/number asc/desc (future)
  - Pagination/windowing (future)
  - Output shaping: short/long, badges/emoji toggles
  - Utility parsers: multi-status parsing, backend normalization, relative/absolute time parsing

Deliverables

- `src/utils/result-handling/filters.ts`
  - parseStatusFilter(input: string | undefined): Set<string> | null
  - parseBackendFilter(input: string | undefined): 'github'|'remote'|'local'|undefined
  - parseTime(value: string | undefined): number | null  // supports 7d/24h/30m or YYYY-MM-DD
  - filterByStatus, filterByBackend, filterByTimeRange(updatedAt)

- `src/utils/result-handling/sort.ts` (stub)
  - comparators: byUpdated, byCreated, byNumber with direction

- Refactor `session pr list/get` to consume utilities
- Tests for parsers + filters (bun:test)

Out of scope

- Retrofitting all existing commands—follow-up tasks will adopt utilities incrementally

Notes

- Keep zero-dependency, functional utilities; avoid side effects
- Aim for consistent semantics across commands (`all` disables status filter; relative times anchored to now)


