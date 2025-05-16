# Migrate or rewrite CLI adapter test files (rules.test.ts, session.test.ts)

## Background

The CLI adapter test files in `src/adapters/cli/__tests__` (`rules.test.ts`, `session.test.ts`) were deleted due to persistent syntax errors and outdated code. These tests were blocking the test suite and did not provide meaningful coverage in their current state.

## Task

- Migrate or rewrite the deleted CLI adapter test files to:
  - Remove syntax errors and outdated patterns
  - Restore meaningful test coverage for CLI adapters
  - Prefer domain-level tests where possible, following project test rules
  - Ensure all new or migrated tests pass in both the main and session workspaces
- Reference SpecStory history for context on why these files were removed.

## Acceptance Criteria

- New or migrated tests exist for CLI adapter logic
- No syntax errors or placeholder code remain
- All tests pass in both main and session workspaces
- Task is documented in the changelog and SpecStory history
