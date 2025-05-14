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

## Addendum: Issues Deferred from Task 071 (Remove Interactive CLI Tests)

The following specific issues arose during Task 071 and were deferred to this task:

1.  **`src/commands/session/startSession.test.ts`**

    - **Issue 1 (Linter - Resolved with Non-Null Assertion for Handoff)**: Linter error `Object is possibly 'undefined'` on `const addSessionArgs = mockCalls[0]![0]!;` (line 115 approx) within the `for...of idFormatsToTest` loop (tests are currently commented out).
      - **Context**: This line uses non-null assertions (`!`) as a temporary workaround. The underlying issue is that TypeScript's type narrowing doesn't fully recognize that `expect(mockCalls.length).toBe(1);` guarantees `mockCalls[0]` is safe to access.
      - **Required Fix (Task 072)**: Implement a more robust type-safe way to access `mockCalls[0][0]` that satisfies the linter without non-null assertions, or confirm if this is a known limitation/configuration issue with Bun Test's typings for Jest mocks. This needs to be fixed when uncommenting the tests below.
    - **Issue 2 (Test Failures - Tests Commented Out)**: 8 tests within the `describe("startSession - Task ID Normalization", ...)` block (now commented out) started failing after changes to use `jest.fn()` and import `beforeEach` from `bun:test` during Task 071.
      - **Specific Failures Include**:
        - `should correctly start session for taskId format: "1"` (and other formats in the loop) - Expected session name like `task#1` but received `test-session`.
        - `should throw error for invalid task ID format` - Expected promise to be rejected, but received an object.
        - `should throw error if task not found after normalization` - Expected promise to be rejected, but received an object.
      - **Context**: These failures suggest issues with how mocks are initialized, cleared, or how the `startSession` function (or its dependencies) behave after the mocking syntax adjustments made in Task 071. The `startSession` function itself might be using stale mock implementations or the module mocking isn't working as intended in this specific file after the changes.
      - **Required Fix (Task 072)**: Investigate the mock setup (especially `mockGitServiceInstance`, `mockSessionDBInstance`, `mockTaskServiceInstance`, and `repoUtilsMocks`), how they are cleared in `beforeEach`, and how `startSession` (imported or potentially re-imported if module mocks are used) interacts with them. Ensure mocks return expected dynamic values based on test inputs. Uncomment and fix these tests.

2.  **`src/domain/__tests__/session.test.ts`** (3 tests commented out during Task 071)

    - **Test**: `"should start a session with valid parameters"`
      - **Error**: `MinskyError: Failed to start session: deps.sessionDB.getNewSessionRepoPath is not a function.`
    - **Test**: `"should update a session with valid parameters"`
      - **Error**: `TypeError: sessionDB.updateSession is not a function.`
    - **Test**: `"should not stash or pop when noStash is true"`
      - **Error**: `TypeError: sessionDB.updateSession is not a function.`
    - **Context**: These were pre-existing failures before Task 071 but were commented out during Task 071 for handoff.
    - **Required Fix (Task 072)**: Review the mock setup for `SessionDB` in these domain tests. Ensure that all methods expected by the code under test (`startSessionFromParams`, `updateSessionFromParams`) are correctly mocked on the `mockSessionDB` object or via the class mocks used in this file. The interface of the actual `SessionDB` may have changed, and these test mocks were not updated. Uncomment and fix these tests.

3.  **`src/adapters/__tests__/integration/session.test.ts`** (2 tests currently failing)
    - **Issue**: `expect(console.error).toHaveBeenCalledWith(expect.stringContaining(...))` assertions show `Number of calls: 2` for `console.error` in error scenarios, though the assertion itself passes (as it checks for _at least_ one call with the substring).
    - **Context**: The MCP tool error handling might be logging an error, and then another mechanism (e.g., global error handler, MCP framework itself) might be logging it again.
    - **Required Fix (Task 072)**: Investigate the source of the double `console.error` call. If the second call is redundant or unintentional, address the root cause. If both calls are expected and distinct, consider more specific assertions for each call (e.g., using `toHaveBeenNthCalledWith`) to make the tests more precise, or confirm the current assertion is sufficient if the content of one call is all that matters.
