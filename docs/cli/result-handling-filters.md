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

## Adopting Commands

- session.pr list/get (already adopted)
- tasks.list: supports `--since`/`--until`
- session.list/session.get: support `--since`/`--until` (applied to `createdAt`)
- rules.list: supports `--since`/`--until` (applies to file mtime proxy)

## Examples

```bash
# Tasks updated in last 7 days (relative)
minsky tasks list --since 7d --json

# Sessions created in August 2024 (absolute dates)
minsky session list --since 2024-08-01 --until 2024-08-31 --json

# Rules modified in the last year
minsky rules list --since 365d --json
```

Behavior details:
- `--since/--until` accept YYYY-MM-DD or relative durations (Nd/Nh/Nm)
- When both provided, items must fall within the inclusive range
- For rules, mtime is used as `updatedAt` proxy until domain timestamps are available

## Guidance

- Prefer central utilities over ad-hoc parsing in command implementations
- For new commands: wire filters first, sorting optional
- Keep human/JSON output unchanged; utilities only affect selection and ordering

## Tests

- `tests/utils/result-handling/filters.test.ts` covers parsers and predicates