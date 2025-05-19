# Task #075: Fix Minsky Session Delete Command Cleanup

## Context

The `minsky session delete` command is intended to remove both the session repository directory and the session record from the database. However, during recent usage (SpecStory history [YYYY-MM-DD_HH-MM-topic](.specstory/history/YYYY-MM-DD_HH-MM-topic.md)), it was observed that the command reported success but failed to remove the session record from the database, requiring manual intervention. This indicates a potential bug in the command's implementation.

## Requirements

1.  Investigate the implementation of `minsky session delete` in `src/commands/session/delete.ts` and the related domain logic in `src/domain/session.ts`.
2.  Identify the root cause of the failure to remove the session record from the database.
3.  Implement the necessary changes to ensure that the `minsky session delete` command reliably removes both the session directory and the database record.
4.  Add or update tests in `src/commands/session/delete.test.ts` and `src/domain/session.test.ts` to cover the fixed cleanup logic and prevent regressions.

## Implementation Steps

1.  Analyze existing code and identify the bug.
2.  Implement the fix in the relevant files (`src/commands/session/delete.ts`, `src/domain/session.ts`).
3.  Update tests to verify the fix.
4.  Ensure error handling is robust and informative.

## Verification

- Run `minsky session delete <session-name>` for a test session.
- Verify that the session directory is removed.
- Verify that the session record is removed from `/Users/edobry/.local/state/minsky/session-db.json`.
- All tests pass.

## Acceptance Criteria

- [ ] The `minsky session delete` command successfully removes both the session repository directory and the session record from the database.
- [ ] Appropriate error handling is in place for cases where cleanup fails.
- [ ] Tests cover the corrected cleanup logic.

## Related

- Task #015: Add `session delete` command to remove session repos and records

## Worklog & Current Status (as of YYYY-MM-DD)

### Summary of Work Done:

*   **Initial Investigation Blocked**: Efforts to investigate the core bug in `minsky session delete` were quickly blocked by the need to stabilize the codebase. The initial plan to add debug logging to `src/domain/session.ts` revealed pre-existing or easily triggered linter errors and test failures.
*   **Focus on Test Failures & Linter Errors**: The majority of the time was spent attempting to:
    *   Resolve persistent test failures in `src/commands/session/startSession.test.ts` (related to session name expectations and error handling logic).
    *   Fix test failures in `src/domain/__tests__/session.test.ts` (mocking/DI for `updateSessionFromParams`).
    *   Address integration test failures in `src/adapters/__tests__/integration/session.test.ts` (issues with `execSync` mocking and `console.error` spies).
    *   Repeatedly attempt to refactor and fix numerous linter errors in `src/domain/session.ts` concerning imports, type definitions, class instantiations, and method signatures. These attempts were largely unsuccessful due to the complexity and cascading nature of the errors.
*   **AI Self-Correction & Process Adherence**: Several iterations involved the AI self-correcting its adherence to user preferences (e.g., avoiding questions, direct action), rule management protocols (`@rules-management.mdc`), and CLI command usage patterns. The `user-preferences.mdc` rule was successfully updated using the Minsky CLI.

### Current State:

*   **Original Task Goal Not Addressed**: The primary objective of fixing the `minsky session delete` command's database cleanup logic has not yet been tackled due to the blocking issues mentioned above.
*   **Critical File `src/domain/session.ts` Unstable**: This core domain file currently has numerous linter errors preventing successful testing and further development. Key problems include:
    *   Incorrect `/// <reference types="@bun-types" />` directive.
    *   Incorrect import paths or missing exports for `../utils/workspace.js` and `../schemas/session.js` (`sessionRecordSchema`).
    *   Errors in how `SessionDB`, `GitService`, and `TaskService` are instantiated (e.g., constructor argument mismatches).
    *   Incorrect arguments passed to `GitService` methods.
    *   Mismatched property names when accessing `XXXParams` types (e.g., `params.repoPath` vs. `params.repo` vs. `params.workspace`).
*   **Multiple Test Suites Failing**:
    *   `src/commands/session/startSession.test.ts`: 8 persistent failures.
    *   `src/domain/__tests__/session.test.ts`: 1 persistent failure in `updateSessionFromParams`.
    *   `src/adapters/__tests__/integration/session.test.ts`: 6 persistent failures.
*   **Debug Logs Added (but unusable currently)**: Debug logs were added to `deleteSession` and `writeDb` in `src/domain/session.ts`, but the file's instability prevents their effective use.

### Remaining Work Plan:

**Phase 1: Stabilize Core Domain Logic (Highest Priority - Blocking)**
1.  **Manually Fix `src/domain/session.ts` Linter Errors:**
    *   Remove `/// <reference types="@bun-types" />`.
    *   Verify and correct import paths for `WorkspaceUtils` (from `../utils/workspace.js`) and `sessionRecordSchema` (from `../schemas/session.js`). Ensure `sessionRecordSchema` is exported from its source.
    *   Verify constructor signatures for `SessionDB`, `GitService` (`src/domain/git.ts`), and `TaskService` (`src/domain/tasks.ts`). Adjust their instantiation in `createSessionDeps` and other parts of `src/domain/session.ts`.
    *   Verify method signatures for `GitService` methods (e.g., `stashChanges`, `pullLatest`) and ensure correct argument passing.
    *   Review and correct property access for `XXXParams` types (e.g., using `params.repo` or `params.workspace` as defined in the schemas).
    *   Ensure `repoUrl` in `startSessionFromParams` is guaranteed to be a string before use in `normalizeRepoName` or `gitService.clone`.
    *   Verify and correct options for `gitService.branch` in `startSessionFromParams`.
2.  **Run Tests**: After `src/domain/session.ts` is lint-free, run `bun test` to reassess the state of test failures.

**Phase 2: Resolve Test Failures**
3.  **Address `src/commands/session/startSession.test.ts` failures (8 tests):**
    *   Investigate the persistent "test-session" name mismatch and error throwing issues.
    *   This may require a different mocking strategy if `bun:test mock.module` is the root cause. Consider targeted dependency injection for the `startSession` command function itself if its signature allows or can be refactored.
4.  **Address `src/domain/__tests__/session.test.ts` failure (1 test - `updateSessionFromParams`):**
    *   Ensure the dependency injection pattern (passing the `deps` object) is correctly implemented and that the mock services (`mockGitService`, `mockSessionDB`) are being used as intended.
5.  **Address `src/adapters/__tests__/integration/session.test.ts` failures (6 tests):**
    *   Fix issues related to `execSync` mocking and `console.error` spy call counts.

**Phase 3: Address Original Task #075 Requirements**
6.  **Investigate `minsky session delete` Bug**:
    *   With a stable codebase and passing tests, use debug logs to trace the `deleteSession` logic in `src/domain/session.ts` and the command logic in `src/commands/session/delete.ts`.
    *   Pinpoint why the session record is not being removed from the database.
7.  **Implement the Fix**: Correct the identified bug.
8.  **Add/Update Tests**: Create specific tests in `src/commands/session/delete.test.ts` and `src/domain/__tests__/session.test.ts` to verify the fix and prevent regressions. Ensure edge cases (e.g., session directory deleted but DB record exists, or vice-versa) are considered.
9.  **Manual Verification**:
    *   Run `minsky session delete <session-name>` for a test session.
    *   Verify directory removal.
    *   Verify database record removal.
10. **Update Acceptance Criteria & Documentation**: Mark task as complete.
