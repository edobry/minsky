# Task #072: Fix Test Failures and Remaining Linter Errors

## Context

Following an attempt to run and fix all Husky hook issues, several critical problems remain that prevent `bun test` and `bun run lint:fix` from passing. These issues block successful pre-commit and pre-push hook execution. A previous commit was made with `--no-verify` to save progress, but these outstanding items must be resolved.

## Objective

Resolve all test failures and critical ESLint errors to ensure Husky hooks (pre-commit and pre-push) pass successfully.

## Requirements

1.  **Test Failures:** All tests executed by `bun test` must pass.
    - **Current issues:**
      - 18 test failures, 6 errors, 213 passing.
      - Major errors:
        - `SyntaxError: Export named 'normalizeTaskId' not found in module .../src/domain/tasks.ts` (affecting many integration and session tests)
        - `TypeError: mock.fn is not a function` in `src/domain/__tests__/session.test.ts`
        - `Cannot assign to import "getCurrentSession"` in `src/domain/workspace.test.ts`
      - Several tests are failing due to missing or incorrect exports, and improper mocking.
2.  **ESLint Errors:** `bun run lint:fix` must exit with code 0.
    - **Current issues:**
      - 806 problems (8 errors, 798 warnings)
      - Errors include:
        - `@typescript-eslint/no-var-requires` (require statement not part of import)
        - Many `Unexpected any. Specify a different type`
        - Many `Unexpected console statement`
        - Many `No magic number`
        - Many unused variables
      - Linter did not auto-fix all issues; manual intervention required.
3.  **Placeholder Test Script:** The `bun detect-placeholder-tests.ts` script must pass with exit code 0.
    - **Current issues:**
      - 18 placeholder/fake test issues found in 38 test files.
      - Patterns found:
        - `expect(true).toBe(true)`
        - `// TODO` comments
        - `test("mock test to bypass failures"`
        - `test("placeholder test to make CI pass"`
      - Files affected include:
        - `src/commands/tasks/list.test.ts`
        - `src/commands/git/commit.test.ts`
        - `src/commands/session/__tests__/autoStatusUpdate.test.ts`
        - `src/commands/session/commit.test.ts`
        - `src/commands/session/get.test.ts`
        - `src/domain/__tests__/gitServiceTaskStatusUpdate.test.ts`
        - `src/domain/__tests__/repository.test.ts`
        - `src/domain/git.test.ts`
        - `src/domain/git.pr.test.ts`
4.  **Husky Hooks:**
    - The `pre-commit` hook (`lint-staged` and `detect-placeholder-tests`) must pass.
    - The `pre-push` hook (`bun test`) must pass.

## Implementation Steps

1.  [ ] **Fix import/export errors:**
    - [ ] Correct all missing or incorrect exports, especially for `normalizeTaskId` in `src/domain/tasks.ts` and all files that import it.
2.  [ ] **Fix improper mock usage:**
    - [ ] Address improper mocking and assignment to imports, e.g., `mock.fn is not a function` and `Cannot assign to import` errors in test files.
3.  [ ] **Remove or rewrite placeholder/fake tests:**
    - [ ] Remove or rewrite all placeholder/fake tests and TODOs flagged by the detection script in the files listed above.
4.  [ ] **Systematically address all linter errors:**
    - [ ] Fix all linter errors, especially those that block a clean exit (e.g., `no-var-requires`, `no-explicit-any`, `no-console`, `no-magic-numbers`, unused variables).
5.  [ ] **Re-run all checks after each batch of fixes:**
    - [ ] Run `bun test`, `bun run lint:fix`, and `bun detect-placeholder-tests.ts` after each set of changes to verify progress.
6.  [ ] **Final verification:**
    - [ ] Ensure all tests pass, linter exits 0, and no placeholder tests remain.
    - [ ] Verify Husky hooks pass on commit and push.

## Verification

- `bun test` passes with 0 failures.
- `bun run lint:fix` exits with code 0.
- `bun detect-placeholder-tests.ts` exits with code 0.
- A `git commit` (without `--no-verify`) successfully runs pre-commit hooks.
- A `git push` successfully runs pre-push hooks.
