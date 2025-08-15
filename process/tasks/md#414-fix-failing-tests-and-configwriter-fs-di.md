# md#414: Fix post-merge test regressions after md#397 merge

## Status
- In progress (failures reduced to 14)

## Scope
- Enforce strict-in/strict-out qualified task IDs (e.g., `md#123`, `gh#456`) across schemas, services, and tests. No legacy or numeric equivalence.
- Ensure tests interact with mocks only; no real resources.
- Stabilize session start/approve workflows; fix DB insertion ordering and approval-only behavior.
- Refactor ConfigWriter tests to Bun-native mocking patterns and per-test isolation.

## Completed
- Strict ID policy
  - Restored strict validation in `task-id-utils`, `taskIdSchema`, session resolver, and task services
  - Updated tests to use qualified IDs; removed legacy/numeric equivalence expectations
  - Added `docs/architecture/ids-policy.md` with rationale (no cross-backend numeric mapping)
- Session approval flow
  - `approveSessionFromParams` now returns `sessionName`
  - Approval/branch-cleanup/workflow tests passing
- Session clone regression tests
  - Updated to qualified IDs; ordering validated (git ops before DB insert)
- ConfigWriter tests
  - Final rewrite to fresh per-test Bun mocks with `spyOn` wiring; no cross-test reuse
  - Eliminated grouped holder reassignments; ESLint `custom/no-jest-patterns` compliant
  - All ConfigWriter tests pass locally and in isolation
- Changelog updated

## Remaining Failures (14)
- Interface-agnostic task command functions (parameter handling, backend option)
- Multi-backend task service (list/update/status across backends)
- Task parsing/add flows (constants and parsing utilities)

## Next Actions
- Triage the remaining 14 failures:
  - Fix interface-agnostic task functions to require qualified IDs and pass backend options consistently
  - Align multi-backend service tests with strict ID policy; ensure all backends are mocked and routed correctly
  - Correct task parsing utilities to accept only qualified IDs and update add/replace flows accordingly
- Keep all tests fully mocked; no real fs/git/network

## Notes
- PR double-prefix bug test asserts current buggy behavior intentionally; fix tracked separately.
- Per-user guidance: session names are not parsed; task association in session record is authoritative.
