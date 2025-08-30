# Shared Result Handling Filters & Sorting

This document standardizes filter and time parsing semantics for list/get style commands across the CLI and MCP adapters.

## Modules

- `src/utils/result-handling/filters.ts`
  - `parseStatusFilter(input): Set<string> | null` — comma-separated list; `all` disables filtering
  - `parseBackendFilter(input): 'github'|'remote'|'local'|undefined` — normalizes input; invalid returns `undefined`
  - `parseTime(value): number | null` — accepts `YYYY-MM-DD` or relative `7d|24h|30m`; returns epoch ms or `null`
  - `filterByStatus(items, set)` — case-insensitive match on `item.status`
  - `filterByBackend(items, backend)` — exact match on `item.backendType`
  - `filterByTimeRange(items, sinceTs, untilTs)` — uses `item.updatedAt` ISO timestamp

- `src/utils/result-handling/sort.ts`
  - `byUpdated(direction)` — comparator for `updatedAt`
  - `byCreated(direction)` — comparator for `createdAt`
  - `byNumber(direction)` — comparator for numeric `number`

## Adoption

- `sessionPrList` and `sessionPrGet` now use these utilities for consistent behavior:
  - Status: comma-separated values or `all`
  - Backend: `github|remote|local`
  - Time: `YYYY-MM-DD` or relative `d/h/m`

## Guidance

- Prefer central utilities over ad-hoc parsing in command implementations
- For new commands: wire filters first, sorting optional
- Keep human/JSON output unchanged; utilities only affect selection and ordering

## Tests

- `tests/utils/result-handling/filters.test.ts` covers parsers and predicates

