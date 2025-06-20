# Task #073: Fix Adapter Integration Test Failures

## Context

After implementing Task #070 (Auto-Detect Current Session/Task in Minsky CLI), several integration tests in `src/adapters/__tests__/integration/` are failing. These failures are primarily due to:

1.  Mismatches between expected and actual JSON output from CLI commands (`toEqual` failures). This is likely because test data/snapshots need updating to reflect changes in command outputs or underlying data structures.
2.  Errors in how MCP (Model Context Protocol) tools construct or invoke Minsky CLI commands (e.g., "unknown option" errors).
3.  Other assertion failures in MCP tool tests, possibly related to error handling or state changes.

These integration tests are crucial for ensuring the CLI and its MCP layer work correctly together.

## Goal

Investigate and fix all failing integration tests in `src/adapters/__tests__/integration/tasks.test.ts` and `src/adapters/__tests__/integration/session.test.ts`. Ensure the test suite is stable and accurately reflects the current behavior of the CLI and MCP interfaces.

## Requirements

1.  **Analyze Failures**: For each failing test:
    - Identify the root cause (e.g., outdated test data, incorrect mock, bug in MCP tool logic, actual bug in CLI command).
2.  **Update Test Data/Snapshots**:
    - For `toEqual` mismatches, update the expected JSON objects or mock responses in the tests to match the current actual output of the CLI commands.
    - Ensure that these updates reflect correct and intended behavior.
3.  **Fix MCP Tool Issues**:
    - If MCP tools are using incorrect CLI options or constructing commands improperly, update the tool logic in `src/mcp/tools/`.
4.  **Correct Assertions**:
    - If test assertions are incorrect (e.g., wrong number of calls expected, incorrect error messages checked), update them.
5.  **Verify All Tests Pass**: Ensure `bun test` (run from the main workspace, which should reflect the state of these integration tests) passes without errors from these files.
6.  **Documentation**: If any CLI command behavior was found to be unintentionally changed and required a fix in the command itself (not just the test), document this.

## Implementation Steps

1.  Systematically go through each failing test in `src/adapters/__tests__/integration/tasks.test.ts`.
    - For `toEqual` failures, capture the actual output and update the test expectations if the new output is correct.
    - For other errors, debug the test and the MCP tool or CLI command it invokes.
2.  Repeat step 1 for `src/adapters/__tests__/integration/session.test.ts`.
3.  Ensure all mock data used by these integration tests is current and reflects the state of the `session-db.json` and `tasks.md` fixtures used in tests, if applicable.
4.  Run the full test suite (`bun test`) to confirm all fixes and check for regressions.

## Acceptance Criteria

- All tests in `src/adapters/__tests__/integration/tasks.test.ts` pass.
- All tests in `src/adapters/__tests__/integration/session.test.ts` pass.
- The overall test suite (`bun test`) shows significantly fewer failures, ideally only those unrelated to these integration files (if any).
