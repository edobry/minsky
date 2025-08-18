# Extract reusable result-handling utilities for list/get commands

## Context

Goal

- Create a reusable module for list/get result handling across CLI commands (sessions, tasks, PRs).

Scope

- Common concerns:
  - Filtering: status (multi-select, comma-separated, or all), backend, time windows (since/until); optional text search (future)
  - Sorting: updated/created/number asc/desc (future)
  - Pagination/windowing (future)
  - Output shaping toggles: short/long, badges/emoji, urls-only
  - Parsers: status set parsing, backend normalization, time parsing (relative 7d/24h/30m and YYYY-MM-DD)

Deliverables

- src/utils/result-handling/filters.ts
  - parseStatusFilter(input): Set<string>|null
  - parseBackendFilter(input): 'github'|'remote'|'local'|undefined
  - parseTime(value): number|null
  - filterByStatus, filterByBackend, filterByTimeRange(updatedAt)
- src/utils/result-handling/sort.ts (stub)
  - byUpdated/byCreated/byNumber comparators with direction
- Refactor session pr list/get to use utilities
- Tests (bun:test) for parsers + filters

Non-goals

- Migrating every command in one PR; follow-ups will adopt utilities incrementally

Acceptance criteria

- New utils exist and are covered by tests
- session pr list/get use the shared utils without behavior regressions
- Docs updated with shared semantics

## Requirements

## Solution

## Notes
