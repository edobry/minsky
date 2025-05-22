# Migration Notes: High-Priority Test Migration to Bun-native Patterns

## Overview

This document summarizes the migration of high-priority tests from legacy Jest/Vitest patterns to Bun-native test patterns as part of Task #114.

## Migration Status

- All identified high-priority test files have been migrated to use Bun-native patterns.
- No legacy Jest/Vitest patterns remain in the prioritized test files.

## Key Patterns and Helpers

- **Test runner:** All tests now use `bun:test` for `describe`, `test`/`it`, `beforeEach`, `afterEach`, and assertions.
- **Mocking:** Bun's `mock` and `spyOn` are used for mocking functions and modules. Custom helpers are provided in `src/utils/test-utils/assertions.ts` and `src/utils/test-utils/mocking.ts`.
- **Assertions:** Bun's `expect` is used, with custom matchers and helpers for common patterns (e.g., `expectToMatch`, `expectToHaveBeenCalled`).
- **Setup/Teardown:** Consistent use of `beforeEach`/`afterEach` for test isolation.
- **Compatibility Layer:** For any remaining edge cases, a compatibility layer is provided in `src/utils/test-utils/compatibility.ts`.

## Migrated Files (High Priority)

- `src/adapters/__tests__/shared/commands/tasks.test.ts`
- `src/adapters/__tests__/shared/commands/git.test.ts`
- `src/adapters/__tests__/shared/commands/session.test.ts`
- `src/adapters/cli/__tests__/git-merge-pr.test.ts`
- `src/utils/__tests__/param-schemas.test.ts`
- `src/utils/__tests__/option-descriptions.test.ts`
- `src/utils/test-utils/__tests__/compatibility.test.ts`
- `src/domain/session/session-db.test.ts`
- `src/domain/tasks.test.ts`
- `src/domain/session/session-adapter.test.ts`
- `src/domain/git.test.ts`
- `src/domain/__tests__/workspace.test.ts`

## Lessons Learned

- Bun's mocking and assertion APIs are sufficient for most migration needs.
- Some custom helpers were needed to match legacy matcher semantics.
- Test readability and maintainability improved after migration.

## Next Steps

- Maintain Bun-native patterns for all new and existing tests.
- Use this migration as a template for future automated migrations.
