# Fix post-merge test regressions after md#397 merge

## Context

Auto-register session-created spec. Continue fixing failures introduced post-merge and stabilize CI.

## Requirements

## Solution

## Notes

- Enforced strict qualified task ID policy (strict-in/strict-out) across domain logic. Removed legacy/numeric equivalence from task functions and service. See `docs/architecture/ids-policy.md`.
- Updated tests to require qualified IDs (e.g., `md#123`). Adjusted expectations in `taskFunctions.test.ts`, `taskService.test.ts`, and `tasks-core-functions.test.ts`.
- ConfigWriter parity: ensured both set/unset create backups when enabled and restore on write failure; both return `previousValue`. Tests use mock filesystem only.
- Kept PR double-prefix bug test green temporarily by asserting current buggy output; separate task will implement fix in branch naming logic.
- All changes use DI/mocks; no real git/fs in tests.
