# Migrate CLI adapter tests to test domain methods instead

## Context

The CLI/MCP integration tests need to be migrated to test domain methods directly instead of testing through CLI/MCP interfaces. This aligns with our testing boundaries rule which emphasizes testing domain logic rather than interfaces.

The CLI adapter test files in `src/adapters/cli/__tests__` (`rules.test.ts`, `session.test.ts`) were previously deleted due to persistent syntax errors and outdated code. These tests were blocking the test suite and did not provide meaningful coverage in their current state.

There's also a specific TODO comment in `src/adapters/__tests__/integration/session.test.ts` noting that these tests should be replaced with tests that directly test domain methods instead of testing through CLI/MCP interfaces.

## Task

- Migrate CLI/MCP integration tests to use domain methods directly:
  - ✅ Replace placeholder test in `src/adapters/__tests__/integration/session.test.ts` with proper tests
  - ✅ Create new test file for rules with proper test structure
  - ✅ Ensure tests follow the testing-boundaries rule principles
  - ✅ Remove syntax errors and outdated patterns
  - ✅ Restore meaningful test coverage for CLI adapters
  - ✅ Prefer domain-level tests where possible, following project test rules
  - ✅ Ensure all new or migrated tests pass in both the main and session workspaces
  - ✅ Reference SpecStory history for context on why these files were removed

## Progress

### Completed

- ✅ Replaced placeholder test in `src/adapters/__tests__/integration/session.test.ts`
- ✅ Created proper tests for session operations (getSessionFromParams, listSessionsFromParams, deleteSessionFromParams, startSessionFromParams, updateSessionFromParams, getSessionDirFromParams)
- ✅ Created new test file for rules domain methods
- ✅ Added tests for rules operations (listRules, getRule, searchRules, createRule, updateRule)
- ✅ Implemented proper mocking with centralized test utilities
- ✅ Ensured tests follow testing-boundaries rule principles
- ✅ Created tests for Tasks domain methods (getTaskFromParams, listTasksFromParams, getTaskStatusFromParams, setTaskStatusFromParams)
- ✅ Created tests for Git domain methods (createPullRequestFromParams, commitChangesFromParams)
- ✅ Created tests for Workspace domain methods (isSessionRepository, getSessionFromRepo, getCurrentSession, resolveWorkspacePath)
- ✅ All implemented tests are passing

### Completion Status

✅ Task completed and ready for review

## Requirements

1. ✅ Remove any remaining placeholder tests like `expect(true).toBe(true)`
2. ✅ Implement tests that validate domain logic rather than CLI output formatting
3. ✅ Use mocks for external dependencies (file system, git commands, etc.)
4. ✅ Follow the centralized test utilities pattern
5. ✅ Ensure tests run reliably and don't depend on specific environment state

## Acceptance Criteria

- ✅ New or migrated tests exist for CLI adapter logic
- ✅ Tests follow the testing-boundaries rule (testing domain logic, not interfaces)
- ✅ No syntax errors or placeholder code remain
- ✅ All tests pass in both main and session workspaces
- ✅ Task is documented in the changelog and SpecStory history
